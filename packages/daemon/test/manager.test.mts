import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Effect } from "effect";
import { BUNDLE_MAGIC_BYTES } from "@planview/core";
import {
  openStorage,
  openDocumentFileStore,
  createDocumentPublicationCoordinator,
  createSnapshotManagement,
} from "@planview/storage";
import { createDaemonApplication } from "../dist/application.js";
import { openManager, MANAGER_CODE_TTL_MS, MANAGER_SESSION_TTL_MS } from "../dist/manager.js";
import { createOperationGate } from "../dist/operation-gate.js";

const fixture = async (
  run: (env: {
    manager: Awaited<ReturnType<typeof openManager>>;
    origin: string;
    exchange: (code?: string) => Promise<Response>;
    api: (path: string, payload?: unknown, token?: string) => Promise<Response>;
    token: string;
    publication: ReturnType<typeof createDocumentPublicationCoordinator>;
    clock: (delta: number) => void;
  }) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), "planview-manager-test-"));
  await mkdir(join(directory, "assets"));
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><script src="/assets/app.js"></script>'
  );
  await writeFile(join(directory, "assets", "app.js"), "document.body.dataset.shell='true'");
  const metadata = Effect.runSync(openStorage(join(directory, "metadata.sqlite")));
  const files = Effect.runSync(
    openDocumentFileStore({
      documentsDir: join(directory, "documents"),
      stagingDir: join(directory, "staging"),
    })
  );
  const publication = createDocumentPublicationCoordinator({
    metadataStore: metadata,
    documentFileStore: files,
  });
  const gate = createOperationGate();
  let time = Date.now();
  const manager = await openManager({
    application: createDaemonApplication({
      publication,
      snapshots: createSnapshotManagement({ metadataStore: metadata, documentFileStore: files }),
      operationGate: gate,
    }),
    profile: "testing",
    appDataDir: directory,
    previewOrigin: "http://127.0.0.1:4777",
    requestShutdown: () => {},
    isShuttingDown: () => false,
    assetsRoot: pathToFileURL(directory + sep),
    now: () => time,
  });
  const launch = manager.launch();
  const origin = launch.origin;
  const exchange = (code = new URL(launch.url).hash.slice(1)) =>
    fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
  const session = await exchange();
  assert.equal(session.status, 200);
  const { token } = (await session.json()) as { token: string };
  const api = (path: string, payload: unknown = {}, bearer = token) =>
    fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  try {
    await run({
      manager,
      origin,
      token,
      exchange,
      api,
      publication,
      clock: (delta) => {
        time += delta;
      },
    });
  } finally {
    gate.close();
    manager.revoke();
    manager.stopAccepting();
    manager.forceClose();
    await manager.close();
    await files.close();
    metadata.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
};

test("manager shell is public but data requires an independent one-use session with expiry and revocation", () =>
  fixture(async ({ manager, origin, token, exchange, api, clock }) => {
    const shell = await fetch(origin);
    assert.equal(shell.status, 200);
    assert.ok(shell.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"));
    assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
    assert.equal(shell.headers.get("set-cookie"), null);
    assert.equal((await exchange()).status, 401, "launch code is consumed");
    assert.equal((await api("list", {}, "foreign-native-secret")).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/list`, {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: `planview=${token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      401
    );
    const status = await api("status");
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { profile: string }).profile, "testing");
    const unused = new URL(manager.launch().url).hash.slice(1);
    clock(MANAGER_CODE_TTL_MS);
    assert.equal(
      (await exchange(unused)).status,
      401,
      "expired launch code cannot create a session"
    );
    assert.equal((await api("logout")).status, 200);
    assert.equal((await api("usage")).status, 401, "logout revokes only that session");
    const second = await exchange(new URL(manager.launch().url).hash.slice(1));
    const session = (await second.json()) as { token: string };
    clock(MANAGER_SESSION_TTL_MS);
    assert.equal((await api("list", {}, session.token)).status, 401);
  }));

