import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { watch, watchFile, unwatchFile } from "node:fs";
import { createServer } from "node:net";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const state = join(root, ".planview-local");
const backend = join(state, "backend");
const envDirectory = join(state, "env");
const deploymentFile = join(backend, "deployment.env");
const convexCli = join(root, "node_modules/convex/bin/main.js");
export function localConvexArguments(args) {
  return [
    "--import",
    pathToFileURL(join(root, "scripts/local-convex-preload.mjs")).href,
    convexCli,
    ...args,
  ];
}
const marker = "plansplease-local-v1";
export const ports = { app: 3000, convex: 3210, convexSite: 3211, site: 4300, docs: 4301 };
const origin = (port) => `http://127.0.0.1:${port}`;
const children = new Set();
let stopping = false;
let lock;
let sourceWatcher;
let shutdownPromise;
const generatedFiles = [];
let generatedTimer;

export function localEnvironment(inherited, secrets) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(
      ([key]) =>
        !/^(CONVEX_|VITE_|PUBLIC_|GITHUB_|UPLOADTHING_|BETTER_AUTH_|DOCUMENT_MUTATION_|CIMD_|MCP_|PLANVIEW_|LOCAL_STORAGE_|SITE_URL$|BASE_PATH$|PORT$|NODE_ENV$)/.test(
          key
        )
    )
  );
  return {
    ...env,
    ...secrets,
    NODE_ENV: "development",
    CONVEX_AGENT_MODE: "anonymous",
    PLANVIEW_LOCAL: "true",
    PLANVIEW_ENV_DIR: envDirectory,
    PLANVIEW_LOCAL_STORAGE_DIR: join(state, "storage"),
    SITE_URL: origin(ports.app),
    CONVEX_URL: origin(ports.convex),
    VITE_CONVEX_URL: origin(ports.convex),
    CONVEX_SITE_URL: origin(ports.convexSite),
    VITE_CONVEX_SITE_URL: origin(ports.convexSite),
    VITE_PUBLIC_SITE_URL: origin(ports.site),
    VITE_PUBLIC_DOCS_URL: origin(ports.docs),
    PUBLIC_APP_URL: origin(ports.app),
    PUBLIC_SITE_URL: origin(ports.site),
    PUBLIC_DOCS_URL: origin(ports.docs),
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    UPLOADTHING_TOKEN: "",
    // Allows local OAuth clients to register without a public HTTPS metadata URL.
    MCP_ALLOW_LEGACY_CLIENTS: "true",
  };
}

const running = async () => {
  let pid;
  try {
    pid = Number(await readFile(join(state, "runner.pid"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid local runner lock. Inspect .planview-local/runner.pid.");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

async function checkState() {
  try {
    const info = await lstat(state);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readFile(join(state, "kind"), "utf8")) !== marker
    )
      throw new Error("Refusing to use an unrecognized .planview-local directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(state, "kind"), marker, { mode: 0o600, flag: "wx" });
  }
  await chmod(state, 0o700);
}

export async function resetLocal(confirm) {
  if (!confirm)
    throw new Error(
      "Reset deletes all local accounts, documents, sessions, and generated secrets. Run npm run local:reset -- --yes to confirm."
    );
  await checkState();
  if (await running()) throw new Error("Stop npm run local before resetting local data.");
  await rm(state, { recursive: true });
  console.log(
    "Deleted this checkout's local workspace. Cloud accounts and CLI data outside it were untouched."
  );
}

function start(label, command, args, cwd, env, quiet = false) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      if (!quiet) process.stdout.write(`[${label}] ${data}`);
    });
  }
  child.on("error", (error) => console.error(`${label}: ${error.message}`));
  child.on("exit", () => children.delete(child));
  return child;
}

async function finished(child, label) {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`${label} exited with status ${child.exitCode}`);
    return;
  }
  await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`${label} exited with status ${code}`))
    );
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGINT");
  await new Promise((accept) => {
    const timer = setTimeout(() => {
      signal("SIGKILL");
      accept();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      accept();
    });
  });
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  sourceWatcher?.close();
  for (const file of generatedFiles) unwatchFile(file);
  clearTimeout(generatedTimer);
  shutdownPromise = (async () => {
    await Promise.all([...children].reverse().map(stop));
    if (lock) {
      await lock.close();
      await rm(join(state, "runner.pid"), { force: true });
    }
  })();
  return shutdownPromise;
}

async function freePort(port) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is in use. Stop the existing service before starting the local workspace.`
        )
      )
    );
    server.listen(port, "127.0.0.1", () => server.close(accept));
  });
}

async function waitFor(url, child, label) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (stopping) throw new Error("Local startup interrupted");
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${label} stopped during startup`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
    } catch {
      /* The backend may still be downloading or starting. */
    }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}

