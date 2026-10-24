import { cliCredentialFromRequest } from "./cli-credential.ts";
import { isConvexConfigurationError } from "./convex-configuration-error.ts";

export type CliSessionHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  getCurrentUser(client: Client): Promise<unknown>;
  createCredential(): { secret: string; tokenHash: string };
  issueCredential(client: Client, tokenHash: string): Promise<unknown>;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

export function createCliSessionHandler<Client>(
  dependencies: CliSessionHandlerDependencies<Client>
) {
  return async ({ request }: { request: Request }) => {
    try {
      if (request.headers.get("origin") !== new URL(request.url).origin) {
        return Response.json(
          { error: "Invalid request origin" },
          { status: 403, headers: privateHeaders }
        );
      }

      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token || !(await dependencies.getCurrentUser(client))) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401, headers: privateHeaders }
        );
      }

      const credential = dependencies.createCredential();
      await dependencies.issueCredential(client, credential.tokenHash);
      return Response.json({ token: credential.secret }, { headers: privateHeaders });
    } catch (error) {
      if (isConvexConfigurationError(error)) {
        const response = dependencies.missingServerConfigurationResponse();
        for (const [name, value] of Object.entries(privateHeaders))
          response.headers.set(name, value);
        return response;
      }

      const response = dependencies.errorResponse(error);
      for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
      return response;
    }
  };
}

export function createCliRevocationHandler<Client>(dependencies: {
  getClient(): Client;
  revokeCredential(client: Client, tokenHash: string): Promise<unknown>;
  errorResponse(error: unknown): Response;
}) {
  return async ({ request }: { request: Request }) => {
    const credential = cliCredentialFromRequest(request);
    if (!credential) {
      return Response.json(
        { error: "CLI credential required" },
        { status: 401, headers: privateHeaders }
      );
    }
    try {
      await dependencies.revokeCredential(dependencies.getClient(), credential.tokenHash);
      return new Response(null, { status: 204, headers: privateHeaders });
    } catch (error) {
      const response = dependencies.errorResponse(error);
      for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
      return response;
    }
  };
}
