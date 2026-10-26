import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import { cloudUploadFingerprint } from "@planview/core";
import { CURRENT_SCHEMA_VERSION, openStorage } from "../dist/index.js";

test("v2 to v3 preserves immutable generation and receipts persist independently across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "share-migrate-"));
  const path = join(root, "metadata.sqlite");
  try {
    const id = "a".repeat(21);
    let storage = Effect.runSync(openStorage(path));
    storage.insertDocumentMetadata({ id, createdAt: 1, lastAccessedAt: 1, size: 0 });
    const generation = storage.getDocumentMetadataSnapshot(id)!.generation;
    storage.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE snapshot_pins; DROP TABLE share_attempts; PRAGMA user_version = 2");
    legacy.close();
    storage = Effect.runSync(openStorage(path));
    assert.equal(storage.getDocumentMetadataSnapshot(id)?.generation, generation);
    const contentSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const attempt = {
      version: 1 as const,
      id,
      generation,
      key: randomUUID(),
      origin: "https://cloud.example",
      accountId: "a",
      title: "Snapshot",
      contentType: "text/html" as const,
      size: 0,
      contentSha256,
      fingerprint: cloudUploadFingerprint("Snapshot", "text/html", 0, contentSha256),
      createdAt: 1,
      status: "unknown" as const,
    };
    storage.insertShareAttempt(attempt);
    storage.close();
    storage = Effect.runSync(openStorage(path));
    assert.deepEqual(storage.latestShareAttempt(attempt), attempt);
    storage.deleteDocument(id);
    assert.deepEqual(storage.getShareAttempt(attempt.key), attempt);
    storage.close();
    const database = new DatabaseSync(path);
    assert.equal(
      database.prepare("PRAGMA user_version").get()?.["user_version"],
      CURRENT_SCHEMA_VERSION
    );
    // Corruption of duplicated indexed identity must not return a different operation.
    database.prepare("UPDATE share_attempts SET accountId = ?").run("other");
    database.close();
    storage = Effect.runSync(openStorage(path));
    assert.throws(() => storage.getShareAttempt(attempt.key), /identity mismatch/);
    storage.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