test("strict Host, Origin and method checks apply before session exchange and all data operations", () =>
  fixture(async ({ origin, token }) => {
    for (const foreign of [
      "null",
      "http://127.0.0.1:4777",
      "http://localhost:4777",
      "https://foreign.example",
    ]) {
      const res = await fetch(`${origin}/api/usage`, {
        method: "POST",
        headers: {
          Origin: foreign,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    assert.equal(
      (
        await fetch(`${origin}/api/usage`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${origin}/api/usage`, {
          headers: { Origin: origin, Authorization: `Bearer ${token}` },
        })
      ).status,
      405
    );
    assert.equal(
      (
        await fetch(`${origin}/api/session`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://foreign.example",
            "Access-Control-Request-Headers": "authorization",
          },
        })
      ).status,
      403
    );
    for (const host of [
      "evil.example",
      new URL(origin).host.replace("127.0.0.1", "localhost"),
      `${new URL(origin).host},evil.example`,
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(origin, { headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.once("error", reject);
        req.end();
      });
      assert.equal(status, 403);
    }
    const absolute = await new Promise<number>((resolve, reject) => {
      const req = request(
        origin,
        { path: "http://evil.example/", headers: { Host: new URL(origin).host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(absolute, 403);
    assert.equal((await fetch(`${origin}/?code=secret`)).status, 403);
  }));

test("bounded HTML import uses exact immutable publication bytes, remains off the manager origin, and shares deletion", () =>
  fixture(async ({ origin, token, api, publication }) => {
    const original = Buffer.from(
      "\ufeff<!doctype html><h1>é\r\n</h1><script>parent.untrusted=true</script>"
    );
    const upload = await fetch(`${origin}/api/import`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "x-planview-filename": "report.html",
      },
      body: original,
    });
    assert.equal(upload.status, 201);
    const published = (await upload.json()) as {
      id: Parameters<typeof publication.readPublishedDocument>[0];
      url: string;
    };
    assert.ok(published.url.startsWith("http://127.0.0.1:4777/"));
    const stream = await Effect.runPromise(publication.readPublishedDocument(published.id));
    assert.deepEqual(Buffer.concat(await stream.toArray()), original);
    const previewAtManager = await fetch(`${origin}/${published.id}`);
    assert.equal(previewAtManager.status, 404);
    assert.equal(
      (
        await fetch(`${origin}/api/import`, {
          method: "POST",
          headers: {
            Origin: origin,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "x-planview-filename": "..%2Foutside.html",
          },
          body: original,
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${origin}/api/import`, {
          method: "POST",
          headers: {
            Origin: origin,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
            "x-planview-filename": "bundle.html",
          },
          body: Buffer.from(BUNDLE_MAGIC_BYTES),
        })
      ).status,
      400
    );
    const listed = await api("list");
    const page = (await listed.json()) as { snapshots: { id: string; generation: string }[] };
    assert.equal(page.snapshots.length, 1);
    const selected = page.snapshots[0]!;
    assert.equal((await api("delete", { ...selected, sourcePath: "/outside" })).status, 400);
    const result = await api("delete", { id: selected.id, generation: selected.generation });
    assert.equal(((await result.json()) as { status: string }).status, "deleted");
    assert.equal(((await (await api("usage")).json()) as { bytes: number }).bytes, 0);
  }));

test("manager bounds launch/session counts and malformed requests", () =>
  fixture(async ({ manager, api, exchange }) => {
    for (let i = 0; i < 7; i += 1)
      assert.equal((await exchange(new URL(manager.launch().url).hash.slice(1))).status, 200);
    assert.equal((await exchange(new URL(manager.launch().url).hash.slice(1))).status, 429);
    for (let i = 0; i < 8; i += 1) manager.launch();
    assert.throws(() => manager.launch(), /Too many unused/);
    assert.equal((await api("list", { limit: 101 })).status, 400);
    assert.equal((await api("usage", { unknown: true })).status, 400);
  }));

test("manager enforces raw and JSON request byte limits before publication", () =>
  fixture(async ({ origin, token, api }) => {
    const response = await fetch(`${origin}/api/import`, {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "x-planview-filename": "large.html",
      },
      body: Buffer.alloc(10 * 1024 * 1024 + 1, 60),
    });
    assert.equal(response.status, 400);
    assert.equal((await api("list", { after: "x".repeat(5000) })).status, 400);
    assert.equal(((await (await api("usage")).json()) as { bytes: number }).bytes, 0);
  }));

test("sessions remain independent between profile managers", () =>
  fixture(async (first) => {
    await fixture(async (second) => {
      assert.notEqual(first.origin, second.origin);
      assert.equal((await first.api("usage", {}, second.token)).status, 401);
      assert.equal((await second.api("usage", {}, first.token)).status, 401);
    });
  }));
