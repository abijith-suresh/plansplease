import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Effect } from "effect";
import { DaemonPortInUseError, resolveDaemonConfigForTest } from "@planview/daemon";
import {
  createLocalApplication,
  LocalApplicationError,
  parseDocumentReference,
} from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemonScriptPath = resolve(packageRoot, "../daemon/dist/entry.js");

const removeFixture = (path: string) =>
  rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 });

const freePort = (): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error)
      );
    });
  });

test("parses ids and local URLs with an optional expected port", () => {
  const port = 49123;
  const id = "a".repeat(21);

  assert.equal(parseDocumentReference(id, port), id);
  assert.equal(parseDocumentReference(`http://localhost:${port}/${id}`, port), id);
  assert.equal(parseDocumentReference(`http://127.0.0.1:${port}/${id}`, port), id);
  assert.equal(parseDocumentReference(`http://localhost:${port + 1}/${id}`), id);
  for (const suffix of ["?download=1", "#section", "?", "#", "/"]) {
    assert.throws(
      () => parseDocumentReference(`http://localhost:${port}/${id}${suffix}`, port),
      /valid 21-character id or an exact local Planview URL/
    );
  }
});

test("local application publishes, retrieves, cleans, restarts, and stops", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-local-api-test-"));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const source = "<!doctype html><html><body>local api</body></html>\n";
  const sourcePath = join(runtimeRoot, "source.html");
  writeFileSync(sourcePath, source);
  const port = await freePort();
  const application = createLocalApplication({
    daemonScriptPath,
    config: resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }),
  });

  try {
    const started = await Effect.runPromise(application.start());
    assert.equal(started.reused, false);
    assert.equal(started.status.state, "running");
    assert.equal(started.status.port, port);

    const reused = await Effect.runPromise(application.start());
    assert.equal(reused.reused, true);
    assert.equal(reused.status.port, port);

    const published = await Effect.runPromise(application.publish(sourcePath));
    assert.match(published.url, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}$`));
    assert.equal(readFileSync(sourcePath, "utf8"), source);

    const chunks: Buffer[] = [];
    await Effect.runPromise(
      application.get({
        reference: published.url,
        onChunk: (chunk) => {
          chunks.push(Buffer.from(chunk));
        },
      })
    );
    assert.equal(Buffer.concat(chunks).toString("utf8"), source);

    const inspected = await Effect.runPromise(application.inspect());
    assert.equal(inspected.state, "running");
    if (inspected.state === "running") {
      assert.equal(inspected.port, port);
    }

    const inventory = await Effect.runPromise(application.list({ limit: 1 }));
    assert.equal(inventory.snapshots.length, 1);
    const selected = inventory.snapshots[0]!;
    assert.equal(selected.id, published.id);
    const usage = await Effect.runPromise(application.usage());
    assert.equal(usage.documentCount, 1);
    assert.equal(usage.documentBytes, Buffer.byteLength(source));
    assert.equal(usage.bytes, Buffer.byteLength(source) + 4096);
    assert.deepEqual(await Effect.runPromise(application.list()), inventory);
    assert.equal((await Effect.runPromise(application.deleteSnapshot(selected))).status, "deleted");
    await assert.rejects(
      Effect.runPromise(application.get({ reference: published.id, onChunk: () => undefined }))
    );
    assert.equal((await Effect.runPromise(application.usage())).bytes, 0);

    const cleaned = await Effect.runPromise(application.clean());
    assert.equal(cleaned.failures.length, 0);

    const restarted = await Effect.runPromise(application.restart());
    assert.equal(restarted.state, "running");
    if (restarted.state === "running") {
      assert.equal(restarted.port, port);
    }

    await Effect.runPromise(application.stop());
    assert.deepEqual(await Effect.runPromise(application.inspect()), { state: "stopped" });
  } finally {
    await Effect.runPromise(application.stop()).catch(() => undefined);
    await removeFixture(runtimeRoot);
  }
});

test("invalid get references fail before the local daemon starts", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-local-reference-test-"));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const application = createLocalApplication({
    daemonScriptPath,
    config: resolveDaemonConfigForTest({
      appDataDir,
      runtimeDir,
      port: await freePort(),
    }),
  });

  try {
    await assert.rejects(
      Effect.runPromise(
        application.get({
          reference: "https://example.test/not-a-local-reference",
          onChunk: () => undefined,
        })
      ),
      (cause: unknown) => cause instanceof LocalApplicationError && cause.operation === "get"
    );
    assert.equal(existsSync(runtimeDir), false);
  } finally {
    await removeFixture(runtimeRoot);
  }
});

test("local application keeps daemon error tags available to callers", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-local-error-test-"));
  const port = await freePort();
  const owner = createServer((socket) => socket.end());
  await new Promise<void>((resolvePromise, rejectPromise) => {
    owner.once("error", rejectPromise);
    owner.listen(port, "127.0.0.1", () => resolvePromise());
  });
  const application = createLocalApplication({
    daemonScriptPath,
    config: resolveDaemonConfigForTest({
      appDataDir: join(runtimeRoot, "data"),
      runtimeDir: join(runtimeRoot, "data", "runtime"),
      port,
    }),
  });

  try {
    await assert.rejects(
      Effect.runPromise(application.start()),
      (cause: unknown) => cause instanceof DaemonPortInUseError
    );
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) =>
      owner.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)))
    );
    await removeFixture(runtimeRoot);
  }
});
