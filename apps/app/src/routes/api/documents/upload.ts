import { randomUUID } from "node:crypto";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  getUnauthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { cliCredentialFromRequest } from "~/lib/cli-credential";
import { getDocumentStorage, isDocumentStorageConfigured } from "~/lib/document-storage";
import { readAppOrigin } from "~/lib/public-app-url";
import { createUploadReceiptHandler } from "~/lib/upload-receipt-handler";
import type { DocumentUploadHandlerDependencies } from "~/lib/document-upload-handler";
import type { ConvexHttpClient } from "convex/browser";
import { createDocumentUploadHandler } from "~/lib/document-upload-handler";
import { createDocumentProof, createAbandonDocumentProof } from "~/lib/document-mutation-proof";

const dependencies: DocumentUploadHandlerDependencies<ConvexHttpClient> = {
  getOperationOrigin: () => readAppOrigin(process.env["SITE_URL"]),
  getUploadReceipt: (client, input, request) => {
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.query(api.documents.uploadReceiptWithCliCredential, { ...input, ...cliCredential })
      : client.query(api.documents.uploadReceipt, input);
  },
  getAuthedClient: (request) => {
    const cliCredential = cliCredentialFromRequest(request);
    if (cliCredential) {
      return Promise.resolve({ client: getUnauthedConvexClient(), token: cliCredential.tokenHash });
    }
    return getAuthedConvexClient(request);
  },
  getCurrentUser: (client, request) => {
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.query(api.cliCredentials.lookup, cliCredential)
      : client.query(api.auth.currentUser, {});
  },
  isStorageConfigured: isDocumentStorageConfigured,
  getUploadLocator: (objectId) => getDocumentStorage().getUploadLocator(objectId),
  uploadFile: (input) => getDocumentStorage().upload(input),
  reserveMetadata: async (client, input, ownerId, request) => {
    const proof = await createDocumentProof({ ownerId, ...input });
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.mutation(api.documents.reserveUploadWithCliCredential, {
          ...input,
          ...cliCredential,
          proof,
        })
      : client.mutation(api.documents.reserveUpload, { ...input, proof });
  },
  abandonMetadata: async (client, input, ownerId, request, uploadConfirmed) => {
    const proof = await createDocumentProof({ ownerId, ...input });
    const outcomeProof = await createAbandonDocumentProof({ ownerId, ...input, uploadConfirmed });
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.mutation(api.documents.abandonUploadWithCliCredential, {
          ...input,
          ...cliCredential,
          proof,
          outcomeProof,
          uploadConfirmed,
        })
      : client.mutation(api.documents.abandonUpload, {
          ...input,
          proof,
          outcomeProof,
          uploadConfirmed,
        });
  },
  createMetadata: async (client, input, ownerId, request) => {
    const proof = await createDocumentProof({ ownerId, ...input });
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.mutation(api.documents.createWithCliCredential, {
          ...input,
          ...cliCredential,
          proof,
        })
      : client.mutation(api.documents.create, { ...input, proof });
  },
  createUploadId: randomUUID,
  missingServerConfigurationResponse,
  errorResponse,
};

export const POST = createDocumentUploadHandler(dependencies);
export const GET = createUploadReceiptHandler(dependencies);
