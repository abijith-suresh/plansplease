import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readText = (file) => {
  try {
    return readFileSync(resolve(root, file), "utf8");
  } catch (error) {
    assert.fail(`${file} should be readable: ${error.message}`);
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    assert.fail(`${file} should contain valid JSON: ${error.message}`);
  }
};

const expectEqual = (actual, expected, description) => {
  assert.deepEqual(actual, expected, `${description} is incorrect`);
};

const expectProperty = (object, property, expected, description) => {
  assert.equal(object?.[property], expected, `${description} is incorrect`);
};

test("repository foundation has the expected configuration", () => {
  expectEqual(readText(".node-version").trim(), "24.19.0", ".node-version");

  const biome = readJson("biome.json");
  expectEqual(biome.$schema, "https://biomejs.dev/schemas/2.5.15/schema.json", "Biome schema");
  expectProperty(biome.vcs, "enabled", true, "Biome VCS enabled setting");
  expectProperty(biome.vcs, "clientKind", "git", "Biome VCS client kind");
  expectProperty(biome.vcs, "useIgnoreFile", true, "Biome VCS ignore-file setting");
  expectProperty(biome.formatter, "indentStyle", "space", "Biome formatter indent style");
  expectProperty(biome.formatter, "indentWidth", 2, "Biome formatter indent width");
  expectProperty(biome.formatter, "lineWidth", 100, "Biome formatter line width");
  expectProperty(biome.linter?.rules, "preset", "recommended", "Biome lint preset");
  expectProperty(
    biome.linter?.rules?.correctness,
    "noUnusedVariables",
    "error",
    "Biome correctness noUnusedVariables rule"
  );
  expectProperty(biome.linter?.rules?.style, "useConst", "error", "Biome style useConst rule");
  expectProperty(
    biome.linter?.rules?.suspicious,
    "noConsole",
    "warn",
    "Biome suspicious noConsole rule"
  );
  expectProperty(biome.linter?.rules?.suspicious, "noVar", "error", "Biome suspicious noVar rule");
  expectProperty(
    biome.overrides?.[0]?.linter?.rules?.a11y,
    "useAnchorContent",
    "off",
    "Biome Markdown a11y rule override"
  );
  expectProperty(
    biome.javascript?.formatter,
    "quoteStyle",
    "double",
    "Biome JavaScript quote style"
  );
  expectProperty(
    biome.javascript?.formatter,
    "semicolons",
    "always",
    "Biome JavaScript semicolons"
  );
  expectProperty(
    biome.javascript?.formatter,
    "trailingCommas",
    "es5",
    "Biome JavaScript trailing commas"
  );
  expectProperty(
    biome.javascript?.formatter,
    "bracketSpacing",
    true,
    "Biome JavaScript bracket spacing"
  );
  expectProperty(
    biome.javascript?.formatter,
    "arrowParentheses",
    "always",
    "Biome JavaScript arrow parentheses"
  );

  const tsBase = readJson("tsconfig.base.json");
  const requiredCompilerOptions = {
    target: "ES2024",
    lib: ["ES2024"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    forceConsistentCasingInFileNames: true,
    noUncheckedIndexedAccess: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true,
    exactOptionalPropertyTypes: true,
  };
  for (const [option, value] of Object.entries(requiredCompilerOptions)) {
    expectEqual(tsBase.compilerOptions?.[option], value, `TypeScript compiler option ${option}`);
  }

  const rootTsConfig = readJson("tsconfig.json");
  expectEqual(rootTsConfig.extends, "./tsconfig.base.json", "root TypeScript extends");
  expectEqual(rootTsConfig.files, [], "root TypeScript files");
  expectEqual(rootTsConfig.include, [], "root TypeScript include");

  const buildTsConfig = readJson("tsconfig.build.base.json");
  expectEqual(buildTsConfig.extends, "./tsconfig.base.json", "build TypeScript extends");
  expectEqual(
    buildTsConfig.compilerOptions,
    { declaration: true, composite: true, noEmitOnError: true, types: ["node"] },
    "shared TypeScript build options"
  );

  const testTsConfig = readJson("tsconfig.test.base.json");
  expectEqual(testTsConfig.extends, "./tsconfig.base.json", "test TypeScript extends");
  expectEqual(
    testTsConfig.compilerOptions,
    { noEmit: true, allowImportingTsExtensions: true, types: ["node"] },
    "shared TypeScript test options"
  );

  const packageJson = readJson("package.json");
  expectEqual(packageJson.private, true, "package privacy");
  expectEqual(packageJson.type, "module", "package module type");
  expectEqual(packageJson.workspaces, ["apps/*", "packages/*"], "workspaces");
  expectProperty(packageJson.engines, "node", ">=24.19.0 <25", "Node engine");
  expectProperty(packageJson.engines, "npm", ">=11.16.0", "npm engine");
  expectProperty(packageJson, "packageManager", "npm@11.16.0", "package manager");
  expectProperty(packageJson.devDependencies, "@biomejs/biome", "2.5.15", "Biome dependency");
  expectProperty(packageJson.devDependencies, "@changesets/cli", "2.31.1", "Changesets dependency");
  expectProperty(
    packageJson.devDependencies,
    "@changesets/parse",
    "0.4.3",
    "Changesets parser dependency"
  );
  expectProperty(packageJson.devDependencies, "semver", "7.8.5", "SemVer dependency");
  expectProperty(packageJson.devDependencies, "typescript", "6.0.3", "TypeScript dependency");
  expectProperty(
    packageJson.scripts,
    "build",
    "npm run build --workspaces --if-present",
    "build script"
  );
  expectProperty(
    packageJson.scripts,
    "check",
    "npm run release-policy && npm run format:check && npm run lint && npm run typecheck && npm run test",
    "check script"
  );
  expectProperty(packageJson.scripts, "format", "biome format --write .", "format script");
  expectProperty(packageJson.scripts, "format:check", "biome format .", "format check script");
  expectProperty(
    packageJson.scripts,
    "release-policy",
    "node scripts/release-policy.mjs",
    "release-policy script"
  );
  expectProperty(packageJson.scripts, "lint", "biome lint .", "lint script");
  expectProperty(
    packageJson.scripts,
    "test",
    'node --test "scripts/**/*.test.mjs" && npm run test --workspaces --if-present',
    "test script"
  );
  expectProperty(
    packageJson.scripts,
    "typecheck",
    "npm run typecheck --workspaces --if-present",
    "typecheck script"
  );
  expectProperty(packageJson.scripts, "verify", "npm run check && npm run build", "verify script");
  expectProperty(
    packageJson.scripts,
    "version-packages",
    "npm run release-policy && changeset version && npm install --package-lock-only --ignore-scripts",
    "version-packages script"
  );
  expectProperty(
    packageJson.scripts,
    "pack:verified",
    "npm pack --workspace @abijith-suresh/planview --ignore-scripts",
    "verified pack script"
  );
  expectProperty(
    packageJson.scripts,
    "publish:verified",
    "node scripts/publish-verified.mjs",
    "verified publish script"
  );
  const publishScript = readText("scripts/publish-verified.mjs");
  assert.match(publishScript, /--ignore-scripts/);
  const releaseWorkflow = readText(".github/workflows/release.yml");
  assert.match(releaseWorkflow, /changesets\/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d/);
  assert.match(releaseWorkflow, /version: npm run version-packages/);
  assert.match(releaseWorkflow, /npm ci --ignore-scripts/);
  assert.match(releaseWorkflow, /secrets\.RELEASE_TOKEN/);
  assert.match(releaseWorkflow, /changeset-release\/main/);
  assert.doesNotMatch(releaseWorkflow, /refs\/tags\/v/);
  assert.match(publishScript, /delete environment\.RELEASE_TOKEN/);
  assert.match(publishScript, /--ignore-scripts/);
  assert.match(publishScript, /PLANVIEW_NPM_PUBLISH/);
  expectProperty(packageJson.scripts, "release", "node scripts/release.mjs", "release script");

  const cliPackageJson = readJson("apps/cli/package.json");
  expectEqual(cliPackageJson.name, "@abijith-suresh/planview", "CLI package name");
  expectEqual(cliPackageJson.type, "module", "CLI package module type");
  expectProperty(
    cliPackageJson.devDependencies,
    "@planview/core",
    "0.1.0",
    "CLI bundled Core format dependency"
  );
  assert.equal(
    cliPackageJson.dependencies?.["@planview/core"],
    undefined,
    "the published CLI must bundle private Core instead of requiring it at runtime"
  );
  assert.equal(
    cliPackageJson.devDependencies?.["@planview/daemon"],
    undefined,
    "the public package must not declare private daemon"
  );
  expectProperty(
    cliPackageJson.devDependencies,
    "@planview/local",
    "0.1.0",
    "CLI local application dependency"
  );
  expectProperty(cliPackageJson.bin, "plansplease", "./dist/index.js", "primary CLI bin mapping");
  expectEqual(cliPackageJson.files, ["dist", "skills", "man", "README.md"], "CLI publish files");
  expectEqual(cliPackageJson.man, "./man/plansplease.1", "CLI man page");
  expectProperty(
    cliPackageJson.scripts,
    "build",
    "npm run build --workspace @planview/local && tsc --project tsconfig.json && node scripts/bundle.mjs && node scripts/make-executable.mjs dist/index.js",
    "CLI build script"
  );
  expectProperty(cliPackageJson.scripts, "prepack", "npm run build", "CLI prepack script");
  const cliSource = readText("apps/cli/src/index.ts");
  assert.match(cliSource, /from "\.\.\/package\.json" with \{ type: "json" \}/);
  assert.match(readText("apps/cli/src/help.ts"), /skills install/);
  assert.match(readText("apps/cli/skills/planview/SKILL.md"), /^name: planview/m);
  assert.match(readText("apps/cli/skills/create-html/SKILL.md"), /^name: create-html/m);
  assert.match(cliSource, /export const VERSION = packageVersion;/);
  assert.doesNotMatch(cliSource, /export const VERSION = ["']/);
  const cliTsConfig = readJson("apps/cli/tsconfig.json");
  expectProperty(
    cliTsConfig.compilerOptions,
    "resolveJsonModule",
    true,
    "CLI JSON module resolution"
  );
  expectProperty(
    cliPackageJson.scripts,
    "typecheck",
    "npm run build --workspace @planview/local && tsc --project tsconfig.json --noEmit",
    "CLI typecheck script"
  );
  expectProperty(
    cliPackageJson.scripts,
    "test",
    'npm run build && npm run typecheck:test && node --test "test/**/*.test.mts"',
    "CLI test script"
  );
  expectProperty(
    cliPackageJson.scripts,
    "typecheck:test",
    "tsc --project tsconfig.test.json",
    "CLI test typecheck script"
  );

  const daemonPackageJson = readJson("packages/daemon/package.json");
  expectEqual(daemonPackageJson.name, "@planview/daemon", "daemon package name");
  expectProperty(
    daemonPackageJson.scripts,
    "test",
    'npm run build && npm run typecheck:test && node --test "test/**/*.test.mts"',
    "daemon test script"
  );
  expectProperty(
    daemonPackageJson.scripts,
    "typecheck:test",
    "tsc --project tsconfig.test.json",
    "daemon test typecheck script"
  );

  const localPackageJson = readJson("packages/local/package.json");
  expectEqual(localPackageJson.name, "@planview/local", "local package name");
  expectEqual(localPackageJson.private, true, "local package privacy");
  expectEqual(localPackageJson.type, "module", "local package module type");
  expectProperty(
    localPackageJson.scripts,
    "build",
    "tsc --build tsconfig.json",
    "local build script"
  );
  expectProperty(
    localPackageJson.scripts,
    "test",
    'npm run build && npm run typecheck:test && node --test "test/**/*.test.mts"',
    "local test script"
  );
  expectProperty(
    localPackageJson.scripts,
    "typecheck",
    "tsc --project tsconfig.typecheck.json",
    "local typecheck script"
  );
  expectProperty(
    localPackageJson.scripts,
    "typecheck:test",
    "tsc --project tsconfig.test.json",
    "local test typecheck script"
  );
  expectEqual(
    localPackageJson.dependencies,
    {
      "@planview/core": "0.1.0",
      "@planview/daemon": "0.1.0",
      "@planview/storage": "0.1.0",
      effect: "4.0.6",
    },
    "local dependencies"
  );
  const localTsConfig = readJson("packages/local/tsconfig.json");
  expectEqual(localTsConfig.extends, "../../tsconfig.build.base.json", "local shared build config");
  expectProperty(
    localTsConfig.compilerOptions,
    "tsBuildInfoFile",
    "dist/.tsbuildinfo",
    "local build state location"
  );
  expectEqual(
    localTsConfig.references,
    [{ path: "../core" }, { path: "../storage" }, { path: "../daemon" }],
    "local TypeScript project references"
  );

  const corePackageJson = readJson("packages/core/package.json");
  expectEqual(corePackageJson.name, "@planview/core", "core package name");
  expectEqual(corePackageJson.private, true, "core package privacy");
  expectEqual(corePackageJson.type, "module", "core package module type");
  expectProperty(
    corePackageJson.scripts,
    "build",
    "tsc --build tsconfig.json",
    "core build script"
  );
  expectProperty(
    corePackageJson.scripts,
    "test",
    'npm run build && npm run typecheck:test && node --test "test/**/*.test.mts"',
    "core test script"
  );
  expectProperty(
    corePackageJson.scripts,
    "typecheck",
    "tsc --project tsconfig.typecheck.json",
    "core typecheck script"
  );
  expectProperty(
    corePackageJson.scripts,
    "typecheck:test",
    "tsc --project tsconfig.test.json",
    "core test typecheck script"
  );
  const coreTsConfig = readJson("packages/core/tsconfig.json");
  expectEqual(coreTsConfig.extends, "../../tsconfig.build.base.json", "core shared build config");
  expectProperty(
    coreTsConfig.compilerOptions,
    "tsBuildInfoFile",
    "dist/.tsbuildinfo",
    "core build state location"
  );
  const coreTypecheckTsConfig = readJson("packages/core/tsconfig.typecheck.json");
  expectEqual(
    coreTypecheckTsConfig.compilerOptions,
    { noEmit: true, composite: false },
    "core clean-checkout typecheck compiler options"
  );

  const storagePackageJson = readJson("packages/storage/package.json");
  expectEqual(storagePackageJson.name, "@planview/storage", "storage package name");
  expectEqual(storagePackageJson.private, true, "storage package privacy");
  expectEqual(storagePackageJson.type, "module", "storage package module type");
  expectProperty(
    storagePackageJson.scripts,
    "build",
    "tsc --build tsconfig.json",
    "storage build script"
  );
  expectProperty(
    storagePackageJson.scripts,
    "test",
    'npm run build && npm run typecheck:test && node --test "test/**/*.test.mts"',
    "storage test script"
  );
  expectProperty(
    storagePackageJson.scripts,
    "typecheck:test",
    "tsc --project tsconfig.test.json",
    "storage test typecheck script"
  );
  expectProperty(
    storagePackageJson.scripts,
    "typecheck",
    "tsc --project tsconfig.typecheck.json",
    "storage typecheck script"
  );
  const storageTsConfig = readJson("packages/storage/tsconfig.json");
  expectEqual(
    storageTsConfig.extends,
    "../../tsconfig.build.base.json",
    "storage shared build config"
  );
  expectProperty(
    storageTsConfig.compilerOptions,
    "tsBuildInfoFile",
    "dist/.tsbuildinfo",
    "storage build state location"
  );
  expectEqual(
    storageTsConfig.references,
    [{ path: "../core" }],
    "storage TypeScript project references"
  );
  const storageTypecheckTsConfig = readJson("packages/storage/tsconfig.typecheck.json");
  expectEqual(
    storageTypecheckTsConfig.compilerOptions,
    {
      noEmit: true,
      composite: false,
      rootDir: "..",
      paths: { "@planview/core": ["../core/src/index.ts"] },
    },
    "storage clean-checkout typecheck compiler options"
  );
  expectProperty(storagePackageJson.dependencies, "effect", "4.0.6", "storage Effect dependency");

  const docsPackageJson = readJson("apps/docs/package.json");
  expectProperty(docsPackageJson, "name", "@planview/docs", "docs package name");
  expectProperty(docsPackageJson, "private", true, "docs package privacy");
  expectProperty(docsPackageJson.scripts, "start", "node server.mjs", "docs static start command");
  expectProperty(
    readJson("apps/docs/tsconfig.json"),
    "extends",
    "../../tsconfig.base.json",
    "docs shared compiler settings"
  );

  const lockfile = readJson("package-lock.json");
  expectEqual(lockfile.lockfileVersion, 3, "lockfile version");
  assert.ok(
    lockfile.packages && typeof lockfile.packages[""] === "object",
    "package-lock.json should have a root package entry"
  );
  const lockRoot = lockfile.packages[""];
  expectProperty(lockRoot, "name", packageJson.name, "package-lock root name");
  expectEqual(lockRoot.workspaces, packageJson.workspaces, "package-lock root workspaces");
  expectProperty(
    lockRoot.engines,
    "node",
    packageJson.engines.node,
    "package-lock root Node engine"
  );
  expectProperty(lockRoot.engines, "npm", packageJson.engines.npm, "package-lock root npm engine");
  expectProperty(
    lockRoot.devDependencies,
    "@biomejs/biome",
    packageJson.devDependencies["@biomejs/biome"],
    "package-lock root Biome dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "@changesets/parse",
    packageJson.devDependencies["@changesets/parse"],
    "package-lock root Changesets parser dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "semver",
    packageJson.devDependencies.semver,
    "package-lock root SemVer dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "typescript",
    packageJson.devDependencies.typescript,
    "package-lock root TypeScript dependency"
  );

  const cliLockPackage = lockfile.packages["apps/cli"];
  expectProperty(cliLockPackage, "name", cliPackageJson.name, "package-lock CLI package name");
  expectProperty(
    cliLockPackage,
    "version",
    cliPackageJson.version,
    "package-lock CLI package version"
  );
  assert.ok(
    lockfile.packages["node_modules/@abijith-suresh/planview"],
    "package-lock should select the scoped public workspace"
  );
  assert.equal(
    lockfile.packages["node_modules/planview"],
    undefined,
    "package-lock should not select an unscoped public workspace"
  );

  const coreLockPackage = lockfile.packages["packages/core"];
  expectProperty(coreLockPackage, "name", corePackageJson.name, "package-lock core package name");
  expectProperty(coreLockPackage, "version", corePackageJson.version, "package-lock core version");

  const storageLockPackage = lockfile.packages["packages/storage"];
  expectProperty(
    storageLockPackage,
    "name",
    storagePackageJson.name,
    "package-lock storage package name"
  );
  expectProperty(
    storageLockPackage,
    "version",
    storagePackageJson.version,
    "package-lock storage version"
  );

  const localLockPackage = lockfile.packages["packages/local"];
  expectProperty(
    localLockPackage,
    "name",
    localPackageJson.name,
    "package-lock local package name"
  );
  expectProperty(
    localLockPackage,
    "version",
    localPackageJson.version,
    "package-lock local package version"
  );
});
