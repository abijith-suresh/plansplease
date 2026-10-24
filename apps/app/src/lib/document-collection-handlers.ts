import { isConvexConfigurationError } from "./convex-configuration-error.ts";

export type DocumentCollectionHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  listDocuments(client: Client): Promise<unknown>;
  listDocumentPage(
    client: Client,
    options: { cursor: string | null; numItems: number }
  ): Promise<unknown>;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

export function createDocumentCollectionHandlers<Client>(
  dependencies: DocumentCollectionHandlerDependencies<Client>
) {
  const GET = async ({ request }: { request: Request }) => {
    const searchParams = new URL(request.url).searchParams;
    const hasPagination = searchParams.has("limit") || searchParams.has("cursor");
    const limit = searchParams.get("limit") ?? "50";
    const cursor = searchParams.get("cursor");

    if (
      hasPagination &&
      (searchParams.getAll("limit").length > 1 ||
        searchParams.getAll("cursor").length > 1 ||
        !/^[1-9]\d*$/.test(limit) ||
        Number(limit) > 100 ||
        cursor === "")
    ) {
      return Response.json({ error: "Invalid pagination parameters" }, { status: 400 });
    }

    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      return Response.json(
        hasPagination
          ? await dependencies.listDocumentPage(client, { cursor, numItems: Number(limit) })
          : await dependencies.listDocuments(client)
      );
    } catch (error) {
      return isConvexConfigurationError(error)
        ? dependencies.missingServerConfigurationResponse()
        : dependencies.errorResponse(error);
    }
  };

  return { GET };
}
