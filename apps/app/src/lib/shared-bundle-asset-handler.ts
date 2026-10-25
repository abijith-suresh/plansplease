import { bundleAssetResponse, bundleResponseHeaders } from "./bundle-asset-handler.ts";
import {
  type CloudBundle,
  cloudBundleContentType,
  cloudBundleMaxBytes,
  cloudBundleMime,
} from "./cloud-bundle.ts";

export type SharedBundleDocument = {
  title: string;
  contentType: string;
  sizeBytes: number;
  storageProvider?: string;
  storageKey?: string;
};

export function createSharedBundleAssetHandler(dependencies: {
  resolve(id: string, token: string): Promise<{ document: SharedBundleDocument } | null>;
  load(provider: string, key: string): Promise<CloudBundle>;
}) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params: { id: string; token: string; path: string };
  }) => {
    const notFound = () =>
      new Response("Not found", { status: 404, headers: bundleResponseHeaders });
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.token)) return notFound();
    try {
      cloudBundleMime(params.path);
      // This capability lookup runs before cache access on every entry request.
      // The optional sharing feature also rejects deleted and revoked links.
      const result = await dependencies.resolve(params.id, params.token);
      const document = result?.document;
      if (
        !document ||
        document.contentType !== cloudBundleContentType ||
        !document.storageProvider ||
        !document.storageKey ||
        !Number.isSafeInteger(document.sizeBytes) ||
        document.sizeBytes < 0 ||
        document.sizeBytes > cloudBundleMaxBytes
      )
        return notFound();
      return bundleAssetResponse(
        await dependencies.load(document.storageProvider, document.storageKey),
        params.path,
        request
      );
    } catch {
      return notFound();
    }
  };
}
