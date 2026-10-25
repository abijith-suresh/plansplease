import { cloudBundleEntry, isCloudBundleTextMime, type CloudBundle } from "./cloud-bundle.ts";

export function readBundleText(
  bundle: CloudBundle,
  path = "index.html",
  offset = 0,
  maxCharacters = 32768
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxCharacters) ||
    maxCharacters < 1 ||
    maxCharacters > 32768
  )
    throw new Error("Invalid bundle read range");
  const file = cloudBundleEntry(bundle, path);
  if (!isCloudBundleTextMime(file.contentType))
    throw new Error("read_document supports UTF-8 text files only");
  const content = new TextDecoder().decode(file.bytes);
  return {
    kind: "bundle" as const,
    path,
    offset,
    totalCharacters: content.length,
    html: content.slice(offset, offset + maxCharacters),
    nextOffset: offset + maxCharacters < content.length ? offset + maxCharacters : null,
  };
}

export function listBundleFilePage(bundle: CloudBundle, offset = 0, limit = 50) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new Error("Invalid bundle file page");
  return {
    kind: "bundle" as const,
    files: bundle.manifest.entries
      .slice(offset, offset + limit)
      .map(({ path, size }) => ({ path, sizeBytes: size })),
    nextOffset: offset + limit < bundle.manifest.entries.length ? offset + limit : null,
  };
}
