import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { V1_STORAGE_METADATA_BYTES_PER_DOCUMENT, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Effect, Exit } from "effect";
import type { DocumentMetadata, MetadataStore } from "../dist/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  openStorage,
  openStorageScoped,
  StorageClosedError,
  StorageInvariantError,
  StorageMigrationError,
  StorageOpenError,
  StoragePathError,
  StorageQuotaExceededError,
} from "../dist/index.js";

type SqliteRow = Readonly<{
  readonly count?: unknown;
  readonly name?: unknown;
  readonly sql?: unknown;
  readonly user_version?: unknown;
}>;
type StorageEnvironment = Readonly<{
  readonly databasePath: string;
  readonly directory: string;
  readonly storage: MetadataStore;
}>;

const withTempDirectory = async <T,>(
  prefix: string,
  callback: (directory: string) => T | PromiseLike<T>
): Promise<T> => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const withStorage = <T,>(callback: (environment: StorageEnvironment) => T | PromiseLike<T>) =>
  withTempDirectory("planview-storage-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    let storage: MetadataStore | undefined;
    try {
      storage = Effect.runSync(openStorage(databasePath));
      return await callback({ databasePath, directory, storage });
    } finally {
      storage?.close();
    }
  });

const metadata = (
  id: string,
  createdAt: number,
  size: number,
  lastAccessedAt = createdAt
): DocumentMetadata => ({
  id,
  createdAt,
  lastAccessedAt,
  size,
});

const generationCount = (databasePath: string): number => {
  const database = new DatabaseSync(databasePath);
  try {
    const count = (
      database.prepare("SELECT COUNT(*) AS count FROM document_generations").get() as SqliteRow
    ).count;
    if (typeof count !== "number") {
      throw new TypeError("SQLite returned a non-numeric generation count.");
    }
    return count;
  } finally {
    database.close();
  }
};

const inspectSchema = (databasePath: string) => {
  const database = new DatabaseSync(databasePath);
  try {
    const version = (database.prepare("PRAGMA user_version").get() as SqliteRow).user_version;
    const columns = database.prepare("PRAGMA table_info(documents)").all() as SqliteRow[];
    return {
      version,
      columns: columns.map((row) => row.name),
    };
  } finally {
    database.close();
  }
};

const createDatabase = (databasePath: string, schema: string, version = 1) => {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(schema);
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
};

test("scoped metadata storage closes after the using effect fails", async () =>
  withTempDirectory("planview-storage-scope-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    let scopedStorage: MetadataStore | undefined;
    const exit = Effect.runSyncExit(
      Effect.scoped(
        Effect.gen(function* () {
          const storage = yield* openStorageScoped(databasePath);
          scopedStorage = storage;
          storage.insertDocumentMetadata(metadata("scoped", 1, 10));
          return yield* Effect.fail("stop after acquisition");
        })
      )
    );

    assert.equal(Exit.isFailure(exit), true);
    assert.ok(scopedStorage);
    const closedStorage = scopedStorage;
    assert.throws(() => closedStorage.getDocumentMetadata("scoped"), StorageClosedError);
  }));

const waitForWorkerMessage = (worker: Worker, expected: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message === expected) {
        worker.off("error", onError);
        resolve();
      }
    };
    const onError = (error: Error) => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
  });

const openWorker = (databasePath: string) => {
  const worker = new Worker(new URL("./concurrent-opener-worker.mts", import.meta.url), {
    workerData: { databasePath },
  });
  return { worker, ready: waitForWorkerMessage(worker, "ready") };
};

test("accounts document bytes and metadata before atomically admitting a publication", () =>
  withStorage(({ storage }) => {
    storage.insertDocumentMetadata(
      metadata("full", 1, V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT)
    );
    assert.deepEqual(storage.getDocumentStorageUsage(), {
      bytes: V1_STORAGE_QUOTA_BYTES,
      documentBytes: V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
      metadataBytes: V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
      documentCount: 1,
    });

    assert.throws(
      () => storage.insertDocumentMetadata(metadata("next", 2, 1)),
      (error) =>
        error instanceof StorageQuotaExceededError &&
        error.currentBytes === V1_STORAGE_QUOTA_BYTES &&
        error.requestedBytes === V1_STORAGE_METADATA_BYTES_PER_DOCUMENT + 1 &&
        error.quotaBytes === V1_STORAGE_QUOTA_BYTES &&
        /fixed 1 GiB limit/.test(error.message)
    );
    assert.equal(storage.getDocumentMetadata("next"), undefined);
  }));

