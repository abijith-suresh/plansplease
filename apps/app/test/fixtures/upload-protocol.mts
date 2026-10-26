import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDatabase } from "./memory-database.mts";
import {
  createDocumentUploadHandler,
  type DocumentUploadMetadata,
} from "../../src/lib/document-upload-handler.ts";
import { createUploadReceiptHandler } from "../../src/lib/upload-receipt-handler.ts";
import { createFilesystemStorage } from "../../src/lib/document-storage-filesystem.ts";
import { signCreateDocumentProof, signAbandonDocumentProof } from "../../convex/documentProof.ts";
import {
  reserveUploadForOwner,
  createForOwner,
  abandonUploadForOwner,
  getUploadReceiptForOwner,
} from "../../convex/documents.ts";

export const secret = "receipt-local-fixture-secret-at-least-32-bytes";
export const origin = "http://127.0.0.1:3000";
export const operationKey = "fixture_operation_0001";
export const exactBytes = new Uint8Array([
  0x3c, 0x68, 0x31, 0x3e, 0x00, 0xc3, 0xa9, 0xff, 0x0d, 0x0a,
]);
export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    DOCUMENT_MUTATION_SECRET: secret,
    ACCOUNT_STORAGE_QUOTA_BYTES: "100000",
    PLANVIEW_LOCAL: "true",
    SITE_URL: origin,
    CONVEX_URL: "http://127.0.0.1:3210",
    CONVEX_SITE_URL: "http://127.0.0.1:3211",
  });
  // Use the repository's explicit local-development mode, never hosted credentials.
  delete process.env["CONVEX_CLOUD_URL"];
  delete process.env["NODE_ENV"];
  const root = await mkdtemp(join(tmpdir(), "receipt fixture ü "));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const database = memoryDatabase();
  const storage = createFilesystemStorage(root, (key) => key);
  const state = {
    owner: "owner-a",
    origin,
    uploads: 0,
    reserveLost: false,
    commitLost: false,
    abandonLost: false,
    unavailable: false,
    providerLost: false,
    commitRejected: false,
    afterUpload: async () => {},
    beforeUpload: async () => {},
  };
  const signed = async (metadata: DocumentUploadMetadata, ownerId: string) => ({
    ...metadata,
    proof: await signCreateDocumentProof(secret, { ownerId, ...metadata }),
  });
  const dependencies = {
    getAuthedClient: async (_request: Request) => ({ client: {}, token: "fixture-session" }),
    getCurrentUser: async (_client: object, _request: Request) => ({ subject: state.owner }),
    isStorageConfigured: () => true,
    getOperationOrigin: () => state.origin,
    getUploadLocator: storage.getUploadLocator,
    createUploadId: randomUUID,
    getUploadReceipt: async (
      _client: object,
      input: { key: string; origin: string },
      _request: Request
    ) => {
      if (state.unavailable) throw new Error("receipt unavailable");
      return database.transaction((ctx) => getUploadReceiptForOwner(ctx, state.owner, input));
    },
    reserveMetadata: async (_client: object, metadata: DocumentUploadMetadata, ownerId: string) => {
      const args = await signed(metadata, ownerId);
      const result = await database.transaction((ctx) => reserveUploadForOwner(ctx, ownerId, args));
      if (state.reserveLost) throw new Error("reserve response lost");
      return result;
    },
    createMetadata: async (_client: object, metadata: DocumentUploadMetadata, ownerId: string) => {
      if (state.commitRejected) throw new Error("commit definitively refused");
      const args = await signed(metadata, ownerId);
      const id = await database.transaction((ctx) => createForOwner(ctx, ownerId, args));
      if (state.commitLost) throw new Error("commit response lost");
      return id;
    },
    abandonMetadata: async (
      _client: object,
      metadata: DocumentUploadMetadata,
      ownerId: string,
      _request: Request,
      uploadConfirmed: boolean
    ) => {
      if (state.abandonLost) throw new Error("fence unavailable");
      const args = {
        ...(await signed(metadata, ownerId)),
        uploadConfirmed,
        outcomeProof: await signAbandonDocumentProof(secret, {
          ownerId,
          ...metadata,
          uploadConfirmed,
        }),
      };
      return database.transaction((ctx) => abandonUploadForOwner(ctx, ownerId, args));
    },
    uploadFile: async (input: Parameters<typeof storage.upload>[0]) => {
      state.uploads++;
      await state.beforeUpload();
      const result = await storage.upload(input);
      await state.afterUpload();
      if (state.providerLost) throw new Error("provider response lost after ingest");
      return result;
    },
    reportCompensationFailure: () => {},
    errorResponse: (error: unknown) => Response.json({ error: String(error) }, { status: 500 }),
    missingServerConfigurationResponse: () => new Response(null, { status: 503 }),
  };
  return {
    state,
    database,
    storage,
    dependencies,
    signed,
    upload: createDocumentUploadHandler(dependencies),
    lookup: createUploadReceiptHandler(dependencies),
  };
}
