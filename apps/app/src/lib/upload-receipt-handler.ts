import { cloudDocumentMaxBytes, uploadProtocolHeader } from "@planview/core";
import { validateReceiptLookup } from "../../convex/uploadReceipt.ts";
import type { DocumentUploadHandlerDependencies } from "./document-upload-handler.ts";
import { receiptResponse } from "./upload-operation.ts";

export function createUploadReceiptHandler<Client>(
  dependencies: Pick<
    DocumentUploadHandlerDependencies<Client>,
    | "getAuthedClient"
    | "getCurrentUser"
    | "getUploadReceipt"
    | "getOperationOrigin"
    | "errorResponse"
  >
) {
  return async ({ request }: { request: Request }) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);
      const identity = token ? await dependencies.getCurrentUser(client, request) : null;
      if (!identity) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      if (!dependencies.getOperationOrigin || !dependencies.getUploadReceipt) {
        return Response.json({ error: "Upload operations are not configured" }, { status: 503 });
      }
      const origin = dependencies.getOperationOrigin();
      if (new URL(request.url).origin !== origin)
        return Response.json({ error: "Upload origin mismatch" }, { status: 400 });
      if (
        request.headers.get(uploadProtocolHeader) === "1" &&
        !request.headers.has("Idempotency-Key")
      ) {
        return Response.json(
          {
            version: 1,
            accountId: identity.subject,
            origin,
            maxBytes: cloudDocumentMaxBytes,
            receipts: true,
          },
          { headers: { "Cache-Control": "private, no-store" } }
        );
      }
      const input = {
        key: request.headers.get("Idempotency-Key") ?? "",
        origin,
      };
      try {
        validateReceiptLookup(input);
        if (new URL(request.url).origin !== input.origin) throw new Error("Upload origin mismatch");
      } catch {
        return Response.json({ error: "Invalid operation key or upload origin" }, { status: 400 });
      }
      const receipt = await dependencies.getUploadReceipt(client, input, request);
      return receipt
        ? receiptResponse(receipt)
        : Response.json(
            { outcome: "not_found" },
            { status: 404, headers: { "Cache-Control": "private, no-store" } }
          );
    } catch (error) {
      return dependencies.errorResponse(error);
    }
  };
}
