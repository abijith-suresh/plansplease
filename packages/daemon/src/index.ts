import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  isValidProfileName,
  V1_CLEANUP_INTERVAL_HOURS,
  V1_MAX_HTML_SIZE_BYTES,
  validateDocumentId,
} from "@planview/core";
import {
  createSnapshotManagement,
  validateSnapshotListOptions,
  validateSnapshotSelection,
  type SnapshotListOptions,
  type SnapshotSelection,
  createDocumentCleanupCoordinator,
  createDocumentPublicationCoordinator,
  type DocumentCleanupFailure,
  type DocumentCleanupResult,
  openDocumentFileStoreScoped,
  openStorageScoped,
} from "@planview/storage";
import { Data, Effect, Exit, Scope } from "effect";
import { createDocumentReadAdmission } from "./document-read-admission.js";
import {
  DAEMON_DESCRIPTOR_NAME,
  DAEMON_HOST,
  DAEMON_LOCK_NAME,
  DAEMON_PORT,
  DaemonPathError,
  isContainedPath,
  LIFECYCLE_TOKEN_ENV,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  resolveDaemonEnvironment,
  resolveDaemonPaths,
  TEST_ADOPTION_PAUSE_ENV,
  TEST_CLEANUP_PAUSE_ENV,
  type DaemonConfig,
  type DaemonConfigOptions,
  type DaemonPathOptions,
  type DaemonPaths,
  type DaemonTestConfigOptions,
} from "./configuration.js";
import { createDaemonHttpServer, type DaemonHttpServer } from "./http-server.js";
import {
  createDaemonHttpRequestHandler,
  DAEMON_CLEAN_PATH,
  DAEMON_INVENTORY_PATH,
  DAEMON_USAGE_PATH,
  DAEMON_DELETE_PATH,
  DAEMON_PIN_PATH,
  DAEMON_UNPIN_PATH,
  DAEMON_MANAGER_PATH,
  DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS,
  DAEMON_DOCUMENT_READ_MAX_DURATION_MS,
  DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS,
  DAEMON_MAX_ACTIVE_DOCUMENT_READS,
  DAEMON_MAX_QUEUED_DOCUMENT_READS,
  DAEMON_PUBLISH_PATH,
  DAEMON_READY_PATH,
  DAEMON_SECRET_HEADER,
  DAEMON_SHUTDOWN_PATH,
  DAEMON_STARTUP_ACK_PATH,
  DAEMON_STATUS_PATH,
  writeDaemonHttpResponse,
  type DaemonStatusPayload,
} from "./http-routes.js";
import {
  pinFromPayload,
  inventoryFromPayload,
  usageFromPayload,
  deletionFromPayload,
} from "./snapshot-response.js";
import { parseShareInspection, parseSharePrepared } from "./sharing-response.js";
import { parseShareAttempt, type SharePrepare } from "@planview/storage";
import { DAEMON_SHARE_PATH } from "./http-routes.js";
import { createDaemonSharing } from "./sharing.js";
import { createDaemonApplication } from "./application.js";
import { openManager, type ManagerServer, type ManagerLaunch } from "./manager.js";
import { createOperationGate } from "./operation-gate.js";

export {
  DAEMON_CLEAN_PATH,
  DAEMON_INVENTORY_PATH,
  DAEMON_USAGE_PATH,
  DAEMON_DELETE_PATH,
  DAEMON_PIN_PATH,
  DAEMON_UNPIN_PATH,
  DAEMON_MANAGER_PATH,
  DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS,
  DAEMON_DOCUMENT_READ_MAX_DURATION_MS,
  DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS,
  DAEMON_MAX_ACTIVE_DOCUMENT_READS,
  DAEMON_MAX_QUEUED_DOCUMENT_READS,
  DAEMON_PUBLISH_PATH,
  DAEMON_READY_PATH,
  DAEMON_SECRET_HEADER,
  DAEMON_SHUTDOWN_PATH,
  DAEMON_STATUS_PATH,
};
export type { DaemonStatusPayload };

export {
  DAEMON_DESCRIPTOR_NAME,
  DAEMON_HOST,
  DAEMON_LOCK_NAME,
  DAEMON_PORT,
  DaemonPathError,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  resolveDaemonEnvironment,
  resolveDaemonPaths,
};
export type {
  DaemonConfig,
  DaemonConfigOptions,
  DaemonPathOptions,
  DaemonPaths,
  DaemonTestConfigOptions,
};

export const DAEMON_PORT_FALLBACK_ATTEMPTS = 50;
export const DAEMON_STARTUP_LEASE_MS = 30_000;
export const DAEMON_STARTUP_GRACE_MS = 5_000;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
/** In-flight mutations get a short drain window before shutdown cancellation. */
export const DAEMON_SHUTDOWN_OPERATION_GRACE_MS = 4_000;
export const DAEMON_DESCRIPTOR_VERSION = 1;
export const DAEMON_CLEANUP_INTERVAL_MS = V1_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;
const DAEMON_LOCK_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REQUEST_TIMEOUT_MS = 1_000;
export const DAEMON_CLEANUP_TIMEOUT_MIN_MS = 10_000;
export const DAEMON_CLEANUP_TIMEOUT_MAX_MS = 60_000;
// Publication is a synchronous request: the 201 response is sent only after
// the immutable file and metadata row have both committed. Give the largest
// allowed source a bounded timeout based on a conservative copy rate rather
// than letting the general lifecycle timeout make the result ambiguous.
export const DAEMON_PUBLISH_TIMEOUT_MIN_MS = 5_000;
export const DAEMON_PUBLISH_TIMEOUT_MAX_MS = 60_000;
const PUBLISH_COPY_RATE_BYTES_PER_SECOND = 1024 * 1024;
const STARTUP_TIMEOUT_MS = DAEMON_CLEANUP_TIMEOUT_MAX_MS;
// A shutdown deadline is enforced by the daemon process. This margin lets a
// lifecycle caller observe descriptor removal when the event loop is delayed.
const SHUTDOWN_POLL_GRACE_MS = 2_000;
// Leave a small, explicit window for forced socket closure before the process
// fallback. Both timers use the same absolute shutdown deadline below.
const SHUTDOWN_FORCE_CLOSE_MARGIN_MS = 250;
// Lifecycle calls can legitimately queue behind a slow shutdown/startup. Keep
// lock acquisition bounded, but long enough for the concurrent lifecycle
// stress and for several operations to pass through the same lock.
const LIFECYCLE_LOCK_WAIT_MS = 60_000;
const STARTUP_POLL_MS = 50;
const LOCAL_HOSTNAME = hostname();
const isTestProcess = () => {
  const { NODE_ENV } = process.env;
  return NODE_ENV === "test";
};

export type RuntimeDescriptor = Readonly<{
  readonly version: typeof DAEMON_DESCRIPTOR_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly profile?: string;
  readonly secret: string;
  readonly startedAt: number;
}>;

type LockDescriptor = Readonly<{
  readonly version: typeof DAEMON_LOCK_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}>;

type FileObservation = Readonly<{
  readonly stats: Stats;
  readonly contents: string;
}>;

type LockObservation = Readonly<{
  readonly stats: Stats;
  readonly observation: FileObservation | undefined;
  readonly protected: boolean;
}>;

export class DaemonStartupBusyError extends Data.TaggedError("DaemonStartupBusyError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class DaemonPortInUseError extends Data.TaggedError("DaemonPortInUseError")<{
  readonly host: string;
  readonly port: number;
  readonly message: string;
}> {}

export class DaemonDescriptorError extends Data.TaggedError("DaemonDescriptorError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class DaemonDescriptorEndpointMismatchError extends Data.TaggedError(
  "DaemonDescriptorEndpointMismatchError"
)<{
  readonly path: string;
  readonly descriptorHost: string;
  readonly descriptorPort: number;
  readonly configHost: string;
  readonly configPort: number;
  readonly message: string;
}> {}

export class DaemonDescriptorProfileMismatchError extends Data.TaggedError(
  "DaemonDescriptorProfileMismatchError"
)<{
  readonly path: string;
  readonly descriptorProfile: string | undefined;
  readonly configProfile: string;
  readonly message: string;
}> {}

