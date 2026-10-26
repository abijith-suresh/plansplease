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
      if (!token || !(await dependencies.getCurrentUser(client, request))) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      if (!dependencies.getOperationOrigin || !dependencies.getUploadReceipt) {
        return Response.json({ error: "Upload operations are not configured" }, { status: 503 });
      }
      const input = {
        key: request.headers.get("Idempotency-Key") ?? "",
        origin: dependencies.getOperationOrigin(),
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
