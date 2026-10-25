import { makeFunctionReference } from "convex/server";
import { getUnauthedConvexClient } from "~/lib/convex-server";
import {
  createSharedBundleAssetHandler,
  type SharedBundleDocument,
} from "~/lib/shared-bundle-asset-handler";
import { loadStoredBundle } from "~/lib/stored-bundle";
import type { Id } from "../../../../../../convex/_generated/dataModel";

// This optional backend function is supplied by the separate sharing feature.
// Missing installations and all denied lookups produce the same opaque 404.
const resolve = makeFunctionReference<
  "query",
  { id: Id<"documents">; token: string },
  { document: SharedBundleDocument; legacyReadUrl: string | null } | null
>("documentSharing:resolve");
export const GET = createSharedBundleAssetHandler({
  resolve: (id, token) =>
    getUnauthedConvexClient().query(resolve, { id: id as Id<"documents">, token }),
  load: (provider, key) =>
    loadStoredBundle(provider, key, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }),
});