export class DaemonRequestError extends Data.TaggedError("DaemonRequestError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DaemonError =
  | DaemonPathError
  | DaemonStartupBusyError
  | DaemonPortInUseError
  | DaemonDescriptorError
  | DaemonDescriptorEndpointMismatchError
  | DaemonDescriptorProfileMismatchError
  | DaemonRequestError;

export type DaemonState =
  | Readonly<{ readonly state: "stopped" }>
  | Readonly<{
      readonly state: "running";
      readonly descriptor: RuntimeDescriptor;
      readonly status: DaemonStatusPayload;
    }>;

export type PublishedDaemonDocument = Readonly<{
  readonly id: import("@planview/core").DocumentId;
  readonly descriptor: RuntimeDescriptor;
  readonly reused: boolean;
}>;

export type CleanedDaemonDocuments = Readonly<{
  readonly descriptor: RuntimeDescriptor;
  readonly reused: boolean;
  readonly result: DocumentCleanupResult;
}>;

export type RetrieveDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly documentId: import("@planview/core").DocumentId;
  readonly onChunk: (chunk: Uint8Array) => void | Promise<void>;
}>;

type DaemonResponse = Readonly<{
  readonly statusCode: number;
  readonly body: string;
}>;

const publishRequestTimeout = (sourceSizeBytes: number | undefined) => {
  const size =
    typeof sourceSizeBytes === "number" && Number.isSafeInteger(sourceSizeBytes)
      ? Math.min(Math.max(sourceSizeBytes, 0), V1_MAX_HTML_SIZE_BYTES)
      : V1_MAX_HTML_SIZE_BYTES;
  const copyMilliseconds = Math.ceil((size / PUBLISH_COPY_RATE_BYTES_PER_SECOND) * 1_000);
  return Math.min(
    DAEMON_PUBLISH_TIMEOUT_MAX_MS,
    Math.max(DAEMON_PUBLISH_TIMEOUT_MIN_MS, DAEMON_PUBLISH_TIMEOUT_MIN_MS + copyMilliseconds)
  );
};

type LifecycleLock = Readonly<{
  readonly token: string;
  readonly release: () => Promise<void>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const isAlreadyExists = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";

const isOwnedByCurrentUser = (stats: Stats) =>
  process.platform === "win32" ||
  process.getuid?.() === undefined ||
  stats.uid === process.getuid?.();

const isPrivateFileStats = (stats: Stats) =>
  stats.isFile() &&
  (process.platform === "win32" || (isOwnedByCurrentUser(stats) && (stats.mode & 0o077) === 0));

const ensurePrivateDirectory = async (path: string) => {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const directory = await lstat(path);
    if (directory.isSymbolicLink()) {
      throw new DaemonPathError({
        path,
        message: "The daemon path must not be a symbolic link.",
      });
    }
    if (!directory.isDirectory()) {
      throw new DaemonPathError({
        path,
        message: "The daemon path exists but is not a directory.",
      });
    }
    if (process.platform !== "win32") {
      if (!isOwnedByCurrentUser(directory)) {
        throw new DaemonPathError({
          path,
          message: "The daemon path must be owned by the current user.",
        });
      }
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      const privateDirectory = await lstat(path);
      if (!isOwnedByCurrentUser(privateDirectory) || (privateDirectory.mode & 0o077) !== 0) {
        throw new DaemonPathError({
          path,
          message: "The daemon path must be owned by the current user and private.",
        });
      }
    }
  } catch (cause) {
    if (cause instanceof DaemonPathError) {
      throw cause;
    }
    throw new DaemonPathError({
      path,
      cause,
      message: `Could not prepare the daemon directory: ${describe(cause)}`,
    });
  }
};

const ensureRuntimeContained = async (paths: DaemonPaths) => {
  try {
    const [appDataRealPath, runtimeRealPath] = await Promise.all([
      realpath(paths.appDataDir),
      realpath(paths.runtimeDir),
    ]);
    if (!isContainedPath(appDataRealPath, runtimeRealPath)) {
      throw new DaemonPathError({
        path: paths.runtimeDir,
        message: "The Planview runtime directory must remain contained below app-data.",
      });
    }
  } catch (cause) {
    if (cause instanceof DaemonPathError) {
      throw cause;
    }
    throw new DaemonPathError({
      path: paths.runtimeDir,
      cause,
      message: `Could not verify app-data containment: ${describe(cause)}`,
    });
  }
};

const readObservation = async (
  path: string,
  maxBytes: number
): Promise<FileObservation | undefined> => {
  let fileStats: Stats;
  try {
    fileStats = await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
  if (!isPrivateFileStats(fileStats)) {
    return undefined;
  }
  const file = await open(
    path,
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    if (!isSameFileIdentity(fileStats, await file.stat())) {
      return undefined;
    }
    const contents = await file.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      return undefined;
    }
    return { stats: fileStats, contents };
  } finally {
    await file.close();
  }
};

const parseJson = (contents: string) => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordValue = (record: Record<string, unknown>, key: string) => record[key];

const isValidDescriptor = (value: unknown): value is RuntimeDescriptor => {
  if (!isRecord(value)) {
    return false;
  }
  const profile = recordValue(value, "profile");
  return (
    recordValue(value, "version") === DAEMON_DESCRIPTOR_VERSION &&
    typeof recordValue(value, "pid") === "number" &&
    Number.isSafeInteger(recordValue(value, "pid")) &&
    (recordValue(value, "pid") as number) > 0 &&
    typeof recordValue(value, "host") === "string" &&
    (recordValue(value, "host") as string).length > 0 &&
    (profile === undefined || (typeof profile === "string" && isValidProfileName(profile))) &&
    typeof recordValue(value, "port") === "number" &&
    Number.isInteger(recordValue(value, "port")) &&
    (recordValue(value, "port") as number) >= 1 &&
    (recordValue(value, "port") as number) <= 65_535 &&
    typeof recordValue(value, "secret") === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(recordValue(value, "secret") as string) &&
    typeof recordValue(value, "startedAt") === "number" &&
    Number.isSafeInteger(recordValue(value, "startedAt")) &&
    (recordValue(value, "startedAt") as number) >= 0
  );
};

const isValidLock = (value: unknown): value is LockDescriptor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    recordValue(value, "version") === DAEMON_LOCK_VERSION &&
    typeof recordValue(value, "pid") === "number" &&
    Number.isSafeInteger(recordValue(value, "pid")) &&
    (recordValue(value, "pid") as number) > 0 &&
    typeof recordValue(value, "host") === "string" &&
    (recordValue(value, "host") as string).length > 0 &&
    typeof recordValue(value, "token") === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(recordValue(value, "token") as string) &&
    typeof recordValue(value, "acquiredAt") === "number" &&
    Number.isSafeInteger(recordValue(value, "acquiredAt")) &&
    (recordValue(value, "acquiredAt") as number) >= 0
  );
};

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

const isSameFileIdentity = (left: Stats, right: Stats) =>
  left.dev === right.dev && left.ino === right.ino;

const isSameFileSnapshot = (left: Stats, right: Stats) =>
  isSameFileIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;

const removeIfSameFileSnapshot = async (path: string, observation: FileObservation) => {
  try {
    const current = await lstat(path);
    if (isSameFileSnapshot(observation.stats, current)) {
      await unlink(path);
    }
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
};

const readDescriptorObservation = async (paths: DaemonPaths) => {
  let stats: Stats;
  try {
    stats = await lstat(paths.descriptorPath);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not inspect the daemon descriptor: ${describe(cause)}`,
    });
  }

  if (!isPrivateFileStats(stats)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor exists but is not a private regular file.",
    });
  }

  try {
    const observation = await readObservation(paths.descriptorPath, 16 * 1024);
    if (observation !== undefined) {
      return observation;
    }

    // A valid descriptor can disappear between lstat and open during a normal
    // shutdown. Recheck before classifying an existing file as corrupt.
    try {
      await lstat(paths.descriptorPath);
    } catch (cause) {
      if (isNotFound(cause)) {
        return undefined;
      }
      throw cause;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor exists but is not a private regular file.",
    });
  } catch (cause) {
    if (cause instanceof DaemonDescriptorError) {
      throw cause;
    }
    if (isNotFound(cause)) {
      return undefined;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not read the daemon descriptor securely: ${describe(cause)}`,
    });
  }
};

export const readDaemonDescriptor = async (paths: DaemonPaths) => {
  const observation = await readDescriptorObservation(paths);
  if (observation === undefined) {
    return undefined;
  }
  const parsed = parseJson(observation.contents);
  if (!isValidDescriptor(parsed)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor is malformed.",
    });
  }
  return parsed;
};

