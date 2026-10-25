import { randomBytes as cryptoRandomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BUNDLE_HEADER_BYTES,
  BundleEntryNotFoundError,
  findBundleEntry,
  InvalidBundleError,
  InvalidSourceFileSizeError,
  isBundleHeader,
  normalizeMacosSystemPath,
  parseBundleHeader,
  parseBundleManifest,
  SourceFileTooLargeError,
  UnsupportedSourceExtensionError,
  V1_MAX_HTML_SIZE_BYTES,
  validateBundlePath,
  validateDocumentId,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "@planview/core";
import { Effect } from "effect";
import {
  acquireFinalizationLock,
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS,
  FinalizationLockBusyError,
  type FinalizationLockLease,
  removeFinalizationLockDirectory,
} from "./document-file-finalization-lock.js";
import { sameFileIdentity, type FileIdentity, usableBirthtime } from "./document-file-identity.js";
import { isProcessAlive, LOCAL_HOSTNAME } from "./document-file-owner-process.js";
export { DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS };
import {
  DocumentFileAlreadyExistsError,
  DocumentFileCloneError,
  DocumentFileDeleteError,
  DocumentFileDiscardError,
  DocumentFileFinalizeError,
  type DocumentFileFormat,
  type DocumentFileIdentity,
  DocumentFileNotBundleError,
  DocumentFileNotRegularError,
  type DocumentFileObservation,
  type DocumentFilePage,
  DocumentFileReadActiveError,
  DocumentFileReadError,
  type DocumentFileReadLease,
  type DocumentFileReconciliationBudget,
  type DocumentFileReconciliationResult,
  type DocumentFileResourceState,
  type DocumentFileScanWatermark,
  DocumentFileSourceError,
  type DocumentFileStore,
  DocumentFileStoreClosedError,
  DocumentFileStoreOpenError,
  type DocumentFileStoreOptions,
  DocumentFileStorePathError,
  DocumentFileTargetBusyError,
  type DocumentFileTargetCapability,
  type DocumentFileTargetCommit,
  type DocumentFileTargetRecoveryPolicy,
  InvalidStagedDocumentFileHandleError,
  type StagedDocumentFileHandle,
} from "./document-file-types.js";

export * from "./document-file-types.js";

const MAX_STAGED_HANDLE_BYTES = 32;
const MAX_STAGED_ALLOCATION_ATTEMPTS = 128;
const STAGED_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const NON_BLOCKING = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
const DIRECTORY = constants.O_DIRECTORY ?? 0;
// fsync(2) reports EINVAL for a directory on filesystems that do not implement
// directory synchronization. The remaining codes are explicit unsupported
// responses. EBADF, ENOTDIR, and all other errors are operational failures.
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const USE_DIRECTORY_FDS =
  process.platform === "linux" && DIRECTORY !== 0 && existsSync("/proc/self/fd");
const FINALIZATION_LOCK_METADATA_BYTES = 4 * 1024;
const READ_REFERENCE_TOKEN_BYTES = 16;
const READ_REFERENCE_PREFIX = ".read.";
const READ_REFERENCE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TARGET_LOCK_WAIT_MS = 32;
const TARGET_LOCK_RETRY_DELAY_MS = 1;

type TrustedDirectory = {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly fd: number | undefined;
};

const isFileStoreError = (error: unknown) =>
  error instanceof DocumentFileStorePathError ||
  error instanceof DocumentFileStoreOpenError ||
  error instanceof DocumentFileStoreClosedError ||
  error instanceof DocumentFileSourceError ||
  error instanceof DocumentFileNotRegularError ||
  error instanceof InvalidStagedDocumentFileHandleError ||
  error instanceof DocumentFileAlreadyExistsError ||
  error instanceof DocumentFileTargetBusyError ||
  error instanceof DocumentFileFinalizeError ||
  error instanceof DocumentFileDiscardError ||
  error instanceof DocumentFileCloneError ||
  error instanceof DocumentFileReadError ||
  error instanceof DocumentFileReadActiveError ||
  error instanceof DocumentFileDeleteError;

const errorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const isNotFound = (error: unknown) => errorCode(error) === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const readFileRange = async (
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number
) => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      break;
    }
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
};

const readDocumentFormat = async (
  file: Awaited<ReturnType<typeof open>>,
  totalSize: number
): Promise<DocumentFileFormat> => {
  const header = await readFileRange(file, 0, BUNDLE_HEADER_BYTES);
  if (!isBundleHeader(header)) {
    return { kind: "html" };
  }
  const { manifestBytes } = parseBundleHeader(header);
  const manifest = await readFileRange(file, BUNDLE_HEADER_BYTES, manifestBytes);
  if (manifest.byteLength !== manifestBytes) {
    throw new InvalidBundleError("The bundle manifest is truncated.");
  }
  return {
    kind: "bundle",
    manifest: parseBundleManifest(manifest, BUNDLE_HEADER_BYTES + manifestBytes, totalSize),
  };
};

const validateDirectoryPath = (path: unknown, label: string) => {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new DocumentFileStorePathError({
      path: typeof path === "string" ? path : String(path),
      reason: `${label} must be a non-empty absolute path.`,
      message: `Could not initialize document file storage: ${label} must be a non-empty absolute path.`,
    });
  }

  const normalized = normalizeMacosSystemPath(resolve(path));
  if (normalized === parse(normalized).root) {
    throw new DocumentFileStorePathError({
      path,
      reason: `${label} must not be a filesystem root.`,
      message: `Could not initialize document file storage: ${label} must not be a filesystem root.`,
    });
  }
  return normalized;
};

const pathKey = (path: string) => {
  let normalized = normalize(path);
  if (process.platform === "win32") {
    if (normalized.startsWith("\\\\?\\UNC\\")) {
      normalized = `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`;
    } else if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice("\\\\?\\".length);
    }
    return normalized.toLowerCase();
  }
  return normalized;
};

const canonicalPath = (path: string) => pathKey(realpathSync.native(path));

const samePath = (left: string, right: string) => pathKey(left) === pathKey(right);

const targetCapabilityFor = (id: string, identity: FileIdentity) =>
  Object.freeze({
    id,
    identity: Object.freeze({
      dev: identity.dev,
      ino: identity.ino,
      birthtimeMs: identity.birthtimeMs,
    }),
  }) as DocumentFileTargetCapability;

const pathError = (path: string, reason: string) =>
  new DocumentFileStorePathError({
    path,
    reason,
    message: `Could not use document file storage path ${path}: ${reason}`,
  });

const checkAncestorSecurity = (path: string, stats: Stats, final: boolean) => {
  if (process.platform === "win32") {
    // Node does not expose a portable NTFS ACL or reparse-point inspection API.
    // The Windows branch is intentionally a local-trust check, not a privacy or
    // containment assertion.
    return;
  }

  const mode = stats.mode & 0o7777;
  if (final) {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw pathError(path, "the storage directory must be owned by the current user.");
    }
    return;
  }

  const writableByOthers = mode & 0o022;
  const safeStickyDirectory = (mode & 0o1000) !== 0 && (mode & 0o0002) !== 0;
  if (writableByOthers !== 0 && !safeStickyDirectory) {
    throw pathError(path, "a storage parent directory is writable by group or others.");
  }
};

const pathSegments = (path: string) => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = relative(root, absolute);
  return {
    root,
    segments: remainder.split(sep).filter((segment) => segment.length > 0),
  };
};

const makePrivateDirectory = (path: string) => {
  try {
    const { root, segments } = pathSegments(path);
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      try {
        const stats = lstatSync(current);
        if (stats.isSymbolicLink()) {
          throw pathError(current, "storage paths and their parents must not be symbolic links.");
        }
        if (!stats.isDirectory()) {
          throw pathError(current, "every storage path component must be a directory.");
        }
        checkAncestorSecurity(current, stats, index === segments.length - 1);
      } catch (cause) {
        if (errorCode(cause) !== "ENOENT") {
          throw cause;
        }
        let created: Stats;
        try {
          mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
          created = lstatSync(current);
        } catch (mkdirCause) {
          if (errorCode(mkdirCause) !== "EEXIST") {
            throw mkdirCause;
          }
          // Another Planview process may have created this directory after our
          // lstat. Re-check the raced path with the same trust rules instead
          // of treating the expected race as an initialization failure.
          created = lstatSync(current);
        }
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw pathError(current, "the storage directory was replaced while it was created.");
        }
        checkAncestorSecurity(current, created, index === segments.length - 1);
      }
    }

    const realPath = canonicalPath(path);
    if (process.platform !== "win32" && !samePath(realPath, path)) {
      throw pathError(path, "storage paths and their parents must resolve without symlinks.");
    }

    if (process.platform !== "win32") {
      chmodSync(path, PRIVATE_DIRECTORY_MODE);
      const privateStats = lstatSync(path);
      checkAncestorSecurity(path, privateStats, true);
      if ((privateStats.mode & 0o077) !== 0) {
        throw pathError(path, "the storage directory must not be accessible by group or others.");
      }
    }
  } catch (cause) {
    if (cause instanceof DocumentFileStorePathError) {
      throw cause;
    }
    throw new DocumentFileStoreOpenError({
      path,
      cause,
      message: `Could not initialize document file storage directory ${path}: ${describe(cause)}`,
    });
  }
};

const openTrustedDirectory = (path: string) => {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw pathError(path, "the storage directory must be a real directory.");
    }
    const expectedPath = canonicalPath(path);
    if (process.platform !== "win32" && !samePath(expectedPath, path)) {
      throw pathError(path, "storage paths and their parents must resolve without symlinks.");
    }

    let fd: number | undefined;
    if (USE_DIRECTORY_FDS) {
      try {
        fd = openSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
        const opened = fstatSync(fd);
        if (!sameFileIdentity(stats, opened)) {
          throw pathError(path, "the storage directory changed while it was opened.");
        }
        if (!samePath(canonicalPath(path), path)) {
          throw pathError(path, "storage paths and their parents must resolve without symlinks.");
        }
      } catch (cause) {
        if (fd !== undefined) {
          closeSync(fd);
          fd = undefined;
        }
        throw cause;
      }
    }

    return { path, identity: stats, fd } satisfies TrustedDirectory;
  } catch (cause) {
    if (cause instanceof DocumentFileStorePathError) {
      throw cause;
    }
    throw new DocumentFileStoreOpenError({
      path,
      cause,
      message: `Could not open trusted document file storage directory ${path}: ${describe(cause)}`,
    });
  }
};

const verifyTrustedDirectory = (directory: TrustedDirectory) => {
  const { root, segments } = pathSegments(directory.path);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (cause) {
      throw pathError(directory.path, `a trusted storage path disappeared: ${describe(cause)}`);
    }
    if (stats.isSymbolicLink()) {
      throw pathError(
        directory.path,
        "storage paths and their parents must not be symbolic links."
      );
    }
    if (!stats.isDirectory()) {
      throw pathError(directory.path, "a trusted storage path component is not a directory.");
    }
    checkAncestorSecurity(current, stats, index === segments.length - 1);
  }

  if (process.platform !== "win32" && !samePath(canonicalPath(directory.path), directory.path)) {
    throw pathError(
      directory.path,
      "storage paths and their parents must resolve without symlinks."
    );
  }
  const stats = lstatSync(directory.path);
  if (!sameFileIdentity(directory.identity, stats)) {
    throw pathError(directory.path, "the trusted storage directory was replaced.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw pathError(directory.path, "the storage directory permissions are no longer private.");
  }
};

