import {
  BUNDLE_HEADER_BYTES,
  createBundleHeader,
  encodeBundleManifest,
  findBundleEntry,
  parseBundleHeader,
  parseBundleManifest,
  validateBundlePath,
  type BundleManifest,
} from "./bundle-format.js";
import { cloudDocumentMaxBytes } from "./cloud-policy.js";

export const cloudBundleContentType = "application/vnd.planview.bundle";
export const cloudBundleMaxBytes = cloudDocumentMaxBytes;

const mimeTypes: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
};

export function cloudBundleMime(path: string) {
  validateBundlePath(path);
  // URL-sensitive filenames are deliberately excluded from cloud v1. In
  // particular, encoded traversal and query/fragment delimiters cannot become
  // different files after the browser or router normalizes the request.
  if (!/^[A-Za-z0-9_./-]+$/.test(path))
    throw new Error(
      "Bundle paths must use URL-safe letters, digits, dots, underscores, hyphens, and folders"
    );
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = Object.hasOwn(mimeTypes, extension) ? mimeTypes[extension] : undefined;
  if (!mime) throw new Error(`Unsupported bundle file extension: ${extension}`);
  return mime;
}

export type CloudBundle = { bytes: Uint8Array; manifest: BundleManifest };

export function parseCloudBundle(bytes: Uint8Array): CloudBundle {
  if (bytes.byteLength > cloudBundleMaxBytes)
    throw new Error("Cloud bundles must be at most 8 MiB including their manifest");
  const { manifestBytes } = parseBundleHeader(bytes);
  const dataOffset = BUNDLE_HEADER_BYTES + manifestBytes;
  if (dataOffset > bytes.byteLength) throw new Error("Bundle manifest is truncated");
  const manifest = parseBundleManifest(
    bytes.subarray(BUNDLE_HEADER_BYTES, dataOffset),
    dataOffset,
    bytes.byteLength
  );
  for (const entry of manifest.entries) cloudBundleMime(entry.path);
  return { bytes, manifest };
}

export function packCloudBundle(files: readonly { path: string; content: string }[]): Uint8Array {
  if (files.length === 0 || files.length > 512)
    throw new Error("A bundle must contain 1 to 512 files");
  let size = 0;
  const encoded = files.map(({ path, content }) => {
    const mime = cloudBundleMime(path);
    if (
      ![
        "text/html",
        "text/css",
        "text/javascript",
        "application/json",
        "text/plain",
        "image/svg+xml",
      ].includes(mime)
    )
      throw new Error("MCP bundle files must contain UTF-8 text");
    const bytes = new TextEncoder().encode(content);
    size += bytes.byteLength;
    if (size > cloudBundleMaxBytes)
      throw new Error("Cloud bundles must be at most 8 MiB including their manifest");
    return { path, bytes };
  });
  let offset = 0;
  const manifestBytes = encodeBundleManifest(
    encoded.map(({ path, bytes }) => {
      const entry = { path, offset, size: bytes.byteLength };
      offset += bytes.byteLength;
      return entry;
    })
  );
  const header = createBundleHeader(manifestBytes);
  const output = new Uint8Array(header.byteLength + manifestBytes.byteLength + size);
  if (output.byteLength > cloudBundleMaxBytes)
    throw new Error("Cloud bundles must be at most 8 MiB including their manifest");
  output.set(header);
  output.set(manifestBytes, header.byteLength);
  offset = header.byteLength + manifestBytes.byteLength;
  for (const { bytes } of encoded) {
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return output;
}

export function cloudBundleEntry(bundle: CloudBundle, path: string) {
  const contentType = cloudBundleMime(path);
  const entry = findBundleEntry(bundle.manifest, path);
  const offset = bundle.manifest.dataOffset + entry.offset;
  return { bytes: bundle.bytes.subarray(offset, offset + entry.size), contentType };
}
