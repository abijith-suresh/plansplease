import {
  bundleCacheKey,
  type createBundleReadCache,
  readBoundedBundle,
  serverBundleReadCache,
} from "./bundle-read-cache.ts";
import { getDocumentStorage } from "./document-storage.ts";

export function createStoredBundleLoader(dependencies: {
  cache: ReturnType<typeof createBundleReadCache>;
  getReadUrl(provider: string, key: string): Promise<string>;
  fetch: typeof fetch;
}) {
  // Callers authorize the document before loading its immutable stored bytes.
  return (
    provider: string,
    key: string,
    options: Pick<RequestInit, "credentials" | "referrerPolicy"> = {}
  ) =>
    dependencies.cache.load(bundleCacheKey(provider, key), async () => {
      const url = await dependencies.getReadUrl(provider, key);
      return readBoundedBundle(
        await dependencies.fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
      );
    });
}

export const loadStoredBundle = createStoredBundleLoader({
  cache: serverBundleReadCache,
  getReadUrl: (provider, key) => getDocumentStorage(provider).getReadUrl(key),
  fetch: (input, init) => fetch(input, init),
});
