import { readFileSync } from "node:fs";
import { build } from "esbuild";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const define = {
  __PLANVIEW_VERSION__: JSON.stringify(metadata.version),
  __PLANVIEW_BUILD__: JSON.stringify(metadata.planviewBuild ?? null),
};

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  define,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["effect"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
});

await build({
  entryPoints: ["../../packages/daemon/src/entry.ts"],
  outfile: "dist/daemon.js",
  bundle: true,
  define,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["effect"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
});