const closeTrustedDirectory = (directory: TrustedDirectory) => {
  if (directory.fd !== undefined) {
    try {
      closeSync(directory.fd);
    } catch {
      // close() is deliberately synchronous and best effort.
    }
  }
};

const isDirectorySyncUnsupported = (cause: unknown) =>
  DIRECTORY_SYNC_UNSUPPORTED_CODES.has(errorCode(cause) ?? "");

const syncDirectory = async (directory: TrustedDirectory) => {
  if (directory.fd !== undefined) {
    try {
      fsyncSync(directory.fd);
    } catch (cause) {
      if (!isDirectorySyncUnsupported(cause)) {
        throw cause;
      }
    }
    return;
  }

  // Windows has no Node API for opening a directory handle suitable for fsync.
  if (process.platform === "win32") {
    return;
  }

  // Keep opening the directory outside the unsupported-error filter. An open
  // failure means the trusted directory cannot be used, not that directory
  // synchronization is unavailable.
  const handle = await open(directory.path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    try {
      await handle.sync();
    } catch (cause) {
      if (!isDirectorySyncUnsupported(cause)) {
        throw cause;
      }
    }
  } finally {
    await handle.close();
  }
};

const isValidStagedHandle = (value: unknown): value is StagedDocumentFileHandle =>
  typeof value === "string" && STAGED_HANDLE_PATTERN.test(value);

const finalizationLockEntry = (entry: string) => {
  if (!entry.startsWith(".") || !entry.endsWith(".lock")) {
    return undefined;
  }
  const body = entry.slice(1, -".lock".length);
  if (isValidStagedHandle(body)) {
    return { kind: "staged" as const, id: body };
  }
  if (body.endsWith(".target")) {
    try {
      return { kind: "target" as const, id: validateDocumentId(body.slice(0, -".target".length)) };
    } catch {
      // Unknown lock names are retained rather than guessed at.
    }
  }
  return undefined;
};

const validateStagedHandle = (value: unknown) => {
  if (!isValidStagedHandle(value)) {
    throw new InvalidStagedDocumentFileHandleError({
      value,
      message: "The staged document file handle is not a valid opaque handle.",
    });
  }

  return value;
};

const sourceValidationError = (error: unknown) =>
  error instanceof UnsupportedSourceExtensionError ||
  error instanceof InvalidSourceFileSizeError ||
  error instanceof SourceFileTooLargeError;

const createStagedHandle = (randomBytes: (size: number) => Uint8Array) => {
  const bytes = randomBytes(MAX_STAGED_HANDLE_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length < MAX_STAGED_HANDLE_BYTES) {
    throw new Error("The staged-file random source returned too few bytes.");
  }

  const handle = Buffer.from(bytes.subarray(0, MAX_STAGED_HANDLE_BYTES)).toString("base64url");
  return validateStagedHandle(handle);
};

const validateNoSymlinkAncestors = async (path: string) => {
  const { root, segments } = pathSegments(path);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (cause) {
      if (isNotFound(cause)) {
        return;
      }
      throw cause;
    }
    if (stats.isSymbolicLink()) {
      throw new DocumentFileNotRegularError({
        path,
        message: `The document source path must not contain symbolic links: ${path}.`,
      });
    }
    // On Windows, lstat cannot prove that a non-symbolic-link directory is not
    // a junction or another reparse point. The final open/identity checks remain
    // useful, but callers must not treat this walk as absolute containment.
  }
};

const regularFileError = (path: string) =>
  new DocumentFileNotRegularError({
    path,
    message: `The document file must be a regular file and must not be a symbolic link: ${path}.`,
  });

const openWithoutFollowingLinks = async (
  path: string,
  flags: number,
  displayPath = path,
  checkAncestors = true
) => {
  if (checkAncestors) {
    await validateNoSymlinkAncestors(path);
  }

  const beforeOpen = await lstat(path);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw regularFileError(displayPath);
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK makes the check safe if a regular file is replaced by a FIFO/device
    // between lstat() and open(). O_NOFOLLOW is available on Unix; the post-open
    // identity checks are the safe Node-only fallback on Windows.
    file = await open(path, flags | NO_FOLLOW | NON_BLOCKING);
    const opened = await file.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw regularFileError(displayPath);
    }
    if (!sameFileIdentity(beforeOpen, opened)) {
      throw new Error("The file changed while it was being opened.");
    }

    const afterOpen = await lstat(path);
    if (!afterOpen.isFile() || afterOpen.isSymbolicLink()) {
      throw new Error("The file changed to a non-regular file while it was being opened.");
    }
    if (!sameFileIdentity(opened, afterOpen)) {
      throw new Error("The file changed while it was being opened.");
    }
    if (checkAncestors) {
      await validateNoSymlinkAncestors(path);
    }
    return file;
  } catch (cause) {
    await file?.close().catch(() => undefined);
    throw cause;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

type ReadReferenceLease = Readonly<{
  readonly path: string;
  readonly identity: FileIdentity;
}>;

type ReadReferenceMetadata = Readonly<{
  readonly version: 1;
  readonly owner: Readonly<{
    readonly pid: number;
    readonly host: string;
  }>;
  readonly acquiredAt: number;
}>;

const readReferenceName = (id: string, token: string) => `${READ_REFERENCE_PREFIX}${id}.${token}`;

const readReferenceEntry = (entry: string) => {
  if (!entry.startsWith(READ_REFERENCE_PREFIX)) {
    return undefined;
  }
  const remainder = entry.slice(READ_REFERENCE_PREFIX.length);
  const separator = remainder.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  const id = remainder.slice(0, separator);
  const token = remainder.slice(separator + 1);
  return /^[A-Za-z0-9_-]{21}$/.test(id) && READ_REFERENCE_TOKEN_PATTERN.test(token)
    ? { id, token }
    : undefined;
};

const readReferenceParts = (entry: string, id: string) => {
  const reference = readReferenceEntry(entry);
  return reference?.id === id ? reference.token : undefined;
};

const parseReadReferenceMetadata = (value: unknown): ReadReferenceMetadata | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, owner: ownerValue, acquiredAt } = value;
  if (!isRecord(ownerValue)) {
    return undefined;
  }
  const { pid, host } = ownerValue;
  if (
    version !== 1 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    host.length === 0 ||
    typeof acquiredAt !== "number" ||
    !Number.isSafeInteger(acquiredAt) ||
    acquiredAt < 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    owner: { pid, host },
    acquiredAt,
  };
};

const readReadReference = async (path: string) => {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
    const identity = await file.stat();
    const contents = Buffer.alloc(FINALIZATION_LOCK_METADATA_BYTES + 1);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (bytesRead > FINALIZATION_LOCK_METADATA_BYTES) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return undefined;
    }
    const metadata = parseReadReferenceMetadata(parsed);
    return metadata === undefined ? undefined : { metadata, identity };
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  } finally {
    await file?.close();
  }
};

const createReadReference = async (
  stagingDir: TrustedDirectory,
  id: string,
  now: () => number
): Promise<ReadReferenceLease> => {
  for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
    const token = cryptoRandomBytes(READ_REFERENCE_TOKEN_BYTES).toString("base64url");
    const name = readReferenceName(id, token);
    const path = entryPath(stagingDir, name);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      await file.writeFile(
        JSON.stringify({
          version: 1,
          owner: { pid: process.pid, host: LOCAL_HOSTNAME },
          acquiredAt: now(),
        }),
        "utf8"
      );
      await file.sync();
      const identity = await file.stat();
      // Keep the release path independent of the optional /proc fd. Store
      // shutdown may close that directory fd before a forced stream close;
      // the same identity check still prevents unlinking a replacement.
      return { path: join(stagingDir.path, name), identity };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") {
        throw cause;
      }
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  throw new Error("Could not allocate a unique active-read reference.");
};

const releaseReadReference = (reference: ReadReferenceLease) => {
  try {
    const current = lstatSync(reference.path);
    if (sameFileIdentity(reference.identity, current)) {
      unlinkSync(reference.path);
    }
  } catch {
    // A missing reference is already released. Any replacement is retained.
  }
};

const entryPath = (directory: TrustedDirectory, name: string) =>
  directory.fd === undefined
    ? join(directory.path, name)
    : join(`/proc/self/fd/${directory.fd}`, name);

const targetConflict = (path: string, id: string, stats: Stats) => {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return regularFileError(path);
  }
  return new DocumentFileAlreadyExistsError({
    id,
    message: `A document with id ${id} already exists.`,
  });
};

const assertTargetAbsent = async (path: string, id: string) => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return;
    }
    throw cause;
  }
  throw targetConflict(path, id, stats);
};

const classifyTargetCollision = async (path: string, id: string) => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    throw new Error(`The document target collision could not be inspected: ${describe(cause)}`);
  }
  throw targetConflict(path, id, stats);
};