export async function mirrorSourceFile(source, destination, filename) {
  if (!filename || filename.split(/[\\/]/).includes("_generated")) return;
  const input = join(source, filename);
  const output = join(destination, filename);
  try {
    const info = await lstat(input);
    await mkdir(dirname(output), { recursive: true });
    if (info.isFile()) await copyFile(input, output);
    else if (info.isDirectory())
      await cp(input, output, {
        recursive: true,
        filter: (path) => !path.split(/[\\/]/).includes("_generated"),
      });
  } catch (error) {
    if (error.code === "ENOENT") await rm(output, { force: true, recursive: true });
    else throw error;
  }
}

export async function syncGeneratedBindings(source, destination) {
  for (const directory of ["_generated", "betterAuth/_generated"]) {
    let files;
    try {
      files = await readdir(join(source, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    await mkdir(join(destination, directory), { recursive: true });
    for (const file of files) {
      if (!file.isFile() || !/\.(ts|js)$/.test(file.name)) continue;
      const input = join(source, directory, file.name);
      const output = join(destination, directory, file.name);
      const contents = await readFile(input);
      const previous = await readFile(output).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!previous || !contents.equals(previous)) await writeFile(output, contents);
    }
  }
}

async function prepare() {
  await checkState();
  if (await running()) throw new Error("This checkout's local workspace is already running.");
  await rm(join(state, "runner.pid"), { force: true });
  lock = await open(join(state, "runner.pid"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await mkdir(backend, { recursive: true, mode: 0o700 });
  await mkdir(envDirectory, { recursive: true, mode: 0o700 });
  let secrets;
  const secretsFile = join(state, "secrets.json");
  try {
    secrets = JSON.parse(await readFile(secretsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secrets = Object.fromEntries(
      [
        "BETTER_AUTH_SECRET",
        "DOCUMENT_MUTATION_SECRET",
        "CIMD_FETCH_SECRET",
        "LOCAL_STORAGE_SECRET",
      ].map((name) => [name, randomBytes(48).toString("hex")])
    );
    await writeFile(secretsFile, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
  }
  for (const name of [
    "BETTER_AUTH_SECRET",
    "DOCUMENT_MUTATION_SECRET",
    "CIMD_FETCH_SECRET",
    "LOCAL_STORAGE_SECRET",
  ]) {
    if (typeof secrets[name] !== "string" || !/^[a-f0-9]{96}$/.test(secrets[name]))
      throw new Error(
        "Invalid generated local secrets. Restore .planview-local or explicitly reset it."
      );
  }
  await writeFile(
    join(backend, "package.json"),
    await readFile(join(root, "apps/app/package.json")),
    { mode: 0o600 }
  );
  await writeFile(
    join(backend, "convex.json"),
    JSON.stringify({
      functions: "convex/",
      codegen: { fileType: "js/dts", legacyComponentApi: false },
      aiFiles: { enabled: false },
    }),
    { mode: 0o600 }
  );
  for (const [target, path] of [
    [join(root, "apps/app/node_modules"), join(backend, "node_modules")],
  ]) {
    await rm(path, { force: true });
    try {
      await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const source = join(root, "apps/app/convex");
  const destination = join(backend, "convex");
  // Convex's component bundler requires real source directories. Codegen stays
  // here; only generated TypeScript/JavaScript bindings are copied back.
  await rm(destination, { force: true, recursive: true });
  await cp(source, destination, { recursive: true });
  let sourceSync = Promise.resolve();
  sourceWatcher = watch(source, { recursive: true }, (_event, filename) => {
    sourceSync = sourceSync
      .then(() => mirrorSourceFile(source, destination, filename))
      .catch((error) => console.error(`Could not sync Convex source: ${error.message}`));
  });
  let bindingsSync = Promise.resolve();
  // The CLI replaces generated files atomically. Poll their stat information
  // so replacing a directory cannot detach an inode-based fs.watch listener.
  for (const directory of ["_generated", "betterAuth/_generated"]) {
    for (const name of [
      "api.d.ts",
      "api.js",
      "dataModel.d.ts",
      "server.d.ts",
      "server.js",
      "api.ts",
      "dataModel.ts",
      "server.ts",
      "component.ts",
    ]) {
      const file = join(destination, directory, name);
      generatedFiles.push(file);
      watchFile(file, { interval: 500 }, () => {
        clearTimeout(generatedTimer);
        generatedTimer = setTimeout(() => {
          bindingsSync = bindingsSync
            .then(() => syncGeneratedBindings(destination, source))
            .catch((error) => console.error(`Could not sync Convex bindings: ${error.message}`));
        }, 200);
      });
    }
  }
  // This file is owned by the runner. Never infer a deployment from the checkout.
  await writeFile(deploymentFile, "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n", { mode: 0o600 });
  const env = localEnvironment(process.env, secrets);
  const backendEnv = Object.fromEntries(
    [
      "PLANVIEW_LOCAL",
      "SITE_URL",
      "BETTER_AUTH_SECRET",
      "DOCUMENT_MUTATION_SECRET",
      "CIMD_FETCH_SECRET",
      "LOCAL_STORAGE_SECRET",
      "MCP_ALLOW_LEGACY_CLIENTS",
    ].map((name) => [name, env[name]])
  );
  await writeFile(
    join(backend, "backend.env"),
    Object.entries(backendEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    { mode: 0o600 }
  );
  return env;
}

export async function runLocal() {
  if (!/^24\./.test(process.versions.node) || Number(process.versions.node.split(".")[1]) < 19)
    throw new Error("Use Node 24.19 or newer in the Node 24 line.");
  const npmCli = process.env["npm_execpath"];
  if (!npmCli || !/npm\/11\.16\./.test(process.env["npm_config_user_agent"] ?? ""))
    throw new Error("Start with npm 11.16: npm run local");
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  try {
    const env = await prepare();
    for (const port of Object.values(ports)) await freePort(port);
    const npm = (label, args, cwd = root) =>
      start(label, process.execPath, [npmCli, ...args], cwd, env);
    await finished(
      npm("build CLI", ["run", "build", "--workspace", "@abijith-suresh/planview"]),
      "CLI build"
    );
    await finished(
      start(
        "auth adapter",
        process.execPath,
        [join(root, "scripts/prepare-auth-adapter.mjs")],
        root,
        env
      ),
      "Auth adapter preparation"
    );
    const common = [
      "dev",
      "--env-file",
      deploymentFile,
      "--local-cloud-port",
      String(ports.convex),
      "--local-site-port",
      String(ports.convexSite),
      "--tail-logs",
      "disable",
    ];
    console.log("Starting anonymous local Convex. The first run downloads its backend binary.");
    const bootstrap = start(
      "Convex bootstrap",
      process.execPath,
      localConvexArguments([...common, "--skip-push"]),
      backend,
      env
    );
    await waitFor(`${origin(ports.convex)}/version`, bootstrap, "Local Convex");
    await finished(
      start(
        "local backend config",
        process.execPath,
        localConvexArguments([
          "env",
          "set",
          "--env-file",
          deploymentFile,
          "--from-file",
          join(backend, "backend.env"),
          "--force",
        ]),
        backend,
        env
      ),
      "Local backend configuration"
    );
    await stop(bootstrap);
    const convex = start("Convex", process.execPath, localConvexArguments(common), backend, env);
    await waitFor(`${origin(ports.convexSite)}/api/auth/get-session`, convex, "Local auth backend");
    const app = npm("app", [
      "run",
      "dev",
      "--workspace",
      "@planview/app",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.app),
      "--strictPort",
    ]);
    const site = start(
      "site",
      process.execPath,
      [
        join(root, "node_modules/astro/bin/astro.mjs"),
        "dev",
        "--ignore-lock",
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.site),
      ],
      join(root, "apps/site"),
      env
    );
    const docs = npm("docs", [
      "run",
      "dev",
      "--workspace",
      "@planview/docs",
      "--",
      "--ignore-lock",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports.docs),
    ]);
    await Promise.all([
      waitFor(`${origin(ports.app)}/api/health`, app, "App"),
      waitFor(origin(ports.site), site, "Site"),
      waitFor(origin(ports.docs), docs, "Docs"),
    ]);
    console.log(
      `\nLocal workspace ready\nApp: ${origin(ports.app)}\nSite: ${origin(ports.site)}\nDocs: ${origin(ports.docs)}\nMCP: ${origin(ports.app)}/mcp\nCreate a local test account in the app. Ctrl-C stops services and keeps data.\n`
    );
    await Promise.race(
      [app, convex, site, docs].map((child) => finished(child, "Local service"))
    ).catch((error) => {
      if (!stopping) throw error;
    });
    if (!stopping) throw new Error("A local service stopped unexpectedly");
  } finally {
    await shutdown();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "reset")
      await resetLocal(process.argv.length === 4 && process.argv[3] === "--yes");
    else if (process.argv.length === 2) await runLocal();
    else throw new Error("Usage: npm run local OR npm run local:reset -- --yes");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
