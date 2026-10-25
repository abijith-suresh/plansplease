import {
  V1_MAX_BUNDLE_FILES,
  V1_MAX_BUNDLE_MANIFEST_BYTES,
  V1_MAX_BUNDLE_PATH_BYTES,
} from "./policy.js";

export const BUNDLE_HEADER_BYTES = 12;
export const BUNDLE_MAGIC_BYTES = Uint8Array.from([0x50, 0x4c, 0x56, 0x57, 0x42, 0x4e, 0x44, 0x31]);

export type BundleManifestEntry = Readonly<{
  readonly path: string;
  readonly offset: number;
  readonly size: number;
}>;

export type BundleManifest = Readonly<{
  readonly version: 1;
  readonly index: "index.html";
  readonly dataOffset: number;
  readonly entries: readonly BundleManifestEntry[];
}>;

export class InvalidBundleError extends Error {
  readonly _tag = "InvalidBundleError" as const;
  readonly code = "INVALID_BUNDLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidBundleError";
  }
}

export class BundleEntryNotFoundError extends Error {
  readonly _tag = "BundleEntryNotFoundError" as const;
  readonly code = "BUNDLE_ENTRY_NOT_FOUND" as const;
  readonly path: string;

  constructor(path: string) {
    super(`Bundle entry was not found: ${path}.`);
    this.name = "BundleEntryNotFoundError";
    this.path = path;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const copyBytes = (value: Uint8Array) => new Uint8Array(value);

const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const isBundleHeader = (value: Uint8Array) =>
  value.length >= BUNDLE_MAGIC_BYTES.length &&
  equalBytes(value.subarray(0, BUNDLE_MAGIC_BYTES.length), BUNDLE_MAGIC_BYTES);

const pathBytes = (value: string) => encoder.encode(value).byteLength;

export const validateBundlePath = (value: unknown) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidBundleError("Bundle paths must be non-empty strings.");
  }
  if (pathBytes(value) > V1_MAX_BUNDLE_PATH_BYTES) {
    throw new InvalidBundleError("Bundle paths are too long.");
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new InvalidBundleError(`Unsafe bundle path: ${JSON.stringify(value)}.`);
  }
  return value;
};

const validateEntries = (entries: readonly BundleManifestEntry[], totalDataBytes?: number) => {
  if (entries.length === 0 || entries.length > V1_MAX_BUNDLE_FILES) {
    throw new InvalidBundleError(
      `A bundle must contain between 1 and ${V1_MAX_BUNDLE_FILES} files.`
    );
  }
  const paths = new Set<string>();
  let previousEnd = 0;
  let hasIndex = false;
  for (const entry of entries) {
    validateBundlePath(entry.path);
    if (paths.has(entry.path)) {
      throw new InvalidBundleError(`Bundle contains duplicate path ${JSON.stringify(entry.path)}.`);
    }
    paths.add(entry.path);
    if (!isSafeInteger(entry.offset) || !isSafeInteger(entry.size)) {
      throw new InvalidBundleError(
        `Bundle entry ${JSON.stringify(entry.path)} has invalid bounds.`
      );
    }
    if (entry.offset < previousEnd) {
      throw new InvalidBundleError("Bundle entries overlap or are out of order.");
    }
    const end = entry.offset + entry.size;
    if (!Number.isSafeInteger(end)) {
      throw new InvalidBundleError("Bundle entry bounds exceed safe integer limits.");
    }
    if (totalDataBytes !== undefined && end > totalDataBytes) {
      throw new InvalidBundleError("Bundle entry extends beyond the stored file.");
    }
    previousEnd = end;
    hasIndex ||= entry.path === "index.html";
  }
  if (!hasIndex) {
    throw new InvalidBundleError("A bundle must contain a root index.html file.");
  }
};

export const encodeBundleManifest = (entries: readonly BundleManifestEntry[]) => {
  validateEntries(entries);
  const bytes = encoder.encode(
    JSON.stringify({ version: 1, index: "index.html", entries }, undefined, 0)
  );
  if (bytes.byteLength > V1_MAX_BUNDLE_MANIFEST_BYTES) {
    throw new InvalidBundleError("The bundle manifest is too large.");
  }
  return copyBytes(bytes);
};

export const createBundleHeader = (manifestBytes: Uint8Array) => {
  if (manifestBytes.byteLength > V1_MAX_BUNDLE_MANIFEST_BYTES) {
    throw new InvalidBundleError("The bundle manifest is too large.");
  }
  const header = new Uint8Array(BUNDLE_HEADER_BYTES);
  header.set(BUNDLE_MAGIC_BYTES, 0);
  new DataView(header.buffer).setUint32(BUNDLE_MAGIC_BYTES.length, manifestBytes.byteLength);
  return header;
};

export const parseBundleHeader = (header: Uint8Array) => {
  if (header.byteLength < BUNDLE_HEADER_BYTES || !isBundleHeader(header)) {
    throw new InvalidBundleError("The stored file is not a Planview bundle.");
  }
  const manifestBytes = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    BUNDLE_MAGIC_BYTES.length
  );
  if (manifestBytes === 0 || manifestBytes > V1_MAX_BUNDLE_MANIFEST_BYTES) {
    throw new InvalidBundleError("The bundle manifest length is invalid.");
  }
  return { manifestBytes };
};

export const parseBundleManifest = (
  bytes: Uint8Array,
  dataOffset: number,
  totalSize: number
): BundleManifest => {
  if (bytes.byteLength === 0 || bytes.byteLength > V1_MAX_BUNDLE_MANIFEST_BYTES) {
    throw new InvalidBundleError("The bundle manifest length is invalid.");
  }
  if (!isSafeInteger(dataOffset) || !isSafeInteger(totalSize) || dataOffset > totalSize) {
    throw new InvalidBundleError("The bundle data offset is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new InvalidBundleError(
      `The bundle manifest is not valid UTF-8 JSON: ${cause instanceof Error ? cause.message : String(cause)}.`
    );
  }
  if (!isRecord(parsed)) {
    throw new InvalidBundleError("The bundle manifest version is unsupported.");
  }
  const { version, index, entries: rawEntries } = parsed;
  if (version !== 1) {
    throw new InvalidBundleError("The bundle manifest version is unsupported.");
  }
  if (index !== "index.html") {
    throw new InvalidBundleError("The bundle manifest must use index.html as its entry page.");
  }
  if (!Array.isArray(rawEntries)) {
    throw new InvalidBundleError("The bundle manifest entries must be an array.");
  }
  const entries = rawEntries.map((rawEntry) => {
    if (!isRecord(rawEntry)) {
      throw new InvalidBundleError("The bundle manifest contains an invalid entry.");
    }
    const { path, offset, size } = rawEntry;
    if (typeof path !== "string" || !isSafeInteger(offset) || !isSafeInteger(size)) {
      throw new InvalidBundleError("The bundle manifest contains an invalid entry.");
    }
    return { path, offset, size } satisfies BundleManifestEntry;
  });
  validateEntries(entries, totalSize - dataOffset);
  return Object.freeze({
    version: 1 as const,
    index: "index.html" as const,
    dataOffset,
    entries: Object.freeze(entries),
  });
};

export const findBundleEntry = (manifest: BundleManifest, path: string) => {
  validateBundlePath(path);
  const entry = manifest.entries.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    throw new BundleEntryNotFoundError(path);
  }
  return entry;
};
