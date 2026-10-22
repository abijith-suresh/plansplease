import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { solidStart } from "@solidjs/start/config";
import { appNitroPlugin } from "./local-nitro.ts";

const resolveUriEsm = fileURLToPath(import.meta.resolve("@jridgewell/resolve-uri/package.json"));

export default defineConfig(async ({ command }) => ({
  envDir: process.env["PLANVIEW_ENV_DIR"] ?? process.cwd(),
  plugins: [
    solidStart({ middleware: "./src/middleware.ts" }),
    await appNitroPlugin(fileURLToPath(new URL(".", import.meta.url)), command),
  ],
  resolve: {
    // The client resolver picks @jridgewell/resolve-uri's browser field (a UMD
    // build with no default export) when the source-map dev toolbar imports
    // trace-mapping; force the ESM build everywhere.
    alias: {
      "@jridgewell/resolve-uri": resolveUriEsm.replace(/package\.json$/, "dist/resolve-uri.mjs"),
    },
  },
}));
