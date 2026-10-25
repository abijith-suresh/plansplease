import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  cleanDaemon,
  DAEMON_CLEAN_PATH,
  DAEMON_DESCRIPTOR_NAME,
  DAEMON_STATUS_PATH,
  DaemonRequestError,
  resolveDaemonConfigForTest,
} from "../dist/index.js";

const cleanupResult = {
  now: 100,
  cutoff: 0,
  removedDocuments: 1,
  removedDocumentFiles: 2,
  removedMetadataRows: 3,
  removedStagedFiles: 4,
  removedReadReferences: 5,
  removedFinalizationLocks: 6,
  reclaimedBytes: 7,
  retainedEntries: 8,
  processedItems: 9,
  resumable: true,
  failures: [
    { phase: "staging", cause: "staging failed", message: "staging failed" },
    { phase: "metadata", id: "document", cause: { code: "busy" }, message: "metadata failed" },
    { phase: "document-file", id: "", cause: null, message: "" },
  ],
};

const withCleanupClient = async (
  run: (
    clean: (payload: Record<string, unknown>) => ReturnType<typeof cleanDaemon>
  ) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), "planview-daemon-response-"));
  const runtimeDir = join(directory, "runtime");
  let cleanupPayload: Record<string, unknown> = cleanupResult;
  const status = {
    state: "running",
    profile: "default",
    pid: process.pid,
    host: "127.0.0.1",
    port: 0,
    startedAt: Date.now(),
  };
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === DAEMON_STATUS_PATH) {
      response.end(JSON.stringify(status));
    } else if (request.url === DAEMON_CLEAN_PATH && request.method === "POST") {
      response.end(JSON.stringify(cleanupPayload));
    } else {
      response.writeHead(404).end();
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    status.port = address.port;
    await mkdir(runtimeDir, { mode: 0o700 });
    await writeFile(
      join(runtimeDir, DAEMON_DESCRIPTOR_NAME),
      JSON.stringify({ version: 1, ...status, secret: "private-response-test-secret-long-enough" }),
      { mode: 0o600 }
    );
    const config = resolveDaemonConfigForTest({
      appDataDir: directory,
      runtimeDir,
      port: address.port,
    });
    await run((payload) => {
      cleanupPayload = payload;
      return cleanDaemon(config, { daemonScriptPath: "unused-for-running-daemon" });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
};

test("cleanup client preserves counts, resumability, and all failure phases", () =>
  withCleanupClient(async (clean) => {
    const response = await Effect.runPromise(clean({ ...cleanupResult, ignored: "extra field" }));
    assert.deepEqual(response.result, cleanupResult);
    assert.equal(response.reused, true);
    const firstFailure = response.result.failures[0];
    assert.ok(firstFailure);
    assert.equal("id" in firstFailure, false);
  }));

test("cleanup client rejects malformed counts and failure records with the protocol error", () =>
  withCleanupClient(async (clean) => {
    const malformed: Record<string, unknown>[] = [];
    for (const [field, value] of Object.entries(cleanupResult)) {
      if (typeof value === "number") {
        for (const invalid of [undefined, null, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          malformed.push({ ...cleanupResult, [field]: invalid });
        }
      }
    }
    for (const failures of [
      undefined,
      null,
      {},
      [null],
      ["staging"],
      [{ phase: "unknown", message: "failed" }],
      [{ phase: 1, message: "failed" }],
      [{ phase: "staging" }],
      [{ phase: "staging", message: 1 }],
      [{ phase: "staging", id: null, message: "failed" }],
      [{ phase: "staging", id: 1, message: "failed" }],
    ]) {
      malformed.push({ ...cleanupResult, failures });
    }
    for (const resumable of [undefined, null, 0, "true"]) {
      malformed.push({ ...cleanupResult, resumable });
    }
    for (const payload of malformed) {
      await assert.rejects(Effect.runPromise(clean(payload)), (error) => {
        assert.ok(error instanceof DaemonRequestError);
        assert.equal(error.path, DAEMON_CLEAN_PATH);
        assert.equal(
          error.message,
          `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`
        );
        assert.deepEqual(error.cause, JSON.parse(JSON.stringify(payload)));
        return true;
      });
    }
  }));
