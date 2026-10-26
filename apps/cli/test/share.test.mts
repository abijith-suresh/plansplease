import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  createLocalApplication,
  resolveAppDataPaths,
  type ShareAttempt,
  type LocalApplication,
} from "@planview/local";
import { cloudUploadFingerprint } from "@planview/core";
import { shareSnapshot } from "../dist/share.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "share-client-"));
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    XDG_DATA_HOME: root,
    LOCALAPPDATA: root,
  });
  const origin = "https://cloud.example";
  const id = "a".repeat(21);
  const profile = "share-client";
  const directory = resolveAppDataPaths({ profile }).appDataDir;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "cloud-credentials.json"),
    JSON.stringify({ version: 1, cloudUrl: origin, token: "planview_cli_fake-unit-credential" }),
    { mode: 0o600 }
  );
  const bytes = Buffer.from("<h1>exact é</h1>\r\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let attempt: ShareAttempt = {
    version: 1,
    id,
    generation: randomUUID(),
    key: randomUUID(),
    origin,
    accountId: "owner-a",
    title: `Snapshot ${id}`,
    contentType: "text/html",
    size: bytes.length,
    contentSha256: hash,
    fingerprint: cloudUploadFingerprint(`Snapshot ${id}`, "text/html", bytes.length, hash),
    createdAt: Date.now(),
    status: "unknown",
  };
  const state = {
    captured: false,
    posts: 0,
    lookups: 0,
    records: 0,
    response: "committed",
    wrong: false,
    failRecord: false,
    oversized: false,
    account: "owner-a",
    prepareLost: false,
  };
  const receipt = () => ({
    version: 1,
    accountId: state.wrong ? "foreign" : "owner-a",
    origin,
    key: attempt.key,
    fingerprint: attempt.fingerprint,
    contentSha256: attempt.contentSha256,
    status: state.response === "pending" ? "pending" : "committed",
    ...(state.response === "pending" ? {} : { documentId: "document1" }),
  });
  const application: LocalApplication = {
    ...createLocalApplication({ daemonScriptPath: "unused" }),
    shareInspect: () =>
      Effect.succeed({
        id,
        local: {
          id,
          generation: attempt.generation,
          size: bytes.length,
          url: `http://127.0.0.1:4777/${id}`,
          expiresAt: Date.now() + 30 * 86400000,
        },
        attempts: state.captured ? [attempt] : [],
        hasMore: false,
      }),
    sharePrepare: (scope) =>
      Effect.try({
        try: () => {
          assert.equal(scope.accountId, attempt.accountId);
          if (state.prepareLost) {
            state.captured = true;
            throw new Error("local response lost");
          }
          const first = !state.captured;
          state.captured = true;
          return {
            attempt,
            localUrl: `http://127.0.0.1:4777/${id}`,
            ...(first ? { bytes: bytes.toString("base64") } : {}),
          };
        },
        catch: (cause) => cause as never,
      }),
    shareRecord: (_key, input) =>
      Effect.try({
        try: () => {
          state.records++;
          if (state.failRecord) throw new Error("local write unavailable");
          const value = input as ReturnType<typeof receipt>;
          attempt = {
            ...attempt,
            status: value.status === "pending" ? "unknown" : "committed",
            receipt: value as never,
          };
          return attempt;
        },
        catch: (cause) => cause as never,
      }),
  };
  globalThis.fetch = async (_input, init) => {
    const key = new Headers(init?.headers).get("Idempotency-Key");
    if (!key)
      return Response.json({
        version: 1,
        origin,
        accountId: state.account,
        maxBytes: 8 * 1024 * 1024,
        receipts: true,
      });
    if (init?.method === "POST") state.posts++;
    else state.lookups++;
    if (state.response === "lost") throw new Error("network lost");
    if (state.response === "not_found")
      return Response.json({ outcome: "not_found" }, { status: 404 });
    if (state.oversized) return new Response("x".repeat(16 * 1024 + 1));
    if (state.response === "legacy")
      return Response.json({ id: "legacy-document" }, { status: 201 });
    const value = receipt();
    return Response.json(
      {
        outcome: value.status === "pending" ? "unknown" : "committed",
        receipt: value,
        ...(value.documentId ? { id: value.documentId } : {}),
      },
      { status: value.status === "pending" ? 202 : 201 }
    );
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  return { state, application, id, profile };
}