const createStore = ({
  documentsDir,
  stagingDir,
  randomBytes,
  now = Date.now,
  beforeFinalizationLockRecoveryClaim,
  beforeStagedCloneLink,
  beforeStagedCloneCleanup,
  beforeStagedSourceCopy,
  afterStagedSourceCopy,
  beforeStagedSourceCleanup,
  beforeFinalizationTargetLink,
  beforeFinalizationTargetInspection,
  beforeFinalizationTargetCleanup,
  beforePostPublicationStagingDirectorySync,
  beforeDocumentTargetDelete,
  beforeDocumentFilePageScan,
  documentFileScanStartedAt,
  documentFileScanObservation,
  onDocumentFileDirectoryEnumeration,
  beforeDocumentFileScanMarkerCleanup,
}: {
  readonly documentsDir: TrustedDirectory;
  readonly stagingDir: TrustedDirectory;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
  readonly beforeFinalizationLockRecoveryClaim?: (lockPath: string) => Promise<void>;
  readonly beforeStagedCloneLink?: (sourcePath: string) => Promise<void>;
  readonly beforeStagedCloneCleanup?: (clonedPath: string) => Promise<void>;
  readonly beforeStagedSourceCopy?: (stagedPath: string) => Promise<void>;
  readonly afterStagedSourceCopy?: (sourcePath: string) => Promise<void>;
  readonly beforeStagedSourceCleanup?: (stagedPath: string) => Promise<void>;
  readonly beforeFinalizationTargetLink?: (targetPath: string) => Promise<void>;
  readonly beforeFinalizationTargetInspection?: (targetPath: string) => Promise<void>;
  readonly beforeFinalizationTargetCleanup?: (targetPath: string) => Promise<void>;
  readonly beforePostPublicationStagingDirectorySync?: () => Promise<void>;
  readonly beforeDocumentTargetDelete?: (targetPath: string) => Promise<void>;
  readonly beforeDocumentFilePageScan?: (startedAt: number | undefined) => Promise<void>;
  readonly documentFileScanStartedAt?: () => number | undefined;
  readonly documentFileScanObservation?: (
    observation: DocumentFileObservation
  ) => DocumentFileObservation;
  readonly onDocumentFileDirectoryEnumeration?: () => void;
  readonly beforeDocumentFileScanMarkerCleanup?: (markerPath: string) => Promise<void>;
}) => {
  const stagedIdentities = new Map<string, FileIdentity>();
  const documentMutexes = new Map<string, Promise<void>>();
  let closeRequested = false;
  let directoriesClosed = false;
  let activeOperations = 0;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  const generateBytes = randomBytes ?? cryptoRandomBytes;

  const ensureOpen = () => {
    if (closeRequested) {
      throw new DocumentFileStoreClosedError({ message: "Document file storage is closed." });
    }
  };

  const finishClose = () => {
    if (closeRequested && activeOperations === 0 && !directoriesClosed) {
      directoriesClosed = true;
      closeTrustedDirectory(documentsDir);
      closeTrustedDirectory(stagingDir);
      resolveClose?.();
      resolveClose = undefined;
    }
  };

  const beginOperation = () => {
    ensureOpen();
    activeOperations += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      activeOperations -= 1;
      finishClose();
    };
  };

  const ensureTrustedRoots = () => {
    verifyTrustedDirectory(documentsDir);
    verifyTrustedDirectory(stagingDir);
  };

  const withDocumentMutex = async <Value>(id: string, operation: () => Promise<Value>) => {
    const previous = documentMutexes.get(id);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    documentMutexes.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (documentMutexes.get(id) === current) {
        documentMutexes.delete(id);
      }
    }
  };

  const activeReadReferenceExists = async (id: string) => {
    const entries = await readdir(entryPath(stagingDir, ""));
    let removedStaleReference = false;
    for (const entry of entries) {
      if (readReferenceParts(entry, id) === undefined) {
        continue;
      }
      const path = entryPath(stagingDir, entry);
      let current: Stats;
      try {
        current = await lstat(path);
      } catch (cause) {
        if (isNotFound(cause)) {
          continue;
        }
        throw cause;
      }
      const observation = await readReadReference(path);
      if (
        observation === undefined ||
        observation.metadata.owner.host !== LOCAL_HOSTNAME ||
        isProcessAlive(observation.metadata.owner.pid)
      ) {
        // A malformed marker, a reference owned by another host, and a live
        // same-host owner all fail closed. Only a well-formed reference whose
        // local owner is definitely dead may be reclaimed.
        return true;
      }
      if (!sameFileIdentity(current, observation.identity)) {
        return true;
      }
      try {
        const fresh = await lstat(path);
        if (!sameFileIdentity(observation.identity, fresh)) {
          return true;
        }
        await unlink(path);
        removedStaleReference = true;
      } catch (cause) {
        if (!isNotFound(cause)) {
          return true;
        }
      }
    }
    if (removedStaleReference) {
      await syncDirectory(stagingDir);
    }
    return false;
  };

  const stagingPath = (handle: unknown) => entryPath(stagingDir, validateStagedHandle(handle));
  const documentPath = (id: string) => entryPath(documentsDir, `${validateDocumentId(id)}.html`);
  const targetLockPath = (id: string) => entryPath(stagingDir, `.${id}.target.lock`);
  async function discardEntry(
    directory: TrustedDirectory,
    name: string,
    expectedIdentity: FileIdentity,
    expectedContents?: string
  ) {
    verifyTrustedDirectory(directory);
    const path = entryPath(directory, name);
    let current: Stats;
    try {
      current = await lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) {
        return false;
      }
      throw cause;
    }
    if (current.isSymbolicLink() || !current.isFile()) {
      throw regularFileError(path);
    }
    if (!sameFileIdentity(expectedIdentity, current)) {
      throw new Error("The file was replaced before identity-safe discard.");
    }
    if (expectedContents !== undefined) {
      const file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
      try {
        const contents = await file.readFile("utf8");
        if (contents !== expectedContents) {
          throw new Error("The file contents were replaced before identity-safe discard.");
        }
      } finally {
        await file.close();
      }
    }
    await unlink(path);
    return true;
  }
  const captureDocumentScanWatermark = async () => {
    // A filesystem birth time is an optional, potentially coarse boundary. Do
    // not substitute a wall-clock value: if the filesystem cannot provide one,
    // the pass must defer its candidates rather than claim snapshot precision.
    for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
      const markerContents = Buffer.from(generateBytes(16)).toString("base64url");
      const markerName = `.scan-${markerContents}`;
      const markerPath = entryPath(documentsDir, markerName);
      let markerCreated = false;
      let markerContentsWritten = false;
      let markerFile: Awaited<ReturnType<typeof open>> | undefined;
      let markerIdentity: FileIdentity | undefined;
      try {
        markerFile = await open(
          markerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
          PRIVATE_FILE_MODE
        );
        markerCreated = true;
        markerIdentity = await markerFile.stat();
        await markerFile.writeFile(markerContents, "utf8");
        await markerFile.sync();
        markerContentsWritten = true;
        await markerFile.close();
        markerFile = undefined;
        return documentFileScanStartedAt === undefined
          ? usableBirthtime(markerIdentity.birthtimeMs)
            ? markerIdentity.birthtimeMs
            : undefined
          : documentFileScanStartedAt();
      } catch (cause) {
        if (!markerCreated && errorCode(cause) === "EEXIST") {
          continue;
        }
        throw cause;
      } finally {
        await markerFile?.close().catch(() => undefined);
        if (markerIdentity !== undefined) {
          try {
            await beforeDocumentFileScanMarkerCleanup?.(markerPath);
          } finally {
            await discardEntry(
              documentsDir,
              markerName,
              markerIdentity,
              markerContentsWritten ? markerContents : undefined
            );
          }
        }
      }
    }
    throw new Error("Could not allocate a document file scan watermark.");
  };
  const acquireTargetLock = async (id: string) => {
    const path = targetLockPath(id);
    const deadline = process.hrtime.bigint() + BigInt(TARGET_LOCK_WAIT_MS) * 1_000_000n;
    while (true) {
      try {
        return await acquireFinalizationLock(path, now, beforeFinalizationLockRecoveryClaim);
      } catch (cause) {
        if (!(cause instanceof FinalizationLockBusyError)) {
          throw cause;
        }
        const remaining = deadline - process.hrtime.bigint();
        if (remaining <= 0n) {
          throw new DocumentFileTargetBusyError({
            id,
            message: `Document target ${id} remained locked by a live peer after ${TARGET_LOCK_WAIT_MS}ms.`,
          });
        }
        const milliseconds = Number((remaining + 999_999n) / 1_000_000n);
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, Math.min(TARGET_LOCK_RETRY_DELAY_MS, milliseconds))
        );
      }
    }
  };
  const releaseTargetLock = async (id: string, lease: FinalizationLockLease) => {
    await removeFinalizationLockDirectory(targetLockPath(id), lease);
    await syncDirectory(stagingDir);
  };
  const close = () => {
    if (closePromise === undefined) {
      closeRequested = true;
      closePromise = new Promise<void>((resolveClosePromise) => {
        resolveClose = resolveClosePromise;
      });
      finishClose();
    }
    return closePromise;
  };

  const stageSourceFile = async (sourcePath: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      validateSourceFileExtension(sourcePath);

      const absoluteSourcePath = normalizeMacosSystemPath(resolve(sourcePath));
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let staged: Awaited<ReturnType<typeof open>> | undefined;
      let sourceStream: ReadStream | undefined;
      let destinationStream:
        | ReturnType<Awaited<ReturnType<typeof open>>["createWriteStream"]>
        | undefined;
      let handle: StagedDocumentFileHandle | undefined;
      let keepStaged = false;

      try {
        try {
          source = await openWithoutFollowingLinks(
            absoluteSourcePath,
            constants.O_RDONLY,
            sourcePath
          );
        } catch (cause) {
          if (cause instanceof DocumentFileNotRegularError) {
            throw cause;
          }
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause,
            message: `Could not open source document file ${sourcePath}: ${describe(cause)}`,
          });
        }

        const stats = await source.stat();
        validateSourceFileSize(stats.size);

        for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
          const candidate = createStagedHandle(generateBytes);
          try {
            staged = await open(
              stagingPath(candidate),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
              PRIVATE_FILE_MODE
            );
            handle = candidate;
            const stagedStats = await staged.stat();
            if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
              throw regularFileError(stagingPath(candidate));
            }
            handle = candidate;
            // Retain the inode identity for every later cleanup. A handle is a
            // pathname capability, not proof that a replacement at that path
            // belongs to this staging operation.
            stagedIdentities.set(candidate, stagedStats);
            break;
          } catch (cause) {
            if (staged !== undefined) {
              await staged.close().catch(() => undefined);
              staged = undefined;
            }
            if (errorCode(cause) !== "EEXIST") {
              throw cause;
            }
          }
        }

        if (staged === undefined || handle === undefined) {
          throw new Error("Could not allocate a unique staged document file handle.");
        }
        ensureTrustedRoots();
        await beforeStagedSourceCopy?.(stagingPath(handle));
        signal?.throwIfAborted();

        sourceStream = source.createReadStream({ autoClose: true });
        let copiedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            copiedBytes += chunk.byteLength;
            if (copiedBytes > V1_MAX_HTML_SIZE_BYTES) {
              callback(new SourceFileTooLargeError(copiedBytes));
              return;
            }
            callback(null, chunk);
          },
        });
        destinationStream = staged.createWriteStream({ autoClose: true });
        if (signal === undefined) {
          await pipeline(sourceStream, limiter, destinationStream);
        } else {
          await pipeline(sourceStream, limiter, destinationStream, { signal });
        }
        await afterStagedSourceCopy?.(absoluteSourcePath);
        source = undefined;
        staged = undefined;

        signal?.throwIfAborted();
        const pathAfterRead = await lstat(absoluteSourcePath);
        if (
          pathAfterRead.isSymbolicLink() ||
          !pathAfterRead.isFile() ||
          !sameFileIdentity(stats, pathAfterRead) ||
          pathAfterRead.mtimeMs !== stats.mtimeMs ||
          pathAfterRead.ctimeMs !== stats.ctimeMs ||
          copiedBytes !== stats.size ||
          copiedBytes !== pathAfterRead.size
        ) {
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause: new Error("The source changed while it was being staged."),
            message: `Could not stage source document file ${sourcePath}: the source changed while it was being read.`,
          });
        }

        ensureTrustedRoots();
        const durableStaged = await openWithoutFollowingLinks(
          stagingPath(handle),
          constants.O_RDWR,
          stagingPath(handle),
          false
        );
        try {
          await durableStaged.sync();
          stagedIdentities.set(handle, await durableStaged.stat());
        } finally {
          await durableStaged.close().catch(() => undefined);
        }
        await syncDirectory(stagingDir);
        keepStaged = true;
        return handle;
      } catch (cause) {
        sourceStream?.destroy();
        destinationStream?.destroy();
        if (sourceStream !== undefined) {
          source = undefined;
        }
        if (destinationStream !== undefined) {
          staged = undefined;
        }
        await staged?.close().catch(() => undefined);
        staged = undefined;

        let cleanupCause: unknown;
        if (handle !== undefined && !keepStaged) {
          try {
            await beforeStagedSourceCleanup?.(stagingPath(handle));
            await discardStagedFile(handle);
          } catch (cleanupError) {
            if (!isNotFound(cleanupError)) {
              cleanupCause = cleanupError;
            }
          }
        }

        if (cleanupCause !== undefined) {
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause,
            cleanupCause,
            message: `Could not stage source document file ${sourcePath}: ${describe(cause)}; cleanup also failed: ${describe(cleanupCause)}`,
          });
        }
        if (
          sourceValidationError(cause) ||
          cause instanceof DocumentFileSourceError ||
          cause instanceof DocumentFileNotRegularError
        ) {
          throw cause;
        }
        throw new DocumentFileSourceError({
          path: sourcePath,
          cause,
          message: `Could not stage source document file ${sourcePath}: ${describe(cause)}`,
        });
      } finally {
        await staged?.close().catch(() => undefined);
        await source?.close().catch(() => undefined);
      }
    } finally {
      releaseOperation();
    }
  };

  const finalizeStagedFile = async (
    handleValue: StagedDocumentFileHandle,
    id: string,
    targetCommit?: DocumentFileTargetCommit
  ) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const documentId = validateDocumentId(id);
      const sourcePath = stagingPath(handle);
      const targetPath = documentPath(documentId);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      const targetLockPath = entryPath(stagingDir, `.${documentId}.target.lock`);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let anotherFinalizerOwnsLock = false;
      let targetLockLease: FinalizationLockLease | undefined;
      let targetLockOwned = false;
      let stagedFileState: DocumentFileResourceState = "retained";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let targetLockState: DocumentFileResourceState = "absent";
      let targetNeedsCleanup = false;
      let targetCreated = false;
      let postPublicationStagingSyncFailed = false;
      let targetRecoveryPolicy: DocumentFileTargetRecoveryPolicy = "delete";
      let targetState: DocumentFileResourceState = "absent";
      let targetCommitAttempted = false;
      let targetIdentity: FileIdentity | undefined;
      let targetCapability: DocumentFileTargetCapability | undefined;
      let sourceIdentity: FileIdentity | undefined;
      let cleanupCause: unknown;
      const discardFinalizationStaged = async () => {
        const expectedIdentity = sourceIdentity ?? stagedIdentities.get(handle);
        if (expectedIdentity === undefined) {
          try {
            await lstat(sourcePath);
          } catch (cause) {
            if (isNotFound(cause)) {
              stagedIdentities.delete(handle);
              return false;
            }
            throw cause;
          }
          throw new Error("The staged document file identity was unavailable for cleanup.");
        }
        await beforeStagedSourceCleanup?.(sourcePath);
        const removed = await discardEntry(stagingDir, handle, expectedIdentity);
        stagedIdentities.delete(handle);
        return removed;
      };

      try {
        const expectedStagedIdentity = stagedIdentities.get(handle);
        try {
          source = await openWithoutFollowingLinks(sourcePath, constants.O_RDWR, sourcePath, false);
        } catch (sourceOpenCause) {
          stagedFileState = isNotFound(sourceOpenCause) ? "absent" : "unknown";
          throw sourceOpenCause;
        }
        const sourceStats = await source.stat();
        sourceIdentity = sourceStats;
        validateSourceFileSize(sourceStats.size);
        if (
          expectedStagedIdentity !== undefined &&
          !sameFileIdentity(expectedStagedIdentity, sourceStats)
        ) {
          stagedFileState = "unknown";
          throw new Error("The staged document file was replaced before finalization.");
        }

        try {
          lockLease = await acquireFinalizationLock(
            lockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
          lockOwned = true;
          finalizationLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          if (cause instanceof FinalizationLockBusyError) {
            anotherFinalizerOwnsLock = true;
            finalizationLockState = "retained";
          } else {
            finalizationLockState = "unknown";
          }
          throw cause;
        }

        try {
          const waitDeadline = process.hrtime.bigint() + BigInt(TARGET_LOCK_WAIT_MS) * 1_000_000n;
          let targetLockCause: unknown;
          while (targetLockLease === undefined) {
            try {
              targetLockLease = await acquireFinalizationLock(
                targetLockPath,
                now,
                beforeFinalizationLockRecoveryClaim
              );
              targetLockCause = undefined;
            } catch (cause) {
              targetLockCause = cause;
              if (!(cause instanceof FinalizationLockBusyError)) {
                break;
              }
              const remainingNanoseconds = waitDeadline - process.hrtime.bigint();
              if (remainingNanoseconds <= 0n) {
                break;
              }
              const remainingMilliseconds = Number((remainingNanoseconds + 999_999n) / 1_000_000n);
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(TARGET_LOCK_RETRY_DELAY_MS, remainingMilliseconds))
              );
            }
          }
          if (targetLockLease === undefined) {
            if (targetLockCause instanceof FinalizationLockBusyError) {
              throw new DocumentFileTargetBusyError({
                id: documentId,
                message: `Document target ${documentId} remained locked by a live peer after ${TARGET_LOCK_WAIT_MS}ms.`,
              });
            }
            throw targetLockCause ?? new FinalizationLockBusyError("The target is busy.");
          }
          targetLockOwned = true;
          targetLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          // A busy peer owns this id-wide lock. It is not this finalizer's
          // resource and must not be surfaced as this caller's retained lock.
          targetLockState = cause instanceof DocumentFileTargetBusyError ? "absent" : "unknown";
          throw cause;
        }

        ensureTrustedRoots();
        await assertTargetAbsent(targetPath, documentId);
        const sourceBeforeLink = await lstat(sourcePath);
        const sourceAtLink = await source.stat();
        if (
          sourceBeforeLink.isSymbolicLink() ||
          !sourceBeforeLink.isFile() ||
          !sameFileIdentity(sourceStats, sourceBeforeLink) ||
          !sameFileIdentity(sourceStats, sourceAtLink) ||
          sourceAtLink.size > V1_MAX_HTML_SIZE_BYTES
        ) {
          throw new Error("The staged document file changed while it was being finalized.");
        }

        ensureTrustedRoots();
        await source.sync();
        await beforeFinalizationTargetLink?.(targetPath);
        try {
          // link() is the Node-supported atomic no-replace primitive. rename() would
          // replace a concurrently-created target on POSIX, so it is intentionally not
          // used here. The source and target must support hard links and share a volume.
          await link(sourcePath, targetPath);
          targetNeedsCleanup = true;
          targetCreated = true;
          targetState = "retained";
        } catch (cause) {
          if (errorCode(cause) === "EEXIST") {
            await classifyTargetCollision(targetPath, documentId);
          }
          throw cause;
        }

        await beforeFinalizationTargetInspection?.(targetPath);
        const targetStats = await lstat(targetPath);
        const sourceAfterLink = await source.stat();
        if (
          targetStats.isSymbolicLink() ||
          !targetStats.isFile() ||
          !sameFileIdentity(targetStats, sourceAfterLink)
        ) {
          throw regularFileError(targetPath);
        }
        targetIdentity = targetStats;
        targetCapability = targetCapabilityFor(documentId, targetStats);

        await beforeFinalizationTargetCleanup?.(targetPath);
        await syncDirectory(documentsDir);
        // Once the target directory is synced, the target is the recoverable
        // durable result. Later staging cleanup failures must not retract it.
        targetRecoveryPolicy = "retain";
        targetNeedsCleanup = false;
        await source.close();
        source = undefined;
        await discardFinalizationStaged();
        stagedFileState = "absent";
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        const syncPostPublicationStaging = async () => {
          try {
            await beforePostPublicationStagingDirectorySync?.();
            await syncDirectory(stagingDir);
          } catch (postPublicationSyncCause) {
            // A failed directory sync makes the durability of every just-removed
            // staging entry ambiguous. Keep all residual states recoverable and
            // let the coordinator preserve the already-synced target.
            postPublicationStagingSyncFailed = true;
            stagedFileState = "unknown";
            finalizationLockState = "unknown";
            targetLockState = "unknown";
            throw postPublicationSyncCause;
          }
        };
        if (targetCommit !== undefined) {
          // Keep the target lock through the final staging sync and the
          // metadata handoff. A cleanup pass that saw this target before its
          // row existed must therefore wait/fail as busy instead of deleting
          // the target between finalization and metadata commit.
          await syncPostPublicationStaging();
        }
        if (targetCapability === undefined || targetIdentity === undefined) {
          throw new Error("The finalized document target identity was unavailable.");
        }
        const expectedTargetIdentity = targetIdentity;
        const readTarget = async () => {
          ensureTrustedRoots();
          let targetFile: Awaited<ReturnType<typeof open>> | undefined;
          try {
            targetFile = await openWithoutFollowingLinks(
              targetPath,
              constants.O_RDONLY,
              targetPath,
              false
            );
            const currentTarget = await targetFile.stat();
            if (!sameFileIdentity(expectedTargetIdentity, currentTarget)) {
              throw new Error("The finalized document target changed during metadata commit.");
            }
            const stream = targetFile.createReadStream({ autoClose: true });
            targetFile = undefined;
            return stream;
          } catch (cause) {
            await targetFile?.close().catch(() => undefined);
            throw cause;
          }
        };
        if (targetCommit !== undefined) {
          targetCommitAttempted = true;
          await targetCommit(targetCapability, readTarget);
        }
        await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
        targetLockLease = undefined;
        targetLockOwned = false;
        targetLockState = "absent";
        if (targetCommit === undefined) {
          // Preserve the legacy direct-finalization boundary for callers that
          // do not have metadata to commit. The Planview coordinator uses the
          // callback above, which keeps this sync inside the publication fence.
          await syncPostPublicationStaging();
        }
        return targetCapability;
      } catch (cause) {
        await source?.close().catch((closeError) => {
          cleanupCause ??= closeError;
        });
        source = undefined;

        if (targetNeedsCleanup && targetLockOwned) {
          try {
            if (targetIdentity === undefined) {
              // A successful link is not enough to authorize pathname cleanup:
              // if target inspection failed, we cannot prove that this path is
              // still the inode created by this finalizer. Inspect only to
              // distinguish a known-absent path; never delete without the
              // identity captured immediately after link().
              try {
                await lstat(targetPath);
              } catch (inspectionCause) {
                if (isNotFound(inspectionCause)) {
                  targetNeedsCleanup = false;
                  targetCreated = false;
                  targetState = "absent";
                } else {
                  throw inspectionCause;
                }
              }
              if (targetNeedsCleanup) {
                throw new Error(
                  "The finalized document target identity was unavailable for cleanup."
                );
              }
            } else {
              const removedTarget = await discardEntry(
                documentsDir,
                `${documentId}.html`,
                targetIdentity
              );
              targetNeedsCleanup = false;
              targetCreated = false;
              targetState = "absent";
              if (removedTarget) {
                try {
                  await syncDirectory(documentsDir);
                } catch (targetSyncCleanupError) {
                  targetState = "unknown";
                  cleanupCause ??= targetSyncCleanupError;
                }
              }
            }
          } catch (targetCleanupError) {
            if (isNotFound(targetCleanupError)) {
              targetNeedsCleanup = false;
              targetCreated = false;
              targetState = "absent";
            } else {
              // The path may now be a replacement. Publication compensation
              // must not delete it by document id after identity is uncertain.
              targetState = "unknown";
              cleanupCause ??= targetCleanupError;
            }
          }
        }

        if (lockOwned) {
          try {
            await discardFinalizationStaged();
            stagedFileState = "absent";
          } catch (sourceCleanupError) {
            if (isNotFound(sourceCleanupError)) {
              stagedFileState = "absent";
            } else {
              stagedFileState = "unknown";
              cleanupCause ??= sourceCleanupError;
            }
          }
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (!isNotFound(lockCleanupError)) {
              finalizationLockState = "retained";
              cleanupCause ??= lockCleanupError;
            } else {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            }
          }
        } else if (!anotherFinalizerOwnsLock && !postPublicationStagingSyncFailed) {
          // Cleanup takes the same per-handle lock even when this finalizer
          // failed before acquiring it. A busy lock is retained for its owner.
          try {
            await discardFinalizationStaged();
            stagedFileState = "absent";
          } catch (sourceCleanupError) {
            if (isNotFound(sourceCleanupError)) {
              stagedFileState = "absent";
            } else {
              stagedFileState = "unknown";
              cleanupCause ??= sourceCleanupError;
            }
          }
        }

        if (targetLockOwned) {
          try {
            await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
            targetLockLease = undefined;
            targetLockOwned = false;
            targetLockState = "absent";
          } catch (targetLockCleanupError) {
            if (isNotFound(targetLockCleanupError)) {
              targetLockLease = undefined;
              targetLockOwned = false;
              targetLockState = "absent";
            } else {
              targetLockState = "retained";
              cleanupCause ??= targetLockCleanupError;
            }
          }
        }
        if (postPublicationStagingSyncFailed && targetLockState === "absent") {
          // The lock pathname was removed, but the sync boundary was
          // ambiguous; report that uncertainty even when best-effort cleanup
          // happened to finish.
          targetLockState = "unknown";
        }

        if (
          cleanupCause === undefined &&
          (cause instanceof DocumentFileAlreadyExistsError ||
            cause instanceof DocumentFileTargetBusyError ||
            cause instanceof DocumentFileNotRegularError)
        ) {
          throw cause;
        }
        throw new DocumentFileFinalizeError({
          id: documentId,
          handle,
          targetCreated,
          targetCommitAttempted,
          ...(targetCapability === undefined ? {} : { targetCapability }),
          targetRecoveryPolicy,
          targetState,
          targetLockState,
          stagingMayBeDiscarded: !anotherFinalizerOwnsLock && finalizationLockState === "absent",
          stagedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not finalize staged document file for ${documentId}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const cloneStagedFile = async (handleValue: StagedDocumentFileHandle) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const sourcePath = stagingPath(handle);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let targetHandle: StagedDocumentFileHandle | undefined;
      let targetIdentity: FileIdentity | undefined;
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let sourceFileState: DocumentFileResourceState = "retained";
      let clonedFileState: DocumentFileResourceState = "absent";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let targetCreated = false;
      let cleanupCause: unknown;

      const linkClone = async (candidate: StagedDocumentFileHandle) => {
        // Check the pathname again after the race seam and immediately before
        // link(). The descriptor check below remains authoritative if the path
        // is replaced in the small interval that follows.
        const sourceFile = source;
        let sourceBeforeLink: Stats;
        try {
          sourceBeforeLink = await lstat(sourcePath);
        } catch (cause) {
          sourceFileState = isNotFound(cause) ? "absent" : "unknown";
          throw cause;
        }
        let sourceAtLink: Stats | undefined;
        try {
          sourceAtLink = await sourceFile?.stat();
        } catch (cause) {
          sourceFileState = "unknown";
          throw cause;
        }
        if (
          sourceFile === undefined ||
          sourceAtLink === undefined ||
          sourceBeforeLink.isSymbolicLink() ||
          !sourceBeforeLink.isFile() ||
          !sameFileIdentity(sourceBeforeLink, sourceAtLink)
        ) {
          sourceFileState = "unknown";
          throw new Error("The staged source file changed before it was cloned.");
        }
        await link(sourcePath, stagingPath(candidate));
        targetHandle = candidate;
        targetCreated = true;
        clonedFileState = "retained";
        const clonedStats = await lstat(stagingPath(candidate));
        targetIdentity = clonedStats;
        stagedIdentities.set(candidate, clonedStats);
        let sourceAfterLink: Stats;
        try {
          sourceAfterLink = await sourceFile.stat();
        } catch (cause) {
          sourceFileState = "unknown";
          throw cause;
        }
        if (
          clonedStats.isSymbolicLink() ||
          !clonedStats.isFile() ||
          !sameFileIdentity(clonedStats, sourceAfterLink) ||
          clonedStats.size !== sourceAfterLink.size
        ) {
          sourceFileState = "unknown";
          throw new Error("The cloned staged document file changed while it was being linked.");
        }
      };

      try {
        try {
          lockLease = await acquireFinalizationLock(
            lockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
          lockOwned = true;
          finalizationLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          if (cause instanceof FinalizationLockBusyError) {
            finalizationLockState = "retained";
          } else {
            finalizationLockState = "unknown";
          }
          throw cause;
        }

        try {
          source = await openWithoutFollowingLinks(sourcePath, constants.O_RDWR, sourcePath, false);
        } catch (cause) {
          sourceFileState = isNotFound(cause) ? "absent" : "unknown";
          throw cause;
        }
        const sourceStats = await source.stat();
        const expectedSourceIdentity = stagedIdentities.get(handle);
        if (
          expectedSourceIdentity !== undefined &&
          !sameFileIdentity(expectedSourceIdentity, sourceStats)
        ) {
          sourceFileState = "unknown";
          throw new Error("The staged source file was replaced before it was cloned.");
        }
        validateSourceFileSize(sourceStats.size);
        await source.sync();
        await beforeStagedCloneLink?.(sourcePath);

        for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
          const candidate = createStagedHandle(generateBytes);
          try {
            // link() supplies no-replace allocation and preserves the immutable
            // staged bytes without reopening caller input.
            await linkClone(candidate);
            await beforeStagedCloneCleanup?.(stagingPath(candidate));
            const clonedAfterCleanupRace = await lstat(stagingPath(candidate));
            if (
              targetIdentity === undefined ||
              !sameFileIdentity(targetIdentity, clonedAfterCleanupRace)
            ) {
              throw new Error("The cloned staged document file changed before cleanup.");
            }
            const sourceAtLink = await source.stat();
            if (
              !sameFileIdentity(sourceStats, sourceAtLink) ||
              sourceAtLink.size !== sourceStats.size
            ) {
              sourceFileState = "unknown";
              throw new Error("The staged source file changed while it was being cloned.");
            }
            break;
          } catch (cause) {
            if (errorCode(cause) !== "EEXIST") {
              throw cause;
            }
          }
        }

        if (targetHandle === undefined) {
          // Keep deterministic random seams useful while retaining a system
          // random fallback for the private clone allocation.
          for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
            const candidate = createStagedHandle(cryptoRandomBytes);
            try {
              await linkClone(candidate);
              await beforeStagedCloneCleanup?.(stagingPath(candidate));
              const clonedAfterCleanupRace = await lstat(stagingPath(candidate));
              if (
                targetIdentity === undefined ||
                !sameFileIdentity(targetIdentity, clonedAfterCleanupRace)
              ) {
                throw new Error("The cloned staged document file changed before cleanup.");
              }
              const sourceAtLink = await source.stat();
              if (
                !sameFileIdentity(sourceStats, sourceAtLink) ||
                sourceAtLink.size !== sourceStats.size
              ) {
                sourceFileState = "unknown";
                throw new Error("The staged source file changed while it was being cloned.");
              }
              break;
            } catch (cause) {
              if (errorCode(cause) !== "EEXIST") {
                throw cause;
              }
            }
          }
        }
        if (targetHandle === undefined) {
          throw new Error("Could not allocate a unique cloned staged document file handle.");
        }
        await syncDirectory(stagingDir);
        await source.close();
        source = undefined;
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        await syncDirectory(stagingDir);
        return targetHandle;
      } catch (cause) {
        await source?.close().catch((closeError) => {
          cleanupCause ??= closeError;
        });
        source = undefined;
        if (targetCreated && targetHandle !== undefined) {
          try {
            if (targetIdentity === undefined) {
              throw new Error("The cloned staged file identity was unavailable for cleanup.");
            }
            const removed = await discardEntry(stagingDir, targetHandle, targetIdentity);
            stagedIdentities.delete(targetHandle);
            if (!removed) {
              clonedFileState = "absent";
            } else {
              targetCreated = false;
              clonedFileState = "absent";
              await syncDirectory(stagingDir);
            }
          } catch (targetCleanupError) {
            if (isNotFound(targetCleanupError)) {
              clonedFileState = "absent";
            } else {
              // Never unlink a path whose identity no longer matches the link
              // made by this clone. It may now belong to a replacement handle.
              clonedFileState = "unknown";
              cleanupCause ??= targetCleanupError;
            }
          }
        }
        if (lockOwned) {
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (isNotFound(lockCleanupError)) {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            } else {
              finalizationLockState = "retained";
              cleanupCause ??= lockCleanupError;
            }
          }
        }
        throw new DocumentFileCloneError({
          handle,
          ...(targetHandle === undefined ? {} : { clonedHandle: targetHandle }),
          sourceFileState,
          clonedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not clone staged document file ${handle}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const discardStagedFile = async (handleValue: StagedDocumentFileHandle) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let stagedFileState: DocumentFileResourceState = "retained";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let removed = false;
      let cleanupCause: unknown;

      try {
        // Taking the same lock as finalization makes compensation safe when a
        // caller accidentally shares a handle with another finalizer. A busy
        // lock is retained for that owner and is reported as an orphan rather
        // than guessed at or removed.
        lockLease = await acquireFinalizationLock(
          lockPath,
          now,
          beforeFinalizationLockRecoveryClaim
        );
        lockOwned = true;
        finalizationLockState = "retained";
        await syncDirectory(stagingDir);
        try {
          const expectedIdentity = stagedIdentities.get(handle);
          if (expectedIdentity === undefined) {
            try {
              await lstat(stagingPath(handle));
              throw new Error("The staged document file identity was unavailable for discard.");
            } catch (cause) {
              if (isNotFound(cause)) {
                removed = false;
                stagedFileState = "absent";
              } else {
                throw cause;
              }
            }
          } else {
            removed = await discardEntry(stagingDir, handle, expectedIdentity);
            stagedFileState = "absent";
            stagedIdentities.delete(handle);
          }
        } catch (cause) {
          if (isNotFound(cause)) {
            stagedFileState = "absent";
          } else {
            stagedFileState = "unknown";
            throw cause;
          }
        }
        if (removed) {
          await syncDirectory(stagingDir);
        }
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        await syncDirectory(stagingDir);
        return removed;
      } catch (cause) {
        if (cause instanceof FinalizationLockBusyError) {
          finalizationLockState = "retained";
        } else if (finalizationLockState === "absent") {
          finalizationLockState = "unknown";
        }
        if (lockOwned) {
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (isNotFound(lockCleanupError)) {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            } else {
              finalizationLockState = "retained";
              cleanupCause = lockCleanupError;
            }
          }
        }
        throw new DocumentFileDiscardError({
          handle,
          stagedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not discard staged document file ${handle}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  type DocumentStreamFactory = (
    file: Awaited<ReturnType<typeof open>>,
    totalSize: number
  ) => Promise<ReadStream>;

  const readDocumentLeaseWith = async (id: string, createStream: DocumentStreamFactory) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      return await withDocumentMutex(documentId, async () => {
        const path = documentPath(documentId);
        let file: Awaited<ReturnType<typeof open>> | undefined;
        let targetLease: FinalizationLockLease | undefined;
        let readReference: ReadReferenceLease | undefined;
        let stream: ReadStream | undefined;
        try {
          // The target lock closes the gap between the metadata-gated open and
          // publishing a cross-instance read reference. A peer deletion either
          // wins first (and this open fails) or observes the reference after it
          // releases the same lock.
          targetLease = await acquireTargetLock(documentId);
          await syncDirectory(stagingDir);
          file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
          ensureTrustedRoots();
          const totalSize = (await file.stat()).size;
          readReference = await createReadReference(stagingDir, documentId, now);
          await syncDirectory(stagingDir);
          stream = await createStream(file, totalSize);
          let released = false;
          const releaseRead = () => {
            if (released) {
              return;
            }
            released = true;
            if (readReference !== undefined) {
              releaseReadReference(readReference);
              readReference = undefined;
            }
          };
          await releaseTargetLock(documentId, targetLease);
          targetLease = undefined;
          return {
            stream,
            // The ordinary read API releases from stream close/error. Callers
            // that need to perform a post-transfer action can hold this lease
            // until that action is complete.
            release: releaseRead,
          } satisfies DocumentFileReadLease;
        } catch (cause) {
          if (readReference !== undefined) {
            releaseReadReference(readReference);
            readReference = undefined;
          }
          stream?.destroy();
          await file?.close().catch(() => undefined);
          if (targetLease !== undefined) {
            await removeFinalizationLockDirectory(targetLockPath(documentId), targetLease).catch(
              () => undefined
            );
          }
          if (
            cause instanceof DocumentFileNotRegularError ||
            cause instanceof DocumentFileNotBundleError ||
            cause instanceof BundleEntryNotFoundError ||
            cause instanceof InvalidBundleError
          ) {
            throw cause;
          }
          throw new DocumentFileReadError({
            id: documentId,
            cause,
            message: `Could not open document file ${documentId}: ${describe(cause)}`,
          });
        }
      });
    } finally {
      releaseOperation();
    }
  };

  const readDocumentLease = (id: string) =>
    readDocumentLeaseWith(id, async (file) => file.createReadStream({ autoClose: true }));

  const inspectDocumentFormat = async (id: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      return await withDocumentMutex(documentId, async () => {
        const path = documentPath(documentId);
        let file: Awaited<ReturnType<typeof open>> | undefined;
        let targetLease: FinalizationLockLease | undefined;
        try {
          targetLease = await acquireTargetLock(documentId);
          file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
          ensureTrustedRoots();
          const format = await readDocumentFormat(file, (await file.stat()).size);
          await releaseTargetLock(documentId, targetLease);
          targetLease = undefined;
          return format;
        } catch (cause) {
          if (targetLease !== undefined) {
            await removeFinalizationLockDirectory(targetLockPath(documentId), targetLease).catch(
              () => undefined
            );
          }
          if (cause instanceof InvalidBundleError || cause instanceof DocumentFileNotRegularError) {
            throw cause;
          }
          throw new DocumentFileReadError({
            id: documentId,
            cause,
            message: `Could not inspect document file ${documentId}: ${describe(cause)}`,
          });
        } finally {
          await file?.close().catch(() => undefined);
        }
      });
    } finally {
      releaseOperation();
    }
  };

  const readDocumentEntryLease = async (id: string, path: string) => {
    const entryPathValue = validateBundlePath(path);
    return readDocumentLeaseWith(id, async (file, totalSize) => {
      const format = await readDocumentFormat(file, totalSize);
      if (format.kind === "html") {
        throw new DocumentFileNotBundleError({
          id,
          message: `Document ${id} is a single HTML file, not a page bundle.`,
        });
      }
      const entry = findBundleEntry(format.manifest, entryPathValue);
      const start = format.manifest.dataOffset + entry.offset;
      if (entry.size === 0) {
        await file.close();
        return Readable.from([]) as unknown as ReadStream;
      }
      return file.createReadStream({ autoClose: true, start, end: start + entry.size - 1 });
    });
  };

  const readDocument = async (id: string) => {
    const lease = await readDocumentLease(id);
    lease.stream.once("close", lease.release);
    lease.stream.once("error", lease.release);
    return lease.stream;
  };

  const deleteDocumentFileUnlocked = async (
    id: string,
    expectedTarget?: DocumentFileTargetCapability,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean> = () => true,
    expectedIdentity?: DocumentFileIdentity
  ) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      const path = documentPath(documentId);
      const targetLockPath = entryPath(stagingDir, `.${documentId}.target.lock`);
      let targetLockLease: FinalizationLockLease | undefined;
      let targetLockOwned = false;
      let targetLockState: DocumentFileResourceState = "absent";
      let targetState: DocumentFileResourceState = "unknown";
      let result = false;
      let failure: unknown;

      try {
        try {
          targetLockLease = await acquireFinalizationLock(
            targetLockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
        } catch (cause) {
          targetLockState = cause instanceof FinalizationLockBusyError ? "retained" : "unknown";
          throw cause;
        }
        targetLockOwned = true;
        targetLockState = "retained";
        await syncDirectory(stagingDir);
        let stats: Stats | undefined;
        try {
          stats = await lstat(path);
        } catch (cause) {
          if (!isNotFound(cause)) {
            throw cause;
          }
          targetState = "absent";
          if (await activeReadReferenceExists(documentId)) {
            throw new DocumentFileReadActiveError({
              id: documentId,
              message: `Document ${documentId} is being read and cannot be reconciled yet.`,
            });
          }
          await shouldDelete(false);
        }
        if (stats !== undefined) {
          targetState = "retained";
          if (stats.isSymbolicLink() || !stats.isFile()) {
            throw regularFileError(path);
          }
          if (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, stats)) {
            throw new Error("The document target was replaced before identity-safe deletion.");
          }
          if (await activeReadReferenceExists(documentId)) {
            throw new DocumentFileReadActiveError({
              id: documentId,
              message: `Document ${documentId} is being read and cannot be deleted yet.`,
            });
          }
          const approved = await shouldDelete(true);
          if (approved) {
            if (expectedTarget !== undefined) {
              if (
                expectedTarget.id !== documentId ||
                !sameFileIdentity(expectedTarget.identity, stats)
              ) {
                throw new Error("The document target was replaced before identity-safe deletion.");
              }
            }
            await beforeDocumentTargetDelete?.(path);
            const targetAfterRace = await lstat(path);
            if (
              targetAfterRace.isSymbolicLink() ||
              !targetAfterRace.isFile() ||
              !sameFileIdentity(stats, targetAfterRace) ||
              (expectedTarget !== undefined &&
                !sameFileIdentity(expectedTarget.identity, targetAfterRace)) ||
              (expectedIdentity !== undefined &&
                !sameFileIdentity(expectedIdentity, targetAfterRace))
            ) {
              throw new Error("The document target was replaced before identity-safe deletion.");
            }
            const removed = await discardEntry(
              documentsDir,
              `${documentId}.html`,
              expectedTarget?.identity ?? expectedIdentity ?? stats
            );
            result = removed;
            targetState = "absent";
            if (removed) {
              await syncDirectory(documentsDir);
            }
          }
        }
      } catch (cause) {
        failure = cause;
        if (isNotFound(cause)) {
          targetState = "absent";
        } else if (targetState === "retained") {
          targetState = "unknown";
        }
      }

      if (targetLockOwned) {
        try {
          await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
          targetLockLease = undefined;
          targetLockOwned = false;
          targetLockState = "absent";
          await syncDirectory(stagingDir);
        } catch (lockCleanupCause) {
          // If removal returned but directory synchronization failed, the
          // current pathname is no longer known to contain the lock, but its
          // durable state is ambiguous. Do not report that as definitely
          // retained.
          targetLockState = targetLockOwned ? "retained" : "unknown";
          failure =
            failure === undefined
              ? lockCleanupCause
              : new AggregateError([failure, lockCleanupCause], "Document target cleanup failed.");
        }
      }

      if (failure === undefined) {
        return result;
      }
      if (isNotFound(failure) && targetLockState === "absent") {
        return result;
      }
      if (failure instanceof DocumentFileNotRegularError) {
        throw failure;
      }
      throw new DocumentFileDeleteError({
        id: documentId,
        targetState,
        targetLockState,
        cause: failure,
        message: `Could not delete document file ${documentId}: ${describe(failure)}`,
      });
    } finally {
      releaseOperation();
    }
  };

  const deleteDocumentFile = async (id: string, expectedTarget?: DocumentFileTargetCapability) => {
    const documentId = validateDocumentId(id);
    return withDocumentMutex(documentId, () =>
      deleteDocumentFileUnlocked(documentId, expectedTarget)
    );
  };

  const deleteDocumentFileIf = async (
    id: string,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean>,
    expectedIdentity?: DocumentFileIdentity
  ) => {
    const documentId = validateDocumentId(id);
    return withDocumentMutex(documentId, () =>
      deleteDocumentFileUnlocked(documentId, undefined, shouldDelete, expectedIdentity)
    );
  };

  const getDocumentFileObservation = async (id: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      let stats: Stats;
      try {
        stats = await lstat(documentPath(documentId));
      } catch (cause) {
        if (isNotFound(cause)) {
          return undefined;
        }
        throw cause;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return undefined;
      }
      return {
        id: documentId,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        identity: {
          dev: stats.dev,
          ino: stats.ino,
          birthtimeMs: stats.birthtimeMs,
        },
      } satisfies DocumentFileObservation;
    } finally {
      releaseOperation();
    }
  };

  const compareNames = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

  const documentEntryIds = async (afterId?: string, throughId?: string) => {
    onDocumentFileDirectoryEnumeration?.();
    const entries = await readdir(entryPath(documentsDir, ""));
    return entries
      .flatMap((entry) => {
        if (!entry.endsWith(".html")) {
          return [];
        }
        try {
          return [validateDocumentId(entry.slice(0, -".html".length))];
        } catch {
          return [];
        }
      })
      .filter(
        (id) =>
          (afterId === undefined || compareNames(id, afterId) > 0) &&
          (throughId === undefined || compareNames(id, throughId) <= 0)
      )
      .sort(compareNames);
  };

  type DocumentFileScanSnapshot = Readonly<{
    readonly throughId: string;
    readonly startedAt: number | undefined;
    readonly hasStartedAt: boolean;
    readonly ids: readonly string[];
  }>;
  const documentFileScanSnapshots = new WeakMap<
    DocumentFileScanWatermark,
    DocumentFileScanSnapshot
  >();

  const firstIdAfter = (ids: readonly string[], afterId: string | undefined) => {
    if (afterId === undefined) {
      return 0;
    }
    let low = 0;
    let high = ids.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (compareNames(ids[middle]!, afterId) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };

  const listDocumentFiles = async () => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const ids = await documentEntryIds();
      const files: DocumentFileObservation[] = [];
      for (const documentId of ids) {
        const observation = await getDocumentFileObservation(documentId);
        if (observation !== undefined) {
          files.push(observation);
        }
      }
      return files;
    } finally {
      releaseOperation();
    }
  };

  const listDocumentFilesPage = async (
    limit: number,
    afterId?: string,
    watermark?: DocumentFileScanWatermark
  ) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Document file page limit must be a positive safe integer.");
    }
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const cursor = afterId === undefined ? undefined : validateDocumentId(afterId);
      const suppliedStartedAt = watermark?.startedAt;
      const suppliedHasStartedAt =
        watermark === undefined ? false : Object.hasOwn(watermark, "startedAt");
      if (
        suppliedStartedAt !== undefined &&
        (!Number.isFinite(suppliedStartedAt) || suppliedStartedAt < 0)
      ) {
        throw new RangeError("Document file scan watermark must contain a valid timestamp.");
      }
      const scanWatermark =
        watermark === undefined
          ? undefined
          : {
              throughId: validateDocumentId(watermark.throughId),
              ...(suppliedStartedAt === undefined ? {} : { startedAt: suppliedStartedAt }),
            };
      const scanStartedAt =
        scanWatermark?.startedAt ??
        (scanWatermark === undefined ? await captureDocumentScanWatermark() : undefined);
      if (scanStartedAt !== undefined && (!Number.isFinite(scanStartedAt) || scanStartedAt < 0)) {
        throw new RangeError("Document file scan watermark must contain a valid timestamp.");
      }
      await beforeDocumentFilePageScan?.(scanStartedAt);

      const cachedSnapshot =
        watermark === undefined ? undefined : documentFileScanSnapshots.get(watermark);
      const cacheMatchesWatermark =
        cachedSnapshot !== undefined &&
        watermark !== undefined &&
        Object.hasOwn(watermark, "throughId") &&
        Object.hasOwn(watermark, "startedAt") === cachedSnapshot.hasStartedAt &&
        watermark.throughId === cachedSnapshot.throughId &&
        watermark.startedAt === cachedSnapshot.startedAt &&
        scanWatermark?.throughId === cachedSnapshot.throughId &&
        scanWatermark?.startedAt === cachedSnapshot.startedAt &&
        suppliedHasStartedAt === cachedSnapshot.hasStartedAt;
      if (cachedSnapshot !== undefined && !cacheMatchesWatermark && watermark !== undefined) {
        // A watermark is normally immutable by contract, but callers can still
        // mutate it at runtime. Once that is observed, discard its snapshot so
        // later restoration of the old values cannot revive a stale cache hit.
        documentFileScanSnapshots.delete(watermark);
      }

      const ids = cacheMatchesWatermark
        ? cachedSnapshot.ids
        : await documentEntryIds(cursor, scanWatermark?.throughId);
      const startIndex = cacheMatchesWatermark ? firstIdAfter(ids, cursor) : 0;
      const pageIds = ids.slice(startIndex, startIndex + limit);
      const files: DocumentFileObservation[] = [];
      for (const documentId of pageIds) {
        const observed = await getDocumentFileObservation(documentId);
        const observation =
          observed === undefined
            ? undefined
            : (documentFileScanObservation?.(observed) ?? observed);
        if (
          observation !== undefined &&
          scanStartedAt !== undefined &&
          usableBirthtime(observation.identity.birthtimeMs) &&
          observation.identity.birthtimeMs < scanStartedAt
        ) {
          files.push(observation);
        }
      }
      const nextId = pageIds.at(-1);
      const lastId = ids.at(-1);
      const pageWatermark =
        watermark ??
        (lastId === undefined
          ? undefined
          : {
              throughId: lastId,
              ...(scanStartedAt === undefined ? {} : { startedAt: scanStartedAt }),
            });
      if (watermark === undefined && pageWatermark !== undefined) {
        documentFileScanSnapshots.set(pageWatermark, {
          throughId: pageWatermark.throughId,
          startedAt: pageWatermark.startedAt,
          hasStartedAt: Object.hasOwn(pageWatermark, "startedAt"),
          ids,
        });
      }
      return {
        files,
        hasMore: ids.length - startIndex > limit,
        ...(nextId === undefined ? {} : { nextId }),
        ...(pageWatermark === undefined ? {} : { watermark: pageWatermark }),
      } satisfies DocumentFilePage;
    } finally {
      releaseOperation();
    }
  };

  const isFreshResource = async (path: string) => {
    try {
      const stats = await lstat(path);
      return (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.mtimeMs > now() - DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS
      );
    } catch (cause) {
      if (isNotFound(cause)) {
        return false;
      }
      // A non-regular or uninspectable resource is retained. It must not be
      // used as evidence that a lock is stale while a publisher may still own
      // the corresponding pathname.
      return true;
    }
  };

  const reconcileLock = async (lockPath: string, resourcePath?: string) => {
    // The directory listing is only a candidate set. Recheck the associated
    // resource immediately before stale-lock recovery so a long reconciliation
    // pass cannot remove a lock for a publisher that has just created a fresh
    // target/staged file.
    if (resourcePath !== undefined && (await isFreshResource(resourcePath))) {
      return false;
    }
    let lease: FinalizationLockLease | undefined;
    try {
      lease = await acquireFinalizationLock(lockPath, now, beforeFinalizationLockRecoveryClaim);
    } catch (cause) {
      if (cause instanceof FinalizationLockBusyError) {
        return false;
      }
      throw cause;
    }
    if (resourcePath !== undefined && (await isFreshResource(resourcePath))) {
      await removeFinalizationLockDirectory(lockPath, lease);
      await syncDirectory(stagingDir);
      return true;
    }
    await removeFinalizationLockDirectory(lockPath, lease);
    await syncDirectory(stagingDir);
    return true;
  };

  const reconcileReadReference = async (entry: string) => {
    const path = entryPath(stagingDir, entry);
    const observation = await readReadReference(path);
    if (
      observation === undefined ||
      observation.metadata.owner.host !== LOCAL_HOSTNAME ||
      isProcessAlive(observation.metadata.owner.pid)
    ) {
      // Malformed markers, foreign owners, and live local owners are retained.
      // Only a marker whose local owner is definitely dead can be reclaimed.
      return "retained";
    }
    const fresh = await readReadReference(path);
    if (
      fresh === undefined ||
      !sameFileIdentity(observation.identity, fresh.identity) ||
      fresh.metadata.owner.host !== LOCAL_HOSTNAME ||
      fresh.metadata.owner.pid !== observation.metadata.owner.pid ||
      fresh.metadata.acquiredAt !== observation.metadata.acquiredAt ||
      isProcessAlive(fresh.metadata.owner.pid)
    ) {
      return "retained";
    }
    return (await discardEntry(stagingDir, entry, fresh.identity)) ? "removed" : "absent";
  };

  const reconcileDocumentFilesUnbounded = async () => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const entries = await readdir(entryPath(stagingDir, ""));
      let stagedFilesRemoved = 0;
      let readReferencesRemoved = 0;
      let finalizationLocksRemoved = 0;
      let retainedEntries = 0;
      const handledLocks = new Set<string>();
      for (const entry of entries) {
        if (isValidStagedHandle(entry)) {
          continue;
        }
        if (readReferenceEntry(entry) !== undefined) {
          continue;
        }
        if (finalizationLockEntry(entry) !== undefined) {
          continue;
        }
        retainedEntries += 1;
      }

      let removedReadReference = false;
      for (const entry of entries) {
        if (readReferenceEntry(entry) === undefined) {
          continue;
        }
        try {
          const result = await reconcileReadReference(entry);
          if (result === "retained") {
            retainedEntries += 1;
          } else if (result === "removed") {
            readReferencesRemoved += 1;
            removedReadReference = true;
          }
        } catch {
          retainedEntries += 1;
        }
      }
      if (removedReadReference) {
        await syncDirectory(stagingDir);
      }

      for (const entry of entries) {
        if (!isValidStagedHandle(entry)) {
          continue;
        }
        const path = stagingPath(entry);
        const lockPath = entryPath(stagingDir, `.${entry}.lock`);
        let lockExisted = false;
        try {
          await lstat(lockPath);
          lockExisted = true;
        } catch (cause) {
          if (!isNotFound(cause)) {
            retainedEntries += 1;
            continue;
          }
        }
        let stagedStats: Stats | undefined;
        try {
          const stats = await lstat(path);
          if (stats.isFile() && !stats.isSymbolicLink()) {
            stagedStats = stats;
            stagedIdentities.set(entry, stats);
          }
        } catch (cause) {
          if (!isNotFound(cause)) {
            retainedEntries += 1;
          }
        }
        if (stagedStats !== undefined && (await isFreshResource(path))) {
          retainedEntries += 1;
          continue;
        }
        try {
          const removed = await discardStagedFile(entry);
          if (removed) {
            stagedFilesRemoved += 1;
          }
          handledLocks.add(`.${entry}.lock`);
          if (
            lockExisted &&
            (await lstat(lockPath).catch((cause) => (isNotFound(cause) ? undefined : cause))) ===
              undefined
          ) {
            finalizationLocksRemoved += 1;
          }
        } catch {
          retainedEntries += 1;
        }
      }

      for (const entry of entries) {
        const lock = finalizationLockEntry(entry);
        if (lock === undefined || handledLocks.has(entry)) {
          continue;
        }
        const lockPath = entryPath(stagingDir, entry);
        try {
          if (lock.kind === "staged") {
            const stagedPath = stagingPath(lock.id);
            if (await isFreshResource(stagedPath)) {
              retainedEntries += 1;
            } else {
              const removed = await discardStagedFile(lock.id);
              if (removed) {
                stagedFilesRemoved += 1;
              }
              if (
                (await lstat(lockPath).catch((cause) =>
                  isNotFound(cause) ? undefined : cause
                )) === undefined
              ) {
                finalizationLocksRemoved += 1;
              }
            }
          } else if (await reconcileLock(lockPath, documentPath(lock.id))) {
            finalizationLocksRemoved += 1;
          } else {
            retainedEntries += 1;
          }
          handledLocks.add(entry);
        } catch {
          retainedEntries += 1;
        }
      }

      return {
        stagedFilesRemoved,
        readReferencesRemoved,
        finalizationLocksRemoved,
        retainedEntries,
        processedItems: entries.length,
        resumable: false,
      } satisfies DocumentFileReconciliationResult;
    } finally {
      releaseOperation();
    }
  };

  const reconcileDocumentFiles = async (budget?: DocumentFileReconciliationBudget) => {
    if (budget === undefined) {
      return reconcileDocumentFilesUnbounded();
    }
    if (!Number.isSafeInteger(budget.maxItems) || budget.maxItems < 1) {
      throw new RangeError("Document reconciliation item budget must be a positive safe integer.");
    }
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const listed = (await readdir(entryPath(stagingDir, ""))).sort(compareNames);
      const watermark = budget.cursor?.watermark ?? listed.at(-1);
      if (watermark === undefined) {
        return {
          stagedFilesRemoved: 0,
          readReferencesRemoved: 0,
          finalizationLocksRemoved: 0,
          retainedEntries: 0,
          processedItems: 0,
          resumable: false,
        } satisfies DocumentFileReconciliationResult;
      }
      const entries = listed.filter(
        (entry) =>
          compareNames(entry, watermark) <= 0 &&
          (budget.cursor?.afterName === undefined ||
            compareNames(entry, budget.cursor.afterName) > 0)
      );
      let stagedFilesRemoved = 0;
      let readReferencesRemoved = 0;
      let finalizationLocksRemoved = 0;
      let retainedEntries = 0;
      let processedItems = 0;
      let afterName = budget.cursor?.afterName;

      for (const entry of entries) {
        if (processedItems >= budget.maxItems || budget.shouldContinue?.() === false) {
          return {
            stagedFilesRemoved,
            readReferencesRemoved,
            finalizationLocksRemoved,
            retainedEntries,
            processedItems,
            resumable: true,
            cursor: { watermark, ...(afterName === undefined ? {} : { afterName }) },
          } satisfies DocumentFileReconciliationResult;
        }
        processedItems += 1;
        afterName = entry;
        try {
          if (readReferenceEntry(entry) !== undefined) {
            const result = await reconcileReadReference(entry);
            if (result === "retained") {
              retainedEntries += 1;
            } else if (result === "removed") {
              readReferencesRemoved += 1;
              await syncDirectory(stagingDir);
            }
            continue;
          }

          if (isValidStagedHandle(entry)) {
            const path = stagingPath(entry);
            try {
              const stagedStats = await lstat(path);
              if (stagedStats.isFile() && !stagedStats.isSymbolicLink()) {
                stagedIdentities.set(entry, stagedStats);
              }
            } catch (cause) {
              if (!isNotFound(cause)) {
                throw cause;
              }
            }
            if (await isFreshResource(path)) {
              retainedEntries += 1;
              continue;
            }
            const lockPath = entryPath(stagingDir, `.${entry}.lock`);
            const lockExisted = await lstat(lockPath).then(
              () => true,
              (cause) => {
                if (isNotFound(cause)) {
                  return false;
                }
                throw cause;
              }
            );
            if (await discardStagedFile(entry)) {
              stagedFilesRemoved += 1;
            }
            if (
              lockExisted &&
              (await lstat(lockPath).catch((cause) => (isNotFound(cause) ? undefined : cause))) ===
                undefined
            ) {
              finalizationLocksRemoved += 1;
            }
            continue;
          }

          const lock = finalizationLockEntry(entry);
          if (lock !== undefined) {
            const lockPath = entryPath(stagingDir, entry);
            if (lock.kind === "staged") {
              const stagedPath = stagingPath(lock.id);
              try {
                const stagedStats = await lstat(stagedPath);
                if (stagedStats.isFile() && !stagedStats.isSymbolicLink()) {
                  stagedIdentities.set(lock.id, stagedStats);
                }
              } catch (cause) {
                if (!isNotFound(cause)) {
                  throw cause;
                }
              }
              if (await isFreshResource(stagedPath)) {
                retainedEntries += 1;
                continue;
              }
              const removed = await discardStagedFile(lock.id);
              if (removed) {
                stagedFilesRemoved += 1;
              }
              if (
                (await lstat(lockPath).catch((cause) =>
                  isNotFound(cause) ? undefined : cause
                )) === undefined
              ) {
                finalizationLocksRemoved += 1;
              }
              continue;
            }
            try {
              const removed = await reconcileLock(lockPath, documentPath(lock.id));
              if (removed) {
                finalizationLocksRemoved += 1;
              } else {
                retainedEntries += 1;
              }
              continue;
            } catch (cause) {
              if (isNotFound(cause)) {
                continue;
              }
              throw cause;
            }
          }
          retainedEntries += 1;
        } catch {
          retainedEntries += 1;
        }
      }

      return {
        stagedFilesRemoved,
        readReferencesRemoved,
        finalizationLocksRemoved,
        retainedEntries,
        processedItems,
        resumable: false,
      } satisfies DocumentFileReconciliationResult;
    } finally {
      releaseOperation();
    }
  };

  return {
    close,
    stageSourceFile,
    finalizeStagedFile,
    readDocument,
    readDocumentFile: readDocument,
    deleteDocumentFile,
    deleteDocumentFileIf,
    getDocumentFileObservation,
    listDocumentFiles,
    listDocumentFilesPage,
    reconcileDocumentFiles,
    cloneStagedFile,
    discardStagedFile,
    readDocumentLease,
    inspectDocumentFormat,
    readDocumentEntryLease,
  };
};

