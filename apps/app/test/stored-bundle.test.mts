import assert from "node:assert/strict";
import { test } from "node:test";

import { createBundleReadCache } from "../src/lib/bundle-read-cache.ts";
import { cloudBundleEntry, packCloudBundle } from "../src/lib/cloud-bundle.ts";
import { createStoredBundleLoader } from "../src/lib/stored-bundle.ts";

const bytes = packCloudBundle([{ path: "index.html", content: "<h1>Plan</h1>" }]);

function createLoader(fetchImplementation?: typeof fetch) {
  const locators: Array<{ provider: string; key: string }> = [];
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  const load = createStoredBundleLoader({
    cache: createBundleReadCache(),
    getReadUrl: async (provider, key) => {
      locators.push({ provider, key });
      return `https://storage.example/${provider}/${key}`;
    },
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return fetchImplementation
        ? fetchImplementation(input, init)
        : new Response(new Uint8Array(bytes));
    },
  });
  return { load, locators, requests };
}

test("stored bundle loading shares bytes by provider and key and retains request options", async () => {
  const { load, locators, requests } = createLoader();
  const first = await load("uploadthing", "one", {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  assert.equal(
    new TextDecoder().decode(cloudBundleEntry(first, "index.html").bytes),
    "<h1>Plan</h1>"
  );
  assert.equal(await load("uploadthing", "one"), first);
  assert.deepEqual(locators, [{ provider: "uploadthing", key: "one" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.input, "https://storage.example/uploadthing/one");
  assert.equal(requests[0]?.init?.credentials, "omit");
  assert.equal(requests[0]?.init?.referrerPolicy, "no-referrer");
  assert.ok(requests[0]?.init?.signal instanceof AbortSignal);
  assert.equal(requests[0]?.init?.signal.aborted, false);

  await load("filesystem", "one");
  await load("filesystem", "two");
  assert.deepEqual(locators.slice(1), [
    { provider: "filesystem", key: "one" },
    { provider: "filesystem", key: "two" },
  ]);
  assert.equal(requests[1]?.init?.credentials, undefined);
  assert.equal(requests[1]?.init?.referrerPolicy, undefined);
});

test("failed stored bundle reads retry resolution and fetching", async () => {
  let attempt = 0;
  const { load, locators, requests } = createLoader(async () => {
    attempt += 1;
    return attempt === 1
      ? new Response("unavailable", { status: 503 })
      : new Response(new Uint8Array(bytes));
  });
  await assert.rejects(load("uploadthing", "one"), /Bundle content is unavailable/);
  await load("uploadthing", "one");
  assert.equal(locators.length, 2);
  assert.equal(requests.length, 2);
});