const readDescriptorForStartup = async (paths: DaemonPaths) => {
  const observation = await readDescriptorObservation(paths);
  if (observation === undefined) {
    return undefined;
  }
  const parsed = parseJson(observation.contents);
  if (!isValidDescriptor(parsed)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The existing daemon descriptor is malformed; refusing to replace it.",
    });
  }
  return parsed;
};

const removeDeadDescriptor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  if (processIsAlive(descriptor.pid)) {
    return false;
  }
  const observation = await readObservation(paths.descriptorPath, 16 * 1024);
  if (observation !== undefined && isValidDescriptor(parseJson(observation.contents))) {
    await removeIfSameFileSnapshot(paths.descriptorPath, observation);
  }
  return true;
};

const inspectLock = async (lockPath: string) => {
  try {
    const stats = await lstat(lockPath);
    if (!isPrivateFileStats(stats)) {
      return { stats, observation: undefined, protected: false };
    }
    // lstat and readObservation are separate operations. A contender can
    // remove a recovered lock in between them; ENOENT means that lock is gone,
    // not that a malformed lock should be retained until the deadline.
    const observation = await readObservation(lockPath, 16 * 1024);
    if (observation === undefined) {
      return undefined;
    }
    return { stats, observation, protected: true };
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
};

const isPastLockLease = (timestamp: number) =>
  Number.isFinite(timestamp) &&
  timestamp <= Date.now() - DAEMON_STARTUP_LEASE_MS - DAEMON_STARTUP_GRACE_MS;

const isRecoverableLock = (observation: LockObservation, existing: unknown) => {
  if (isValidLock(existing)) {
    // A valid local owner is authoritative while its PID is alive. A dead
    // owner still gets the conservative lease window so a delegated daemon
    // can take ownership if its starting CLI disappears.
    return (
      existing.host === LOCAL_HOSTNAME &&
      !processIsAlive(existing.pid) &&
      isPastLockLease(existing.acquiredAt)
    );
  }
  return observation.protected && isPastLockLease(observation.stats.mtimeMs);
};

const releaseLock = (lockPath: string, token: string) => async () => {
  let observation: FileObservation | undefined;
  try {
    observation = await readObservation(lockPath, 16 * 1024);
  } catch (cause) {
    if (isNotFound(cause)) {
      return;
    }
    throw cause;
  }
  if (observation === undefined) {
    return;
  }
  const existing = parseJson(observation.contents);
  if (isValidLock(existing) && existing.token === token) {
    await removeIfSameFileSnapshot(lockPath, observation);
  }
};

const createLock = async (
  paths: DaemonPaths,
  deadline = Date.now() + LIFECYCLE_LOCK_WAIT_MS,
  lockPath = paths.lockPath
) => {
  const token = randomBytes(32).toString("base64url");
  const descriptor = {
    version: DAEMON_LOCK_VERSION,
    pid: process.pid,
    host: LOCAL_HOSTNAME,
    token,
    acquiredAt: Date.now(),
  } satisfies LockDescriptor;

  while (true) {
    let file: FileHandle | undefined;
    try {
      file = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE
      );
      await file.writeFile(JSON.stringify(descriptor), "utf8");
      await file.sync();
      await file.close();
      return {
        token,
        // The token identity makes this cleanup safe after adoption: once the
        // daemon transfers the lock, this token no longer matches and the
        // starter cannot unlink the daemon's lock.
        release: releaseLock(lockPath, token),
      } satisfies LifecycleLock;
    } catch (cause) {
      const createdLock = file !== undefined;
      await file?.close().catch(() => undefined);
      if (!isAlreadyExists(cause)) {
        if (createdLock) {
          await unlink(lockPath).catch(() => undefined);
        }
        throw new DaemonStartupBusyError({
          path: lockPath,
          message: `Could not acquire the daemon lifecycle lock: ${describe(cause)}`,
        });
      }

      const inspected = await inspectLock(lockPath);
      if (inspected === undefined) {
        continue;
      }
      const observation = inspected.observation;
      const existing = observation === undefined ? undefined : parseJson(observation.contents);
      // A well-formed lock is recovered through owner liveness plus its
      // conservative lease. Never use age to evict a live PID; doing so can
      // let two lifecycle operations run concurrently when the first one is
      // paused in startup or shutdown.
      if (observation !== undefined && isRecoverableLock(inspected, existing)) {
        await removeIfSameFileSnapshot(lockPath, observation);
        continue;
      }
      if (Date.now() < deadline) {
        await wait(STARTUP_POLL_MS);
        continue;
      }
      throw new DaemonStartupBusyError({
        path: lockPath,
        message:
          "Another Planview lifecycle operation is in progress, or its lock is malformed and has not exceeded the conservative lease.",
      });
    }
  }
};

/** Transfers the lifecycle lock only while its identity and token still match. */
const adoptLock = async (paths: DaemonPaths, token: string) => {
  const inspected = await inspectLock(paths.lockPath);
  const observation = inspected?.observation;
  const existing = observation === undefined ? undefined : parseJson(observation.contents);
  if (!inspected?.protected || observation === undefined || !isValidLock(existing)) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: "The daemon could not adopt its lifecycle lock from the starting CLI.",
    });
  }
  if (existing.token !== token) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: "The daemon lifecycle lock belongs to another operation.",
    });
  }

  // Transfer ownership instead of sharing the starter's token. This makes a
  // late starter cleanup harmless even if it races the daemon's adoption.
  const adoptedToken = randomBytes(32).toString("base64url");
  const adopted = {
    ...existing,
    pid: process.pid,
    token: adoptedToken,
    acquiredAt: Date.now(),
  } satisfies LockDescriptor;
  let file: FileHandle | undefined;
  try {
    file = await open(
      paths.lockPath,
      constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
    const currentStats = await file.stat();
    if (!isSameFileIdentity(observation.stats, currentStats)) {
      throw new Error("The daemon lifecycle lock was replaced during adoption.");
    }
    const current = parseJson(await file.readFile({ encoding: "utf8" }));
    if (!isValidLock(current) || current.token !== token) {
      throw new Error("The daemon lifecycle lock changed during adoption.");
    }
    await file.truncate(0);
    await file.write(JSON.stringify(adopted), 0, "utf8");
    await file.sync();
  } catch (cause) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: `The daemon could not adopt its lifecycle lock: ${describe(cause)}`,
    });
  } finally {
    await file?.close().catch(() => undefined);
  }

  // The daemon owns the transferred token until it has published a usable
  // descriptor. It then releases the lock itself, so the starter can disappear
  // at any point after adoption without stranding lifecycle operations.
  return {
    token: adoptedToken,
    release: releaseLock(paths.lockPath, adoptedToken),
  } satisfies LifecycleLock;
};

