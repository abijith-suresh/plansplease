import { isLocalDevelopment } from "../../convex/localMode.ts";
import { getFilesystemStorage } from "./document-storage-filesystem.ts";
import { createUploadThingStorage } from "./document-storage-uploadthing.ts";

export { createUploadThingStorageAdapter } from "./document-storage-uploadthing.ts";

export const documentStorageProviders = ["uploadthing", "filesystem"] as const;
export type DocumentStorageProvider = (typeof documentStorageProviders)[number];

export type StoredDocument = {
  storageProvider: DocumentStorageProvider;
  storageKey: string;
};

export type DocumentStorageUpload = { file: File; objectId: string; deadlineAt: number };

export interface DocumentStorageAdapter {
  readonly provider: DocumentStorageProvider;
  getUploadLocator(objectId: string): StoredDocument;
  upload(input: DocumentStorageUpload): Promise<StoredDocument>;
  getReadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  read?(key: string): Promise<Uint8Array<ArrayBuffer>>;
}

export function isDocumentStorageConfigured() {
  return isLocalDevelopment(process.env)
    ? Boolean(process.env["PLANVIEW_LOCAL_STORAGE_DIR"] && process.env["LOCAL_STORAGE_SECRET"])
    : Boolean(process.env["UPLOADTHING_TOKEN"]);
}

export function getDocumentStorage(
  provider = isLocalDevelopment(process.env) ? "filesystem" : "uploadthing"
): DocumentStorageAdapter {
  if (provider === "filesystem") return getFilesystemStorage();
  if (provider !== "uploadthing") {
    throw new Error(`Unsupported document storage provider: ${provider}`);
  }

  const token = process.env["UPLOADTHING_TOKEN"];
  if (!token) throw new Error("UploadThing is not configured");

  return createUploadThingStorage(token);
}
