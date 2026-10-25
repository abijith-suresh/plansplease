import { createBundleAssetHandler } from "~/lib/bundle-asset-handler";

import { api, getUnauthedConvexClient } from "~/lib/convex-server";
import { requireMutationSecret } from "~/lib/document-mutation-proof";
import { createMcpDocumentProof } from "~/lib/mcp-document-proof";
import { loadStoredBundle } from "~/lib/stored-bundle";
import type { Id } from "../../../../../../convex/_generated/dataModel";

export const GET = createBundleAssetHandler({
  secret: requireMutationSecret,
  getDocument: async ({ ownerId, documentId }) => {
    const result = await getUnauthedConvexClient().query(api.mcpDocuments.get, {
      ownerId,
      id: documentId as Id<"documents">,
      proof: await createMcpDocumentProof({ action: "get", ownerId, arguments: [documentId] }),
    });
    return result?.document ?? null;
  },
  load: (claims) =>
    loadStoredBundle(claims.storageProvider, claims.storageKey, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }),
});