test("serializes concurrent quota admission across storage instances", () =>
  withTempDirectory("planview-storage-quota-race-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    const workers = ["left", "right"].map(
      (id) =>
        new Worker(new URL("./quota-insert-worker.mts", import.meta.url), {
          workerData: { databasePath, id },
        })
    );
    try {
      const results = await Promise.all(
        workers.map(
          (worker) =>
            new Promise((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("error", reject);
            })
        )
      );
      assert.equal(results.filter((result) => result === "accepted").length, 1);
      assert.equal(results.filter((result) => result === "quota").length, 1);
      const storage = Effect.runSync(openStorage(databasePath));
      try {
        assert.equal(storage.getDocumentStorageUsage().bytes, V1_STORAGE_QUOTA_BYTES);
      } finally {
        storage.close();
      }
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }));

test("retention deletion releases the fixed metadata quota charge", () =>
  withStorage(({ storage }) => {
    storage.insertDocumentMetadata(
      metadata("expired", 1, V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT)
    );
    assert.throws(
      () => storage.insertDocumentMetadata(metadata("blocked", 2, 1)),
      StorageQuotaExceededError
    );
    assert.notEqual(storage.deleteDocumentIfLastAccessedBefore("expired", 2), undefined);
    storage.insertDocumentMetadata(metadata("reclaimed", 3, 1));
    assert.equal(storage.getDocumentMetadata("reclaimed")?.size, 1);
  }));

test("migrates populated v1 metadata to v2 and creates a generation for each row", () =>
  withTempDirectory("planview-storage-v1-migration-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    createDatabase(
      databasePath,
      `
        CREATE TABLE documents (
          id TEXT PRIMARY KEY NOT NULL
            CHECK (typeof(id) = 'text' AND length(trim(id)) > 0),
          createdAt INTEGER NOT NULL
            CHECK (typeof(createdAt) = 'integer' AND createdAt >= 0),
          lastAccessedAt INTEGER NOT NULL
            CHECK (typeof(lastAccessedAt) = 'integer' AND lastAccessedAt >= createdAt),
          size INTEGER NOT NULL
            CHECK (typeof(size) = 'integer' AND size >= 0)
        ) STRICT
      `
    );

    const seed = new DatabaseSync(databasePath);
    try {
      const insert = seed.prepare(
        "INSERT INTO documents (id, createdAt, lastAccessedAt, size) VALUES (:id, :createdAt, :lastAccessedAt, :size)"
      );
      insert.run({ ":id": "legacy-first", ":createdAt": 10, ":lastAccessedAt": 12, ":size": 31 });
      insert.run({ ":id": "legacy-second", ":createdAt": 20, ":lastAccessedAt": 24, ":size": 47 });
    } finally {
      seed.close();
    }

    const storage = Effect.runSync(openStorage(databasePath));
    try {
      assert.deepEqual(storage.getDocumentMetadata("legacy-first"), {
        id: "legacy-first",
        createdAt: 10,
        lastAccessedAt: 12,
        size: 31,
      });
      assert.deepEqual(storage.getDocumentMetadata("legacy-second"), {
        id: "legacy-second",
        createdAt: 20,
        lastAccessedAt: 24,
        size: 47,
      });

      const page = storage.listDocumentMetadataPage(10);
      assert.equal(page.hasMore, false);
      assert.deepEqual(
        page.rows.map(({ id, createdAt, lastAccessedAt, size }) => ({
          id,
          createdAt,
          lastAccessedAt,
          size,
        })),
        [
          { id: "legacy-first", createdAt: 10, lastAccessedAt: 12, size: 31 },
          { id: "legacy-second", createdAt: 20, lastAccessedAt: 24, size: 47 },
        ]
      );
      assert.ok(page.rows.every(({ generation }) => generation.length > 0));
      assert.notEqual(page.rows[0]?.generation, page.rows[1]?.generation);
      assert.equal(generationCount(databasePath), 2);
      assert.deepEqual(inspectSchema(databasePath), {
        version: CURRENT_SCHEMA_VERSION,
        columns: ["id", "createdAt", "lastAccessedAt", "size"],
      });
    } finally {
      storage.close();
    }
  }));

