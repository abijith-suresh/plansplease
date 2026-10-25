import { validateDocumentId, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Data, Effect } from "effect";
import { V1_RETENTION_MILLISECONDS } from "./cleanup.js";
import { DocumentFileDeleteError, type DocumentFileStore } from "./document-files.js";
import type {
  DocumentMetadataSnapshot,
  DocumentStorageUsage,
  MetadataStore,
} from "./metadata-contracts.js";

export type SnapshotListOptions = Readonly<{ limit?: number; after?: string }>;
export type SnapshotSelection = Readonly<{ id: string; generation: string }>;
export type SnapshotInventory = Readonly<{
  snapshots: readonly (DocumentMetadataSnapshot & { expiresAt: number })[];
  nextAfter?: string;
}>;
export type SnapshotUsage = DocumentStorageUsage &
  Readonly<{
    quotaBytes: number;
    retentionMilliseconds: number;
  }>;
export type SnapshotDeleteResult = SnapshotSelection &
  Readonly<{
    status: "deleted" | "not_found" | "stale" | "retained" | "partial";
    removedMetadata: boolean;
    removedFile: boolean;
    /** Physical/durable state can be uncertain after unlink or directory sync failure. */
    fileState: "absent" | "retained" | "unknown";
    recovery: "none" | "retry_selection" | "clean" | "inspect";
    message?: string;
  }>;
export class SnapshotManagementError extends Data.TaggedError("SnapshotManagementError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export const validateSnapshotListOptions = (options: SnapshotListOptions = {}) => {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Snapshot list limit must be an integer from 1 to 100.");
  }
  return {
    limit,
    ...(options.after === undefined ? {} : { after: validateDocumentId(options.after) }),
  };
};
export const validateSnapshotSelection = (selection: SnapshotSelection) => {
  const id = validateDocumentId(selection.id);
  if (typeof selection.generation !== "string" || !/^[0-9a-f-]{36}$/.test(selection.generation)) {
    throw new TypeError("A snapshot generation from list is required.");
  }
  return { id, generation: selection.generation };
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const failure = (cause: unknown) =>
  new SnapshotManagementError({ cause, message: describe(cause) });

/** Uses the daemon's existing stores. Call mutations through its operation gate. */
export const createSnapshotManagement = ({
  metadataStore,
  documentFileStore,
}: {
  metadataStore: MetadataStore;
  documentFileStore: DocumentFileStore;
}) => {
  const list = (options: SnapshotListOptions = {}) =>
    Effect.try({
      try: (): SnapshotInventory => {
        const { limit, after } = validateSnapshotListOptions(options);
        const page = metadataStore.listDocumentMetadataPage(limit, after);
        const last = page.rows.at(-1);
        return {
          snapshots: page.rows.map((row) => ({
            ...row,
            expiresAt: row.lastAccessedAt + V1_RETENTION_MILLISECONDS,
          })),
          ...(page.hasMore && last !== undefined ? { nextAfter: last.id } : {}),
        };
      },
      catch: failure,
    });
  const usage = () =>
    Effect.try({
      try: (): SnapshotUsage => ({
        ...metadataStore.getDocumentStorageUsage(),
        quotaBytes: V1_STORAGE_QUOTA_BYTES,
        retentionMilliseconds: V1_RETENTION_MILLISECONDS,
      }),
      catch: failure,
    });
  const deleteSnapshot = (input: SnapshotSelection, signal?: AbortSignal) =>
    Effect.tryPromise({
      try: async (): Promise<SnapshotDeleteResult> => {
        const selection = validateSnapshotSelection(input);
        signal?.throwIfAborted();
        const row = metadataStore.getDocumentMetadataSnapshot(selection.id);
        const base = {
          ...selection,
          removedMetadata: false,
          removedFile: false,
          fileState: "unknown",
          recovery: "none",
        } as const;
        if (row === undefined) return { ...base, status: "not_found" };
        if (row.generation !== selection.generation) return { ...base, status: "stale" };
        let removedMetadata = false;
        let metadataDecisionAttempted = false;
        try {
          const file = await documentFileStore.getDocumentFileObservation(selection.id);
          signal?.throwIfAborted();
          // The target lock excludes publication and new reads. Existing read leases
          // reject deletion before this callback can remove metadata. Once started,
          // finish the pair without cancellation between SQLite and unlink.
          const removedFile = await documentFileStore.deleteDocumentFileIf(
            selection.id,
            (exists) => {
              if (exists && file === undefined) return false;
              metadataDecisionAttempted = true;
              removedMetadata = metadataStore.deleteDocumentIfMatches(row);
              return exists && removedMetadata;
            },
            file?.identity
          );
          return {
            ...selection,
            status: removedMetadata ? "deleted" : "stale",
            removedMetadata,
            removedFile,
            fileState: removedMetadata ? "absent" : "unknown",
            recovery: "none",
          };
        } catch (cause) {
          // Metadata is the visibility fence. If unlink fails after its removal,
          // existing bounded orphan reconciliation owns recovery, including restart.
          // Never restore a row with a new generation or claim physical bytes freed.
          let metadataUncertain = metadataDecisionAttempted && !removedMetadata;
          if (metadataUncertain) {
            try {
              const current = metadataStore.getDocumentMetadataSnapshot(selection.id);
              removedMetadata = current === undefined;
              // A proved retained generation can be selected again. Cleanup does
              // not remove an otherwise valid, unexpired snapshot.
              metadataUncertain = current !== undefined && current.generation !== row.generation;
            } catch {
              // An unreadable commit stays partial and requires reconciliation.
            }
          }
          const partial = removedMetadata || metadataUncertain;
          return {
            ...selection,
            status: partial ? "partial" : "retained",
            removedMetadata,
            removedFile: false,
            fileState: cause instanceof DocumentFileDeleteError ? cause.targetState : "unknown",
            recovery: metadataUncertain ? "inspect" : partial ? "clean" : "retry_selection",
            message: describe(cause),
          };
        }
      },
      catch: failure,
    });
  return { list, usage, deleteSnapshot };
};
