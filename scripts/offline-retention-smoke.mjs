import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { npmPackFilename } from "./npm-pack-result.mjs";

/** Fixture ownership is closed before the installed daemon starts. No runtime DB inspection. */
export async function testInstalledRetention({ root, installed, workspace }) {
  const { openStorage, openDocumentFileStore, createDocumentPublicationCoordinator } = await import(
    pathToFileURL(join(root, "packages/storage/dist/index.js")).href
  );
  const { packCloudBundle } = await import(
    pathToFileURL(join(root, "packages/core/dist/cloud-bundle.js")).href
  );
  const data = join(workspace, "offline-retention é");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_TEST_DAEMON_PORT: String(port),
    PLANVIEW_APP_DATA_DIR: data,
    PLANVIEW_RUNTIME_DIR: join(data, "runtime"),
  };
  const args = (...values) => [installed, ...values, "--json"];
  const command = (...values) => {
    const result = spawnSync(process.execPath, args(...values), {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    return result;
  };
  const execute = (...values) => {
    const result = command(...values);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const concurrent = (...values) =>
    new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, args(...values), {
        cwd: workspace,
        env: environment,
        windowsHide: true,
      });
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        try {
          resolveResult({ code, value: JSON.parse(output), errors });
        } catch (error) {
          reject(error);
        }
      });
    });
  const source = join(workspace, "offline.html");
  const folderBytes = Buffer.from(
    packCloudBundle([
      { path: "index.html", content: "<h1>offline é</h1>\r\n" },
      { path: "assets/note.txt", content: "immutable\r\n" },
    ])
  );
  // Seed an expired pinned folder and enough matching sparse files to fill the
  // actual 1 GiB logical quota, without changing runtime limits or clocks.
  const metadata = Effect.runSync(openStorage(join(data, "metadata.sqlite")));
  const files = Effect.runSync(
    openDocumentFileStore({
      documentsDir: join(data, "documents"),
      stagingDir: join(data, "staging"),
    })
  );
  const selected = [];
  try {
    let remaining = 1024 ** 3;
    for (let index = 0; remaining > 0; index++) {
      const size = index === 0 ? folderBytes.length : Math.min(10 * 1024 ** 2, remaining - 4096);
      assert.ok(size >= 0);
      if (index === 0) await writeFile(source, folderBytes);
      else {
        const file = await open(source, "w");
        try {
          await file.truncate(size);
        } finally {
          await file.close();
        }
      }
      const id = `pin${String(index).padStart(18, "0")}`;
      await Effect.runPromise(
        createDocumentPublicationCoordinator({
          metadataStore: metadata,
          documentFileStore: files,
          now: () => 1,
          generateId: () => id,
        }).publish(source)
      );
      const row = metadata.getDocumentMetadataSnapshot(id);
      metadata.setDocumentPinned(row, true);
      selected.push(row);
      remaining -= size + 4096;
    }
    assert.equal(metadata.getDocumentStorageUsage().bytes, 1024 ** 3);
  } finally {
    await files.close();
    metadata.close();
  }
  try {
    const start = execute("start");
    const pid = start.pid;
    const manager = execute("ui");
    assert.equal(execute("status").pid, pid);
    const usage = execute("usage");
    assert.equal(usage.bytes, 1024 ** 3);
    assert.equal(usage.pinnedBytes, usage.bytes);
    assert.equal(usage.pinnedCount, selected.length);
    const sessionResponse = await fetch(`${manager.origin}/api/session`, {
      method: "POST",
      headers: { Origin: manager.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: new URL(manager.url).hash.slice(1) }),
    });
    const session = await sessionResponse.json();
    const refusedImport = await fetch(`${manager.origin}/api/import`, {
      method: "POST",
      headers: {
        Origin: manager.origin,
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/octet-stream",
        "x-planview-filename": "new.html",
      },
      body: "new",
    });
    assert.notEqual(refusedImport.status, 201);
    assert.match(await refusedImport.text(), /quota/);
    const page = execute("list", "--limit", "100");
    const folder = page.snapshots.find((row) => row.id === selected[0].id);
    assert.equal(folder.pinned, true);
    assert.equal(folder.expiresAt, null);
    assert.equal(folder.lastAccessedAt, 1);
    assert.equal(folder.generation, selected[0].generation);
    assert.ok(folder.unpinnedExpiresAt < Date.now());
    const inspection = execute("share", folder.id, "--inspect");
    assert.equal(inspection.local.pinned, true);
    assert.equal(inspection.local.expiresAt, null);
    const share = command("share", folder.id);
    assert.equal(share.status, 1);
    const outcome = JSON.parse(share.stdout);
    assert.equal(outcome.cloud.status, "failed");
    assert.equal(outcome.local.pinned, true);
    assert.equal(outcome.local.expiresAt, null);
    assert.equal(outcome.local.generation, folder.generation);
    assert.equal(
      execute("share", folder.id, "--inspect").attempts.length,
      0,
      "no credential means no cloud admission or auto-pin"
    );
    execute("clean");
    assert.equal(execute("usage").documentCount, selected.length);
    assert.deepEqual(await readFile(join(data, "documents", `${folder.id}.html`)), folderBytes);
    await writeFile(source, "new");
    const refused = command("publish", source);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /quota/);
    assert.match(refused.stderr, /[Pp]in/);
    assert.equal(execute("usage").bytes, 1024 ** 3);
    execute("stop");
    await assert.rejects(fetch(manager.origin, { signal: AbortSignal.timeout(1000) }));
    execute("start");
    assert.equal(
      execute("usage").pinnedCount,
      selected.length,
      "pins survive restart and startup cleanup"
    );
    // Do not preview this expired row: preview reads deliberately renew access.
    const expired = selected.at(-1);
    const unpin = execute("unpin", expired.id, "--generation", expired.generation);
    assert.equal(unpin.retention.expiresAt, 1 + 30 * 86400000);
    execute("clean");
    assert.equal(execute("usage").documentCount, selected.length - 1);
    const removed = execute("delete", selected[1].id, "--generation", selected[1].generation);
    assert.equal(removed.status, "deleted", "manual selected delete can remove pins");
    const missing = command("pin", selected[1].id, "--generation", selected[1].generation);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).status, "not_found");
    const fresh = execute("publish", source);
    let freshRow;
    let after;
    do {
      const page = execute("list", "--limit", "100", ...(after ? ["--after", after] : []));
      freshRow = page.snapshots.find((row) => row.id === fresh.id);
      after = page.nextAfter;
    } while (!freshRow && after);
    assert.ok(freshRow);
    assert.equal(freshRow.pinned, false, "publication never auto-pins");
    const mutations = await Promise.all([
      concurrent("pin", fresh.id, "--generation", freshRow.generation),
      concurrent("unpin", fresh.id, "--generation", freshRow.generation),
      concurrent("delete", fresh.id, "--generation", freshRow.generation),
    ]);
    assert.equal(mutations[2].value.status, "deleted");
    for (const mutation of mutations.slice(0, 2))
      assert.ok(["updated", "not_found"].includes(mutation.value.status), mutation.errors);
    let foundAfterDelete = false;
    after = undefined;
    do {
      const page = execute("list", "--limit", "100", ...(after ? ["--after", after] : []));
      foundAfterDelete ||= page.snapshots.some((row) => row.id === fresh.id);
      after = page.nextAfter;
    } while (after);
    assert.equal(foundAfterDelete, false, "concurrent mutation cannot resurrect");
    const pinStarted = performance.now();
    const stable = execute("pin", folder.id, "--generation", folder.generation);
    const pinMilliseconds = Math.round(performance.now() - pinStarted);
    assert.equal(stable.status, "updated");
    const preview = await fetch(`http://127.0.0.1:${port}/${folder.id}/index.html`);
    assert.equal(await preview.text(), "<h1>offline é</h1>\r\n");
    assert.deepEqual(await readFile(join(data, "documents", `${folder.id}.html`)), folderBytes);
    process.stdout.write(
      JSON.stringify({
        platform: process.platform,
        quotaBytes: 1024 ** 3,
        seededPinnedCount: selected.length,
        exactFolderBytes: folderBytes.length,
        pinMilliseconds,
        sameDaemonForManager: true,
        restartSurvived: true,
        quotaRefusedPublishAndImport: true,
        expiredUnpinCleaned: true,
        concurrentDeleteDidNotResurrect: true,
      }) + "\n"
    );
  } finally {
    command("stop");
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = await mkdtemp(join(tmpdir(), "installed-pins-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (values) => {
    const result = spawnSync(
      npm,
      values.map((value) => (process.platform === "win32" ? `"${value}"` : value)),
      { cwd: root, encoding: "utf8", shell: process.platform === "win32" }
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
    const installed = join(
      prefix,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
      "@abijith-suresh/planview/dist/index.js"
    );
    await testInstalledRetention({ root, installed, workspace });
    process.stdout.write(`Installed offline retention passed on ${process.platform}.\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
