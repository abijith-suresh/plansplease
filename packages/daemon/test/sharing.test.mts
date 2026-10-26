import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  openStorage,
  openDocumentFileStore,
  createDocumentPublicationCoordinator,
  createSnapshotManagement,
  parseShareAttempt,
} from "@planview/storage";
import { createDaemonSharing } from "../dist/sharing.js";
import { createOperationGate } from "../dist/operation-gate.js";

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  bytes = Buffer.from("\ufeff<h1>é</h1>\r\n\0")
) {
  const directory = await mkdtemp(join(tmpdir(), "share-owned-"));
  const storage = Effect.runSync(openStorage(join(directory, "metadata.sqlite")));
  const files = await Effect.runPromise(
    openDocumentFileStore({
      documentsDir: join(directory, "documents"),
      stagingDir: join(directory, "staging"),
    })
  );
  const publication = createDocumentPublicationCoordinator({
    metadataStore: storage,
    documentFileStore: files,
  });
  const source = join(directory, "source.html");
  await writeFile(source, bytes);
  const published = await Effect.runPromise(publication.publish(source));
  const sharing = createDaemonSharing({
    metadataStore: storage,
    publication,
    operationGate: createOperationGate(),
    origin: () => "http://127.0.0.1:4777",
  });
  t.after(async () => {
    await files.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    bytes,
    storage,
    files,
    publication,
    sharing,
    source,
    published,
    scope: { id: published.id, origin: "https://cloud.example", accountId: "account-a" },
  };
}
const receiptFor = (
  attempt: Awaited<ReturnType<ReturnType<typeof createDaemonSharing>["prepare"]>>["attempt"],
  status: "pending" | "committed" | "failed" = "committed"
) => ({
  version: 1,
  accountId: attempt.accountId,
  origin: attempt.origin,
  key: attempt.key,
  fingerprint: attempt.fingerprint,
  contentSha256: attempt.contentSha256,
  status,
  ...(status === "committed" ? { documentId: "cloud-doc" } : {}),
});

test("sharing captures owned immutable bytes once, persists before returning, and concurrent calls receive no second lease", async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, "source mutated");
  const before = f.storage.getDocumentMetadataSnapshot(f.published.id)!;
  const results = await Promise.all(Array.from({ length: 8 }, () => f.sharing.prepare(f.scope)));
  assert.equal(results.filter((row) => row.bytes !== undefined).length, 1);
  const fresh = results.find((row) => row.bytes !== undefined)!;
  assert.deepEqual(Buffer.from(fresh.bytes!, "base64"), f.bytes);
  assert.equal(fresh.attempt.contentSha256, createHash("sha256").update(f.bytes).digest("hex"));
  assert.equal(fresh.attempt.generation, before.generation);
  assert.equal(f.storage.getShareAttempt(fresh.attempt.key)?.key, fresh.attempt.key);
  assert.equal(new Set(results.map((row) => row.attempt.key)).size, 1);
  assert.deepEqual(
    f.storage.getDocumentMetadataSnapshot(f.published.id),
    before,
    "share never refreshes retention"
  );
  assert.equal(JSON.stringify(f.sharing.inspect(f.published.id)).includes("bytes"), false);
});

test("receipt writes are identity checked and terminal outcomes cannot regress or change", async (t) => {
  const f = await fixture(t);
  const { attempt } = await f.sharing.prepare(f.scope);
  for (const changed of [
    { accountId: "other" },
    { origin: "https://other.example" },
    { fingerprint: "a".repeat(64) },
    { contentSha256: "b".repeat(64) },
    { key: "other_operation_key" },
  ]) {
    await assert.rejects(
      f.sharing.record(attempt.key, { ...receiptFor(attempt), ...changed }),
      /conflict/
    );
  }
  assert.equal(f.storage.getShareAttempt(attempt.key)?.status, "unknown");
  await f.sharing.record(attempt.key, {
    ...receiptFor(attempt),
    token: "credential-never-persisted",
    unexpected: { secret: "hidden" },
  });
  assert.equal(f.storage.getShareAttempt(attempt.key)?.status, "committed");
  assert.equal(JSON.stringify(f.sharing.inspect(f.published.id)).includes("credential"), false);
  assert.equal(
    (await f.sharing.record(attempt.key, receiptFor(attempt, "pending"))).status,
    "committed"
  );
  await assert.rejects(f.sharing.record(attempt.key, receiptFor(attempt, "failed")), /Conflicting/);
  await assert.rejects(
    f.sharing.record(attempt.key, { ...receiptFor(attempt), documentId: "other-doc" }),
    /Conflicting/
  );
});

test("new attempts require terminal failure and account/origin scopes never reuse or contaminate another operation", async (t) => {
  const f = await fixture(t);
  const first = await f.sharing.prepare(f.scope);
  await assert.rejects(
    f.sharing.prepare({ ...f.scope, newAttempt: true }),
    /proven terminal failure/
  );
  await assert.rejects(
    f.sharing.prepare({ ...f.scope, accountId: "other", operation: first.attempt.key }),
    /another account/
  );
  const other = await f.sharing.prepare({ ...f.scope, accountId: "other" });
  const origin = await f.sharing.prepare({ ...f.scope, origin: "https://other.example" });
  assert.notEqual(first.attempt.key, other.attempt.key);
  assert.notEqual(first.attempt.key, origin.attempt.key);
  await f.sharing.record(first.attempt.key, receiptFor(first.attempt, "failed"));
  const next = await f.sharing.prepare({ ...f.scope, newAttempt: true });
  assert.notEqual(next.attempt.key, first.attempt.key);
  assert.equal(f.storage.getShareAttempt(first.attempt.key)?.status, "failed");
  assert.equal(f.storage.getShareAttempt(other.attempt.key)?.status, "unknown");
});

