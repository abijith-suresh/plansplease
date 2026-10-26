import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  createBundleHeader,
  encodeBundleManifest,
  type DocumentId,
  V1_STORAGE_QUOTA_BYTES,
} from "@planview/core";
import {
  createDocumentCleanupCoordinator,
  createDocumentPublicationCoordinator,
  createSnapshotManagement,
  openStorage,
  V1_RETENTION_MILLISECONDS,
} from "../dist/index.js";
import { withStorageTestEnvironment } from "./support/storage-environment.mts";
const run = Effect.runPromise;
const id = "a".repeat(21) as DocumentId;
const fixture = (
  fn: (env: Parameters<Parameters<typeof withStorageTestEnvironment>[1]>[0]) => Promise<void>
) => withStorageTestEnvironment("pins-", fn);
const seed = async (
  env: Parameters<Parameters<typeof withStorageTestEnvironment>[1]>[0],
  folder = false
) => {
  const source = join(env.directory, "source.html");
  if (folder) {
    const html = Buffer.from("<h1>é</h1>\r\n");
    const data = Buffer.from([0, 255, 1]);
    const manifest = encodeBundleManifest([
      { path: "index.html", offset: 0, size: html.length },
      { path: "data.bin", offset: html.length, size: data.length },
    ]);
    await writeFile(
      source,
      Buffer.concat([Buffer.from(createBundleHeader(manifest)), Buffer.from(manifest), html, data])
    );
  } else await writeFile(source, Buffer.from([0xef, 0xbb, 0xbf, 0, 255, 13, 10]));
  await run(
    createDocumentPublicationCoordinator({ ...env, now: () => 1, generateId: () => id }).publish(
      source
    )
  );
  return env.metadataStore.getDocumentMetadataSnapshot(id)!;
};

test("pin survives expiry, preserves access/generation/exact folder bytes, and unpin restores original expiry", () =>
  fixture(async (env) => {
    const row = await seed(env, true);
    const bytes = await readFile(join(env.documentsDir, `${id}.html`));
    const management = createSnapshotManagement(env);
    assert.equal((await run(management.setPinned(row, true))).status, "updated");
    assert.deepEqual((await run(management.list())).snapshots[0], {
      ...row,
      pinned: true,
      expiresAt: null,
      unpinnedExpiresAt: 1 + V1_RETENTION_MILLISECONDS,
    });
    const cleanup = createDocumentCleanupCoordinator({
      ...env,
      now: () => V1_RETENTION_MILLISECONDS * 2,
    });
    await run(cleanup.clean());
    assert.deepEqual(await readFile(join(env.documentsDir, `${id}.html`)), bytes);
    assert.equal((await run(management.usage())).pinnedBytes, bytes.length + 4096);
    const unpin = await run(management.setPinned(row, false));
    assert.equal(unpin.retention?.expiresAt, 1 + V1_RETENTION_MILLISECONDS);
    assert.equal(env.metadataStore.getDocumentMetadata(id)?.lastAccessedAt, 1);
    await run(cleanup.clean());
    assert.equal(env.metadataStore.getDocumentMetadata(id), undefined);
  }));

test("cleanup's final expiry fence respects a pin acquired after candidate selection", () =>
  fixture(async (env) => {
    const row = await seed(env);
    const cleanup = createDocumentCleanupCoordinator({
      ...env,
      now: () => V1_RETENTION_MILLISECONDS * 2,
      beforeDocumentCleanup: async () => {
        env.metadataStore.setDocumentPinned(row, true);
      },
    });
    await run(cleanup.clean());
    assert.equal(env.metadataStore.getDocumentMetadataSnapshot(id)?.pinned, true);
    assert.ok(await env.documentFileStore.getDocumentFileObservation(id));
    assert.equal(
      env.metadataStore.deleteDocumentIfLastAccessedBefore(row, V1_RETENTION_MILLISECONDS * 2),
      undefined
    );
    assert.equal(env.metadataStore.deleteDocumentIfMatches(row, true), false);
  }));

test("final reconciliation fence preserves a new pin even for a mismatched file", () =>
  fixture(async (env) => {
    const row = await seed(env);
    env.metadataStore.recordDocumentAccess(id, V1_RETENTION_MILLISECONDS * 2);
    const store = {
      ...env.metadataStore,
      deleteDocumentIfMatches: (candidate: typeof row, automatic?: boolean) => {
        env.metadataStore.setDocumentPinned(candidate, true);
        return env.metadataStore.deleteDocumentIfMatches(candidate, automatic);
      },
    };
    await writeFile(join(env.documentsDir, `${id}.html`), "changed!!");
    await run(
      createDocumentCleanupCoordinator({
        ...env,
        metadataStore: store,
        now: () => V1_RETENTION_MILLISECONDS * 2,
      }).clean()
    );
    assert.equal(env.metadataStore.getDocumentMetadataSnapshot(id)?.pinned, true);
    assert.equal((await env.documentFileStore.getDocumentFileObservation(id))?.size, 9);
  }));

