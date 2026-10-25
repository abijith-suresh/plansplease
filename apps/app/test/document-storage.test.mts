import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { cloudBundleContentType, packCloudBundle } from "../src/lib/cloud-bundle.ts";

import { createUploadThingStorageAdapter } from "../src/lib/document-storage.ts";
import { createUploadThingUploadFetch } from "../src/lib/document-storage-uploadthing.ts";

type UploadThingApi = Exclude<
  Parameters<typeof createUploadThingStorageAdapter>[0],
  (deadlineAt?: number) => unknown
>;

function createUploadThingApi(overrides: Partial<UploadThingApi>): UploadThingApi {
  return {
    uploadFiles: async () => assert.fail("Unexpected provider upload"),
    getFileUrls: async () => assert.fail("Unexpected provider lookup"),
    deleteFiles: async () => assert.fail("Unexpected provider deletion"),
    ...overrides,
  };
}

test("passes custom IDs to UploadThing and accepts an idempotent zero-count deletion", async () => {
  const calls: Array<{ key: string; keyType: string }> = [];
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      deleteFiles: async (key, options) => {
        calls.push({ key, keyType: options.keyType });
        return { success: true, deletedCount: 0 };
      },
    })
  );

  await adapter.delete("uploadthing-custom-id:owner_123:uuid-123");

  assert.deepEqual(calls, [{ key: "owner_123:uuid-123", keyType: "customId" }]);
});

test("throws when UploadThing resolves a deletion as unsuccessful", async () => {
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      deleteFiles: async () => ({ success: false, deletedCount: 0 }),
    })
  );

  await assert.rejects(
    adapter.delete("uploadthing-custom-id:owner_123:uuid-123"),
    /UploadThing could not delete the stored document/
  );
});

test("upload owns provider-specific options and returns its locator", async () => {
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      uploadFiles: async (file, options) => {
        assert.equal(file.customId, "owner_123:object-456");
        assert.equal(file.type, "text/html");
        assert.equal(file.name, "plan.html");
        assert.equal(await file.text(), "<h1>Plan</h1>");
        assert.deepEqual(options, { acl: "public-read", contentDisposition: "inline" });
        return { data: { key: "provider-result" }, error: null };
      },
    })
  );
  assert.deepEqual(
    await adapter.upload({
      file: new File(["<h1>Plan</h1>"], "plan.html", { type: "text/html" }),
      objectId: "owner_123:object-456",
      deadlineAt: Date.now() + 60_000,
    }),
    {
      storageProvider: "uploadthing",
      storageKey: "uploadthing-custom-id:owner_123:object-456",
    }
  );
});

test("bundle uploads preserve encoded bytes, MIME and the reserved provider locator", async () => {
  const bytes = packCloudBundle([
    { path: "index.html", content: '<link rel="stylesheet" href="style.css"><h1>Plan</h1>' },
    { path: "style.css", content: "h1{color:coral}" },
  ]);
  const objectId = "owner:artifact";
  const deadlineAt = Date.now() + 60_000;
  const adapter = createUploadThingStorageAdapter((deadline) => {
    assert.equal(deadline, deadlineAt);
    return createUploadThingApi({
      uploadFiles: async (file) => {
        assert.equal(file.type, cloudBundleContentType);
        assert.equal(file.customId, objectId);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
        return { data: { key: "provider-result" }, error: null };
      },
    });
  });
  const result = await adapter.upload({
    file: new File([new Uint8Array(bytes)], "artifact.planview", { type: cloudBundleContentType }),
    objectId,
    deadlineAt,
  });
  assert.deepEqual(result, adapter.getUploadLocator(objectId));
});

test("reads both custom locators and older raw file keys", async () => {
  const calls: string[] = [];
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      getFileUrls: async (key, options) => {
        calls.push(`${options.keyType}:${key}`);
        return { data: [{ url: "https://cdn.example/read" }] };
      },
    })
  );
  assert.equal(
    await adapter.getReadUrl("uploadthing-custom-id:owner:object"),
    "https://cdn.example/read"
  );
  assert.equal(await adapter.getReadUrl("legacy-key"), "https://cdn.example/read");
  assert.deepEqual(calls, ["customId:owner:object", "fileKey:legacy-key"]);
});

test("upload failure never returns a locator", async () => {
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      uploadFiles: async () => ({ data: null, error: { message: "provider upload failed" } }),
    })
  );
  await assert.rejects(
    adapter.upload({
      file: new File(["plan"], "plan.html"),
      objectId: "owner:object",
      deadlineAt: Date.now() + 60_000,
    }),
    /provider upload failed/
  );
});

test("an expired reservation sends no bytes to the provider", async () => {
  let uploads = 0;
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      uploadFiles: async () => {
        uploads += 1;
        return { data: {}, error: null };
      },
    })
  );
  await assert.rejects(
    adapter.upload({
      file: new File(["plan"], "plan.html"),
      objectId: "owner:object",
      deadlineAt: Date.now() - 1,
    }),
    /reservation expired/
  );
  assert.equal(uploads, 0);
});

test("provider construction receives the unchanged reservation deadline", async () => {
  const deadlines: Array<number | undefined> = [];
  const deadlineAt = Date.now() + 60_000;
  const adapter = createUploadThingStorageAdapter((deadline) => {
    deadlines.push(deadline);
    return createUploadThingApi({
      uploadFiles: async () => ({ data: {}, error: null }),
      getFileUrls: async () => ({ data: [{ url: "https://cdn.example/read" }] }),
    });
  });
  const objectId = "owner:object";
  assert.deepEqual(
    await adapter.upload({ file: new File(["plan"], "plan.html"), objectId, deadlineAt }),
    adapter.getUploadLocator(objectId)
  );
  await adapter.getReadUrl("legacy-key");
  assert.deepEqual(deadlines, [deadlineAt, undefined]);
});

test("all provider requests share the absolute deadline and retain SDK cancellation", async () => {
  const signals: AbortSignal[] = [];
  const boundedFetch = createUploadThingUploadFetch(Date.now() + 100, async (_input, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    return new Response();
  });
  const sdkAbort = new AbortController();
  await boundedFetch("https://provider.example/first", { signal: sdkAbort.signal });
  await boundedFetch("https://provider.example/second", {});
  sdkAbort.abort();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  await setTimeout(150);
  assert.equal(signals[1]?.aborted, true);
  assert.throws(() => boundedFetch("https://provider.example/late", {}), /reservation expired/);
  assert.equal(signals.length, 2);
});

test("file preparation cannot renew an expired reservation", async (t) => {
  const deadlineAt = Date.now() + 60_000;
  let now = deadlineAt - 1;
  t.mock.method(Date, "now", () => now);
  let uploads = 0;
  const adapter = createUploadThingStorageAdapter(
    createUploadThingApi({
      uploadFiles: async () => {
        uploads += 1;
        return { data: {}, error: null };
      },
    })
  );
  const file = new File(["plan"], "plan.html");
  t.mock.method(file, "arrayBuffer", async () => {
    now = deadlineAt + 1;
    return new ArrayBuffer(4);
  });
  await assert.rejects(
    adapter.upload({ file, objectId: "owner:object", deadlineAt }),
    /reservation expired/
  );
  assert.equal(uploads, 0);
});
