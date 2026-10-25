import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditWorkspaceBoundaries } from "./workspace-boundary.mjs";

const workspaces = [
  ["packages/core", "@planview/core"],
  ["packages/storage", "@planview/storage"],
  ["packages/daemon", "@planview/daemon"],
  ["packages/local", "@planview/local"],
  ["apps/cli", "@abijith-suresh/planview"],
  ["apps/app", "@planview/app"],
  ["apps/site", "@planview/site"],
  ["apps/docs", "@planview/docs"],
];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "planview-boundaries-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  write("package.json", { workspaces: ["apps/*", "packages/*"] });
  for (const [path, name] of workspaces) write(`${path}/package.json`, { name });
  return { root, write };
}
const edges = (root) =>
  auditWorkspaceBoundaries(root).map(({ file, target }) => ({ file, target }));

test("repository manifests and authored imports follow workspace dependency direction", () => {
  assert.deepEqual(auditWorkspaceBoundaries(fileURLToPath(new URL("..", import.meta.url))), []);
});

test("manifest checks allow declared directions and reject reverse dependencies", (t) => {
  const { root, write } = fixture(t);
  write("packages/storage/package.json", {
    name: "@planview/storage",
    dependencies: { "@planview/core": "0.1.0" },
  });
  write("packages/core/package.json", {
    name: "@planview/core",
    devDependencies: { "@planview/daemon": "0.1.0" },
  });
  assert.deepEqual(edges(root), [
    { file: "packages/core/package.json", target: "@planview/daemon" },
  ]);
});

test("source checks inspect imports, exports, type imports, and literal module calls", (t) => {
  const { root, write } = fixture(t);
  write(
    "packages/core/src/imports.ts",
    `
    import "@planview/daemon";
    export * from "@planview/storage";
    type Document = import("@planview/app").Document;
    const load = () => import("@planview/local");
    const legacy = require("@abijith-suresh/planview");
  `
  );
  assert.deepEqual(
    auditWorkspaceBoundaries(root).map(({ specifier }) => specifier),
    [
      "@abijith-suresh/planview",
      "@planview/app",
      "@planview/daemon",
      "@planview/local",
      "@planview/storage",
    ]
  );
});

test("relative and TypeScript path imports resolve to their workspace", (t) => {
  const { root, write } = fixture(t);
  write("packages/daemon/src/index.ts", "export const daemon = true;");
  write("apps/app/tsconfig.json", {
    compilerOptions: { paths: { "@internal/*": ["../../packages/daemon/src/*"] } },
  });
  write(
    "apps/app/src/index.ts",
    'import "@internal/index"; import "../../../packages/daemon/src/index.ts";'
  );
  assert.deepEqual(edges(root), [
    { file: "apps/app/src/index.ts", target: "@planview/daemon" },
    { file: "apps/app/src/index.ts", target: "@planview/daemon" },
  ]);
});

test("Astro frontmatter, scripts, and expressions use the same import check", (t) => {
  const { root, write } = fixture(t);
  write(
    "apps/site/src/page.astro",
    `---
import "@planview/app";
---
<script>import "@planview/daemon";</script>
<div>{import("@planview/storage")}</div>
<p>import "@planview/local";</p>
<script type="application/json">{"example":"@planview/core"}</script>`
  );
  assert.deepEqual(
    auditWorkspaceBoundaries(root).map(({ specifier }) => specifier),
    ["@planview/app", "@planview/daemon", "@planview/storage"]
  );
});

test("comments, strings, tests, and generated outputs do not create source dependencies", (t) => {
  const { root, write } = fixture(t);
  for (const path of [
    "test/example.ts",
    "dist/index.js",
    "src/_generated/api.ts",
    "src/example.test.ts",
  ]) {
    write(`packages/core/${path}`, 'import "@planview/daemon";');
  }
  write(
    "packages/core/src/index.ts",
    `// import "@planview/daemon";
    const example = 'import "@planview/daemon";';`
  );
  assert.deepEqual(edges(root), []);
});
