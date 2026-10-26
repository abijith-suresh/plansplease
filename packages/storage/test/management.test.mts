import assert from "node:assert/strict";
import type { DocumentId } from "@planview/core";
import { join } from "node:path";
import { rm, writeFile, rename } from "node:fs/promises";
import { test } from "node:test";
import { Effect } from "effect";
import {
  DocumentFileDeleteError,
  createSnapshotManagement,
  createDocumentPublicationCoordinator,
  createDocumentCleanupCoordinator,
  createMetadataGatedDocumentReader,
  openStorage,
  openDocumentFileStore,
  V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS,
  type MetadataStore,
} from "../dist/index.js";
import {
  withStorageTestEnvironment,
  type StorageTestEnvironment,
} from "./support/storage-environment.mts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fixture = <T,>(fn: (env: StorageTestEnvironment) => Promise<T>, options = {}) =>
  withStorageTestEnvironment("planview-management-", fn, options);
const publish = async (
  env: StorageTestEnvironment,
  character = "a",
  bytes: string | Buffer = "original"
) => {
  const source = join(env.directory, `${character}.source.html`);
  await writeFile(source, bytes);
  const published = await run(
    createDocumentPublicationCoordinator({
      ...env,
      generateId: () => character.repeat(21) as DocumentId,
      now: () => 1,
    }).publish(source)
  );
  return {
    ...published,
    generation: env.metadataStore.getDocumentMetadataSnapshot(published.id)!.generation,
  };
};

test("bounded inventory reports expiry, stable id continuation and exact logical bytes without touching access", () =>
  fixture(async (env) => {
    const management = createSnapshotManagement(env);
    for (const c of ["c", "a", "b"]) await publish(env, c, "é\r\n");
    const before = env.metadataStore.listDocumentMetadata();
    const page = await run(management.list({ limit: 2 }));
    assert.deepEqual(
      page.snapshots.map((row) => row.id),
      ["a".repeat(21), "b".repeat(21)]
    );
    assert.equal(page.nextAfter, "b".repeat(21));
    assert.equal(page.snapshots[0]!.expiresAt, 1 + 30 * 86400000);
    // Inserts before a continuation belong to a fresh traversal, not this page.
    await publish(env, "0");
    const last = await run(management.list({ limit: 2, after: page.nextAfter! }));
    assert.deepEqual(
      last.snapshots.map((row) => row.id),
      ["c".repeat(21)]
    );
    assert.equal(last.nextAfter, undefined);
    assert.deepEqual(
      env.metadataStore.listDocumentMetadata().filter((row) => row.id !== "0".repeat(21)),
      before
    );
    const usage = await run(management.usage());
    assert.equal(
      usage.documentBytes,
      3 * Buffer.byteLength("é\r\n") + Buffer.byteLength("original")
    );
    assert.equal(usage.metadataBytes, 4 * 4096);
    assert.equal(usage.bytes, usage.documentBytes + usage.metadataBytes);
    assert.equal(usage.quotaBytes, 1024 ** 3);
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity])
      await assert.rejects(run(management.list({ limit })));
    await assert.rejects(run(management.list({ after: "../bad" })));
  }));

test("active read leases retain metadata and exact bytes until release, then selected deletion succeeds", () =>
  fixture(async (env) => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 60, 104, 49, 62, 0, 0xff, 13, 10]);
    const selected = await publish(env, "a", bytes);
    const management = createSnapshotManagement(env);
    const lease = await run(
      createMetadataGatedDocumentReader(env).readPublishedDocumentLease(selected.id)
    );
    assert.deepEqual(Buffer.concat(await lease.stream.toArray()), bytes);
    const retained = await run(management.deleteSnapshot(selected));
    assert.equal(retained.status, "retained");
    assert.equal(retained.removedMetadata, false);
    assert.ok(env.metadataStore.getDocumentMetadata(selected.id));
    lease.release();
    const deleted = await run(management.deleteSnapshot(selected));
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.removedMetadata, true);
    assert.equal(deleted.removedFile, true);
    assert.equal(await env.documentFileStore.getDocumentFileObservation(selected.id), undefined);
    assert.equal((await run(management.usage())).bytes, 0);
    assert.equal((await run(management.deleteSnapshot(selected))).status, "not_found");
  }));

