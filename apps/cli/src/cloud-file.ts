import type { FileHandle } from "node:fs/promises";
import { cloudDocumentMaxBytes } from "@planview/core/cloud-policy";

export const MAX_HTML_SIZE_BYTES = cloudDocumentMaxBytes;
const READ_CHUNK_SIZE_BYTES = 64 * 1024;

type UploadFileReader = Pick<FileHandle, "read" | "stat">;

/**
 * Read a cloud upload into a fixed-size buffer. The extra byte detects a file
 * that grows past the upload limit while it is being read without allowing the
 * read to allocate based on an untrusted, changing file size.
 */
export const readBoundedCloudFile = async (file: UploadFileReader) => {
  const initialStats = await file.stat();
  if (initialStats.size > MAX_HTML_SIZE_BYTES) {
    throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
  }

  const data = Buffer.alloc(MAX_HTML_SIZE_BYTES + 1);
  let bytesReadTotal = 0;

  while (true) {
    const remaining = data.byteLength - bytesReadTotal;
    if (remaining === 0) {
      throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
    }

    const requested = Math.min(remaining, READ_CHUNK_SIZE_BYTES);
    const { bytesRead } = await file.read(data, bytesReadTotal, requested, bytesReadTotal);
    if (bytesRead > requested) {
      throw new Error("The HTML file changed while it was being read.");
    }

    bytesReadTotal += bytesRead;
    if (bytesReadTotal > MAX_HTML_SIZE_BYTES) {
      throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
    }
    if (bytesRead > 0) continue;

    const currentStats = await file.stat();
    if (currentStats.size > MAX_HTML_SIZE_BYTES) {
      throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
    }
    if (currentStats.size > bytesReadTotal) continue;
    if (currentStats.size < bytesReadTotal) {
      throw new Error("The HTML file changed while it was being read.");
    }

    return data.subarray(0, bytesReadTotal);
  }
};