test("local deletion retains attempts and unknown operations recover without recapturing files", async (t) => {
  const f = await fixture(t);
  const first = await f.sharing.prepare(f.scope);
  const management = createSnapshotManagement({
    metadataStore: f.storage,
    documentFileStore: f.files,
  });
  const selection = f.storage.getDocumentMetadataSnapshot(f.published.id)!;
  assert.equal((await Effect.runPromise(management.deleteSnapshot(selection))).status, "deleted");
  assert.equal(f.sharing.inspect(f.published.id).local, undefined);
  const recovered = await f.sharing.prepare(f.scope);
  assert.equal(recovered.attempt.key, first.attempt.key);
  assert.equal(recovered.bytes, undefined);
  await f.sharing.record(first.attempt.key, receiptFor(first.attempt));
  assert.equal(f.storage.getDocumentMetadata(f.published.id), undefined);
});

test("local 10 MiB snapshots exceeding cloud 8 MiB remain intact with explicit refusal", async (t) => {
  const f = await fixture(t, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
  const result = await f.sharing.prepare(f.scope);
  assert.equal(result.attempt.status, "failed");
  assert.equal(result.attempt.failureCode, "CLOUD_SIZE_LIMIT");
  assert.equal(result.bytes, undefined);
  assert.equal(f.storage.getDocumentMetadata(f.published.id)?.size, f.bytes.length);
  const lease = await Effect.runPromise(f.publication.readPublishedDocumentLease(f.published.id));
  let size = 0;
  for await (const chunk of lease.stream) size += chunk.length;
  lease.release();
  assert.equal(size, f.bytes.length);
});

test("local bookkeeping failure never grants upload bytes; committed-but-lost local acknowledgement remains lookup-only", async (t) => {
  const f = await fixture(t);
  const failing = createDaemonSharing({
    metadataStore: {
      ...f.storage,
      insertShareAttempt: () => {
        throw new Error("write failed");
      },
    },
    publication: f.publication,
    operationGate: createOperationGate(),
    origin: () => "http://127.0.0.1:4777",
  });
  await assert.rejects(failing.prepare(f.scope), /write failed/);
  assert.equal(f.storage.latestShareAttempt(f.scope), undefined);
  const lost = createDaemonSharing({
    metadataStore: {
      ...f.storage,
      insertShareAttempt: (attempt) => {
        f.storage.insertShareAttempt(attempt);
        throw new Error("ack lost");
      },
    },
    publication: f.publication,
    operationGate: createOperationGate(),
    origin: () => "http://127.0.0.1:4777",
  });
  await assert.rejects(lost.prepare(f.scope), /ack lost/);
  const recovery = await f.sharing.prepare(f.scope);
  assert.equal(recovery.bytes, undefined);
  assert.equal(recovery.attempt.status, "unknown");
});

test("capture holds an actual active-read lease against selected deletion and releases it after cancellation", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const controller = new AbortController();
  const sharing = createDaemonSharing({
    metadataStore: f.storage,
    publication: {
      ...f.publication,
      readPublishedDocumentLease: (id) =>
        Effect.tryPromise({
          try: async () => {
            const lease = await Effect.runPromise(f.publication.readPublishedDocumentLease(id));
            started.resolve();
            await resume.promise;
            return lease;
          },
          catch: (cause) => cause as never,
        }),
    },
    operationGate: createOperationGate(),
    origin: () => "http://127.0.0.1:4777",
  });
  const capture = sharing.prepare(f.scope, controller.signal);
  await started.promise;
  const manager = createSnapshotManagement({
    metadataStore: f.storage,
    documentFileStore: f.files,
  });
  const selection = f.storage.getDocumentMetadataSnapshot(f.published.id)!;
  assert.equal((await Effect.runPromise(manager.deleteSnapshot(selection))).status, "retained");
  controller.abort();
  resume.resolve();
  await assert.rejects(capture);
  assert.equal(f.storage.latestShareAttempt(f.scope), undefined);
  assert.equal((await Effect.runPromise(manager.deleteSnapshot(selection))).status, "deleted");
});

test("a replacement generation cannot silently reuse old attempts; explicit historical recovery has no upload bytes", async (t) => {
  const f = await fixture(t);
  const first = await f.sharing.prepare(f.scope);
  const original = f.storage.getDocumentMetadata(f.published.id)!;
  f.storage.deleteDocument(f.published.id);
  f.storage.insertDocumentMetadata(original);
  assert.notEqual(
    f.storage.getDocumentMetadataSnapshot(f.published.id)?.generation,
    first.attempt.generation
  );
  await assert.rejects(f.sharing.prepare(f.scope), /generation changed/);
  const history = await f.sharing.prepare({ ...f.scope, operation: first.attempt.key });
  assert.equal(history.bytes, undefined);
  assert.equal(history.attempt.generation, first.attempt.generation);
});

test("a committed local attempt can never substitute a refusal code for its verified receipt", async (t) => {
  const f = await fixture(t);
  const { attempt } = await f.sharing.prepare(f.scope);
  for (const failureCode of ["CLOUD_SIZE_LIMIT", "CLOUD_FORMAT_REFUSED"]) {
    assert.throws(
      () => parseShareAttempt({ ...attempt, status: "committed", failureCode }),
      /terminal share requires/
    );
  }
});