const writeProtectedDescriptor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  const temporaryPath = join(
    dirname(paths.descriptorPath),
    `.${DAEMON_DESCRIPTOR_NAME}.${randomBytes(16).toString("hex")}.tmp`
  );
  await writeFile(temporaryPath, JSON.stringify(descriptor), {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  try {
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, paths.descriptorPath);
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not publish the protected daemon descriptor: ${describe(cause)}`,
    });
  }
};

const removeDescriptorFor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  const observation = await readObservation(paths.descriptorPath, 16 * 1024);
  if (observation === undefined) {
    return;
  }
  const current = parseJson(observation.contents);
  if (
    isValidDescriptor(current) &&
    current.pid === descriptor.pid &&
    current.secret === descriptor.secret
  ) {
    await removeIfSameFileSnapshot(paths.descriptorPath, observation);
  }
};

const portInUseMessage = (config: Pick<DaemonConfig, "host" | "port" | "strictPort">) =>
  config.strictPort
    ? `Port ${config.port} on ${config.host} is occupied by an unknown process; Planview will not stop it.`
    : `No available port was found on ${config.host} from ${config.port} through ${Math.min(65_535, config.port + DAEMON_PORT_FALLBACK_ATTEMPTS)}.`;

const openDaemon = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  await ensurePrivateDirectory(paths.appDataDir);
  await ensurePrivateDirectory(paths.runtimeDir);
  await ensureRuntimeContained(paths);

  const delegatedToken = process.env[LIFECYCLE_TOKEN_ENV];
  let acknowledgeStartup = () => {};
  const startupAcknowledgement =
    delegatedToken === undefined
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => {
          acknowledgeStartup = resolvePromise;
        });
  const lock =
    delegatedToken === undefined ? await createLock(paths) : await adoptLock(paths, delegatedToken);
  if (delegatedToken !== undefined && isTestProcess()) {
    const pauseMilliseconds = Number(process.env[TEST_ADOPTION_PAUSE_ENV]);
    if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
      await wait(pauseMilliseconds);
    }
  }
  let httpServer: DaemonHttpServer | undefined;
  let managerServer: ManagerServer | undefined;
  let descriptor: RuntimeDescriptor | undefined;
  let storageScope: Scope.Closeable | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupDrain: Promise<void> | undefined;
  let startupReady = false;
  let shutdownInitiated = false;
  let shutdownRequested = false;
  let resolveShutdown: (() => void) | undefined;
  let stopAccepting = () => {};
  let forceCloseConnections = () => {};
  let abortRequests = () => {};
  let waitForRequests = () => Promise.resolve();
  let shutdownDeadline: number | undefined;
  let shutdownAbortTimer: NodeJS.Timeout | undefined;
  let shutdownForceCloseTimer: NodeJS.Timeout | undefined;
  let shutdownForceTimer: NodeJS.Timeout | undefined;
  let shutdownCompleted = false;
  const documentReadAdmission = createDocumentReadAdmission({
    maxActiveReads: DAEMON_MAX_ACTIVE_DOCUMENT_READS,
    maxQueuedReads: DAEMON_MAX_QUEUED_DOCUMENT_READS,
    queueTimeoutMs: DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS,
  });
  const operationGate = createOperationGate();
  const terminateUncooperativeProcess = () => {
    try {
      // The descriptor remains in place until this process is dead. A later
      // lifecycle operation can then prove the PID is gone before replacement.
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  };
  const beginShutdown = () => {
    if (shutdownInitiated) {
      return;
    }
    shutdownInitiated = true;
    shutdownDeadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
    documentReadAdmission.close();
    operationGate.close();
    stopAccepting();
    managerServer?.revoke();
    shutdownAbortTimer = setTimeout(() => {
      operationGate.abortActive();
      abortRequests();
    }, DAEMON_SHUTDOWN_OPERATION_GRACE_MS);
    shutdownAbortTimer.unref();
    const forceCloseDelay = Math.max(
      0,
      DAEMON_SHUTDOWN_TIMEOUT_MS - SHUTDOWN_FORCE_CLOSE_MARGIN_MS
    );
    shutdownForceCloseTimer = setTimeout(() => {
      forceCloseConnections();
    }, forceCloseDelay);
    shutdownForceCloseTimer.unref();
    shutdownForceTimer = setTimeout(() => {
      if (!shutdownCompleted) {
        // The forced socket close has already run. If work or storage still
        // has not reached its safe boundary, retain the hard process bound.
        terminateUncooperativeProcess();
      }
    }, DAEMON_SHUTDOWN_TIMEOUT_MS);
    shutdownForceTimer.unref();
    resolveShutdown?.();
  };
  const requestShutdown = () => {
    shutdownRequested = true;
    beginShutdown();
  };
  try {
    // Sequential finalization is LIFO, closing the file store before SQLite.
    const openedStorageScope = Effect.runSync(Scope.make("sequential"));
    storageScope = openedStorageScope;
    const openedMetadataStore = Effect.runSync(
      Scope.provide(openedStorageScope)(
        openStorageScoped(join(config.appDataDir, "metadata.sqlite"))
      )
    );
    const openedDocumentFileStore = Effect.runSync(
      Scope.provide(openedStorageScope)(
        openDocumentFileStoreScoped({
          documentsDir: join(config.appDataDir, "documents"),
          stagingDir: join(config.appDataDir, "staging"),
        })
      )
    );
    const publicationCoordinator = createDocumentPublicationCoordinator({
      documentFileStore: openedDocumentFileStore,
      metadataStore: openedMetadataStore,
    });
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore: openedDocumentFileStore,
      metadataStore: openedMetadataStore,
      ...(isTestProcess()
        ? {
            beforeDocumentCleanup: async (_id: string, signal?: AbortSignal) => {
              const pauseMilliseconds = Number(process.env[TEST_CLEANUP_PAUSE_ENV]);
              if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
                await wait(pauseMilliseconds, signal);
              }
            },
          }
        : {}),
    });
    const runCleanupSlice = (requestSignal?: AbortSignal) => {
      // Manual and scheduled cleanup share the same mutation gate. Reads do
      // not enter it, so a client that stops consuming a response cannot delay
      // cleanup.
      return operationGate(
        (signal) => Effect.runPromise(cleanup.clean(signal), { signal: requestSignal }),
        requestSignal
      );
    };
    const scheduleCleanupDrain = () => {
      if (cleanupDrain !== undefined || shutdownInitiated) {
        return;
      }
      const drain = (async () => {
        while (!shutdownInitiated) {
          const result = await runCleanupSlice();
          if (!result.resumable) {
            return;
          }
          // Every slice is bounded; yielding here prevents automatic cleanup
          // from monopolizing the daemon's event loop while a large store is
          // being drained.
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      })();
      cleanupDrain = drain;
      void drain.then(
        () => {
          if (cleanupDrain === drain) {
            cleanupDrain = undefined;
          }
        },
        () => {
          if (cleanupDrain === drain) {
            cleanupDrain = undefined;
          }
        }
      );
    };
    const runCleanup = (requestSignal?: AbortSignal) => {
      const operation = runCleanupSlice(requestSignal);
      return operation.then((result) => {
        if (result.resumable && !shutdownInitiated) {
          scheduleCleanupDrain();
        }
        return result;
      });
    };
    const snapshots = createSnapshotManagement({
      metadataStore: openedMetadataStore,
      documentFileStore: openedDocumentFileStore,
    });
    const application = createDaemonApplication({
      publication: publicationCoordinator,
      snapshots,
      operationGate,
    });
    const sharing = createDaemonSharing({
      metadataStore: openedMetadataStore,
      publication: publicationCoordinator,
      operationGate,
      origin: () => `http://${runtimeDescriptor.host}:${runtimeDescriptor.port}`,
    });
    const launchManager = (requestSignal?: AbortSignal) =>
      operationGate(async (signal) => {
        signal.throwIfAborted();
        if (managerServer === undefined) {
          managerServer = await openManager({
            application,
            profile: config.profile,
            appDataDir: config.appDataDir,
            previewOrigin: `http://127.0.0.1:${runtimeDescriptor.port}`,
            requestShutdown,
            isShuttingDown: () => shutdownInitiated,
          });
          if (signal.aborted || shutdownInitiated) {
            const cancelledManager = managerServer;
            // A cancelled caller must not leave a closed listener cached for
            // the next launch. Clear ownership even if closing fails.
            managerServer = undefined;
            cancelledManager.revoke();
            cancelledManager.stopAccepting();
            await cancelledManager.close();
            throw new Error("Daemon stopped during manager startup.");
          }
        }
        return managerServer.launch();
      }, requestSignal);
    const runtimeDescriptor = {
      version: DAEMON_DESCRIPTOR_VERSION as typeof DAEMON_DESCRIPTOR_VERSION,
      pid: process.pid,
      host: config.host,
      port: config.port,
      profile: config.profile,
      secret: randomBytes(32).toString("base64url"),
      startedAt: Date.now(),
    };
    descriptor = runtimeDescriptor;
    const daemonHttpServer = createDaemonHttpServer(
      createDaemonHttpRequestHandler({
        descriptor: runtimeDescriptor,
        requestShutdown,
        publicationCoordinator,
        metadataStore: openedMetadataStore,
        runCleanup,
        application,
        sharing,
        launchManager,
        isReady: () => startupReady,
        documentReadAdmission,
        acknowledgeStartup,
        isTestProcess,
        wait,
      }),
      (res, cause) => {
        if (!res.headersSent) {
          writeDaemonHttpResponse(res, 500, JSON.stringify({ error: "internal_error" }));
        } else {
          res.destroy(cause instanceof Error ? cause : undefined);
        }
      }
    );
    httpServer = daemonHttpServer;
    stopAccepting = () => {
      daemonHttpServer.stopAccepting();
      managerServer?.stopAccepting();
    };
    forceCloseConnections = () => {
      daemonHttpServer.forceClose();
      managerServer?.forceClose();
    };
    abortRequests = () => {
      daemonHttpServer.abortRequests();
      managerServer?.abortRequests();
    };
    waitForRequests = async () => {
      await Promise.all([daemonHttpServer.waitForRequests(), managerServer?.waitForRequests()]);
    };
    const actualPort = await daemonHttpServer.listen(
      config.host,
      config.port,
      config.strictPort,
      DAEMON_PORT_FALLBACK_ATTEMPTS
    );
    runtimeDescriptor.port = actualPort;
    if (httpServer === undefined || descriptor === undefined) {
      throw new Error("The daemon listener was not initialized.");
    }
    // Publish the endpoint while startup cleanup is in progress, but keep
    // readiness false. Callers can distinguish a live, bounded reconciliation
    // from a dead child instead of waiting on an invisible process.
    await writeProtectedDescriptor(paths, descriptor);
    await runCleanup();
    if (shutdownInitiated) {
      throw new Error("The daemon shutdown began during startup.");
    }
    startupReady = true;
    await requestReady(descriptor);
    cleanupTimer = setInterval(() => {
      void runCleanup().catch(() => undefined);
    }, DAEMON_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    // A detached starter must observe readiness before another lifecycle
    // operation can stop this child. If the starter crashes, the bounded
    // fallback releases the lock without stranding future operations.
    await Promise.race([startupAcknowledgement, wait(DAEMON_STARTUP_GRACE_MS)]);
    await lock.release();
    const runningHttpServer = httpServer;
    const runningDescriptor = descriptor;
    return {
      server: runningHttpServer.server,
      descriptor: runningDescriptor,
      paths,
      close: (() => {
        let closePromise: Promise<void> | undefined;
        return () => {
          if (closePromise !== undefined) {
            return closePromise;
          }
          closePromise = (async () => {
            beginShutdown();
            resolveShutdown = undefined;
            if (cleanupTimer !== undefined) {
              clearInterval(cleanupTimer);
              cleanupTimer = undefined;
            }

            const deadline = shutdownDeadline ?? Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
            const settleBeforeDeadline = async (promise: Promise<unknown>) => {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                return false;
              }
              let timer: NodeJS.Timeout | undefined;
              try {
                return await Promise.race([
                  promise.then(
                    () => true,
                    () => false
                  ),
                  new Promise<boolean>((resolvePromise) => {
                    timer = setTimeout(() => resolvePromise(false), remaining);
                  }),
                ]);
              } finally {
                if (timer !== undefined) {
                  clearTimeout(timer);
                }
              }
            };

            const serverClose = Promise.all([runningHttpServer.close(), managerServer?.close()]);
            const workSettled = await settleBeforeDeadline(
              Promise.all([operationGate.waitForIdle(), waitForRequests()])
            );
            if (!workSettled) {
              operationGate.abortActive();
              abortRequests();
              // A native or third-party operation that ignores cancellation
              // may still mutate storage. Killing the process is the only safe
              // boundary; removing the descriptor would permit a replacement
              // daemon to run concurrently with that mutation.
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }
            if (shutdownAbortTimer !== undefined) {
              clearTimeout(shutdownAbortTimer);
              shutdownAbortTimer = undefined;
            }

            const storageSettled = await settleBeforeDeadline(
              storageScope === undefined
                ? Promise.resolve()
                : Effect.runPromise(Scope.close(storageScope, Exit.void))
            );
            if (!storageSettled) {
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }

            const serverSettled = await settleBeforeDeadline(serverClose);
            if (!serverSettled) {
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }
            // Descriptor removal is the final lifecycle action. At this point
            // no request, mutation, storage close, or listener can still run.
            await removeDescriptorFor(paths, runningDescriptor);
            shutdownCompleted = true;
            if (shutdownForceCloseTimer !== undefined) {
              clearTimeout(shutdownForceCloseTimer);
              shutdownForceCloseTimer = undefined;
            }
            if (shutdownForceTimer !== undefined) {
              clearTimeout(shutdownForceTimer);
              shutdownForceTimer = undefined;
            }
          })();
          return closePromise;
        };
      })(),
      waitForShutdown: () => {
        if (shutdownRequested) {
          return Promise.resolve();
        }
        return new Promise<void>((resolvePromise) => {
          const onSignal = () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            resolvePromise();
          };
          process.once("SIGINT", onSignal);
          process.once("SIGTERM", onSignal);
          resolveShutdown = () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            resolvePromise();
          };
        });
      },
    };
  } catch (cause) {
    if (shutdownAbortTimer !== undefined) {
      clearTimeout(shutdownAbortTimer);
      shutdownAbortTimer = undefined;
    }
    if (shutdownForceCloseTimer !== undefined) {
      clearTimeout(shutdownForceCloseTimer);
      shutdownForceCloseTimer = undefined;
    }
    if (shutdownForceTimer !== undefined) {
      clearTimeout(shutdownForceTimer);
      shutdownForceTimer = undefined;
    }
    documentReadAdmission.close();
    await lock.release().catch(() => undefined);
    if (managerServer !== undefined) {
      managerServer.revoke();
      managerServer.forceClose();
      await managerServer.close().catch(() => undefined);
    }
    if (httpServer !== undefined) {
      await httpServer.close().catch(() => undefined);
    }
    if (storageScope !== undefined) {
      await Effect.runPromise(Scope.close(storageScope, Exit.void)).catch(() => undefined);
    }
    if (descriptor !== undefined) {
      await removeDescriptorFor(paths, descriptor).catch(() => undefined);
    }
    if (isAddressInUse(cause)) {
      throw new DaemonPortInUseError({
        host: config.host,
        port: config.port,
        message: portInUseMessage(config),
      });
    }
    throw cause;
  }
};

