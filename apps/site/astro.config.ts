import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import { readSiteOrigin } from "./src/lib/public-site-url";

const normalizeBasePath = (value: string | undefined) => {
  const withoutOuterSlashes = value?.replace(/^\/+|\/+$/g, "") ?? "";
  return withoutOuterSlashes ? `/${withoutOuterSlashes}` : "";
};

// biome-ignore lint/complexity/useLiteralKeys: Astro's environment type uses an index signature.
const base = normalizeBasePath(process.env["BASE_PATH"]);
const environment = {
  ...loadEnv(
    process.env["NODE_ENV"] ?? "production",
    process.env["PLANVIEW_ENV_DIR"] ?? process.cwd(),
    "PUBLIC_"
  ),
  ...process.env,
};

export default defineConfig({
  output: "static",
  vite: { envDir: process.env["PLANVIEW_ENV_DIR"] ?? process.cwd() },
  site: readSiteOrigin(environment["PUBLIC_SITE_URL"]),
  base,
});