test("manual delete remains allowed while pinned and retains active reads; stale pin cannot rebind", () =>
  fixture(async (env) => {
    const row = await seed(env);
    const management = createSnapshotManagement(env);
    const lease = await env.documentFileStore.readDocumentLease(id);
    assert.equal((await run(management.setPinned(row, true))).status, "updated");
    assert.equal((await run(management.deleteSnapshot(row))).status, "retained");
    lease.stream.destroy();
    await once(lease.stream, "close");
    lease.release();
    assert.equal((await run(management.deleteSnapshot(row))).status, "deleted");
    assert.equal((await run(management.setPinned(row, true))).status, "not_found");
    const replacement = await seed(env);
    assert.notEqual(replacement.generation, row.generation);
    assert.equal((await run(management.setPinned(row, true))).status, "stale");
    assert.equal(env.metadataStore.getDocumentMetadataSnapshot(id)?.pinned, false);
  }));

test("pins count toward finite quota across reopen and publication refuses without evicting them", () =>
  fixture(async (env) => {
    const row = await seed(env);
    env.metadataStore.setDocumentPinned(row, true);
    // Metadata-only quota boundary fixture. Installed smoke covers matching physical files.
    const other = "b".repeat(21);
    env.metadataStore.insertDocumentMetadata({
      id: other,
      createdAt: 1,
      lastAccessedAt: 1,
      size: V1_STORAGE_QUOTA_BYTES - row.size - 8192,
    });
    env.metadataStore.setDocumentPinned(
      env.metadataStore.getDocumentMetadataSnapshot(other)!,
      true
    );
    env.metadataStore.close();
    const reopened = Effect.runSync(openStorage(join(env.directory, "metadata.sqlite")));
    try {
      assert.equal(reopened.getDocumentMetadataSnapshot(id)?.generation, row.generation);
      assert.equal(reopened.getDocumentMetadataSnapshot(id)?.pinned, true);
      const source = join(env.directory, "new.html");
      await writeFile(source, "new");
      await assert.rejects(
        run(
          createDocumentPublicationCoordinator({ ...env, metadataStore: reopened }).publish(source)
        ),
        /quota.*|Pins count/s
      );
      assert.equal(reopened.getDocumentStorageUsage().bytes, V1_STORAGE_QUOTA_BYTES);
      assert.equal(reopened.getPinnedStorageUsage().pinnedBytes, V1_STORAGE_QUOTA_BYTES);
    } finally {
      reopened.close();
    }
  }));

test("ambiguous pin acknowledgement is inspectable and a failed write neither renews access nor resurrects", () =>
  fixture(async (env) => {
    const row = await seed(env);
    for (const commit of [false, true]) {
      const management = createSnapshotManagement({
        ...env,
        metadataStore: {
          ...env.metadataStore,
          setDocumentPinned: (selection, pinned) => {
            if (commit) env.metadataStore.setDocumentPinned(selection, pinned);
            throw new Error("commit acknowledgement lost");
          },
        },
      });
      await assert.rejects(run(management.setPinned(row, true)), /Refresh list/);
      assert.equal(env.metadataStore.getDocumentMetadataSnapshot(id)?.pinned, commit);
      assert.equal(env.metadataStore.getDocumentMetadata(id)?.lastAccessedAt, 1);
    }
  }));

test("missing-file reconciliation cannot remove metadata pinned after observation", () =>
  fixture(async (env) => {
    const row = await seed(env);
    env.metadataStore.recordDocumentAccess(id, V1_RETENTION_MILLISECONDS * 2);
    await env.documentFileStore.deleteDocumentFile(id);
    const store = {
      ...env.metadataStore,
      deleteDocumentIfMatches: (candidate: typeof row, automatic?: boolean) => {
        env.metadataStore.setDocumentPinned(candidate, true);
        return env.metadataStore.deleteDocumentIfMatches(candidate, automatic);
      },
    };
    await run(
      createDocumentCleanupCoordinator({
        ...env,
        metadataStore: store,
        now: () => V1_RETENTION_MILLISECONDS * 2,
      }).clean()
    );
    assert.equal(env.metadataStore.getDocumentMetadataSnapshot(id)?.pinned, true);
    assert.equal((await run(createSnapshotManagement(env).deleteSnapshot(row))).status, "deleted");
  }));

test("cancellation after file observation releases the lease without changing pin/access state", () =>
  fixture(async (env) => {
    const row = await seed(env);
    const controller = new AbortController();
    const management = createSnapshotManagement({
      ...env,
      documentFileStore: {
        ...env.documentFileStore,
        getDocumentFileObservation: async (id) => {
          const observation = await env.documentFileStore.getDocumentFileObservation(id);
          controller.abort(new Error("caller cancelled after observation"));
          return observation;
        },
      },
    });
    await assert.rejects(run(management.setPinned(row, true, controller.signal)), /not confirmed/);
    assert.deepEqual(env.metadataStore.getDocumentMetadataSnapshot(id), row);
    assert.equal((await run(createSnapshotManagement(env).deleteSnapshot(row))).status, "deleted");
  }));
