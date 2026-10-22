"use node";

import { createHmac } from "node:crypto";
import { isFilesystemKey, isLocalDevelopment } from "./localMode";
import { UTApi } from "uploadthing/server";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { deleteUploadThingFile } from "./documentDeletionStorage";

async function deleteStoredFile(claim: { storageProvider: string; storageKey: string }) {
  if (claim.storageProvider === "filesystem") {
    if (!isLocalDevelopment(process.env) || !isFilesystemKey(claim.storageKey))
      throw new Error("Local deletion requires local development mode");
    const secret = process.env["LOCAL_STORAGE_SECRET"];
    if (!secret || secret.length < 32) throw new Error("Local deletion is not configured");
    const expires = Date.now() + 60_000;
    const signature = createHmac("sha256", secret)
      .update(JSON.stringify(["delete", claim.storageKey, expires]))
      .digest("hex");
    const query = new URLSearchParams({
      key: claim.storageKey,
      expires: String(expires),
      signature,
    });
    const response = await fetch(`${process.env["SITE_URL"]}/api/local-storage?${query}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Local storage deletion failed");
    return;
  }
  if (claim.storageProvider !== "uploadthing") throw new Error("Unsupported deletion storage");
  const token = process.env["UPLOADTHING_TOKEN"];
  if (!token) throw new Error("UploadThing is not configured for deletion");
  await deleteUploadThingFile(new UTApi({ token }), claim.storageKey);
}

export const processDeletion = internalAction({
  args: { jobId: v.id("deletionJobs") },
  handler: async (ctx, { jobId }) => {
    const claim = await ctx.runMutation(internal.documents.claimDeletion, { jobId });
    if (!claim) return;

    try {
      await deleteStoredFile(claim);
      await ctx.runMutation(internal.documents.finishDeletion, { jobId, attempts: claim.attempts });
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Convex logs expose failed background attempts.
      console.error("Document deletion attempt failed", error);
      await ctx.runMutation(internal.documents.deferDeletion, { jobId, attempts: claim.attempts });
    }
  },
});

export const processAbandonedUpload = internalAction({
  args: { reservationId: v.id("uploadReservations") },
  handler: async (ctx, { reservationId }) => {
    const claim = await ctx.runMutation(internal.documents.claimUploadCleanup, { reservationId });
    if (!claim) return;
    try {
      await deleteStoredFile(claim);
      await ctx.runMutation(internal.documents.finishUploadCleanup, {
        reservationId,
        attempts: claim.attempts,
      });
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole: Convex logs expose failed background attempts.
      console.error("Abandoned upload cleanup failed", error);
      await ctx.runMutation(internal.documents.deferUploadCleanup, {
        reservationId,
        attempts: claim.attempts,
      });
    }
  },
});
