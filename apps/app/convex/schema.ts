import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    ownerId: v.string(),
    title: v.string(),
    // `storageId` is retained for documents created before the external
    // storage boundary was introduced. New documents use the provider/key
    // pair below so the storage implementation can change independently.
    storageId: v.optional(v.id("_storage")),
    storageProvider: v.optional(v.string()),
    storageKey: v.optional(v.string()),
    contentType: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletionRequestedAt: v.optional(v.number()),
  })
    .index("by_owner_createdAt", ["ownerId", "createdAt"])
    .index("by_owner_active_createdAt", ["ownerId", "deletionRequestedAt", "createdAt"])
    .index("by_owner_storageKey", ["ownerId", "storageKey"]),
  accountStorageUsage: defineTable({
    ownerId: v.string(),
    usedBytes: v.number(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  uploadReservations: defineTable({
    ownerId: v.string(),
    title: v.string(),
    storageKey: v.string(),
    storageProvider: v.optional(v.string()),
    sizeBytes: v.number(),
    uploadDeadlineAt: v.number(),
    nextAttemptAt: v.number(),
    cleanupRequested: v.boolean(),
    uploadConfirmed: v.boolean(),
    attempts: v.number(),
  })
    .index("by_owner_storageKey", ["ownerId", "storageKey"])
    .index("by_nextAttemptAt", ["nextAttemptAt"]),
  deletionJobs: defineTable({
    documentId: v.id("documents"),
    storageKey: v.string(),
    storageProvider: v.optional(v.string()),
    nextAttemptAt: v.number(),
    attempts: v.number(),
  }).index("by_nextAttemptAt", ["nextAttemptAt"]),
  cliCredentials: defineTable({
    ownerId: v.string(),
    tokenHash: v.string(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_owner", ["ownerId"]),
});
