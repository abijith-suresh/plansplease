import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { makeBuildIdentity, validateBuildIdentity } from "../packages/core/src/build-identity.ts";
import { runNpm } from "./npm-command.mjs";

const gitEnvironment = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
});
export function installationPath(value) {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error("Supply an absolute new destination.");
  if (
    process.platform === "win32" &&
    (/[&%^!]/.test(value) || [...value].some((c) => c.charCodeAt(0) < 32))
  )
    throw new Error("Windows npm launcher paths cannot contain &, %, ^, ! or controls.");
  return resolve(value);
}

const packages = [{ name: "@abijith-suresh/planview", directory: "apps/cli" }];
const runtimeVersion = "4.0.6";
const CONSUMER = {
  name: "plansplease-candidate-consumer",
  version: "0.0.0",
  private: true,
  type: "module",
};
function validateRepository(root) {
  const metadata = json(join(root, "apps/cli/package.json"));
  if (
    metadata.name !== packages[0].name ||
    !isDeepStrictEqual(metadata.dependencies, { effect: runtimeVersion })
  )
    invalid("Unexpected public/runtime package graph.");
  const locked = json(join(root, "package-lock.json")).packages["node_modules/effect"];
  if (
    locked.version !== runtimeVersion ||
    locked.dependencies ||
    locked.optionalDependencies ||
    locked.peerDependencies ||
    locked.resolved !== "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(locked.integrity)
  )
    invalid("Unexpected runtime dependency lock.");
  return {
    manifests: [metadata],
    runtime: { version: locked.version, resolved: locked.resolved, integrity: locked.integrity },
  };
}

const REQUIREMENTS = { node: ">=24.19.0 <25", npm: "11.16.0" };
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 8192;
const invalid = (message = "Invalid prerelease artifact.") => {
  throw new Error(message);
};
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const integrity = (data) => `sha512-${createHash("sha512").update(data).digest("base64")}`;
const json = (file) => JSON.parse(readBounded(file).toString("utf8"));
const encode = (value) => `${JSON.stringify(value, null, 2)}\n`;
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
const safePath = (value) =>
  typeof value === "string" &&
  value.length <= 512 &&
  !value.includes("\\") &&
  [...value].every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
  ) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"));
const publicPath = (value) =>
  safePath(value) &&
  (value === "package.json" ||
    /^(?:readme|license)(?:\.[a-z0-9]+)?$/i.test(value) ||
    /^(?:dist|skills|man)\//.test(value));
function readBounded(file, limit = MAX_FILE) {
  const observed = lstatSync(file);
  if (!observed.isFile()) invalid();
  const descriptor = openSync(
    file,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW)
  );
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size > limit ||
      stat.dev !== observed.dev ||
      stat.ino !== observed.ino
    )
      invalid();
    // One extra byte detects a file growing after stat without an unbounded read.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(descriptor);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      invalid();
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}
const invoke = (args, cwd) =>
  runNpm(args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    maxBuffer: MAX_TOTAL,
    stdio: ["ignore", "pipe", "pipe"],
  });
const git = (root, args, options = {}) =>
  execFileSync("git", args, {
    cwd: root,
    env: gitEnvironment(),
    windowsHide: true,
    maxBuffer: MAX_TOTAL,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
function toolchain() {
  if (
    process.versions.node !== "24.19.0" ||
    invoke(["--version"], process.cwd()).trim() !== REQUIREMENTS.npm
  )
    invalid("Preparation requires Node 24.19.0 and repository-pinned npm 11.16.0.");
}
function outside(directory, root) {
  const part = relative(root, directory);
  return part !== "" && (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part));
}
function createDestination(destination, forbiddenRoot) {
  let directory = installationPath(destination);
  directory = installationPath(join(realpathSync(dirname(directory)), basename(directory)));
  if (forbiddenRoot && !outside(directory, realpathSync(forbiddenRoot)))
    invalid("Choose a new destination outside the source repository.");
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    invalid(
      error.code === "EEXIST"
        ? "The destination already exists. Choose a new directory."
        : "Cannot create the destination directory."
    );
  }
  return directory;
}

export const validatePreparationIdentity = makeBuildIdentity;
export function validateDispatch(context) {
  if (!context || ![undefined, false, "false"].includes(context.publishRequested))
    invalid("Publication is disabled: no owner-controlled publication gate is configured.");
  const identity = validateBuildIdentity(context.identity);
  if (
    context.eventName !== "workflow_dispatch" ||
    context.repository !== "abijith-suresh/plansplease" ||
    context.ref !== "refs/heads/main" ||
    context.sourceSha !== identity.sourceSha ||
    context.checkedOutSha !== identity.sourceSha
  )
    invalid("Prerelease dispatch must use the trusted main revision and repository.");
  return identity;
}

