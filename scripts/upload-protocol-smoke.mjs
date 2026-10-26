import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
        stdoutBytes: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString(),
      })
    );
  });
}
let server, extraServer, installedCli, installedEnvironment;
let dropResponse = false,
  dropAdmission = false,
  legacyReply = false;
let protocolSupported = true;
const revoked = new Set();
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
            ...(process.env.PLANVIEW_TEST_PACK_BUILT === "1" ? ["--ignore-scripts"] : []),
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
      const account =
        credential?.tokenHash === hashCliCredential(token)
          ? "owner-a"
          : credential?.tokenHash === hashCliCredential("planview_cli_fixture-account-b")
            ? "owner-b"
            : undefined;
      if (!account || revoked.has(account)) return null;
      f.state.owner = account;
      return { subject: account };
    },
  };
  const upload = createDocumentUploadHandler(dependencies);
  const receipt = createUploadReceiptHandler(dependencies);
  const keys = [];
  const serve = async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      f.state.origin = `http://${incoming.headers.host}`;
      const request = new Request(`${f.state.origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
      });
      keys.push(request.headers.get("Idempotency-Key"));
      if (
        request.method === "GET" &&
        !request.headers.has("Idempotency-Key") &&
        !protocolSupported
      ) {
        outgoing.writeHead(404);
        outgoing.end("{}");
        return;
      }
      if (request.method === "POST" && request.headers.has("Idempotency-Key") && dropAdmission) {
        dropAdmission = false;
        outgoing.destroy();
        return;
      }
      const response = await (request.method === "GET" ? receipt : upload)({ request });
      if (request.method === "POST" && request.headers.has("Idempotency-Key")) {
        if (dropResponse) {
          dropResponse = false;
          outgoing.destroy();
          return;
        }
        if (legacyReply) {
          legacyReply = false;
          outgoing.writeHead(201, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ id: "legacy-no-receipt" }));
          return;
        }
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  };
  server = createServer(serve);
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  f.state.origin = `http://127.0.0.1:${server.address().port}`;
  process.env.SITE_URL = f.state.origin;
  const portServer = createServer();
  await new Promise((ready) => portServer.listen(0, "127.0.0.1", ready));
  const daemonPort = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: join(root, "xdg"),
    LOCALAPPDATA: join(root, "local"),
    NODE_ENV: "test",
    PLANVIEW_TEST_DAEMON_PORT: String(daemonPort),
  };
  installedCli = cli;
  installedEnvironment = environment;
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
  const command = async (...args) => {
    const answer = await execute(cli, ["--profile", "upload-fixture", ...args], environment);
    return {
      ...answer,
      value: args.includes("--json") && answer.stdout ? JSON.parse(answer.stdout) : undefined,
    };
  };
  const successful = async (...args) => {
    const answer = await command(...args);
    assert.equal(answer.code, 0, answer.stderr + answer.stdout);
    return answer.value;
  };
  const cloudOrigin = f.state.origin;
  const saveCredentials = async (cloudUrl = cloudOrigin, credential = token) =>
    writeFile(
      join(directory, "cloud-credentials.json"),
      JSON.stringify({ version: 1, cloudUrl, token: credential }),
      { mode: 0o600 }
    );
  const publish = async (bytes) => {
    await writeFile(source, bytes);
    return successful("publish", "--json", source);
  };
  const runShare = (id) => command("share", "--json", id);
  const offlineCount = keys.length;
  await successful("share", "--help");
  assert.equal(keys.length, offlineCount);
  const snapshot = await publish(exactBytes);
  const inspected = await successful("share", "--inspect", "--json", snapshot.id);
  assert.equal(keys.length, offlineCount, "inspection does no cloud work");
  await writeFile(source, "mutable source no longer matches");
  const daemonBefore = await successful("status", "--json");
  const sample = async (pid) => {
    if (process.platform !== "linux") return undefined;
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
      cpuTicks: Number(fields[11]) + Number(fields[12]),
    };
  };
  const idleBefore = await sample(daemonBefore.pid);
  await new Promise((done) => setTimeout(done, 500));
  const idleAfter = await sample(daemonBefore.pid);
  const sharingStarted = performance.now();
  const shared = await runShare(snapshot.id);
  const sharingDurationMs = performance.now() - sharingStarted;
  const shareAfter = await sample(daemonBefore.pid);
  const daemonAfter = await successful("status", "--json");
  assert.equal(
    daemonBefore.pid,
    daemonAfter.pid,
    "sharing reuses the existing storage-owner process"
  );
  const resources = {
    platform: process.platform,
    daemonBefore,
    daemonAfter,
    idleBefore,
    idleAfter,
    shareAfter,
    idleWindowMs: 500,
    sharingDurationMs,
    method:
      "Installed CLI to loopback production-handler fixture. Linux /proc VmRSS KiB and raw utime+stime ticks for the actual daemon. CLI latency includes process/auth/capture/upload/record. A single small fixture observation, not a Windows or hosted comparison.",
  };
  if (process.env.PLANVIEW_PROTOCOL_RESOURCE_REPORT)
    await writeFile(
      process.env.PLANVIEW_PROTOCOL_RESOURCE_REPORT,
      JSON.stringify(resources, null, 2)
    );
  assert.equal(shared.code, 0, shared.stderr + shared.stdout);
  assert.equal(shared.value.local.generation, inspected.local.generation);
  assert.equal(
    shared.value.local.contentSha256,
    createHash("sha256").update(exactBytes).digest("hex")
  );
  assert.equal(shared.value.cloud.receipt.accountId, "owner-a");
  assert.deepEqual(
    await f.storage.read(
      f.database.rows("documents").find((row) => row._id === shared.value.cloud.documentId)
        .storageKey
    ),
    exactBytes
  );
  assert.equal(
    (await command("get", snapshot.id)).stdoutBytes.equals(Buffer.from(exactBytes)),
    true
  );
  const posts = () => f.state.uploads;
  const stablePosts = posts();
  assert.equal((await runShare(snapshot.id)).value.cloud.documentId, shared.value.cloud.documentId);
  assert.equal(posts(), stablePosts);
  await successful("restart", "--json");
  assert.equal((await runShare(snapshot.id)).value.cloud.documentId, shared.value.cloud.documentId);
  assert.equal(posts(), stablePosts);

  const lostSnapshot = await publish(Buffer.from("<h1>lost response</h1>"));
  dropResponse = true;
  const lost = await runShare(lostSnapshot.id);
  assert.equal(lost.code, 1);
  assert.equal(lost.value.cloud.status, "unknown");
  const afterLost = posts();
  await successful("restart", "--json");
  const recovered = await runShare(lostSnapshot.id);
  assert.equal(recovered.code, 0, recovered.stderr + recovered.stdout);
  assert.equal(recovered.value.cloud.operationKey, lost.value.cloud.operationKey);
  assert.equal(posts(), afterLost, "receipt recovery never resends bytes");

  const concurrentSnapshot = await publish(Buffer.from("<h1>concurrent</h1>"));
  const beforeConcurrent = posts();
  const concurrent = await Promise.all([
    runShare(concurrentSnapshot.id),
    runShare(concurrentSnapshot.id),
  ]);
  assert.equal(posts(), beforeConcurrent + 1);
  assert.equal(new Set(concurrent.map((answer) => answer.value.cloud.operationKey)).size, 1);
  assert.equal((await runShare(concurrentSnapshot.id)).code, 0);

  const stoppedSnapshot = await publish(Buffer.from("<h1>stop during cloud upload</h1>"));
  const uploadStarted = Promise.withResolvers();
  const resumeUpload = Promise.withResolvers();
  f.state.beforeUpload = async () => {
    uploadStarted.resolve();
    await resumeUpload.promise;
  };
  const stoppedShare = runShare(stoppedSnapshot.id);
  await Promise.race([
    uploadStarted.promise,
    stoppedShare.then((answer) => {
      throw new Error(`Share ended before hold: ${answer.stdout} ${answer.stderr}`);
    }),
  ]);
  await successful("stop", "--json");
  resumeUpload.resolve();
  const afterStop = await stoppedShare;
  f.state.beforeUpload = async () => {};
  assert.equal(afterStop.value.cloud.status, "committed");
  assert.equal(afterStop.value.bookkeeping, "unknown");
  assert.equal(
    (await successful("status", "--json")).state,
    "stopped",
    "late receipt writes cannot undo an explicit stop"
  );
  const beforeStopRecovery = posts();
  assert.equal((await runShare(stoppedSnapshot.id)).code, 0);
  assert.equal(posts(), beforeStopRecovery);

  const missingSnapshot = await publish(Buffer.from("<h1>no admission response</h1>"));
  dropAdmission = true;
  const missing = await runShare(missingSnapshot.id);
  assert.equal(missing.value.cloud.status, "unknown");
  const beforeMissingLookup = posts();
  assert.equal((await runShare(missingSnapshot.id)).value.cloud.status, "unknown");
  assert.equal((await command("share", "--json", "--new-attempt", missingSnapshot.id)).code, 1);
  assert.equal(
    posts(),
    beforeMissingLookup,
    "404 lookup and deliberate flag cannot replace unknown key"
  );

  const oldSnapshot = await publish(Buffer.from("<h1>old protocol</h1>"));
  protocolSupported = false;
  const beforeOld = posts();
  assert.equal((await runShare(oldSnapshot.id)).value.cloud.code, "CLOUD_PREFLIGHT_REFUSED");
  assert.equal(posts(), beforeOld);
  assert.equal(
    (await successful("share", "--inspect", "--json", oldSnapshot.id)).attempts.length,
    0
  );
  protocolSupported = true;
  legacyReply = true;
  const legacyShare = await runShare(oldSnapshot.id);
  assert.equal(legacyShare.value.cloud.status, "unknown", "legacy201 never invents a receipt");
  assert.equal(
    (await runShare(oldSnapshot.id)).code,
    0,
    "real server receipt recovers the synthetic lost protocol response"
  );

  const refusedSnapshot = await publish(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const beforeRefused = posts();
  const refused = await runShare(refusedSnapshot.id);
  assert.equal(refused.code, 1);
  assert.equal(refused.value.cloud.code, "CLOUD_SIZE_LIMIT");
  assert.equal(refused.value.local.status, "available");
  assert.equal(posts(), beforeRefused);
  assert.equal((await command("get", refusedSnapshot.id)).stdoutBytes.length, 8 * 1024 * 1024 + 1);

  const folder = join(root, "encoded folder ü");
  await mkdir(folder);
  await writeFile(join(folder, "index.html"), "<!doctype html><img src=icon.png>");
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await writeFile(join(folder, "icon.png"), binary);
  const bundle = await successful("publish", "--json", folder);
  const rootPreview = await (await fetch(`${bundle.url}/`)).text();
  const iconPreview = Buffer.from(await (await fetch(`${bundle.url}/icon.png`)).arrayBuffer());
  assert.equal(rootPreview, "<!doctype html><img src=icon.png>");
  assert.deepEqual(iconPreview, binary);
  await writeFile(join(folder, "icon.png"), "changed source");
  const bundleShare = await runShare(bundle.id);
  assert.equal(bundleShare.code, 0, bundleShare.stderr + bundleShare.stdout);
  assert.equal(
    bundleShare.value.cloud.receipt.contentSha256,
    bundleShare.value.local.contentSha256
  );
  const cloudBundleBytes = await f.storage.read(
    f.database.rows("documents").find((row) => row._id === bundleShare.value.cloud.documentId)
      .storageKey
  );
  const { parseCloudBundle } = await import("@planview/core/cloud-bundle");
  const parsedBundle = parseCloudBundle(cloudBundleBytes);
  const fileBytes = (path) => {
    const entry = parsedBundle.manifest.entries.find((row) => row.path === path);
    return Buffer.from(
      cloudBundleBytes.subarray(
        parsedBundle.manifest.dataOffset + entry.offset,
        parsedBundle.manifest.dataOffset + entry.offset + entry.size
      )
    );
  };
  assert.deepEqual(fileBytes("icon.png"), binary, "source mutation cannot change the owned bundle");
  assert.equal(fileBytes("index.html").toString(), rootPreview);
  assert.equal(
    createHash("sha256").update(cloudBundleBytes).digest("hex"),
    bundleShare.value.local.contentSha256
  );

  const quotaSnapshot = await publish(Buffer.from("<h1>quota refusal</h1>"));
  process.env.ACCOUNT_STORAGE_QUOTA_BYTES = "1";
  const quotaRefused = await runShare(quotaSnapshot.id);
  assert.equal(quotaRefused.value.cloud.status, "failed");
  assert.equal(quotaRefused.value.cloud.receipt.failureCode, "STORAGE_QUOTA_EXCEEDED");
  process.env.ACCOUNT_STORAGE_QUOTA_BYTES = "100000";
  assert.equal(
    (await runShare(quotaSnapshot.id)).value.cloud.status,
    "failed",
    "terminal keys are not retried"
  );
  const deliberate = await command("share", "--json", "--new-attempt", quotaSnapshot.id);
  assert.equal(deliberate.code, 0, deliberate.stdout + deliberate.stderr);
  assert.notEqual(deliberate.value.cloud.operationKey, quotaRefused.value.cloud.operationKey);

  await saveCredentials(cloudOrigin, "planview_cli_fixture-account-b");
  const beforeAccount = posts();
  const crossAccount = await command(
    "share",
    "--json",
    "--operation",
    shared.value.cloud.operationKey,
    snapshot.id
  );
  assert.equal(crossAccount.code, 1);
  assert.equal(posts(), beforeAccount);
  const accountB = await runShare(snapshot.id);
  assert.equal(accountB.code, 0);
  assert.equal(accountB.value.cloud.accountId, "owner-b");
  assert.notEqual(accountB.value.cloud.operationKey, shared.value.cloud.operationKey);
  revoked.add("owner-b");
  assert.equal((await runShare(snapshot.id)).value.cloud.code, "CLOUD_PREFLIGHT_REFUSED");
  assert.equal(posts(), beforeAccount + 1);
  revoked.clear();
  await saveCredentials();
  extraServer = createServer(serve);
  await new Promise((ready) => extraServer.listen(0, "127.0.0.1", ready));
  const otherOrigin = `http://127.0.0.1:${extraServer.address().port}`;
  await saveCredentials(otherOrigin);
  const other = await runShare(snapshot.id);
  assert.equal(other.code, 0, other.stderr + other.stdout);
  assert.equal(other.value.cloud.origin, otherOrigin);
  assert.notEqual(other.value.cloud.operationKey, shared.value.cloud.operationKey);
  await saveCredentials();
  const history = await successful("share", "--inspect", "--json", snapshot.id);
  assert.equal(history.attempts.length, 3);
  assert.equal(JSON.stringify(history).includes(token), false);
  const nativeSelection = (await successful("list", "--json")).snapshots.find(
    (row) => row.id === snapshot.id
  );
  await successful("delete", "--json", "--generation", nativeSelection.generation, snapshot.id);
  const afterLocalDelete = await runShare(snapshot.id);
  assert.equal(afterLocalDelete.code, 0);
  assert.equal(afterLocalDelete.value.local.status, "missing");
  assert.equal(afterLocalDelete.value.cloud.documentId, shared.value.cloud.documentId);
  assert.ok(f.database.rows("documents").find((row) => row._id === shared.value.cloud.documentId));
  await successful("stop", "--json");
  assert.equal((await successful("status", "--json")).state, "stopped");
  console.log(
    JSON.stringify({
      installedLegacyId: legacy.id,
      keyedDocumentId: firstBody.id,
      exactBytes: exactBytes.length,
      uploads: f.state.uploads,
      receiptLookup: "committed",
      fixture: "installed CLI, actual daemon/SQLite, real HTTP/filesystem; cloud transaction model",
      shareCases: [
        "exact bytes",
        "bundles",
        "concurrency",
        "lost responses",
        "restart",
        "unknown404",
        "old server",
        "size",
        "account",
        "origin",
        "independent deletion",
        "stop during upload",
      ],
    })
  );
} finally {
  if (installedCli && installedEnvironment)
    await execute(
      installedCli,
      ["--profile", "upload-fixture", "stop"],
      installedEnvironment
    ).catch(() => undefined);
  if (extraServer) {
    extraServer.closeAllConnections();
    await new Promise((done) => extraServer.close(done));
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
  await rm(root, { recursive: true, force: true });
}
