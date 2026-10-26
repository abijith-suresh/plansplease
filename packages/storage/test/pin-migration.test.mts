import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Effect } from "effect";
import { openStorage } from "../dist/index.js";

test("additive v3 migration preserves immutable generations/access and refuses malformed/future schemas without changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pin-migration-"));
  const path = join(directory, "metadata.sqlite");
  try {
    let store = Effect.runSync(openStorage(path));
    const id = "a".repeat(21);
    store.insertDocumentMetadata({ id, createdAt: 1, lastAccessedAt: 2, size: 3 });
    const before = store.getDocumentMetadataSnapshot(id)!;
    store.close();
    let db = new DatabaseSync(path);
    db.exec("DROP TABLE snapshot_pins; PRAGMA user_version = 3");
    db.close();
    store = Effect.runSync(openStorage(path));
    assert.deepEqual(store.getDocumentMetadataSnapshot(id), before);
    store.setDocumentPinned(before, true);
    store.close();
    store = Effect.runSync(openStorage(path));
    assert.deepEqual(store.getDocumentMetadataSnapshot(id), { ...before, pinned: true });
    store.close();
    db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 5");
    db.close();
    const future = await readFile(path);
    assert.throws(() => Effect.runSync(openStorage(path)), /not supported/);
    assert.deepEqual(await readFile(path), future);
    db = new DatabaseSync(path);
    db.exec(
      "PRAGMA user_version = 4; DROP TABLE snapshot_pins; CREATE TABLE snapshot_pins (id TEXT); "
    );
    db.close();
    const malformed = await readFile(path);
    assert.throws(() => Effect.runSync(openStorage(path)), /Invalid metadata schema/);
    assert.deepEqual(await readFile(path), malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
