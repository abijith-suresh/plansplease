import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (file) => readFileSync(resolve(root, file), "utf8");
const readJson = (file) => JSON.parse(readText(file));

test("repository toolchain declarations agree and support the checked-in runtime", () => {
  const packageJson = readJson("package.json");
  const nodeVersion = readText(".node-version").trim();
  const pinnedNpmVersion = packageJson.packageManager?.match(/^npm@(.+)$/)?.[1];

  assert.ok(semver.valid(nodeVersion), ".node-version must contain an exact Node version");
  assert.ok(semver.satisfies(nodeVersion, packageJson.engines.node));
  assert.ok(semver.valid(pinnedNpmVersion), "packageManager must pin an exact npm version");
  assert.ok(semver.satisfies(pinnedNpmVersion, packageJson.engines.npm));
  assert.deepEqual(readJson("package-lock.json").packages[""].engines, packageJson.engines);
  assert.match(readText(".github/workflows/ci.yml"), /node-version-file: \.node-version/);
  assert.match(readText(".github/workflows/ci.yml"), /packageManager/);

  const compilerOptions = readJson("tsconfig.base.json").compilerOptions;
  for (const [option, value] of Object.entries({
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    verbatimModuleSyntax: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
  })) {
    assert.equal(compilerOptions[option], value, `TypeScript ${option} constraint`);
  }
});

test("workspace privacy, package boundaries and lockfile names stay consistent", () => {
  const packageJson = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const manifests = [
    ["apps/app/package.json", "apps/app"],
    ["apps/cli/package.json", "apps/cli"],
    ["apps/docs/package.json", "apps/docs"],
    ["apps/site/package.json", "apps/site"],
    ["packages/core/package.json", "packages/core"],
    ["packages/daemon/package.json", "packages/daemon"],
    ["packages/local/package.json", "packages/local"],
    ["packages/storage/package.json", "packages/storage"],
  ];

  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, "module");
  assert.deepEqual(lockfile.packages[""].workspaces, packageJson.workspaces);
  for (const [file, lockPath] of manifests) {
    const manifest = readJson(file);
    assert.equal(lockfile.packages[lockPath]?.name, manifest.name, `${file} lock name`);
    assert.equal(lockfile.packages[lockPath]?.version, manifest.version, `${file} lock version`);
    if (file !== "apps/cli/package.json") assert.equal(manifest.private, true, `${file} privacy`);
    assert.equal(manifest.type, "module", `${file} module type`);
  }

  const cli = readJson("apps/cli/package.json");
  const core = readJson("packages/core/package.json");
  const app = readJson("apps/app/package.json");
  assert.equal(cli.name, "@abijith-suresh/planview");
  assert.deepEqual(cli.bin, { plansplease: "./dist/index.js" });
  assert.equal(cli.dependencies?.[core.name], undefined, "the CLI bundles private Core");
  assert.equal(cli.devDependencies?.[core.name], core.version);
  assert.equal(cli.devDependencies?.["@planview/daemon"], undefined);
  assert.equal(app.dependencies?.[core.name], core.version);
  assert.equal(lockfile.packages["node_modules/@abijith-suresh/planview"]?.resolved, "apps/cli");
  assert.equal(lockfile.packages["node_modules/@abijith-suresh/planview"]?.link, true);
  assert.equal(lockfile.packages["node_modules/planview"], undefined);
  assert.equal(Object.keys(core.dependencies ?? {}).length, 0, "Core has no runtime dependencies");
});

test("release controls remain enabled without enabling automatic npm publishing", () => {
  const packageJson = readJson("package.json");
  const cli = readJson("apps/cli/package.json");
  const releaseWorkflow = readText(".github/workflows/release.yml");
  const publishScript = readText("scripts/publish-verified.mjs");

  for (const name of ["release-policy", "verify", "changeset:check", "pack:check"]) {
    assert.equal(typeof packageJson.scripts[name], "string", `missing ${name} script`);
  }
  assert.equal(cli.name, "@abijith-suresh/planview");
  assert.ok(cli.scripts.prepack, "CLI package builds before packing");
  assert.match(readText("apps/cli/src/help.ts"), /npx skills add/);
  assert.doesNotMatch(readText("apps/cli/src/index.ts"), /installSkills|SkillsCommandError/);
  assert.match(readText("apps/cli/skills/planview/SKILL.md"), /^name: planview/m);
  assert.match(readText("apps/cli/skills/create-html/SKILL.md"), /^name: create-html/m);
  assert.match(releaseWorkflow, /changesets\/action@/);
  assert.match(releaseWorkflow, /npm run version-packages/);
  assert.match(releaseWorkflow, /npm ci --ignore-scripts/);
  assert.match(releaseWorkflow, /secrets\.RELEASE_TOKEN/);
  assert.match(releaseWorkflow, /changeset-release\/main/);
  assert.doesNotMatch(releaseWorkflow, /refs\/tags\/v/);
  assert.match(publishScript, /delete environment\.RELEASE_TOKEN/);
  assert.match(publishScript, /--ignore-scripts/);
  assert.match(publishScript, /PLANVIEW_NPM_PUBLISH/);
});
