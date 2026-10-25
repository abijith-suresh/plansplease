import assert from "node:assert/strict";
import { test } from "node:test";

import { createBundleReadCache } from "../src/lib/bundle-read-cache.ts";
import { packCloudBundle } from "../src/lib/cloud-bundle.ts";
import { createStoredBundleLoader } from "../src/lib/stored-bundle.ts";

test("stored bundle loading shares bytes by provider and key and retains request options", async () => {
  const bytes = packCloudBundle([{ path: "index.html", content: "<h1>Plan</h1>" }]);
  const locators: string[] = [];
  const load = createStoredBundleLoader({
    cache: createBundleReadCache(),
    getReadUrl: async (provider, key) => {
      const url = `https://storage.example/${provider}/${key}`;
      locators.push(url);
      return url;
    },
    fetch: async (url, options) => {
      assert.equal(url, locators.at(-1));
      if (locators.length === 1) {
        assert.equal(options?.credentials, "omit");
        assert.equal(options?.referrerPolicy, "no-referrer");
      }
      return new Response(new Uint8Array(bytes));
    },
  });
  const first = await load("uploadthing", "one", {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  assert.equal(await load("uploadthing", "one"), first);
  await load("filesystem", "one");
  await load("filesystem", "two");
  assert.deepEqual(locators, [
    "https://storage.example/uploadthing/one",
    "https://storage.example/filesystem/one",
    "https://storage.example/filesystem/two",
  ]);
});
