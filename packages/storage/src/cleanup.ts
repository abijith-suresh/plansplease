import { V1_RETENTION_DAYS } from "@planview/core";
import { Data, Effect } from "effect";
import {
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS,
  type DocumentFileObservation,
  type DocumentFileReconciliationCursor,
  type DocumentFileReconciliationResult,
  type DocumentFileScanWatermark,
  type DocumentFileStore,
} from "./document-files.js";
import type {
  DocumentMetadata,
  DocumentMetadataAccessCursor,
  MetadataStore,
} from "./metadata-contracts.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const CLEANUP_PAGE_SIZE = 128;
/** Fixed policy limits keep daemon maintenance responsive and resumable. */
export const V1_CLEANUP_ITEM_BUDGET = 512;
export const V1_CLEANUP_TIME_BUDGET_MILLISECONDS = 1_000;
/**
 * A just-finalized target can briefly exist before its metadata transaction.
 * Keep fresh uncommitted targets for one publication lock lease plus grace so
 * a crash-safe reconciliation pass cannot delete a live publisher's target.
 */
export const V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS =
  DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS;

export type DocumentCleanupFailure = Readonly<{
  readonly phase: "staging" | "metadata" | "document-file";
  readonly id?: string;
  readonly cause: unknown;
  readonly message: string;
}>;

export type DocumentCleanupResult = Readonly<{
  readonly now: number;
  readonly cutoff: number;
  readonly removedDocuments: number;
  readonly removedDocumentFiles: number;
  readonly removedMetadataRows: number;
  readonly removedStagedFiles: number;
  readonly removedReadReferences: number;
  readonly removedFinalizationLocks: number;
  readonly reclaimedBytes: number;
  readonly retainedEntries: number;
  readonly processedItems: number;
  /** More bounded work remains; the next clean call resumes from a cursor. */
  readonly resumable: boolean;
  readonly failures: readonly DocumentCleanupFailure[];
}>;

export type DocumentCleanupCoordinatorOptions = Readonly<{
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
  readonly now?: () => number;
  readonly retentionDays?: number;
  /** Private deterministic fault seam for cleanup tests. */
  readonly beforeDocumentCleanup?: (id: string, signal?: AbortSignal) => Promise<void>;
  /** Private deterministic fault seam for reconciliation tests. */
  readonly beforeReconciliation?: (signal?: AbortSignal) => Promise<void>;
}>;

export interface DocumentCleanupCoordinator {
  readonly clean: (
    signal?: AbortSignal
  ) => Effect.Effect<DocumentCleanupResult, DocumentCleanupError>;
}

export class DocumentCleanupError extends Data.TaggedError("DocumentCleanupError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const validNow = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("The cleanup clock must return a non-negative safe integer.");
  }
  return value;
};

const validRetentionDays = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("The cleanup retention period must be a non-negative safe integer.");
  }
  return value;
};

const failureFor = (phase: DocumentCleanupFailure["phase"], cause: unknown, id?: string) => ({
  phase,
  ...(id === undefined ? {} : { id }),
  cause,
  message: describe(cause),
});

const bytesFor = (file: DocumentFileObservation | undefined) =>
  file === undefined ? 0 : file.size;

const isOldEnoughOrphan = (file: DocumentFileObservation, now: number) =>
  Number.isFinite(file.modifiedAt) &&
  file.modifiedAt <= now - V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS;

const accessCursorFor = (metadata: DocumentMetadata) => ({
  lastAccessedAt: metadata.lastAccessedAt,
  id: metadata.id,
});

