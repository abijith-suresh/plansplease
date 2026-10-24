import { createMcpProtectedRequestHandler } from "@better-auth/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { createMcpDocumentService } from "./mcp-documents";
import { createHostedMcpServer } from "./hosted-mcp-server";

const siteUrl = process.env["SITE_URL"]?.replace(/\/$/, "");
const resource = siteUrl ? `${siteUrl}/mcp` : undefined;
const allowLegacyClients = process.env["MCP_ALLOW_LEGACY_CLIENTS"] === "true";

const handler = createMcpHandler(
  ({ authInfo }) => {
    const ownerId = authInfo?.extra?.["userId"];
    if (typeof ownerId !== "string" || !ownerId) throw new Error("MCP identity is missing");
    return createHostedMcpServer(createMcpDocumentService(ownerId), siteUrl!);
  },
  // JSON escaping can expand an 8 MiB HTML string by up to six times.
  {
    legacy: allowLegacyClients ? "stateless" : "reject",
    maxRequestBodySize: 50 * 1024 * 1024,
    onerror: (error) =>
      console.error("mcp.transport_failed", {
        errorType: error.name,
        at: error.stack?.split("\n")[1]?.trim(),
      }),
  }
);

const protectedHandler =
  siteUrl && resource
    ? createMcpProtectedRequestHandler(
        {
          issuer: `${siteUrl}/api/auth`,
          audience: resource,
          jwksUrl: `${siteUrl}/api/auth/jwks`,
          requiredScopes: ["cloud:documents"],
        },
        (request, claims) => {
          const userId = claims.sub;
          if (!userId) return new Response(null, { status: 403 });
          const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
          if (!token) return new Response(null, { status: 401 });
          const clientId = claims["client_id"] ?? claims["azp"];
          return handler.fetch(request, {
            authInfo: {
              token,
              clientId: typeof clientId === "string" ? clientId : "unknown",
              scopes: typeof claims["scope"] === "string" ? claims["scope"].split(" ") : [],
              resource: new URL(resource),
              extra: { userId },
            },
          });
        }
      )
    : undefined;

export const handleHostedMcp = async (request: Request) => {
  if (!protectedHandler) {
    return Response.json({ error: "MCP is not configured" }, { status: 503 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(resource!).origin) {
    return new Response(null, { status: 403 });
  }
  const response = await protectedHandler(request);
  if (process.env["MCP_DIAGNOSTICS"] === "true") {
    console.info("mcp.response", { method: request.method, status: response.status });
  }
  return response;
};