/** Export one bounded Git object snapshot; never switch or modify the bound checkout. */
export function snapshotCommit(root, directory, sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || /^0+$/.test(sha))
    invalid("Supply a full source commit SHA.");
  if (git(root, ["rev-parse", "--verify", `${sha}^{commit}`], { encoding: "utf8" }).trim() !== sha)
    invalid("Source SHA must identify a commit.");
  const records = git(root, ["ls-tree", "-rz", "--full-tree", sha])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!records.length || records.length > MAX_FILES)
    invalid("Source snapshot exceeds its file bound.");
  const entries = records.map((record) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match || !safePath(match[3]))
      invalid("Source snapshot contains unsupported paths or file types.");
    return { mode: match[1], oid: match[2], path: match[3] };
  });
  const contents = git(root, ["cat-file", "--batch"], {
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
  });
  let cursor = 0,
    total = 0;
  for (const entry of entries) {
    const end = contents.indexOf(10, cursor);
    if (end < cursor) invalid();
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(
      contents.subarray(cursor, end).toString("ascii")
    );
    const size = Number(match?.[2]);
    total += size;
    if (
      !match ||
      match[1] !== entry.oid ||
      !Number.isSafeInteger(size) ||
      size > MAX_FILE ||
      total > MAX_TOTAL ||
      end + size + 1 >= contents.length ||
      contents[end + size + 1] !== 10
    )
      invalid("Source snapshot exceeds its content bound.");
    const file = join(directory, entry.path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents.subarray(end + 1, end + 1 + size));
    chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
    cursor = end + size + 2;
  }
  if (cursor !== contents.length) invalid();
}