export const createDocumentCleanupCoordinator = (options: DocumentCleanupCoordinatorOptions) => {
  const {
    documentFileStore,
    metadataStore,
    now = Date.now,
    retentionDays = V1_RETENTION_DAYS,
    beforeDocumentCleanup,
    beforeReconciliation,
  } = options;
  const retention = validRetentionDays(retentionDays);
  let running: Promise<DocumentCleanupResult> | undefined;
  let candidateCursor: DocumentMetadataAccessCursor | undefined;
  let metadataCursor: string | undefined;
  // The final page can complete the phase while consuming the whole item budget.
  let metadataReconciliationComplete = false;
  let fileCursor: string | undefined;
  let reconciliationCursor: DocumentFileReconciliationCursor | undefined;
  let metadataWatermark: number | undefined;
  let fileWatermark: DocumentFileScanWatermark | undefined;

  const run = async (signal?: AbortSignal) => {
    const currentTime = validNow(now());
    const cutoff = Math.max(0, currentTime - retention * DAY_MS);
    const startedAt = performance.now();
    const failures: DocumentCleanupFailure[] = [];
    let processedItems = 0;
    let removedDocuments = 0;
    let removedDocumentFiles = 0;
    let removedMetadataRows = 0;
    let reclaimedBytes = 0;
    let removedStagedFiles = 0;
    let removedReadReferences = 0;
    let removedFinalizationLocks = 0;
    let retainedEntries = 0;
    let budgetExhausted = false;

    const canProcess = () =>
      processedItems < V1_CLEANUP_ITEM_BUDGET &&
      performance.now() - startedAt < V1_CLEANUP_TIME_BUDGET_MILLISECONDS;
    const takeItem = () => {
      processedItems += 1;
    };
    const inspectionError = (cause: unknown) =>
      new DocumentCleanupError({
        cause,
        message: `Could not inspect Planview cleanup state: ${describe(cause)}`,
      });
    const makeResult = (forceResumable = false) => {
      const resumable =
        forceResumable ||
        budgetExhausted ||
        candidateCursor !== undefined ||
        metadataCursor !== undefined ||
        fileCursor !== undefined ||
        fileWatermark !== undefined ||
        reconciliationCursor !== undefined;
      if (!resumable) {
        // A completed pass must take a fresh watermark next time. Keeping an
        // old rowid watermark would permanently hide rows inserted after this pass.
        metadataReconciliationComplete = false;
        metadataWatermark = undefined;
        fileWatermark = undefined;
      }
      return Object.freeze({
        now: currentTime,
        cutoff,
        removedDocuments,
        removedDocumentFiles,
        removedMetadataRows,
        removedStagedFiles,
        removedReadReferences,
        removedFinalizationLocks,
        reclaimedBytes,
        retainedEntries,
        processedItems,
        resumable,
        failures: Object.freeze(failures),
      });
    };

    try {
      signal?.throwIfAborted();
      await beforeReconciliation?.(signal);
      signal?.throwIfAborted();
      try {
        metadataWatermark ??= metadataStore.getDocumentMetadataScanWatermark();
      } catch (cause) {
        throw inspectionError(cause);
      }

      try {
        const remaining = V1_CLEANUP_ITEM_BUDGET - processedItems;
        if (remaining < 1 || !canProcess()) {
          budgetExhausted = true;
        } else {
          const staging: DocumentFileReconciliationResult =
            await documentFileStore.reconcileDocumentFiles({
              maxItems: remaining,
              shouldContinue: () => canProcess() && signal?.aborted !== true,
              ...(reconciliationCursor === undefined ? {} : { cursor: reconciliationCursor }),
            });
          processedItems += staging.processedItems;
          removedStagedFiles += staging.stagedFilesRemoved;
          removedReadReferences += staging.readReferencesRemoved;
          removedFinalizationLocks += staging.finalizationLocksRemoved;
          retainedEntries += staging.retainedEntries;
          reconciliationCursor = staging.resumable ? staging.cursor : undefined;
          budgetExhausted = staging.resumable;
        }
      } catch (cause) {
        signal?.throwIfAborted();
        failures.push(failureFor("staging", cause));
        retainedEntries += 1;
      }

      const protectedFileIds = new Set<string>();

      // The access-order index makes this the hot path: only a bounded page of
      // stale rows is ever materialized, and the tuple cursor survives a call
      // that reaches either fixed budget.
      while (!budgetExhausted) {
        if (!canProcess()) {
          budgetExhausted = true;
          break;
        }
        const page = (() => {
          try {
            return metadataStore.listDocumentMetadataCandidates(
              cutoff,
              Math.min(CLEANUP_PAGE_SIZE, V1_CLEANUP_ITEM_BUDGET - processedItems),
              candidateCursor,
              metadataWatermark
            );
          } catch (cause) {
            throw inspectionError(cause);
          }
        })();
        if (page.rows.length === 0) {
          candidateCursor = undefined;
          break;
        }

        let stoppedInPage = false;
        for (const row of page.rows) {
          signal?.throwIfAborted();
          if (!canProcess()) {
            budgetExhausted = true;
            stoppedInPage = true;
            break;
          }
          const previousCandidateCursor = candidateCursor;
          candidateCursor = accessCursorFor(row);
          protectedFileIds.add(row.id);
          takeItem();
          if (row.pinned || row.lastAccessedAt >= cutoff) {
            continue;
          }

          try {
            await beforeDocumentCleanup?.(row.id, signal);
            signal?.throwIfAborted();
            const file = await documentFileStore.getDocumentFileObservation(row.id);
            let deletedMetadata: DocumentMetadata | undefined;
            let removedMetadataRow = false;
            const removedFile = await documentFileStore.deleteDocumentFileIf(
              row.id,
              (targetExists) => {
                if (!targetExists) {
                  removedMetadataRow = metadataStore.deleteDocumentIfMatches(row, true);
                  return false;
                }
                // The target was absent during the observation. A newly
                // published replacement must not be deleted by this old row.
                if (file === undefined) {
                  return false;
                }
                deletedMetadata = metadataStore.deleteDocumentIfLastAccessedBefore(row, cutoff);
                return deletedMetadata !== undefined;
              },
              file?.identity
            );
            // Deletion and its metadata decision are one storage operation. Do
            // not abort in the middle of it; cancellation is observed only once
            // the pair has reached a safe boundary.
            signal?.throwIfAborted();
            if (deletedMetadata !== undefined || removedMetadataRow) {
              removedDocuments += 1;
              removedMetadataRows += 1;
              if (removedFile) {
                removedDocumentFiles += 1;
                reclaimedBytes += bytesFor(file);
              }
            }
          } catch (cause) {
            if (signal?.aborted) {
              candidateCursor = previousCandidateCursor;
            }
            signal?.throwIfAborted();
            failures.push(failureFor("document-file", cause, row.id));
            retainedEntries += 1;
          }
        }
        if (stoppedInPage) {
          break;
        }
        if (!page.hasMore) {
          candidateCursor = undefined;
          break;
        }
      }

      // Reconciliation uses bounded id pages rather than a full metadata map.
      // It catches fresh metadata rows whose file disappeared and mismatched
      // pairs, while stale retention remains driven by the indexed query above.
      while (!budgetExhausted && !metadataReconciliationComplete) {
        if (!canProcess()) {
          budgetExhausted = true;
          break;
        }
        const page = (() => {
          try {
            return metadataStore.listDocumentMetadataPage(
              Math.min(CLEANUP_PAGE_SIZE, V1_CLEANUP_ITEM_BUDGET - processedItems),
              metadataCursor,
              metadataWatermark
            );
          } catch (cause) {
            throw inspectionError(cause);
          }
        })();
        if (page.rows.length === 0) {
          metadataCursor = undefined;
          metadataReconciliationComplete = true;
          break;
        }

        let stoppedInPage = false;
        for (const row of page.rows) {
          signal?.throwIfAborted();
          if (!canProcess()) {
            budgetExhausted = true;
            stoppedInPage = true;
            break;
          }
          const previousMetadataCursor = metadataCursor;
          metadataCursor = row.id;
          protectedFileIds.add(row.id);
          takeItem();
          try {
            if (row.pinned) {
              retainedEntries += 1;
              continue;
            }
            const file = await documentFileStore.getDocumentFileObservation(row.id);
            if (file === undefined) {
              let removed = false;
              await documentFileStore.deleteDocumentFileIf(row.id, (targetExists) => {
                if (targetExists) {
                  return false;
                }
                removed = metadataStore.deleteDocumentIfMatches(row, true);
                return false;
              });
              if (removed) {
                removedMetadataRows += 1;
              }
              continue;
            }
            if (row.size === file.size) {
              continue;
            }

            let removed = false;
            await documentFileStore.deleteDocumentFileIf(
              row.id,
              (targetExists) => {
                if (!targetExists) {
                  return false;
                }
                removed = metadataStore.deleteDocumentIfMatches(row, true);
                return removed;
              },
              file.identity
            );
            if (removed) {
              removedMetadataRows += 1;
              removedDocumentFiles += 1;
              reclaimedBytes += bytesFor(file);
            }
          } catch (cause) {
            if (signal?.aborted) {
              metadataCursor = previousMetadataCursor;
            }
            signal?.throwIfAborted();
            failures.push(failureFor("metadata", cause, row.id));
            retainedEntries += 1;
          }
        }
        if (stoppedInPage) {
          break;
        }
        if (!page.hasMore) {
          metadataCursor = undefined;
          metadataReconciliationComplete = true;
          break;
        }
      }

      // Physical orphan reconciliation also advances by an id cursor. A
      // missing metadata lookup is re-proven while the target lock is held,
      // retaining the same publication and active-read safety boundary.
      while (!budgetExhausted) {
        if (!canProcess()) {
          budgetExhausted = true;
          break;
        }
        const page = await (async () => {
          try {
            return await documentFileStore.listDocumentFilesPage(
              Math.min(CLEANUP_PAGE_SIZE, V1_CLEANUP_ITEM_BUDGET - processedItems),
              fileCursor,
              fileWatermark
            );
          } catch (cause) {
            throw inspectionError(cause);
          }
        })();
        fileWatermark ??= page.watermark;
        if (page.files.length === 0 && !page.hasMore) {
          fileCursor = undefined;
          fileWatermark = undefined;
          break;
        }

        let stoppedInPage = false;
        for (const file of page.files) {
          signal?.throwIfAborted();
          if (!canProcess()) {
            budgetExhausted = true;
            stoppedInPage = true;
            break;
          }
          const previousFileCursor = fileCursor;
          fileCursor = file.id;
          takeItem();
          try {
            if (protectedFileIds.has(file.id)) {
              if (metadataStore.getDocumentMetadata(file.id) === undefined) {
                retainedEntries += 1;
              }
              continue;
            }
            if (metadataStore.getDocumentMetadata(file.id) !== undefined) {
              continue;
            }
            if (!isOldEnoughOrphan(file, currentTime)) {
              retainedEntries += 1;
              continue;
            }
            const removed = await documentFileStore.deleteDocumentFileIf(
              file.id,
              (targetExists) => {
                if (!targetExists) {
                  return false;
                }
                if (metadataStore.getDocumentMetadata(file.id) !== undefined) {
                  return false;
                }
                return true;
              },
              file.identity
            );
            if (removed) {
              removedDocumentFiles += 1;
              reclaimedBytes += file.size;
            }
          } catch (cause) {
            if (signal?.aborted) {
              fileCursor = previousFileCursor;
            }
            signal?.throwIfAborted();
            failures.push(failureFor("document-file", cause, file.id));
            retainedEntries += 1;
          }
        }
        if (stoppedInPage) {
          break;
        }
        if (!page.hasMore) {
          fileCursor = undefined;
          fileWatermark = undefined;
          break;
        }
        // The store cursor advances over every examined name, including
        // entries conservatively deferred by the scan fence. Do not derive it
        // from returned files or a deferred entry can be admitted/skipped on a
        // later page.
        fileCursor = page.nextId ?? fileCursor;
      }

      return makeResult();
    } catch (cause) {
      if (signal?.aborted) {
        // A cancellation is a bounded pause, not a completed pass. The active
        // row cursor is restored by its phase before cancellation escapes, so
        // the next call rechecks that row instead of skipping it.
        return makeResult(true);
      }
      throw cause;
    }
  };

  const clean = (
    signal?: AbortSignal
  ): Effect.Effect<DocumentCleanupResult, DocumentCleanupError> =>
    Effect.tryPromise({
      try: (effectSignal) => {
        if (running === undefined) {
          const operationSignal =
            signal === undefined ? effectSignal : AbortSignal.any([effectSignal, signal]);
          running = run(operationSignal).finally(() => {
            running = undefined;
          });
        }
        return running;
      },
      catch: (cause) =>
        cause instanceof DocumentCleanupError
          ? cause
          : new DocumentCleanupError({
              cause,
              message: `Could not clean Planview storage: ${describe(cause)}`,
            }),
    });

  return { clean } satisfies DocumentCleanupCoordinator;
};

export const V1_RETENTION_MILLISECONDS = V1_RETENTION_DAYS * DAY_MS;