test("serializes concurrent v0 openers and lets both observe the committed migration", () =>
  withTempDirectory("planview-storage-concurrent-", async (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    createDatabase(databasePath, "", 0);

    let blocker: DatabaseSync | undefined;
    const openers: Array<ReturnType<typeof openWorker>> = [];
    try {
      blocker = new DatabaseSync(databasePath);
      blocker.exec("BEGIN IMMEDIATE");
      openers.push(openWorker(databasePath));
      openers.push(openWorker(databasePath));
      await Promise.all(openers.map(({ ready }) => ready));
      openers.forEach(({ worker }) => {
        worker.postMessage("open");
      });
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "opening")));
      blocker.exec("COMMIT");
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "opened")));
      assert.deepEqual(inspectSchema(databasePath), {
        version: CURRENT_SCHEMA_VERSION,
        columns: ["id", "createdAt", "lastAccessedAt", "size"],
      });
      openers.forEach(({ worker }) => {
        worker.postMessage("close");
      });
      await Promise.all(openers.map(({ worker }) => waitForWorkerMessage(worker, "closed")));
    } finally {
      try {
        blocker?.exec("ROLLBACK");
      } catch {
        // The transaction may already have been committed.
      }
      blocker?.close();
      await Promise.all(openers.map(({ worker }) => worker.terminate()));
    }
  }));

