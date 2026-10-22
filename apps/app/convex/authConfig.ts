import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { createClient } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import type { GenericCtx } from "@convex-dev/better-auth/utils";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";
import schema from "./betterAuth/schema";
import { isLocalDevelopment } from "./localMode";
import { preserveConvexEndpoints } from "./pluginEndpoints";

const githubClientId = process.env["GITHUB_CLIENT_ID"];
const githubClientSecret = process.env["GITHUB_CLIENT_SECRET"];
const siteUrl = (process.env["SITE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
const resource = `${siteUrl}/mcp`;
const allowLegacyClients = process.env["MCP_ALLOW_LEGACY_CLIENTS"] === "true";

const trustedOrigins = [siteUrl, "http://localhost:3000"];

async function fetchClientMetadataResource(input: RequestInfo | URL, init?: RequestInit) {
  const secret = process.env["CIMD_FETCH_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("CIMD metadata transport is not configured");
  }
  const request = new Request(input, init);
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new Error("CIMD metadata transport only supports GET and HEAD");
  }
  const headers = Object.fromEntries(
    [...request.headers].filter(([name]) =>
      ["accept", "if-none-match", "if-modified-since"].includes(name.toLowerCase())
    )
  );
  return fetch(`${siteUrl}/api/internal/cimd-fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ url: request.url, method: request.method, headers }),
    signal: request.signal,
  });
}

export const authComponent = createClient<DataModel, typeof schema>(components.betterAuth, {
  local: { schema },
  verbose: false,
});

const convexAuthPlugin = preserveConvexEndpoints(convex({ authConfig }));

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const socialProviders: BetterAuthOptions["socialProviders"] =
    githubClientId && githubClientSecret
      ? {
          github: {
            clientId: githubClientId,
            clientSecret: githubClientSecret,
          },
        }
      : {};

  return {
    appName: "plansplease workspace",
    baseURL: siteUrl,
    secret: process.env["BETTER_AUTH_SECRET"],
    trustedOrigins,
    database: authComponent.adapter(ctx),
    socialProviders,
    emailAndPassword: { enabled: isLocalDevelopment(process.env), minPasswordLength: 12 },
    plugins: [
      convexAuthPlugin,
      // Existing signing keys are RSA. Pin the algorithm so keys created
      // before Better Auth stored `alg` remain readable and usable.
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
      mcp({
        loginPage: "/mcp/login",
        consentPage: "/mcp/consent",
        resource,
        scopes: ["openid", "profile", "email", "offline_access", "cloud:documents"],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: allowLegacyClients,
        allowUnauthenticatedClientRegistration: allowLegacyClients,
      }) as unknown as NonNullable<BetterAuthOptions["plugins"]>[number],
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  } satisfies BetterAuthOptions;
};

// registerRoutes constructs one auth instance with an empty context to inspect
// its base path. OAuth resource seeding also starts during construction, so
// give that inspection instance inert database methods. Real HTTP actions
// always provide the Convex context and perform the actual seed.
export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const runtimeCtx =
    "runQuery" in ctx && "runMutation" in ctx
      ? ctx
      : ({
          runQuery: async () => null,
          runMutation: async () => null,
        } as unknown as GenericCtx<DataModel>);
  return betterAuth(createAuthOptions(runtimeCtx));
};