const isAddressInUse = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE";

const request = (
  descriptor: RuntimeDescriptor,
  method: string,
  path: string,
  body?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
  maxResponseBytes = Number.MAX_SAFE_INTEGER
) =>
  new Promise<DaemonResponse>((resolvePromise, rejectPromise) => {
    let responseObject: import("node:http").IncomingMessage | undefined;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const resolve = (value: DaemonResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const reject = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(cause);
    };
    const requestObject = httpRequest(
      {
        host: descriptor.host,
        port: descriptor.port,
        method,
        path,
        headers: {
          [DAEMON_SECRET_HEADER]: descriptor.secret,
          Authorization: `Bearer ${descriptor.secret}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        responseObject = res;
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            const cause = new Error("The daemon metadata response exceeded its byte limit.");
            res.destroy(cause);
            reject(cause);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );
    requestObject.on("timeout", () =>
      requestObject.destroy(new Error("The daemon request timed out."))
    );
    requestObject.on("error", reject);
    const onAbort = () => {
      const cause = signal?.reason ?? new Error("The daemon request was canceled.");
      const error = cause instanceof Error ? cause : new Error(String(cause));
      responseObject?.destroy(error);
      requestObject.destroy(error);
      reject(cause);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (body === undefined) {
      requestObject.end();
    } else {
      requestObject.end(body);
    }
  });

const assertDescriptorEndpoint = (
  config: DaemonConfig,
  descriptor: Readonly<{ readonly host: string; readonly port: number }>,
  path: string
) => {
  if (descriptor.host === config.host && (!config.strictPort || descriptor.port === config.port)) {
    return;
  }
  throw new DaemonDescriptorEndpointMismatchError({
    path,
    descriptorHost: descriptor.host,
    descriptorPort: descriptor.port,
    configHost: config.host,
    configPort: config.port,
    message: `The daemon descriptor points to ${descriptor.host}:${descriptor.port}, but the configured daemon endpoint is ${config.host}:${config.port}.`,
  });
};

const assertDescriptorProfile = (
  config: DaemonConfig,
  descriptor: Pick<RuntimeDescriptor, "profile">,
  path: string
) => {
  if (descriptor.profile === undefined && config.profile === DEFAULT_PROFILE_NAME) {
    return;
  }
  if (descriptor.profile === config.profile) {
    return;
  }
  throw new DaemonDescriptorProfileMismatchError({
    path,
    descriptorProfile: descriptor.profile,
    configProfile: config.profile,
    message: `The daemon descriptor belongs to profile ${descriptor.profile ?? DEFAULT_PROFILE_NAME}, but the configured profile is ${config.profile}.`,
  });
};

const parseResponse = <Value>(answer: DaemonResponse, path: string, statusCode: number) => {
  if (answer.statusCode !== statusCode) {
    let detail: string | undefined;
    try {
      const errorPayload = parseJson(answer.body);
      const errorMessage = isRecord(errorPayload)
        ? recordValue(errorPayload, "message")
        : undefined;
      if (typeof errorMessage === "string") {
        detail = errorMessage;
      }
    } catch {
      // Preserve the status diagnostic when the daemon returned non-JSON data.
    }
    throw new DaemonRequestError({
      path,
      cause: answer.body,
      message: `The daemon returned HTTP ${answer.statusCode} for ${path}.${detail === undefined ? "" : ` ${detail}`}`,
    });
  }
  const parsed = parseJson(answer.body);
  if (!isRecord(parsed)) {
    throw new DaemonRequestError({
      path,
      cause: answer.body,
      message: `The daemon returned invalid JSON for ${path}.`,
    });
  }
  return parsed as Value;
};

const streamDocument = (
  descriptor: RuntimeDescriptor,
  documentId: import("@planview/core").DocumentId,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal
) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let responseObject: import("node:http").IncomingMessage | undefined;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const abort = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      responseObject?.destroy(error);
      requestObject.destroy(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise();
    };
    const fail = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      abort(cause);
      rejectPromise(cause);
    };

    const requestObject = httpRequest(
      {
        host: descriptor.host,
        port: descriptor.port,
        method: "GET",
        path: `/${documentId}`,
        headers: {
          [DAEMON_SECRET_HEADER]: descriptor.secret,
          Authorization: `Bearer ${descriptor.secret}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        responseObject = res;
        // Once headers arrive, stdout backpressure is the request's normal
        // flow-control mechanism. Do not turn a slow consumer into a timeout.
        requestObject.setTimeout(0);
        const consume = async () => {
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            for await (const chunk of res) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const body = Buffer.concat(chunks).toString("utf8");
            throw new DaemonRequestError({
              path: `/${documentId}`,
              cause: body,
              message:
                res.statusCode === 404
                  ? `The Planview document ${documentId} was not found.`
                  : `The daemon returned HTTP ${res.statusCode ?? 0} for /${documentId}.`,
            });
          }

          for await (const chunk of res) {
            signal?.throwIfAborted();
            await onChunk(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
        };

        void consume().then(succeed, fail);
      }
    );
    requestObject.on("timeout", () => fail(new Error("The daemon request timed out.")));
    requestObject.on("error", fail);
    const onAbort = () =>
      fail(signal?.reason ?? new Error("The daemon document read was canceled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    requestObject.end();
  });

const requestStatus = async (descriptor: RuntimeDescriptor, signal?: AbortSignal) => {
  const answer = await request(descriptor, "GET", DAEMON_STATUS_PATH, undefined, undefined, signal);
  return parseResponse<DaemonStatusPayload>(answer, DAEMON_STATUS_PATH, 200);
};

const requestReady = async (descriptor: RuntimeDescriptor, signal?: AbortSignal) => {
  const answer = await request(descriptor, "GET", DAEMON_READY_PATH, undefined, undefined, signal);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_READY_PATH, 200);
};

const acknowledgeDaemonStartup = async (descriptor: RuntimeDescriptor, signal?: AbortSignal) => {
  const answer = await request(
    descriptor,
    "POST",
    DAEMON_STARTUP_ACK_PATH,
    undefined,
    undefined,
    signal
  );
  return parseResponse<Record<string, unknown>>(answer, DAEMON_STARTUP_ACK_PATH, 202);
};

const requestClean = async (
  descriptor: RuntimeDescriptor,
  timeoutMs: number,
  signal?: AbortSignal
) => {
  const answer = await request(descriptor, "POST", DAEMON_CLEAN_PATH, undefined, timeoutMs, signal);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_CLEAN_PATH, 200);
};

const wait = (milliseconds: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const inspectDaemonPromise = async (
  config: DaemonConfig,
  signal?: AbortSignal
): Promise<DaemonState> => {
  const paths = resolveDaemonPaths(config);
  const descriptor = await readDaemonDescriptor(paths);
  if (descriptor === undefined) {
    return { state: "stopped" };
  }
  assertDescriptorProfile(config, descriptor, paths.descriptorPath);
  assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
  try {
    const status = await requestStatus(descriptor, signal);
    assertDescriptorEndpoint(config, status, DAEMON_STATUS_PATH);
    return { state: "running", descriptor, status };
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof DaemonDescriptorEndpointMismatchError) {
      throw cause;
    }
    if (!processIsAlive(descriptor.pid)) {
      await removeDeadDescriptor(paths, descriptor);
      return { state: "stopped" };
    }
    throw new DaemonRequestError({
      path: DAEMON_STATUS_PATH,
      cause,
      message: `The daemon descriptor belongs to a live process but its private status endpoint is unavailable: ${describe(cause)}`,
    });
  }
};

const waitForReady = async (
  config: DaemonConfig,
  timeoutMs = STARTUP_TIMEOUT_MS,
  child?: import("node:child_process").ChildProcess,
  signal?: AbortSignal
) => {
  const paths = resolveDaemonPaths(config);
  const deadline = Date.now() + timeoutMs;
  let readinessObserved = false;
  let startupFailure: DaemonError | undefined;
  let childDiagnostics = "";
  let rejectChildFailure: ((error: DaemonError) => void) | undefined;
  const childFailure =
    child === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          rejectChildFailure = reject;
        });
  const failForChild = (cause: unknown) => {
    if (readinessObserved || startupFailure !== undefined) {
      return;
    }
    const diagnostics = childDiagnostics.trim();
    const detailedCause =
      diagnostics.length === 0
        ? cause
        : new Error(`${describe(cause)}\nDaemon stderr: ${diagnostics}`);
    startupFailure = diagnostics.includes(portInUseMessage(config))
      ? new DaemonPortInUseError({
          host: config.host,
          port: config.port,
          message: portInUseMessage(config),
        })
      : new DaemonRequestError({
          path: DAEMON_READY_PATH,
          cause: detailedCause,
          message: `The detached Planview daemon failed before readiness: ${describe(detailedCause)}`,
        });
    rejectChildFailure?.(startupFailure);
  };
  const onChildStderr = (chunk: string | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    childDiagnostics = `${childDiagnostics}${text}`.slice(-8 * 1024);
  };
  const onChildError = (cause: Error) => failForChild(cause);
  const onChildClose = (code: number | null, signal: NodeJS.Signals | null) =>
    failForChild(
      new Error(
        signal === null
          ? `The detached daemon exited with code ${code ?? 0}.`
          : `The detached daemon exited after signal ${signal}.`
      )
    );
  const raceWithChild = <Value>(operation: Promise<Value>) => {
    if (childFailure === undefined) {
      return operation;
    }
    return Promise.race([operation, childFailure]);
  };

  child?.once("error", onChildError);
  child?.once("close", onChildClose);
  child?.stderr?.setEncoding("utf8");
  child?.stderr?.on("data", onChildStderr);
  if (
    child !== undefined &&
    (child.exitCode !== null || child.signalCode !== null) &&
    child.stderr?.readableEnded === true
  ) {
    onChildClose(child.exitCode, child.signalCode);
  }
  const onAbort = () => {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  try {
    signal?.throwIfAborted();
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const descriptor = await raceWithChild(readDaemonDescriptor(paths));
      if (descriptor !== undefined) {
        assertDescriptorProfile(config, descriptor, paths.descriptorPath);
        assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
        try {
          const ready = await raceWithChild(requestReady(descriptor, signal));
          const readyHost = isRecord(ready) ? recordValue(ready, "host") : undefined;
          const readyPort = isRecord(ready) ? recordValue(ready, "port") : undefined;
          if (typeof readyHost !== "string" || typeof readyPort !== "number") {
            throw new DaemonRequestError({
              path: DAEMON_READY_PATH,
              cause: ready,
              message: `The daemon returned an invalid endpoint for ${DAEMON_READY_PATH}.`,
            });
          }
          assertDescriptorEndpoint(config, { host: readyHost, port: readyPort }, DAEMON_READY_PATH);
          await raceWithChild(acknowledgeDaemonStartup(descriptor, signal));
          readinessObserved = true;
          return { state: "running", descriptor, reused: false };
        } catch (cause) {
          if (startupFailure !== undefined) {
            throw startupFailure;
          }
          if (cause instanceof DaemonDescriptorEndpointMismatchError) {
            throw cause;
          }
          // The listener can be accepting connections a few milliseconds before
          // the readiness response is observable. Keep polling within the bound.
        }
      }
      // A descriptor may disappear after this child becomes ready when a
      // concurrent lifecycle operation immediately performs its own restart.
      // Continue to the bounded deadline and observe the next descriptor rather
      // than misclassifying that normal handoff as this startup's failure. Do not
      // probe the port here: an in-flight startup owns it and a second probe must
      // never classify it as an unknown process.
      await raceWithChild(wait(STARTUP_POLL_MS, signal));
    }
  } finally {
    child?.off("error", onChildError);
    child?.off("close", onChildClose);
    child?.stderr?.off("data", onChildStderr);
    child?.stderr?.destroy();
    signal?.removeEventListener("abort", onAbort);
  }
  throw new DaemonRequestError({
    path: DAEMON_READY_PATH,
    cause: new Error("startup timeout"),
    message: "The Planview daemon did not become ready before the startup timeout.",
  });
};

