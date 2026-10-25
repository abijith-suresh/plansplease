import { type SignedProof, signProof, verifyProof } from "./signedProof.ts";

export type McpDocumentAction = "list" | "get" | "create" | "delete" | "reserve" | "abandon";

export type McpDocumentProof = SignedProof;

export type McpDocumentProofInput = Readonly<{
  action: McpDocumentAction;
  ownerId: string;
  arguments: readonly (string | number | null)[];
}>;

const message = (input: McpDocumentProofInput, expiresAt: number) =>
  JSON.stringify([
    "planview-mcp-documents-v1",
    input.action,
    input.ownerId,
    input.arguments,
    expiresAt,
  ]);

export const signMcpDocumentProof = (secret: string, input: McpDocumentProofInput) =>
  signProof(secret, (expiresAt) => message(input, expiresAt));

export const verifyMcpDocumentProof = async (
  secret: string,
  input: McpDocumentProofInput,
  proof: McpDocumentProof,
  now = Date.now()
) => verifyProof(secret, proof, message(input, proof.expiresAt), now);