test("rejects a claimed v1 database whose schema omits required semantics without repair", () =>
  withTempDirectory("planview-storage-schema-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    const incompatibleSchema = `
      CREATE TABLE documents (
        id TEXT,
        createdAt INTEGER NOT NULL,
        lastAccessedAt INTEGER NOT NULL,
        size INTEGER NOT NULL
      )
    `;
    createDatabase(databasePath, incompatibleSchema);

    assert.throws(
      () => Effect.runSync(openStorage(databasePath)),
      (error) => error instanceof StorageMigrationError && /schema/i.test(error.message)
    );
    const database = new DatabaseSync(databasePath);
    try {
      assert.equal((database.prepare("PRAGMA user_version").get() as SqliteRow).user_version, 1);
      const actualSchema = (
        database
          .prepare("SELECT sql FROM sqlite_schema WHERE name = 'documents'")
          .get() as SqliteRow
      ).sql;
      if (typeof actualSchema !== "string") {
        throw new TypeError("SQLite returned no documents schema.");
      }
      assert.equal(
        actualSchema.replace(/\s+/g, " ").trim(),
        incompatibleSchema.replace(/\s+/g, " ").trim()
      );
    } finally {
      database.close();
    }
  }));

test("rejects a claimed v1 database with a trigger that could bypass monotonic access", () =>
  withTempDirectory("planview-storage-trigger-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    const schemaWithTrigger = `
      CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        createdAt INTEGER NOT NULL,
        lastAccessedAt INTEGER NOT NULL,
        size INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER rewrite_access AFTER UPDATE OF lastAccessedAt ON documents
      BEGIN
        UPDATE documents SET lastAccessedAt = 0 WHERE id = NEW.id;
      END;
    `;
    createDatabase(databasePath, schemaWithTrigger);

    assert.throws(
      () => Effect.runSync(openStorage(databasePath)),
      (error) =>
        error instanceof StorageMigrationError &&
        /unexpected user schema object/i.test(error.message)
    );
  }));

test("metadata cursors use SQLite bytewise order and a rowid watermark", () =>
  withStorage(({ storage }) => {
    const ids = ["A", "_", "-", "a", "0"].map((character) => character.repeat(21));
    ids.forEach((id) => {
      storage.insertDocumentMetadata(metadata(id, 1, 1));
    });
    const expected = [...ids].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    );
    const observed: string[] = [];
    const watermark = storage.getDocumentMetadataScanWatermark();
    let cursor: string | undefined;
    let page: ReturnType<MetadataStore["listDocumentMetadataPage"]>;
    do {
      page = storage.listDocumentMetadataPage(2, cursor, watermark);
      observed.push(...page.rows.map((row) => row.id));
      cursor = page.rows.at(-1)?.id;
    } while (page.hasMore);
    assert.deepEqual(observed, expected);
  }));

test("supports immutable insert, lookup, access recording, aggregate, and delete", () => {
  return withStorage(({ databasePath, storage }) => {
    const original = metadata("doc-1", 1_700_000_000_000, 120, 1_700_000_000_100);
    storage.insertDocumentMetadata(original);

    assert.deepEqual(storage.getDocumentMetadata("doc-1"), original);
    assert.equal(storage.recordDocumentAccess("doc-1", 1_700_000_000_200), true);
    assert.throws(
      () => storage.recordDocumentAccess("doc-1", 1_700_000_000_150),
      (error) =>
        error instanceof StorageInvariantError &&
        /must not be earlier than lastAccessedAt/.test(error.message)
    );
    assert.deepEqual(storage.getDocumentMetadata("doc-1"), {
      ...original,
      lastAccessedAt: 1_700_000_000_200,
    });
    assert.deepEqual(storage.getDocumentAggregate(), { count: 1, size: 120 });
    assert.equal(storage.deleteDocument("doc-1"), true);
    assert.equal(storage.getDocumentMetadata("doc-1"), undefined);
    assert.equal(generationCount(databasePath), 0);
    assert.deepEqual(storage.getDocumentAggregate(), { count: 0, size: 0 });
    assert.equal(storage.deleteDocument("doc-1"), false);
  });
});

test("deletes only the generation belonging to the deleted document", () =>
  withStorage(({ databasePath, storage }) => {
    storage.insertDocumentMetadata(metadata("reusable", 1, 1));
    const original = storage.listDocumentMetadataCandidates(2, 1).rows[0];
    assert.ok(original);
    assert.equal(storage.deleteDocumentIfMatches(original), true);
    assert.equal(generationCount(databasePath), 0);

    storage.insertDocumentMetadata(metadata("reusable", 2, 2));
    const replacement = storage.listDocumentMetadataCandidates(3, 1).rows[0];
    assert.ok(replacement);
    assert.notEqual(replacement.generation, original.generation);
    assert.equal(storage.deleteDocumentIfMatches(original), false);
    assert.equal(generationCount(databasePath), 1);
    assert.deepEqual(storage.getDocumentMetadata("reusable"), {
      id: "reusable",
      createdAt: 2,
      lastAccessedAt: 2,
      size: 2,
    });
    assert.equal(storage.deleteDocumentIfMatches(replacement), true);
    assert.equal(generationCount(databasePath), 0);
  }));

test("persists metadata across close and reopen", () =>
  withTempDirectory("planview-storage-persistence-", (directory) => {
    const databasePath = join(directory, "metadata.sqlite");
    let first: MetadataStore | undefined;
    let second: MetadataStore | undefined;
    try {
      first = Effect.runSync(openStorage(databasePath));
      const expected = metadata("persistent", 42, 9, 43);
      first.insertDocumentMetadata(expected);
      first.close();
      first = undefined;

      second = Effect.runSync(openStorage(databasePath));
      assert.deepEqual(second.getDocumentMetadata("persistent"), expected);
      assert.deepEqual(second.getDocumentAggregate(), { count: 1, size: 9 });
    } finally {
      first?.close();
      second?.close();
    }
  }));

test("enforces identifier, size, and epoch timestamp invariants", () => {
  return withStorage(({ storage }) => {
    for (const invalid of [
      metadata("", 1, 1),
      metadata("   ", 1, 1),
      metadata("negative-size", 1, -1),
      metadata("fractional-size", 1, 1.5),
      metadata("negative-created", -1, 1),
      metadata("unsafe-created", Number.MAX_SAFE_INTEGER + 1, 1),
      metadata("before-created", 2, 1, 1),
    ]) {
      assert.throws(() => storage.insertDocumentMetadata(invalid), StorageInvariantError);
    }

    storage.insertDocumentMetadata(metadata("valid", 10, 0));
    assert.throws(
      () => storage.recordDocumentAccess("valid", 9),
      (error) => error instanceof StorageInvariantError && error.field === "accessedAt"
    );
    assert.equal(storage.recordDocumentAccess("missing", 10), false);
  });
});

test("rejects duplicate ids without mutating the existing immutable row", () => {
  return withStorage(({ storage }) => {
    const original = metadata("same-id", 1, 10);
    storage.insertDocumentMetadata(original);
    assert.throws(
      () => storage.insertDocumentMetadata(metadata("same-id", 2, 20)),
      /UNIQUE|constraint/i
    );
    assert.deepEqual(storage.getDocumentMetadata("same-id"), original);
  });
});

test("closes idempotently and rejects operations after close", () => {
  return withStorage(({ storage }) => {
    storage.close();
    storage.close();
    assert.throws(() => storage.getDocumentAggregate(), StorageClosedError);
  });
});

test("reports clear typed errors for invalid and unavailable database paths", () => {
  assert.throws(
    () => Effect.runSync(openStorage("relative.sqlite")),
    (error) => error instanceof StoragePathError
  );

  return withTempDirectory("planview-storage-path-", (directory) => {
    assert.throws(
      () => Effect.runSync(openStorage(join(directory, "missing", "metadata.sqlite"))),
      (error) =>
        error instanceof StorageOpenError &&
        /Could not open SQLite metadata storage/.test(error.message)
    );
  });
});