const initializeStore = (options: DocumentFileStoreOptions): DocumentFileStore => {
  const documentsPath = validateDirectoryPath(options.documentsDir, "documentsDir");
  const stagingPathValue = validateDirectoryPath(options.stagingDir, "stagingDir");
  if (samePath(documentsPath, stagingPathValue)) {
    throw new DocumentFileStorePathError({
      path: documentsPath,
      reason: "documentsDir and stagingDir must be different directories.",
      message:
        "Could not initialize document file storage: documentsDir and stagingDir must differ.",
    });
  }

  let documentsDir: TrustedDirectory | undefined;
  let stagingDir: TrustedDirectory | undefined;
  try {
    makePrivateDirectory(documentsPath);
    documentsDir = openTrustedDirectory(documentsPath);
    makePrivateDirectory(stagingPathValue);
    stagingDir = openTrustedDirectory(stagingPathValue);
    if (sameFileIdentity(documentsDir.identity, stagingDir.identity)) {
      throw new DocumentFileStorePathError({
        path: stagingPathValue,
        reason: "documentsDir and stagingDir must not resolve to the same physical directory.",
        message:
          "Could not initialize document file storage: documentsDir and stagingDir must differ physically.",
      });
    }
    return createStore({
      documentsDir,
      stagingDir,
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.beforeFinalizationLockRecoveryClaim === undefined
        ? {}
        : { beforeFinalizationLockRecoveryClaim: options.beforeFinalizationLockRecoveryClaim }),
      ...(options.beforeStagedCloneLink === undefined
        ? {}
        : { beforeStagedCloneLink: options.beforeStagedCloneLink }),
      ...(options.beforeStagedCloneCleanup === undefined
        ? {}
        : { beforeStagedCloneCleanup: options.beforeStagedCloneCleanup }),
      ...(options.beforeStagedSourceCopy === undefined
        ? {}
        : { beforeStagedSourceCopy: options.beforeStagedSourceCopy }),
      ...(options.afterStagedSourceCopy === undefined
        ? {}
        : { afterStagedSourceCopy: options.afterStagedSourceCopy }),
      ...(options.beforeStagedSourceCleanup === undefined
        ? {}
        : { beforeStagedSourceCleanup: options.beforeStagedSourceCleanup }),
      ...(options.beforeFinalizationTargetLink === undefined
        ? {}
        : { beforeFinalizationTargetLink: options.beforeFinalizationTargetLink }),
      ...(options.beforeFinalizationTargetInspection === undefined
        ? {}
        : { beforeFinalizationTargetInspection: options.beforeFinalizationTargetInspection }),
      ...(options.beforeFinalizationTargetCleanup === undefined
        ? {}
        : { beforeFinalizationTargetCleanup: options.beforeFinalizationTargetCleanup }),
      ...(options.beforePostPublicationStagingDirectorySync === undefined
        ? {}
        : {
            beforePostPublicationStagingDirectorySync:
              options.beforePostPublicationStagingDirectorySync,
          }),
      ...(options.beforeDocumentTargetDelete === undefined
        ? {}
        : { beforeDocumentTargetDelete: options.beforeDocumentTargetDelete }),
      ...(options.beforeDocumentFilePageScan === undefined
        ? {}
        : { beforeDocumentFilePageScan: options.beforeDocumentFilePageScan }),
      ...(options.documentFileScanStartedAt === undefined
        ? {}
        : { documentFileScanStartedAt: options.documentFileScanStartedAt }),
      ...(options.documentFileScanObservation === undefined
        ? {}
        : { documentFileScanObservation: options.documentFileScanObservation }),
      ...(options.onDocumentFileDirectoryEnumeration === undefined
        ? {}
        : { onDocumentFileDirectoryEnumeration: options.onDocumentFileDirectoryEnumeration }),
      ...(options.beforeDocumentFileScanMarkerCleanup === undefined
        ? {}
        : { beforeDocumentFileScanMarkerCleanup: options.beforeDocumentFileScanMarkerCleanup }),
    });
  } catch (cause) {
    if (documentsDir !== undefined) {
      closeTrustedDirectory(documentsDir);
    }
    if (stagingDir !== undefined) {
      closeTrustedDirectory(stagingDir);
    }
    throw cause;
  }
};

export const openDocumentFileStore = (options: DocumentFileStoreOptions) =>
  Effect.try({
    try: () => initializeStore(options),
    catch: (cause) =>
      isFileStoreError(cause)
        ? cause
        : new DocumentFileStoreOpenError({
            path:
              typeof options?.documentsDir === "string" ? options.documentsDir : String(options),
            cause,
            message: `Could not initialize document file storage: ${describe(cause)}`,
          }),
  });

/** Acquires the document file store and closes it with the surrounding Effect scope. */
export const openDocumentFileStoreScoped = (options: DocumentFileStoreOptions) =>
  Effect.acquireRelease(openDocumentFileStore(options), (store) =>
    Effect.promise(() => store.close())
  );

export { isValidStagedHandle };
