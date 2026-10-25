import { type SignedProof, signProof, verifyProof } from "./signedProof.ts";

export type DocumentMutationProof = SignedProof;

export type CreateDocumentProofInput = Readonly<{
  ownerId: string;
  title: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
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
