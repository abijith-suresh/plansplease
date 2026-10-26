import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { npmPackFilename } from "./npm-pack-result.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(repositoryRoot, "apps/cli");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("a clean build is included by the package dry run", () => {
  rmSync(resolve(packageRoot, "dist"), { force: true, recursive: true });
  const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.ok(npmPackFilename(JSON.parse(result.stdout)));
  assert.match(result.stdout, /"path": "dist\/index\.js"/);
  assert.match(result.stdout, /"path": "dist\/manager\/index\.html"/);
  assert.match(result.stdout, /"path": "dist\/manager\/assets\/[^"]+\.js"/);
  assert.match(result.stdout, /"path": "dist\/manager\/assets\/[^"]+\.css"/);
  assert.match(result.stdout, /"path": "dist\/index\.d\.ts"/);
  assert.match(result.stdout, /"path": "skills\/planview\/SKILL\.md"/);
  assert.match(result.stdout, /"path": "skills\/create-html\/SKILL\.md"/);
  assert.match(
    result.stdout,
    /"path": "skills\/create-html\/references\/browser-native-patterns\.md"/
  );
  assert.match(result.stdout, /"path": "skills\/create-html\/assets\/document\.html"/);
  assert.match(result.stdout, /"path": "man\/plansplease\.1"/);
});
