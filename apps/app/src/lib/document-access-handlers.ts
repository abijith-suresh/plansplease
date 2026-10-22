import type { DocumentStorageAdapter } from "./document-storage.js";
import { documentPreviewResponse, localDocumentPreviewResponse } from "./document-preview.ts";

export type DocumentAccessRecord = Readonly<{
  readonly contentType: string;
  readonly ownerId?: string;
  readonly title?: string;
  readonly storageProvider?: string;
  readonly storageKey?: string;
}>;

export type DocumentAccessHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  getDocument(client: Client, id: string): Promise<DocumentAccessRecord | null | undefined>;
  bundlePreview?(id: string, document: DocumentAccessRecord): Promise<Response>;
  getDocumentStorage(provider: string): DocumentStorageAdapter;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  readonly convexSiteUrl: string | undefined;
  proxyResponse(response: Response): Promise<Response>;
  requestDeletion(client: Client, id: string): Promise<"accepted" | "deleted" | "not_found">;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

export type DocumentRouteEvent = { request: Request; params: { id: string } };

const errorResponse = <Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>,
  error: unknown
) =>
  error instanceof Error && error.message === "Convex is not configured"
    ? dependencies.missingServerConfigurationResponse()
    : dependencies.errorResponse(error);

export function createDocumentPreviewHandler<Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>
) {
  return async ({ request, params }: DocumentRouteEvent) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return new Response("Authentication required", { status: 401 });
      }

      const document = await dependencies.getDocument(client, params.id);

      if (!document) {
        return new Response("Not found", { status: 404 });
      }

      if (document.contentType === "application/vnd.planview.bundle") {
        if (!dependencies.bundlePreview) return new Response("Not found", { status: 404 });
        return dependencies.bundlePreview(params.id, document);
      }
      if (document.storageProvider && document.storageKey) {
        const storage = dependencies.getDocumentStorage(document.storageProvider);
        const preview =
          document.storageProvider === "filesystem"
            ? localDocumentPreviewResponse
            : documentPreviewResponse;
        return preview(await storage.getReadUrl(document.storageKey), document.title);
      }

      if (!dependencies.convexSiteUrl) {
        return dependencies.missingServerConfigurationResponse();
      }

      const response = await dependencies.fetch(
        `${dependencies.convexSiteUrl}/documents/content?id=${encodeURIComponent(params.id)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      return dependencies.proxyResponse(response);
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };
}

export function createDocumentDeleteHandler<Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>
) {
  return async ({ request, params }: DocumentRouteEvent) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      const result = await dependencies.requestDeletion(client, params.id);
      if (result === "not_found") {
        return Response.json({ error: "Document not found" }, { status: 404 });
      }
      return new Response(null, { status: result === "accepted" ? 202 : 204 });
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };
}