export type StartDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
}>;

const prepareLifecyclePaths = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  await ensurePrivateDirectory(paths.appDataDir);
  await ensurePrivateDirectory(paths.runtimeDir);
  await ensureRuntimeContained(paths);
  return paths;
};

const startWithLock = async (
  config: DaemonConfig,
  options: StartDaemonOptions,
  paths: DaemonPaths,
  lock: LifecycleLock,
  startupTimeoutMs: number,
  signal?: AbortSignal
) => {
  const current = await inspectDaemonPromise(config, signal);
  if (current.state === "running") {
    return { ...current, reused: true };
  }

  const startupDescriptor = await readDescriptorForStartup(paths);
  if (startupDescriptor !== undefined) {
    assertDescriptorProfile(config, startupDescriptor, paths.descriptorPath);
    assertDescriptorEndpoint(config, startupDescriptor, paths.descriptorPath);
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [options.daemonScriptPath], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    env: resolveDaemonEnvironment(config, lock.token),
  });
  child.unref();
  return waitForReady(config, startupTimeoutMs, child, signal);
};

const startDetachedDaemonPromise = async (
  config: DaemonConfig,
  options: StartDaemonOptions,
  signal?: AbortSignal
) => {
  const paths = await prepareLifecyclePaths(config);
  const startupTimeoutMs = DAEMON_CLEANUP_TIMEOUT_MAX_MS;
  const lock = await createLock(paths);
  try {
    return await startWithLock(config, options, paths, lock, startupTimeoutMs, signal);
  } finally {
    await lock.release();
  }
};