test("a stale immutable generation cannot delete a replacement with identical metadata", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    env.metadataStore.deleteDocument(selected.id);
    env.metadataStore.insertDocumentMetadata(selected.metadata);
    const management = createSnapshotManagement(env);
    assert.equal((await run(management.deleteSnapshot(selected))).status, "stale");
    assert.ok(env.metadataStore.getDocumentMetadata(selected.id));
    const current = (await run(management.list())).snapshots[0]!;
    assert.notEqual(current.generation, selected.generation);
    assert.equal((await run(management.deleteSnapshot(current))).status, "deleted");
  }));

test("generation replacement between observation and locked decision is retained", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    const management = createSnapshotManagement({
      ...env,
      documentFileStore: {
        ...env.documentFileStore,
        getDocumentFileObservation: async (id) => {
          const file = await env.documentFileStore.getDocumentFileObservation(id);
          env.metadataStore.deleteDocument(id);
          env.metadataStore.insertDocumentMetadata(selected.metadata);
          return file;
        },
      },
    });
    assert.equal((await run(management.deleteSnapshot(selected))).status, "stale");
    assert.ok(env.metadataStore.getDocumentMetadata(selected.id));
    assert.ok(await env.documentFileStore.getDocumentFileObservation(selected.id));
  }));

test("file replacement after observation is never unlinked", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    const management = createSnapshotManagement({
      ...env,
      documentFileStore: {
        ...env.documentFileStore,
        getDocumentFileObservation: async (id) => {
          const file = await env.documentFileStore.getDocumentFileObservation(id);
          await rename(
            join(env.documentsDir, `${id}.html`),
            join(env.directory, "kept-original.html")
          );
          await writeFile(join(env.documentsDir, `${id}.html`), "replacement");
          return file;
        },
      },
    });
    const result = await run(management.deleteSnapshot(selected));
    assert.equal(result.status, "retained");
    assert.equal(result.removedMetadata, false);
    assert.equal((await env.documentFileStore.getDocumentFileObservation(selected.id))!.size, 11);
  }));

test("missing file reconciliation removes only the selected generation", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    await rm(join(env.documentsDir, `${selected.id}.html`));
    const result = await run(createSnapshotManagement(env).deleteSnapshot(selected));
    assert.equal(result.status, "deleted");
    assert.equal(result.removedFile, false);
    assert.equal(result.removedMetadata, true);
  }));

test("unlink failure is a partial outcome, hidden immediately, and recoverable after reopening both stores", async () => {
  let failDelete = true;
  await fixture(
    async (env) => {
      const selected = await publish(env);
      assert.equal(
        (await run(createSnapshotManagement(env).setPinned(selected, true))).status,
        "updated"
      );
      assert.equal(env.metadataStore.getPinnedStorageUsage().pinnedCount, 1);
      const result = await run(createSnapshotManagement(env).deleteSnapshot(selected));
      assert.deepEqual(env.metadataStore.getPinnedStorageUsage(), {
        pinnedBytes: 0,
        pinnedCount: 0,
      });
      assert.equal(result.status, "partial");
      assert.equal(result.recovery, "clean");
      assert.equal(result.removedMetadata, true);
      assert.equal(result.removedFile, false);
      await assert.rejects(
        run(createMetadataGatedDocumentReader(env).readPublishedDocumentLease(selected.id))
      );
      assert.ok(await env.documentFileStore.getDocumentFileObservation(selected.id));
      env.metadataStore.close();
      await env.documentFileStore.close();
      const reopenedFiles = Effect.runSync(
        openDocumentFileStore({ documentsDir: env.documentsDir, stagingDir: env.stagingDir })
      );
      const reopened = Effect.runSync(openStorage(join(env.directory, "metadata.sqlite")));
      try {
        failDelete = false;
        const recovered = await run(
          createDocumentCleanupCoordinator({
            ...env,
            metadataStore: reopened,
            documentFileStore: reopenedFiles,
            now: () => Date.now() + V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS + 1000,
          }).clean()
        );
        assert.equal(recovered.removedDocumentFiles, 1);
        assert.equal(recovered.reclaimedBytes, Buffer.byteLength("original"));
        assert.equal(reopened.getDocumentMetadata(selected.id), undefined);
        assert.deepEqual(reopened.getPinnedStorageUsage(), { pinnedBytes: 0, pinnedCount: 0 });
      } finally {
        reopened.close();
        await reopenedFiles.close();
      }
    },
    {
      beforeDocumentTargetDelete: async () => {
        if (failDelete) throw new Error("injected unlink failure");
      },
    }
  );
});