export function validateManifest(value) {
  if (
    !keys(value, [
      "schemaVersion",
      "build",
      "tag",
      "publication",
      "requirements",
      "runtime",
      "packages",
    ]) ||
    value.schemaVersion !== 1 ||
    value.publication !== "disabled" ||
    !isDeepStrictEqual(value.requirements, REQUIREMENTS)
  )
    invalid();
  const build = validateBuildIdentity(value.build);
  if (
    !keys(value.runtime, ["version", "resolved", "integrity"]) ||
    value.runtime.version !== runtimeVersion ||
    value.runtime.resolved !== "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.runtime.integrity)
  )
    invalid();
  if (
    value.tag !== build.channel ||
    !Array.isArray(value.packages) ||
    value.packages.length !== packages.length
  )
    invalid();
  const filenames = new Set();
  let total = 0;
  for (const [index, pkg] of value.packages.entries()) {
    if (
      !keys(pkg, ["name", "version", "filename", "sha256", "integrity", "files"]) ||
      pkg.name !== packages[index].name ||
      pkg.version !== build.version ||
      typeof pkg.filename !== "string" ||
      !/^[a-zA-Z0-9._-]{1,200}\.tgz$/.test(pkg.filename) ||
      filenames.has(pkg.filename) ||
      !/^[a-f0-9]{64}$/.test(pkg.sha256) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity) ||
      !Array.isArray(pkg.files) ||
      !pkg.files.length ||
      pkg.files.length > MAX_FILES
    )
      invalid();
    filenames.add(pkg.filename);
    const paths = new Set();
    for (const file of pkg.files) {
      total += file.size;
      if (
        !keys(file, ["path", "size", "sha256"]) ||
        !publicPath(file.path) ||
        paths.has(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > MAX_FILE ||
        total > MAX_TOTAL ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        invalid();
      paths.add(file.path);
    }
    if (!paths.has("package.json")) invalid();
  }
  return value;
}
const sums = (manifest, manifestBytes) =>
  `${[
    ...manifest.packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`),
    `${hash(manifestBytes)}  manifest.json`,
  ].join("\n")}\n`;
export function verifyPrepared(directory) {
  const bytes = readBounded(join(directory, "manifest.json"));
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  const expected = [
    "manifest.json",
    "SHA256SUMS",
    ...manifest.packages.map((pkg) => pkg.filename),
  ].sort();
  if (!isDeepStrictEqual(readdirSync(directory).sort(), expected))
    invalid("Artifact directory contains unexpected files.");
  for (const pkg of manifest.packages) {
    const bytes = readBounded(join(directory, pkg.filename), MAX_TOTAL);
    if (hash(bytes) !== pkg.sha256 || integrity(bytes) !== pkg.integrity)
      invalid("Artifact checksum verification failed.");
  }
  if (readBounded(join(directory, "SHA256SUMS")).toString("utf8") !== sums(manifest, bytes))
    invalid("Artifact checksum manifest verification failed.");
  return manifest;
}
function installedFiles(directory, prefix = "", budget = { count: 0 }) {
  if (prefix.split("/").length > 32) invalid();
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (++budget.count > MAX_FILES) invalid();
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      result.push(...installedFiles(join(directory, entry.name), path, budget));
    else if (entry.isFile()) result.push(path);
    else invalid("Installed package contains an unsupported file type.");
  }
  return result.sort();
}
export function verifyInstalledContents(directory, manifest) {
  validateManifest(manifest);
  for (const pkg of manifest.packages) {
    const home = join(directory, "node_modules", pkg.name);
    if (lstatSync(home).isSymbolicLink())
      invalid("Installed package must not link to a workspace.");
    if (!isDeepStrictEqual(installedFiles(home), pkg.files.map((file) => file.path).sort()))
      invalid("Installed package file list differs from the prepared artifact.");
    for (const file of pkg.files) {
      const bytes = readBounded(join(home, file.path));
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        invalid("Installed package content verification failed.");
    }
    const metadata = json(join(home, "package.json"));
    if (
      metadata.name !== pkg.name ||
      metadata.version !== manifest.build.version ||
      !isDeepStrictEqual(metadata.planviewBuild, manifest.build) ||
      metadata.private !== true ||
      metadata.publishConfig !== undefined ||
      metadata.scripts !== undefined
    )
      invalid("Installed package metadata differs from the prepared build.");
    if (
      !isDeepStrictEqual(metadata.dependencies, { effect: runtimeVersion }) ||
      metadata.devDependencies !== undefined
    )
      invalid("Installed dependency graph differs from prepared graph.");
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      for (const [name, version] of Object.entries(metadata[section] ?? {})) {
        if (
          name.startsWith("@planview/") &&
          (!packages.some((candidate) => candidate.name === name) ||
            version !== manifest.build.version)
        )
          invalid("Installed internal dependencies must match the exact build version.");
      }
    }
  }
  const effectHome = join(directory, "node_modules", "effect");
  if (!lstatSync(effectHome).isDirectory() || lstatSync(effectHome).isSymbolicLink()) invalid();
  const runtime = json(join(effectHome, "package.json"));
  if (
    runtime.name !== "effect" ||
    runtime.version !== runtimeVersion ||
    runtime.dependencies ||
    runtime.optionalDependencies ||
    runtime.peerDependencies
  )
    invalid("Unexpected installed runtime graph.");
  const lock = json(join(directory, "package-lock.json"));
  if (!isDeepStrictEqual(lock.packages["node_modules/effect"], manifest.runtime))
    invalid("Runtime dependency lock differs from prepared graph.");
}
export function installPrepared(bundle, destination, expectedSha) {
  const manifest = verifyPrepared(bundle);
  if (manifest.build.sourceSha !== expectedSha)
    invalid("Bundle does not match the approved source SHA.");
  toolchain();
  const directory = createDestination(
    destination,
    resolve(dirname(fileURLToPath(import.meta.url)), "..")
  );
  try {
    mkdirSync(join(directory, "artifacts"));
    manifest.packages.map((pkg) => {
      const target = join(directory, "artifacts", pkg.filename);
      copyFileSync(join(bundle, pkg.filename), target);
      return target;
    });
    const pkg = manifest.packages[0];
    const dependency = `file:artifacts/${pkg.filename}`;
    writeFileSync(
      join(directory, "package.json"),
      encode({ ...CONSUMER, dependencies: { [pkg.name]: dependency } })
    );
    writeFileSync(
      join(directory, "package-lock.json"),
      encode({
        name: CONSUMER.name,
        version: CONSUMER.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: CONSUMER.name,
            version: CONSUMER.version,
            dependencies: { [pkg.name]: dependency },
          },
          [`node_modules/${pkg.name}`]: {
            version: manifest.build.version,
            resolved: dependency,
            integrity: pkg.integrity,
            dependencies: { effect: runtimeVersion },
            bin: { plansplease: "dist/index.js" },
            engines: { node: REQUIREMENTS.node },
          },
          "node_modules/effect": manifest.runtime,
        },
      })
    );
    invoke(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
    verifyInstalledContents(directory, manifest);
    const cli = join(directory, "node_modules", "@abijith-suresh", "planview", "dist", "index.js");
    const run = (args) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: directory,
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PLANVIEW_APP_DATA_DIR: "invalid-relative-home" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    if (run(["--version"]).trim() !== `plansplease ${manifest.build.version}`)
      invalid("Installed version verification failed.");
    const info = JSON.parse(run(["build-info"]));
    if (
      info.name !== packages[0].name ||
      info.version !== manifest.build.version ||
      !isDeepStrictEqual(info.build, manifest.build)
    )
      invalid("Installed build identity verification failed.");
    const binDirectory = join(directory, "node_modules", ".bin");
    const executable = join(
      binDirectory,
      process.platform === "win32" ? "plansplease.cmd" : "plansplease"
    );
    if (!existsSync(executable)) invalid("Installed CLI launcher is missing.");
    return {
      directory,
      executable,
      cli,
      binDirectory,
      version: manifest.build.version,
      build: manifest.build,
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("Prerelease installation failed; its partial directory was removed.", {
      cause: error,
    });
  }
}

function sourceFingerprint(root) {
  const state = Buffer.concat([
    git(root, ["diff", "--binary", "HEAD", "--"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
  ]);
  const digests = [
    "package.json",
    "package-lock.json",
    ...packages.map((pkg) => `${pkg.directory}/package.json`),
  ].map((file) => hash(readBounded(join(root, file))));
  return hash(Buffer.concat([state, Buffer.from(digests.join("\n"))]));
}

export async function preparePrerelease(root, destination, input, options = {}) {
  const identity = validateBuildIdentity(input);
  if (
    ![undefined, false, "false"].includes(options.publish) ||
    (process.env.PLANVIEW_PRERELEASE_PUBLISH_REQUESTED &&
      process.env.PLANVIEW_PRERELEASE_PUBLISH_REQUESTED !== "false")
  )
    invalid("Publication is disabled.");
  toolchain();
  const before = sourceFingerprint(root);
  const directory = createDestination(destination, root);
  let temporary;
  try {
    temporary = mkdtempSync(join(tmpdir(), "plansplease-prerelease-"));
    const snapshot = join(temporary, "source");
    mkdirSync(snapshot);
    snapshotCommit(root, snapshot, identity.sourceSha);
    const { manifests, runtime } = validateRepository(snapshot);
    if (manifests[0].version !== identity.sourceVersion)
      invalid("Build source version differs from the selected commit.");
    invoke(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], snapshot);
    const sourceMetadata = manifests[0];
    sourceMetadata.version = identity.version;
    sourceMetadata.planviewBuild = identity;
    writeFileSync(join(snapshot, "apps/cli/package.json"), encode(sourceMetadata));
    invoke(["run", "build", "--workspace", packages[0].name], snapshot);
    const prepared = [];
    for (const pkg of packages) {
      const [listing] = JSON.parse(
        invoke(
          ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", pkg.name],
          snapshot
        )
      );
      if (
        listing.name !== pkg.name ||
        !Array.isArray(listing.files) ||
        listing.files.length > MAX_FILES
      )
        invalid();
      const stage = join(temporary, `package-${prepared.length}`);
      mkdirSync(stage);
      for (const file of listing.files) {
        if (!publicPath(file.path)) invalid("Public package includes an unsupported path.");
        const source = join(snapshot, pkg.directory, file.path);
        const bytes = readBounded(source);
        mkdirSync(dirname(join(stage, file.path)), { recursive: true });
        writeFileSync(join(stage, file.path), bytes);
        chmodSync(join(stage, file.path), lstatSync(source).mode & 0o777);
      }
      const metadata = json(join(stage, "package.json"));
      metadata.version = identity.version;
      metadata.planviewBuild = identity;
      metadata.private = true;
      delete metadata.publishConfig;
      delete metadata.devDependencies;
      delete metadata.scripts;
      for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
      ]) {
        for (const name of Object.keys(metadata[section] ?? {}))
          if (packages.some((item) => item.name === name))
            metadata[section][name] = identity.version;
      }
      writeFileSync(join(stage, "package.json"), encode(metadata));
      const [packed] = JSON.parse(
        invoke(["pack", "--json", "--ignore-scripts", "--pack-destination", directory], stage)
      );
      if (
        packed.name !== pkg.name ||
        packed.version !== identity.version ||
        !/^[a-zA-Z0-9._-]{1,200}\.tgz$/.test(packed.filename) ||
        !Array.isArray(packed.files)
      )
        invalid();
      const bytes = readBounded(join(directory, packed.filename), MAX_TOTAL);
      if (packed.integrity !== integrity(bytes)) invalid();
      const files = packed.files
        .map((file) => {
          if (!publicPath(file.path)) invalid();
          const bytes = readBounded(join(stage, file.path));
          return { path: file.path, size: bytes.length, sha256: hash(bytes) };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      prepared.push({
        name: pkg.name,
        version: identity.version,
        filename: packed.filename,
        sha256: hash(bytes),
        integrity: integrity(bytes),
        files,
      });
    }
    const manifest = validateManifest({
      schemaVersion: 1,
      build: identity,
      tag: identity.channel,
      publication: "disabled",
      requirements: REQUIREMENTS,
      runtime,
      packages: prepared,
    });
    const bytes = Buffer.from(encode(manifest));
    writeFileSync(join(directory, "manifest.json"), bytes);
    writeFileSync(join(directory, "SHA256SUMS"), sums(manifest, bytes));
    verifyPrepared(directory);
    const installation = installPrepared(
      directory,
      join(temporary, "consumer install é"),
      identity.sourceSha
    );
    await options.checkInstalled?.(installation, manifest);
    if (sourceFingerprint(root) !== before) invalid("Preparation changed the source checkout.");
    return { directory, manifest };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("Prerelease preparation failed; its partial artifact directory was removed.", {
      cause: error,
    });
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (sourceFingerprint(root) !== before) {
      rmSync(directory, { recursive: true, force: true });
      invalid("Preparation changed the source checkout; the output was removed.");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void (async () => {
    try {
      const values = {};
      const args = process.argv.slice(2);
      for (let i = 0; i < args.length; i++) {
        const name = args[i];
        if ((name === "--dispatch" || name === "--browser") && values[name] === undefined) {
          values[name] = true;
          continue;
        }
        if (
          !["--output", "--channel", "--source-sha", "--date", "--run-id", "--attempt"].includes(
            name
          ) ||
          Object.hasOwn(values, name) ||
          !args[i + 1] ||
          args[i + 1].startsWith("--")
        )
          invalid("Invalid preparation arguments.");
        values[name] = args[++i];
      }
      if (!values["--output"]) invalid("Supply --output with a new absolute artifact directory.");
      const root = process.cwd();
      if (
        !/^[a-f0-9]{40}$/.test(values["--source-sha"] ?? "") ||
        /^0+$/.test(values["--source-sha"])
      )
        invalid("Supply a full source commit SHA.");
      const sourceVersion = JSON.parse(
        git(root, ["show", `${values["--source-sha"]}:apps/cli/package.json`], { encoding: "utf8" })
      ).version;
      const identity = makeBuildIdentity({
        sourceSha: values["--source-sha"],
        sourceVersion,
        channel: values["--channel"],
        date: values["--date"],
        runId: values["--run-id"],
        attempt: values["--attempt"],
      });
      if (
        process.env.PLANVIEW_PRERELEASE_PUBLISH_REQUESTED &&
        process.env.PLANVIEW_PRERELEASE_PUBLISH_REQUESTED !== "false"
      )
        invalid("Publication is disabled: no owner-controlled publication gate is configured.");
      if (values["--dispatch"]) {
        validateDispatch({
          eventName: process.env.GITHUB_EVENT_NAME,
          repository: process.env.GITHUB_REPOSITORY,
          ref: process.env.GITHUB_REF,
          sourceSha: process.env.GITHUB_SHA,
          checkedOutSha: git(root, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          identity,
          publishRequested: process.env.PLANVIEW_PRERELEASE_PUBLISH_REQUESTED,
        });
        git(root, ["merge-base", "--is-ancestor", identity.sourceSha, "origin/main"]);
      }
      const { checkInstalledPrerelease } = await import("./check-prerelease.mjs");
      const result = await preparePrerelease(root, values["--output"], identity, {
        checkInstalled: (installation, manifest) =>
          checkInstalledPrerelease(installation, manifest, {
            browser: values["--browser"] === true,
          }),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
      process.stderr.write(
        "Prerelease preparation failed. Publication remains disabled; inspect the selected source, arguments, pinned toolchain and offline dependency cache.\n"
      );
      process.exitCode = 1;
    }
  })();
}
