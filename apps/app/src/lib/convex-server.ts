import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api";

import { ConvexTokenServiceError, fetchConvexToken } from "./convex-token";
import { ConvexConfigurationError } from "./convex-configuration-error";

const convexUrl = process.env["CONVEX_URL"] ?? process.env["VITE_CONVEX_URL"];
export const convexSiteUrl = process.env["CONVEX_SITE_URL"] ?? process.env["VITE_CONVEX_SITE_URL"];

export { api };

const requireConvexConfiguration = () => {
  if (!convexUrl || !convexSiteUrl) {
    throw new ConvexConfigurationError();
  }
  return { convexUrl, convexSiteUrl };
};

export const getUnauthedConvexClient = () =>
  new ConvexHttpClient(requireConvexConfiguration().convexUrl);

export async function getAuthedConvexClient(request: Request) {
  const { convexSiteUrl } = requireConvexConfiguration();

  // CLI credentials are accepted only by the upload route. They must never
  // become a Better Auth session or a Convex JWT on other app routes.
  if (/^Bearer\s+planview_cli_/i.test(request.headers.get("authorization") ?? "")) {
    return { client: getUnauthedConvexClient(), token: null };
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("accept-encoding", "identity");

  const token = await fetchConvexToken(convexSiteUrl, headers);
  const client = getUnauthedConvexClient();

  if (token) {
    client.setAuth(token);
  }

  return { client, token };
}

export async function proxyResponse(response: Response) {
  const headers = new Headers(response.headers);

  headers.delete("content-length");
  // Fetch transparently decompresses upstream responses, so forwarding this
  // header would make the downstream client try to decompress plain bytes.
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function missingServerConfigurationResponse() {
  return Response.json(
    {
      error: "The cloud backend is not configured yet.",
      code: "BACKEND_NOT_CONFIGURED",
    },
    { status: 503 }
  );
}

export function errorResponse(error: unknown) {
  if (error instanceof ConvexTokenServiceError) {
    return Response.json({ error: error.message }, { status: 502 });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";

  return Response.json({ error: message }, { status: 500 });
}
