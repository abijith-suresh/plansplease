import { parseCloudBundle, cloudBundleMaxBytes, type CloudBundle } from "./cloud-bundle.ts";
import { readBoundedResponseBytes } from "./bounded-response.ts";

// Keep only two loaded objects and two fetches in progress. Entry requests still
// authorize metadata before touching this cache. Failed/expired loads are removed.
export function createBundleReadCache(now = Date.now) {
  const entries = new Map<string, { value: Promise<CloudBundle>; expiresAt: number }>();
  let loading = 0;
  const maxEntries = 2;
  return {
    async load(key: string, loader: () => Promise<Uint8Array>): Promise<CloudBundle> {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > now()) return existing.value;
      if (existing) entries.delete(key);
      if (loading >= maxEntries) throw new Error("Bundle delivery is busy. Try again.");
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      loading += 1;
      const value = Promise.resolve()
        .then(loader)
        .then(parseCloudBundle)
        .finally(() => {
          loading -= 1;
        });
      entries.set(key, { value, expiresAt: now() + 60_000 });
      void value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      return value;
    },
  };
}

export async function readBoundedBundle(response: Response): Promise<Uint8Array> {
  return readBoundedResponseBytes(response, {
    maxBytes: cloudBundleMaxBytes,
    unavailableMessage: "Bundle content is unavailable",
    tooLargeMessage: "Bundle content exceeds 8 MiB",
    checkContentLength: true,
  });
}

export const serverBundleReadCache = createBundleReadCache();
export const bundleCacheKey = (provider: string, key: string) => JSON.stringify([provider, key]);
