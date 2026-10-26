import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  // npm pack --json reserves stdout for its machine-readable result.
  logLevel: "warn",
  plugins: [solid()],
  build: { outDir: "../dist/manager", emptyOutDir: true, assetsInlineLimit: 0 },
});
