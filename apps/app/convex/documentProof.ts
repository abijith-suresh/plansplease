import { type SignedProof, signProof, verifyProof } from "./signedProof.ts";

export type DocumentMutationProof = SignedProof;

export type UploadOperation = Readonly<{
  key: string;
  origin: string;
  fingerprint: string;
  contentSha256: string;
}>;

// Optional extension preserves the exact legacy proof message when absent.
const operationMessage = (operation: UploadOperation | undefined) =>
  operation
    ? [
        "upload-operation-v1",
        operation.key,
        operation.origin,
        operation.fingerprint,
        operation.contentSha256,
      ]
    : [];

export type CreateDocumentProofInput = Readonly<{
  ownerId: string;
  title: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  operation?: UploadOperation;
}>;

const createMessage = (input: CreateDocumentProofInput, expiresAt: number) =>
  JSON.stringify([
    "create",
    input.ownerId,
    input.title,
    input.storageProvider,
    input.storageKey,
    input.contentType,
    input.sizeBytes,
    ...operationMessage(input.operation),
    expiresAt,
  ]);

export const signCreateDocumentProof = (secret: string, input: CreateDocumentProofInput) =>
  signProof(secret, (expiresAt) => createMessage(input, expiresAt));

export const verifyCreateDocumentProof = (
  secret: string,
  input: CreateDocumentProofInput,
  proof: DocumentMutationProof,
  now = Date.now()
) => verifyProof(secret, proof, createMessage(input, proof.expiresAt), now);

export type AbandonDocumentProofInput = CreateDocumentProofInput & { uploadConfirmed: boolean };
const abandonMessage = (input: AbandonDocumentProofInput, expiresAt: number) =>
  JSON.stringify([
    "abandon-upload",
    input.ownerId,
    input.title,
    input.storageProvider,
    input.storageKey,
    input.contentType,
    input.sizeBytes,
    input.uploadConfirmed,
    ...operationMessage(input.operation),
    expiresAt,
  ]);

export const signAbandonDocumentProof = (secret: string, input: AbandonDocumentProofInput) =>
  signProof(secret, (expiresAt) => abandonMessage(input, expiresAt));

export const verifyAbandonDocumentProof = (
  secret: string,
  input: AbandonDocumentProofInput,
  proof: DocumentMutationProof,
  now = Date.now()
) => verifyProof(secret, proof, abandonMessage(input, proof.expiresAt), now);