export type PublishDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly sourcePath: string;
  /** The validated source size lets the client budget for the bounded copy. */
  readonly sourceSizeBytes?: number;
}>;

const cleanupResultFromPayload = (payload: Record<string, unknown>) => {
  const invalidResult = (): never => {
    throw new DaemonRequestError({
      path: DAEMON_CLEAN_PATH,
      cause: payload,
      message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
    });
  };
  const numberValue = (field: Exclude<keyof DocumentCleanupResult, "resumable" | "failures">) => {
    const value = recordValue(payload, field);
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return invalidResult();
    }
    return value;
  };
  const counts = {
    now: numberValue("now"),
    cutoff: numberValue("cutoff"),
    removedDocuments: numberValue("removedDocuments"),
    removedDocumentFiles: numberValue("removedDocumentFiles"),
    removedMetadataRows: numberValue("removedMetadataRows"),
    removedStagedFiles: numberValue("removedStagedFiles"),
    removedReadReferences: numberValue("removedReadReferences"),
    removedFinalizationLocks: numberValue("removedFinalizationLocks"),
    reclaimedBytes: numberValue("reclaimedBytes"),
    retainedEntries: numberValue("retainedEntries"),
    processedItems: numberValue("processedItems"),
  };
  const rawFailures = recordValue(payload, "failures");
  if (!Array.isArray(rawFailures)) {
    return invalidResult();
  }
  const failures = rawFailures.map((failure): DocumentCleanupFailure => {
    if (!isRecord(failure)) {
      return invalidResult();
    }
    const { phase, id, message, cause } = failure;
    if (phase !== "staging" && phase !== "metadata" && phase !== "document-file") {
      return invalidResult();
    }
    if ((id !== undefined && typeof id !== "string") || typeof message !== "string") {
      return invalidResult();
    }
    return { phase, ...(id === undefined ? {} : { id }), cause, message };
  });
  const resumable = recordValue(payload, "resumable");
  if (typeof resumable !== "boolean") {
    return invalidResult();
  }
  return { ...counts, resumable, failures } satisfies DocumentCleanupResult;
};

const publishDocumentPromise = async (
  config: DaemonConfig,
  options: PublishDaemonOptions,
  signal?: AbortSignal
) => {
  const running = await startDetachedDaemonPromise(
    config,
    {
      daemonScriptPath: options.daemonScriptPath,
    },
    signal
  );
  const answer = await request(
    running.descriptor,
    "POST",
    DAEMON_PUBLISH_PATH,
    JSON.stringify({ sourcePath: options.sourcePath }),
    publishRequestTimeout(options.sourceSizeBytes),
    signal
  );
  const payload = parseResponse<Record<string, unknown>>(answer, DAEMON_PUBLISH_PATH, 201);
  try {
    const id = validateDocumentId(recordValue(payload, "id"));
    return { id, descriptor: running.descriptor, reused: running.reused };
  } catch (cause) {
    throw new DaemonRequestError({
      path: DAEMON_PUBLISH_PATH,
      cause,
      message: `The daemon returned an invalid published document id for ${DAEMON_PUBLISH_PATH}.`,
    });
  }
};

const cleanDaemonPromise = async (
  config: DaemonConfig,
  options: StartDaemonOptions,
  signal?: AbortSignal
) => {
  const running = await startDetachedDaemonPromise(config, options, signal);
  const payload = await requestClean(running.descriptor, DAEMON_CLEANUP_TIMEOUT_MAX_MS, signal);
  return {
    descriptor: running.descriptor,
    reused: running.reused,
    result: cleanupResultFromPayload(payload),
  } satisfies CleanedDaemonDocuments;
};

const retrieveDocumentPromise = async (
  config: DaemonConfig,
  options: RetrieveDaemonOptions,
  signal?: AbortSignal
) => {
  const documentId = validateDocumentId(options.documentId);
  const running = await startDetachedDaemonPromise(
    config,
    {
      daemonScriptPath: options.daemonScriptPath,
    },
    signal
  );
  await streamDocument(running.descriptor, documentId, options.onChunk, signal);
  return { descriptor: running.descriptor, reused: running.reused };
};

const stopWithLock = async (config: DaemonConfig, signal?: AbortSignal) => {
  const current = await inspectDaemonPromise(config, signal);
  if (current.state === "stopped") {
    return current;
  }
  const paths = resolveDaemonPaths(config);
  const answer = await request(
    current.descriptor,
    "POST",
    DAEMON_SHUTDOWN_PATH,
    undefined,
    undefined,
    signal
  );
  parseResponse<Record<string, unknown>>(answer, DAEMON_SHUTDOWN_PATH, 202);
  const deadline =
    Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS + REQUEST_TIMEOUT_MS + SHUTDOWN_POLL_GRACE_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const descriptor = await readDaemonDescriptor(paths);
    if (descriptor !== undefined) {
      assertDescriptorProfile(config, descriptor, paths.descriptorPath);
      assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
    }
    if (descriptor === undefined || !processIsAlive(descriptor.pid)) {
      if (descriptor !== undefined) {
        await removeDeadDescriptor(paths, descriptor);
      }
      return { state: "stopped" } as const;
    }
    await wait(STARTUP_POLL_MS, signal);
  }
  throw new DaemonRequestError({
    path: DAEMON_SHUTDOWN_PATH,
    cause: new Error("shutdown timeout"),
    message: "The Planview daemon did not shut down before the shutdown timeout.",
  });
};

const stopDaemonPromise = async (config: DaemonConfig, signal?: AbortSignal) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths);
  try {
    return await stopWithLock(config, signal);
  } finally {
    await lock.release();
  }
};

