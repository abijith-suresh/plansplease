import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { npmPackFilename } from "./npm-pack-result.mjs";
import { probeWindowsFixtureOwners } from "./windows-profile-owner-probe.mjs";

export async function testInstalledProfiles({ root, installed, workspace }) {
  const home = join(workspace, "profile home é");
  mkdirSync(home, { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: join(home, "data"),
    LOCALAPPDATA: join(home, "local"),
    NODE_ENV: "test",
    PLANVIEW_DAEMON_STRICT_PORT: "false",
  };
  for (const key of [
    "PLANVIEW_APP_DATA_DIR",
    "PLANVIEW_DATA_DIR",
    "PLANVIEW_RUNTIME_DIR",
    "PLANVIEW_PROFILE",
  ])
    delete env[key];
  env.PLANVIEW_TEST_DAEMON_PORT = String(
    await new Promise((accept, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => accept(address.port));
      });
    })
  );
  const { resolveAppDataPaths, normalizeMacosSystemPath, cloudUploadFingerprint } = await import(
    pathToFileURL(join(root, "packages/core/dist/index.js")).href
  );
  const { openStorage, openDocumentFileStore, createDocumentPublicationCoordinator } = await import(
    pathToFileURL(join(root, "packages/storage/dist/index.js")).href
  );
  const data = normalizeMacosSystemPath(resolveAppDataPaths({ env, homeDir: home }).appDataDir);
  const namedData = join(data, "profiles/research");
  const marker = join(workspace, "browser-opens.jsonl");
  const preload = join(workspace, "observe-browser.mjs");
  writeFileSync(
    preload,
    `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; import { appendFileSync } from 'node:fs'; const original = cp.spawn; cp.spawn = (exe, args, options) => { if (['cmd.exe','cmd','open','xdg-open'].includes(String(exe).toLowerCase())) { appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ exe, args })+String.fromCharCode(10)); return original(process.execPath, ['-e','process.exit(0)'], { ...options, windowsHide: true }); } return original(exe,args,options); }; syncBuiltinESMExports();`
  );
  const command = (profile, ...args) =>
    spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, installed, "--profile", profile, ...args, "--json"],
      { cwd: workspace, env, encoding: "utf8", windowsHide: true }
    );
  const execute = (profile, ...args) => {
    const result = command(profile, ...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const api = (origin, token, path, payload = {}) =>
    fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  const exchange = async (launch) => {
    const response = await fetch(`${launch.origin}/api/session`, {
      method: "POST",
      headers: { Origin: launch.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: new URL(launch.url).hash.slice(1) }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForExit = async (pid) => {
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((accept) => setTimeout(accept, 25));
    assert.equal(alive(pid), false, "stopped profile process exits");
  };
  const pids = [];
  try {
    const listStarted = performance.now();
    const empty = execute("default", "profiles", "list");
    const offlineListMilliseconds = Math.round(performance.now() - listStarted);
    assert.equal(empty.current.name, "default");
    assert.equal(empty.current.present, false);
    assert.equal(existsSync(data), false, "offline discovery starts/creates nothing");
    assert.equal(command("default", "profiles", "--help").status, 0);
    assert.equal(existsSync(data), false);
    for (const name of ["../outside", "a/b", "A", "a".repeat(33), "bad;name"])
      assert.equal(command("default", "profiles", "create", name).status, 1);
    const plan = execute("default", "profiles", "select", "research");
    assert.equal(plan.openCommand, "plansplease --profile research ui --open");
    assert.equal(existsSync(data), false);
    const firstCreate = command("default", "profiles", "create", "research");
    if (process.platform === "win32" && firstCreate.status !== 0) {
      try {
        probeWindowsFixtureOwners({
          workspace,
          paths: [data, join(data, "profiles"), namedData],
          env,
        });
      } catch {
        // Keep the actual installed assertion even if the independent probe is incomplete.
        process.stdout.write(`${JSON.stringify({ fixtureOwnerProbeIncomplete: true })}\n`);
      }
    }
    assert.equal(firstCreate.status, 0, firstCreate.stderr);
    assert.equal(JSON.parse(firstCreate.stdout).created, true);
    assert.deepEqual(readdirSync(namedData), []);
    assert.equal(execute("default", "profiles", "current").daemon.state, "stopped");
    assert.equal(existsSync(join(data, "metadata.sqlite")), false);
    const runtime = join(namedData, "runtime");
    mkdirSync(runtime, { mode: 0o700 });
    const descriptor = join(runtime, "daemon.json");
    writeFileSync(descriptor, "malformed", { mode: 0o600 });
    assert.equal(command("research", "profiles", "current").status, 1);
    assert.equal(
      execute("default", "profiles", "list").profiles.length,
      2,
      "discovery never opens another descriptor"
    );
    const fake = {
      version: 1,
      profile: "research",
      pid: process.pid,
      host: "127.0.0.1",
      port: Number(env.PLANVIEW_TEST_DAEMON_PORT),
      secret: "x".repeat(43),
      startedAt: 1,
    };
    writeFileSync(descriptor, JSON.stringify(fake), { mode: 0o600 });
    const unavailable = command("research", "profiles", "current");
    assert.equal(unavailable.status, 1);
    assert.equal(JSON.parse(unavailable.stdout).daemon.state, "unavailable");
    assert.equal(unavailable.stdout.includes(fake.secret), false);
    writeFileSync(descriptor, JSON.stringify({ ...fake, pid: 2147483646 }), { mode: 0o600 });
    assert.equal(execute("research", "profiles", "current").daemon.state, "stopped");
    const outside = join(home, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(
      outside,
      join(data, "profiles/linked"),
      process.platform === "win32" ? "junction" : "dir"
    );
    assert.ok(execute("default", "profiles", "list").skippedEntries >= 1);
    assert.equal(command("default", "profiles", "create", "linked").status, 1);
    assert.deepEqual(readdirSync(outside), []);
    const localId = "p".repeat(21);
    const key = randomUUID();
    const selections = [];
    // Closed fixture owners seed identical IDs with different bytes/pins/receipts.
    for (const [index, path] of [data, namedData].entries()) {
      const metadata = Effect.runSync(openStorage(join(path, "metadata.sqlite")));
      const files = Effect.runSync(
        openDocumentFileStore({
          documentsDir: join(path, "documents"),
          stagingDir: join(path, "staging"),
        })
      );
      try {
        const source = join(workspace, "profile-source.html");
        const bytes = Buffer.from(`<h1>profile ${index} é</h1>\r\n`);
        writeFileSync(source, bytes);
        await Effect.runPromise(
          createDocumentPublicationCoordinator({
            metadataStore: metadata,
            documentFileStore: files,
            generateId: () => localId,
          }).publish(source)
        );
        const row = metadata.getDocumentMetadataSnapshot(localId);
        metadata.setDocumentPinned(row, index === 0);
        selections.push(row);
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const title = `Snapshot ${localId}`;
        const attempt = {
          version: 1,
          id: localId,
          generation: row.generation,
          key,
          origin: "https://cloud.example",
          accountId: "fixture-account",
          title,
          contentType: "text/html",
          size: bytes.length,
          contentSha256,
          fingerprint: cloudUploadFingerprint(title, "text/html", bytes.length, contentSha256),
          createdAt: Date.now(),
          status: "unknown",
        };
        metadata.insertShareAttempt(attempt);
        if (index === 0)
          metadata.recordShareReceipt(key, {
            version: 1,
            accountId: attempt.accountId,
            origin: attempt.origin,
            key,
            fingerprint: attempt.fingerprint,
            contentSha256,
            status: "committed",
            documentId: "fixture-default-doc",
          });
      } finally {
        await files.close();
        metadata.close();
      }
    }
    const a = execute("default", "ui");
    const statusA = execute("default", "status");
    pids.push(statusA.pid);
    const tokenA = await exchange(a);
    const planned = await api(a.origin, tokenA, "profile-plan", { name: "research" });
    const plannedResult = await planned.json();
    assert.equal(planned.status, 200, JSON.stringify(plannedResult).slice(0, 4096));
    assert.equal(plannedResult.target.name, "research");
    assert.equal(
      execute("research", "status").state,
      "stopped",
      "manager selection does not start target"
    );
    assert.equal(existsSync(marker), false, "no browser opens without explicit --open");
    assert.equal(pids.filter(alive).length, 1);
    const b = execute("research", "ui", "--open");
    const statusB = execute("research", "status");
    pids.push(statusB.pid);
    assert.notEqual(statusA.pid, statusB.pid);
    assert.notEqual(statusA.port, statusB.port);
    assert.notEqual(a.origin, b.origin);
    assert.equal(pids.filter(alive).length, 2);
    const opens = readFileSync(marker, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(opens.length, 1);
    assert.ok(
      opens[0].args.includes(b.url),
      "explicit --open passes selected manager link to platform launcher"
    );
    const tokenB = await exchange(b);
    assert.equal((await api(b.origin, tokenA, "status")).status, 401);
    assert.equal((await api(a.origin, tokenB, "status")).status, 401);
    assert.equal((await api(b.origin, tokenA, "delete", selections[1])).status, 401);
    assert.equal(
      (
        await api(a.origin, tokenA, "delete", {
          id: localId,
          generation: selections[0].generation,
          profile: "research",
        })
      ).status,
      400
    );
    assert.equal(
      (await api(a.origin, tokenA, "profile-plan", { name: "research", launch: true })).status,
      400
    );
    assert.equal(
      (await api(a.origin, tokenA, "profile-create", { name: "not-created" })).status,
      404
    );
    const secretA = JSON.parse(readFileSync(join(data, "runtime/daemon.json"), "utf8")).secret;
    const secretB = JSON.parse(readFileSync(join(namedData, "runtime/daemon.json"), "utf8")).secret;
    assert.notEqual(secretA, secretB);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${statusB.port}/__planview/usage`, {
          headers: { "x-planview-secret": secretA },
        })
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${statusA.port}/__planview/usage`, {
          headers: { "x-planview-secret": secretB },
        })
      ).status,
      401
    );
    const rowA = execute("default", "list").snapshots[0],
      rowB = execute("research", "list").snapshots[0];
    assert.equal(rowA.id, rowB.id);
    assert.notEqual(rowA.generation, rowB.generation);
    assert.equal(rowA.pinned, true);
    assert.equal(rowB.pinned, false);
    const shareA = execute("default", "share", localId, "--inspect"),
      shareB = execute("research", "share", localId, "--inspect");
    assert.equal(shareA.attempts[0].status, "committed");
    assert.equal(shareB.attempts[0].status, "unknown");
    assert.notEqual(shareA.attempts[0].contentSha256, shareB.attempts[0].contentSha256);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${statusA.port}/${localId}`)).text(),
      "<h1>profile 0 é</h1>\r\n"
    );
    assert.equal(
      await (await fetch(`http://127.0.0.1:${statusB.port}/${localId}`)).text(),
      "<h1>profile 1 é</h1>\r\n"
    );
    assert.equal(execute("default", "profiles", "current").daemon.pid, statusA.pid);
    execute("default", "stop");
    await waitForExit(statusA.pid);
    assert.equal(pids.filter(alive).length, 1);
    assert.equal(execute("research", "status").pid, statusB.pid);
    assert.equal((await fetch(b.origin)).status, 200);
    await assert.rejects(fetch(a.origin, { signal: AbortSignal.timeout(1000) }));
    execute("research", "stop");
    await waitForExit(statusB.pid);
    assert.equal(pids.filter(alive).length, 0);
    for (let i = 0; i < 110; i++) mkdirSync(join(data, "profiles", `p${i}`), { mode: 0o700 });
    const populatedStarted = performance.now();
    const bounded = execute("default", "profiles", "list", "--limit", "100");
    const boundedCatalogMilliseconds = Math.round(performance.now() - populatedStarted);
    assert.ok(bounded.profiles.length <= 100);
    assert.ok(bounded.scannedEntries <= 256);
    assert.equal(bounded.limited, true);
    process.stdout.write(
      JSON.stringify({
        platform: process.platform,
        profileProcessCounts: [0, 1, 1, 2, 1, 0],
        offlineListMilliseconds,
        boundedCatalogMilliseconds,
        sameIdIsolated: true,
        pinsAndReceiptsIsolated: true,
        independentPortsAndSessions: true,
        explicitPlatformBrowserLaunches: opens.length,
        countBound: true,
      }) + "\n"
    );
  } finally {
    command("default", "stop");
    command("research", "stop");
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = mkdtempSync(join(tmpdir(), "installed-profiles-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args) => {
    const result = spawnSync(
      npm,
      args.map((arg) => (process.platform === "win32" ? `"${arg}"` : arg)),
      { cwd: root, encoding: "utf8", shell: process.platform === "win32", windowsHide: true }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    const tarball =
      process.env.TARBALL ??
      join(
        workspace,
        npmPackFilename(
          JSON.parse(
            run([
              "pack",
              "--workspace",
              "@abijith-suresh/planview",
              "--ignore-scripts",
              "--pack-destination",
              workspace,
              "--json",
            ])
          )
        )
      );
    const prefix = join(workspace, "installed é");
    run(["install", "--global", "--prefix", prefix, "--ignore-scripts", tarball]);
    await testInstalledProfiles({
      root,
      installed: join(
        prefix,
        process.platform === "win32" ? "node_modules" : "lib/node_modules",
        "@abijith-suresh/planview/dist/index.js"
      ),
      workspace,
    });
    process.stdout.write(`Installed profile controls passed on ${process.platform}.\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