test("share response without a receipt, oversized response, or conflicting identity fails closed without replay", async (t) => {
  for (const response of ["legacy", "oversized", "wrong"] as const)
    await t.test(response, async (child) => {
      const f = await fixture(child);
      f.state.response = response === "legacy" ? "legacy" : "committed";
      f.state.oversized = response === "oversized";
      f.state.wrong = response === "wrong";
      const result = await shareSnapshot(f.application, f.id, f.profile);
      assert.equal(result.cloud.status, "unknown");
      assert.equal(result.cloud.receipt, undefined);
      assert.equal(f.state.records, 0);
      assert.equal(f.state.posts, 1);
      await shareSnapshot(f.application, f.id, f.profile);
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.lookups, 1);
    });
});

test("cloud commit with local bookkeeping failure reports both and a later invocation only looks up", async (t) => {
  const f = await fixture(t);
  f.state.failRecord = true;
  const first = await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(first.cloud.status, "committed");
  assert.equal(first.bookkeeping, "unknown");
  assert.match(first.recovery, /receipt lookup only/);
  f.state.failRecord = false;
  const second = await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(second.cloud.documentId, first.cloud.documentId);
  assert.equal(second.bookkeeping, "recorded");
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.lookups, 1);
});

test("interrupted admission and not_found lookup never prove failure or resend bytes", async (t) => {
  const f = await fixture(t);
  f.state.response = "lost";
  const first = await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(first.cloud.status, "unknown");
  f.state.response = "not_found";
  const second = await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(second.cloud.status, "unknown");
  assert.equal(second.cloud.operationKey, first.cloud.operationKey);
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.lookups, 1);
});

test("lost local prepare response does not send bytes or invent an operation; subsequent invocation looks up", async (t) => {
  const f = await fixture(t);
  f.state.prepareLost = true;
  const first = await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(first.bookkeeping, "unknown");
  assert.equal(first.cloud.operationKey, undefined);
  assert.equal(f.state.posts, 0);
  f.state.prepareLost = false;
  f.state.response = "not_found";
  await shareSnapshot(f.application, f.id, f.profile);
  assert.equal(f.state.posts, 0);
  assert.equal(f.state.lookups, 1);
});

test("mismatched prepared account, origin, id or explicit recovery lease fails closed before POST", async (t) => {
  for (const mismatch of ["account", "origin", "id", "operation"] as const)
    await t.test(mismatch, async (child) => {
      const f = await fixture(child);
      const application: LocalApplication = {
        ...f.application,
        sharePrepare: (input) =>
          f.application.sharePrepare(input).pipe(
            Effect.map((prepared) => ({
              ...prepared,
              attempt: {
                ...prepared.attempt,
                ...(mismatch === "account" ? { accountId: "foreign" } : {}),
                ...(mismatch === "origin" ? { origin: "https://foreign.example" } : {}),
                ...(mismatch === "id" ? { id: "b".repeat(21) } : {}),
              },
            }))
          ),
      };
      const result = await shareSnapshot(
        application,
        f.id,
        f.profile,
        mismatch === "operation" ? { operation: "selected_recovery_key" } : {}
      );
      assert.equal(result.cloud.status, "unknown");
      assert.equal(result.cloud.code, "LOCAL_PREPARATION_UNCONFIRMED");
      assert.equal(f.state.posts, 0);
      assert.equal(f.state.lookups, 0);
    });
});