const restartDaemonPromise = async (
  config: DaemonConfig,
  options: StartDaemonOptions,
  signal?: AbortSignal
) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths);
  try {
    await stopWithLock(config, signal);
    return await startWithLock(config, options, paths, lock, DAEMON_CLEANUP_TIMEOUT_MAX_MS, signal);
  } finally {
    await lock.release();
  }
};

const isDaemonError = (cause: unknown): cause is DaemonError =>
  cause instanceof DaemonPathError ||
  cause instanceof DaemonStartupBusyError ||
  cause instanceof DaemonPortInUseError ||
  cause instanceof DaemonDescriptorError ||
  cause instanceof DaemonDescriptorEndpointMismatchError ||
  cause instanceof DaemonDescriptorProfileMismatchError ||
  cause instanceof DaemonRequestError;

const daemonFailure = (path: string, cause: unknown): DaemonError =>
  isDaemonError(cause)
    ? cause
    : new DaemonRequestError({
        path,
        cause,
        message: `The Planview daemon operation at ${path} failed: ${describe(cause)}`,
      });

const daemonLifecycle = (config: DaemonConfig) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openDaemon(config),
      catch: (cause) => daemonFailure(DAEMON_READY_PATH, cause),
    }),
    (resource) =>
      Effect.tryPromise({
        try: () => resource.waitForShutdown(),
        catch: (cause) => daemonFailure(DAEMON_SHUTDOWN_PATH, cause),
      }),
    (resource) =>
      Effect.tryPromise({
        try: () => resource.close(),
        catch: (cause) => daemonFailure(DAEMON_SHUTDOWN_PATH, cause),
      })
  );

export const runDaemon = (config: DaemonConfig = resolveDaemonConfig()) => daemonLifecycle(config);

const daemonEffect = <Value>(path: string, operation: (signal: AbortSignal) => Promise<Value>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => daemonFailure(path, cause),
  });

export const inspectDaemon = (config: DaemonConfig) =>
  daemonEffect(DAEMON_STATUS_PATH, (signal) => inspectDaemonPromise(config, signal));

export const startDetachedDaemon = (config: DaemonConfig, options: StartDaemonOptions) =>
  daemonEffect(DAEMON_READY_PATH, (signal) => startDetachedDaemonPromise(config, options, signal));

export const publishDocument = (config: DaemonConfig, options: PublishDaemonOptions) =>
  daemonEffect(DAEMON_PUBLISH_PATH, (signal) => publishDocumentPromise(config, options, signal));

export const cleanDaemon = (config: DaemonConfig, options: StartDaemonOptions) =>
  daemonEffect(DAEMON_CLEAN_PATH, (signal) => cleanDaemonPromise(config, options, signal));

export const retrieveDocument = (config: DaemonConfig, options: RetrieveDaemonOptions) =>
  daemonEffect(`/${options.documentId}`, (signal) =>
    retrieveDocumentPromise(config, options, signal)
  );

export const stopDaemon = (config: DaemonConfig) =>
  daemonEffect(DAEMON_SHUTDOWN_PATH, (signal) => stopDaemonPromise(config, signal));

export const restartDaemon = (config: DaemonConfig, options: StartDaemonOptions) =>
  daemonEffect(DAEMON_READY_PATH, (signal) => restartDaemonPromise(config, options, signal));

const snapshotRequest = async <A>(
  config: DaemonConfig,
  options: StartDaemonOptions,
  path: string,
  parse: (payload: unknown) => A,
  signal: AbortSignal,
  body?: string
) => {
  const running = await startDetachedDaemonPromise(config, options, signal);
  const answer = await request(
    running.descriptor,
    body === undefined ? "GET" : "POST",
    path,
    body,
    path === DAEMON_DELETE_PATH ? DAEMON_CLEANUP_TIMEOUT_MAX_MS : REQUEST_TIMEOUT_MS,
    signal,
    128 * 1024
  );
  return parse(parseResponse<unknown>(answer, path, 200));
};
export const listDaemonSnapshots = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  input: SnapshotListOptions = {}
) =>
  daemonEffect(DAEMON_INVENTORY_PATH, (signal) => {
    const validated = validateSnapshotListOptions(input);
    const query = new URLSearchParams({
      limit: String(validated.limit),
      ...(validated.after === undefined ? {} : { after: validated.after }),
    });
    return snapshotRequest(
      config,
      options,
      `${DAEMON_INVENTORY_PATH}?${query}`,
      inventoryFromPayload,
      signal
    );
  });
export const getDaemonStorageUsage = (config: DaemonConfig, options: StartDaemonOptions) =>
  daemonEffect(DAEMON_USAGE_PATH, (signal) =>
    snapshotRequest(config, options, DAEMON_USAGE_PATH, usageFromPayload, signal)
  );
export const deleteDaemonSnapshot = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  input: SnapshotSelection
) =>
  daemonEffect(DAEMON_DELETE_PATH, (signal) => {
    const selection = validateSnapshotSelection(input);
    return snapshotRequest(
      config,
      options,
      DAEMON_DELETE_PATH,
      deletionFromPayload,
      signal,
      JSON.stringify(selection)
    );
  });

export const setDaemonSnapshotPinned = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  input: SnapshotSelection,
  pinned: boolean
) =>
  daemonEffect(DAEMON_PIN_PATH, (signal) =>
    snapshotRequest(
      config,
      options,
      pinned ? DAEMON_PIN_PATH : DAEMON_UNPIN_PATH,
      pinFromPayload,
      signal,
      JSON.stringify(validateSnapshotSelection(input))
    )
  );

export const launchDaemonManager = (config: DaemonConfig, options: StartDaemonOptions) =>
  daemonEffect(DAEMON_MANAGER_PATH, async (signal) => {
    const running = await startDetachedDaemonPromise(config, options, signal);
    const answer = await request(
      running.descriptor,
      "POST",
      DAEMON_MANAGER_PATH,
      "{}",
      10_000,
      signal,
      16 * 1024
    );
    const payload = parseResponse<Record<string, unknown>>(answer, DAEMON_MANAGER_PATH, 200);
    const url = new URL(String(payload["url"]));
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.port === String(running.descriptor.port) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      !/^#[A-Za-z0-9_-]{43}$/.test(url.hash) ||
      url.username ||
      url.password ||
      payload["origin"] !== url.origin ||
      typeof payload["expiresAt"] !== "number" ||
      !Number.isSafeInteger(payload["expiresAt"])
    )
      throw new Error("The daemon returned an invalid manager launch link.");
    return {
      url: url.href,
      origin: url.origin,
      expiresAt: payload["expiresAt"],
    } satisfies ManagerLaunch;
  });
export type { ManagerLaunch } from "./manager.js";

const daemonShareRequest = async <A>(
  config: DaemonConfig,
  options: StartDaemonOptions,
  body: object,
  parse: (value: unknown) => A,
  signal: AbortSignal,
  maxBytes = 128 * 1024,
  allowStart = true
) => {
  const running = allowStart
    ? await startDetachedDaemonPromise(config, options, signal)
    : await inspectDaemonPromise(config, signal);
  if ("state" in running && running.state !== "running")
    throw new Error(
      "The daemon was stopped. Recover this share receipt on the next explicit share invocation."
    );
  const answer = await request(
    running.descriptor,
    "POST",
    DAEMON_SHARE_PATH,
    JSON.stringify(body),
    30_000,
    signal,
    maxBytes
  );
  return parse(parseResponse<unknown>(answer, DAEMON_SHARE_PATH, 200));
};
export const inspectDaemonShares = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  id: string,
  operation?: string
) =>
  daemonEffect(DAEMON_SHARE_PATH, (signal) =>
    daemonShareRequest(
      config,
      options,
      { action: "inspect", id, ...(operation ? { operation } : {}) },
      parseShareInspection,
      signal
    )
  );
export const prepareDaemonShare = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  input: SharePrepare
) =>
  daemonEffect(DAEMON_SHARE_PATH, (signal) =>
    daemonShareRequest(
      config,
      options,
      { action: "prepare", ...input },
      parseSharePrepared,
      signal,
      16 * 1024 * 1024
    )
  );
export const recordDaemonShare = (
  config: DaemonConfig,
  options: StartDaemonOptions,
  key: string,
  receipt: unknown
) =>
  daemonEffect(DAEMON_SHARE_PATH, (signal) =>
    daemonShareRequest(
      config,
      options,
      { action: "record", operation: key, receipt },
      parseShareAttempt,
      signal,
      128 * 1024,
      false
    )
  );
