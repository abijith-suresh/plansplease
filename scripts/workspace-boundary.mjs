import { globSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { convertToTSX } from "@astrojs/compiler/sync";
import ts from "typescript";

const allowedDependencies = new Map([
  ["@planview/core", []],
  ["@planview/storage", ["@planview/core"]],
  ["@planview/daemon", ["@planview/core", "@planview/storage"]],
  ["@planview/local", ["@planview/core", "@planview/storage", "@planview/daemon"]],
  ["@abijith-suresh/planview", ["@planview/core", "@planview/local"]],
  ["@planview/app", ["@planview/core"]],
  ["@planview/site", []],
  ["@planview/docs", []],
]);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "_generated",
  "__generated__",
  "generated",
]);
const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".astro",
]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const contains = (directory, path) => path === directory || path.startsWith(`${directory}${sep}`);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name.startsWith(".") || ignoredDirectories.has(entry.name)
        ? []
        : sourceFiles(path);
    }
    return entry.isFile() &&
      sourceExtensions.has(extname(entry.name)) &&
      !/\.(?:test|spec)\.[^.]+$/.test(entry.name)
      ? [path]
      : [];
  });
}

function compilerOptions(directory) {
  const path = join(directory, "tsconfig.json");
  const loaded = ts.readConfigFile(path, ts.sys.readFile);
  if (loaded.error?.code === 5083) return {};
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, " "));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, directory);
  const errors = parsed.errors.filter((error) => error.code !== 18003);
  if (errors.length) {
    throw new Error(
      errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")
    );
  }
  return parsed.options;
}

function imports(file) {
  const text = readFileSync(file, "utf8");
  const code = extname(file) === ".astro" ? convertToTSX(text, { filename: file }).code : text;
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    extname(file) === ".astro" ? ts.ScriptKind.TSX : undefined
  );
  const specifiers = new Set([
    ...source.referencedFiles.map(({ fileName }) => fileName),
    ...source.typeReferenceDirectives.map(({ fileName }) => fileName),
  ]);
  const add = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

export function auditWorkspaceBoundaries(repositoryRoot) {
  const root = realpathSync(resolve(repositoryRoot));
  const patterns = readJson(join(root, "package.json")).workspaces;
  const workspaces = globSync(
    patterns.map((pattern) => `${pattern}/package.json`),
    { cwd: root }
  ).map((path) => {
    const manifestPath = join(root, path);
    const manifest = readJson(manifestPath);
    return { path: dirname(manifestPath), manifestPath, manifest, name: manifest.name };
  });
  for (const name of allowedDependencies.keys()) {
    if (!workspaces.some((workspace) => workspace.name === name))
      throw new Error(`Missing workspace ${name}`);
  }
  const workspaceAt = (path) => workspaces.find((workspace) => contains(workspace.path, path));
  const packageNamed = (specifier) =>
    workspaces.find(({ name }) => specifier === name || specifier.startsWith(`${name}/`));
  const violations = [];
  const check = (source, target, file, kind, specifier) => {
    if (
      !target ||
      source.name === target.name ||
      allowedDependencies.get(source.name)?.includes(target.name)
    )
      return;
    const path = relative(root, file).split(sep).join("/");
    violations.push({
      file: path,
      kind,
      source: source.name,
      target: target.name,
      specifier,
      message: `${path}: ${source.name} may not depend on ${target.name} through ${specifier}`,
    });
  };

  for (const workspace of workspaces) {
    for (const field of dependencyFields) {
      for (const name of Object.keys(workspace.manifest[field] ?? {})) {
        check(
          workspace,
          packageNamed(name),
          workspace.manifestPath,
          "manifest",
          `${field}.${name}`
        );
      }
    }
    const options = compilerOptions(workspace.path);
    for (const file of sourceFiles(workspace.path)) {
      for (const specifier of imports(file)) {
        const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
        const target =
          packageNamed(specifier) ??
          (resolved
            ? workspaceAt(realpathSync(resolved.resolvedFileName))
            : specifier.startsWith(".")
              ? workspaceAt(resolve(dirname(file), specifier))
              : undefined);
        check(workspace, target, file, "import", specifier);
      }
    }
  }
  return violations.sort(
    (a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier)
  );
}
