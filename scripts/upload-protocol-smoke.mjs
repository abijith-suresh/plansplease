import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmPackFilename } from "./npm-pack-result.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "plansplease upload installed ü "));
const cleanups = [];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function runNpm(args) {
  const result = spawnSync(
    npm,
    args.map((value) => (process.platform === "win32" ? `"${value}"` : value)),
    {
      cwd: repository,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, npm_config_loglevel: "warn" },
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}
function execute(cli, args, environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: environment,
      windowsHide: true,
      timeout: 30_000,
    });
    const stdout = [],
      stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    );
  });
}
let server;
try {
  const tarball =
    process.env.TARBALL ??
    join(
      root,
      npmPackFilename(
        JSON.parse(
          runNpm([
            "pack",
            "--workspace",
            "@abijith-suresh/planview",
            "--pack-destination",
            root,
            "--json",
          ])
        )
      )
    );
  // Packing builds Core before these source-side fixture imports resolve it.
  const { resolveAppDataPaths } = await import("@planview/core");
  const { cliCredentialFromRequest, hashCliCredential } = await import(
    "../apps/app/src/lib/cli-credential.ts"
  );
  const { fixture, exactBytes } = await import("../apps/app/test/fixtures/upload-protocol.mts");
  const { createDocumentUploadHandler } = await import(
    "../apps/app/src/lib/document-upload-handler.ts"
  );
  const { createUploadReceiptHandler } = await import(
    "../apps/app/src/lib/upload-receipt-handler.ts"
  );
  const prefix = join(root, "installed prefix ü");
  runNpm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const cli = join(prefix, "node_modules/@abijith-suresh/planview/dist/index.js");
  const f = await fixture({ after: (cleanup) => cleanups.push(cleanup) });
  const token = "planview_cli_installed-local-fixture";
  await f.database.transaction((ctx) =>
    ctx.db.insert("cliCredentials", {
      ownerId: "owner-a",
      tokenHash: hashCliCredential(token),
      createdAt: Date.now(),
    })
  );
  const dependencies = {
    ...f.dependencies,
    getAuthedClient: async (request) => ({
      client: {},
      token: cliCredentialFromRequest(request)?.tokenHash,
    }),
    getCurrentUser: async (_client, request) => {
      const credential = cliCredentialFromRequest(request);
      return credential?.tokenHash === hashCliCredential(token) ? { subject: "owner-a" } : null;
    },
  };
  const upload = createDocumentUploadHandler(dependencies);
  const receipt = createUploadReceiptHandler(dependencies);
  const keys = [];
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(`${f.state.origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      keys.push(request.headers.get("Idempotency-Key"));
      const response = await (request.method === "GET" ? receipt : upload)({ request });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  f.state.origin = `http://127.0.0.1:${server.address().port}`;
  process.env.SITE_URL = f.state.origin;
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: join(root, "xdg"),
    LOCALAPPDATA: join(root, "local"),
  };
  const directory = resolveAppDataPaths({
    profile: "upload-fixture",
    env: environment,
    homeDir: root,
  }).appDataDir;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "cloud-credentials.json"),
    JSON.stringify({
      version: 1,
      cloudUrl: f.state.origin,
      token,
    }),
    { mode: 0o600 }
  );
  const source = join(root, "exact source ü.html");
  await writeFile(source, exactBytes);
  const result = await execute(
    cli,
    ["--profile", "upload-fixture", "upload", "--json", source],
    environment
  );
  assert.equal(result.code, 0, result.stderr);
  const legacy = JSON.parse(result.stdout);
  assert.ok(legacy.id);
  assert.deepEqual(keys, [null], "installed legacy upload must not silently opt in or retry");
  assert.equal(f.database.rows("uploadReceipts").length, 0);
  assert.deepEqual(await f.storage.read(f.database.rows("documents")[0].storageKey), exactBytes);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": "installed_wire_operation_001",
  };
  const send = () => {
    const form = new FormData();
    form.set("title", "Wire fixture");
    form.set("file", new File([exactBytes], "exact.html", { type: "text/html" }));
    return fetch(`${f.state.origin}/api/documents/upload`, { method: "POST", headers, body: form });
  };
  const first = await send();
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  const replay = await send();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, firstBody.id);
  const status = await fetch(`${f.state.origin}/api/documents/upload`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).receipt.status, "committed");
  assert.equal(f.state.uploads, 2, "one legacy upload and one keyed upload");
  // Credential rejection is also exercised directly over the real HTTP listener.
  assert.equal(
    (
      await fetch(`${f.state.origin}/api/documents/upload`, {
        headers: { "Idempotency-Key": headers["Idempotency-Key"] },
      })
    ).status,
    401
  );
  console.log(
    JSON.stringify({
      installedLegacyId: legacy.id,
      keyedDocumentId: firstBody.id,
      exactBytes: exactBytes.length,
      uploads: f.state.uploads,
      receiptLookup: "committed",
      fixture: "real HTTP and filesystem; in-memory transaction model",
    })
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(root, { recursive: true, force: true });
}