test("metadata failure before or after commit never guesses that the pair was fully deleted", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    for (const commit of [false, true]) {
      const metadataStore: MetadataStore = {
        ...env.metadataStore,
        deleteDocumentIfMatches: (row) => {
          if (commit) env.metadataStore.deleteDocumentIfMatches(row);
          throw new Error("injected metadata acknowledgement failure");
        },
      };
      const result = await run(
        createSnapshotManagement({ ...env, metadataStore }).deleteSnapshot(selected)
      );
      assert.equal(result.status, commit ? "partial" : "retained");
      assert.equal(result.removedMetadata, commit);
      assert.equal(result.removedFile, false);
      assert.equal(result.recovery, commit ? "clean" : "retry_selection");
      assert.ok(await env.documentFileStore.getDocumentFileObservation(selected.id));
    }
  }));

test("inventory never enumerates storage and invalid selection never enters deletion", async () => {
  await fixture(
    async (env) => {
      await publish(env);
      const management = createSnapshotManagement(env);
      assert.equal((await run(management.list())).snapshots.length, 1);
      assert.equal((await run(management.usage())).documentCount, 1);
      await assert.rejects(run(management.deleteSnapshot({ id: "../outside", generation: "bad" })));
    },
    {
      onDocumentFileDirectoryEnumeration: () => {
        throw new Error("Unexpected directory enumeration");
      },
    }
  );
});

test("cancellation before deletion preserves the pair and cancellation inside the pair finishes it", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    const aborted = AbortSignal.abort(new Error("cancelled before work"));
    await assert.rejects(run(createSnapshotManagement(env).deleteSnapshot(selected, aborted)));
    assert.ok(env.metadataStore.getDocumentMetadata(selected.id));
    const controller = new AbortController();
    const management = createSnapshotManagement({
      ...env,
      metadataStore: {
        ...env.metadataStore,
        deleteDocumentIfMatches: (row) => {
          const result = env.metadataStore.deleteDocumentIfMatches(row);
          controller.abort(new Error("cancelled after metadata commit"));
          return result;
        },
      },
    });
    assert.equal(
      (await run(management.deleteSnapshot(selected, controller.signal))).status,
      "deleted"
    );
    assert.equal(await env.documentFileStore.getDocumentFileObservation(selected.id), undefined);
  }));

test("unreadable metadata after an ambiguous commit requires inspection", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    let attempted = false;
    const management = createSnapshotManagement({
      ...env,
      metadataStore: {
        ...env.metadataStore,
        deleteDocumentIfMatches: () => {
          attempted = true;
          throw new Error("unknown commit");
        },
        getDocumentMetadataSnapshot: (id) => {
          if (attempted) throw new Error("metadata unavailable");
          return env.metadataStore.getDocumentMetadataSnapshot(id);
        },
      },
    });
    const result = await run(management.deleteSnapshot(selected));
    assert.equal(result.status, "partial");
    assert.equal(result.removedMetadata, false);
    assert.equal(result.recovery, "inspect");
    assert.ok(await env.documentFileStore.getDocumentFileObservation(selected.id));
  }));

test("a failure acknowledged after unlink never reports definite physical reclamation", () =>
  fixture(async (env) => {
    const selected = await publish(env);
    const management = createSnapshotManagement({
      ...env,
      documentFileStore: {
        ...env.documentFileStore,
        deleteDocumentFileIf: async (...args) => {
          await env.documentFileStore.deleteDocumentFileIf(...args);
          throw new DocumentFileDeleteError({
            id: selected.id,
            targetState: "absent",
            targetLockState: "unknown",
            cause: new Error("directory sync acknowledgement failure"),
            message: "durable deletion uncertain",
          });
        },
      },
    });
    const result = await run(management.deleteSnapshot(selected));
    assert.equal(result.status, "partial");
    assert.equal(result.removedMetadata, true);
    assert.equal(result.removedFile, false);
    assert.equal(result.fileState, "absent");
    assert.equal(result.recovery, "clean");
    assert.equal(await env.documentFileStore.getDocumentFileObservation(selected.id), undefined);
  }));
