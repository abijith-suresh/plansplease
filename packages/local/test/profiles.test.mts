import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import { resolveDaemonConfigForTest } from "@planview/daemon";
import { createLocalApplication } from "../dist/index.js";

test("current-profile status never starts a service and distinguishes missing, malformed, mismatched, live-unavailable and stale descriptors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-current-"));
  const appDataDir = join(directory, "isolated");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No port"));
      server.close(() => resolve(address.port));
    });
  });
  const application = createLocalApplication({
    config: resolveDaemonConfigForTest({ appDataDir, runtimeDir, profile: "research", port }),
    daemonScriptPath: "must-not-be-started",
  });
  const run = Effect.runPromise;
  try {
    const missing = await run(application.profileCurrent());
    assert.equal(missing.current.name, "research");
    assert.equal(missing.current.present, false);
    assert.equal(missing.daemon.state, "stopped");
    await assert.rejects(readFile(join(appDataDir, "metadata.sqlite")));
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const descriptor = join(runtimeDir, "daemon.json");
    await writeFile(descriptor, "malformed", { mode: 0o600 });
    assert.equal(
      (await run(application.profilesList())).scope,
      "isolated_override",
      "offline discovery ignores malformed descriptor contents"
    );
    assert.equal((await run(application.profileCurrent())).daemon.state, "unavailable");
    const record = {
      version: 1,
      pid: process.pid,
      profile: "other",
      host: "127.0.0.1",
      port,
      secret: "z".repeat(43),
      startedAt: 1,
    };
    await writeFile(descriptor, JSON.stringify(record), { mode: 0o600 });
    const mismatch = await run(application.profileCurrent());
    assert.equal(mismatch.daemon.state, "unavailable");
    assert.equal(JSON.stringify(mismatch).includes(record.secret), false);
    await writeFile(descriptor, JSON.stringify({ ...record, profile: "research" }), {
      mode: 0o600,
    });
    assert.equal(
      (await run(application.profileCurrent())).daemon.state,
      "unavailable",
      "live PID with failed private endpoint is not stopped"
    );
    await writeFile(
      descriptor,
      JSON.stringify({ ...record, profile: "research", pid: 2147483646 }),
      { mode: 0o600 }
    );
    assert.equal((await run(application.profileCurrent())).daemon.state, "stopped");
    await assert.rejects(readFile(join(appDataDir, "metadata.sqlite")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
