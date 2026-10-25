import type { ReadStream } from "node:fs";
import {
  type DocumentId,
  generateDocumentId,
  InvalidSourceFileSizeError,
  SourceFileTooLargeError,
  UnsupportedSourceExtensionError,
  validateDocumentId,
  validateSourceFileSize,
} from "@planview/core";
import { Effect } from "effect";
import {
  DocumentFileAlreadyExistsError,
  DocumentFileCloneError,
  DocumentFileDeleteError,
  DocumentFileDiscardError,
  DocumentFileFinalizeError,
  DocumentFileNotRegularError,
  type DocumentFileResourceState,
  DocumentFileSourceError,
  type DocumentFileStore,
  DocumentFileStoreClosedError,
  DocumentFileStoreOpenError,
  DocumentFileStorePathError,
  DocumentFileTargetBusyError,
  type DocumentFileTargetCapability,
  type DocumentFileTargetRecoveryPolicy,
  type StagedDocumentFileHandle,
} from "./document-files.js";
import type { DocumentMetadata } from "./metadata-contracts.js";
import {
  DocumentPublicationError,
  DocumentPublicationRetryLimitError,
  type DocumentPublicationCoordinator,
  type DocumentPublicationCoordinatorOptions,
  type DocumentPublicationOrphanState,
  type DocumentPublicationRecovery,
  type DocumentPublicationResourceState,
} from "./publication-contracts.js";
import { createMetadataGatedDocumentReader } from "./publication-reader.js";

export {
  DocumentPublicationError,
  DocumentPublicationRetryLimitError,
  type DocumentPublicationCoordinator,
  type DocumentPublicationCoordinatorOptions,
  type DocumentPublicationOrphanState,
  type DocumentPublicationRecovery,
  type DocumentPublicationResource,
  type DocumentPublicationResourceState,
  type DocumentPublicationResult,
} from "./publication-contracts.js";

export {
  createMetadataGatedDocumentReader,
  DocumentPublicationNotFoundError,
  DocumentPublicationReadError,
  type MetadataGatedDocumentReader,
  type MetadataGatedDocumentReaderOptions,
} from "./publication-reader.js";

const DEFAULT_MAX_ATTEMPTS = 8;

type MetadataObservation = "absent" | "occupied" | "unknown";
type OwnedHandleState = {
  readonly handle: StagedDocumentFileHandle;
  staged: DocumentFileResourceState;
  lock: DocumentFileResourceState;
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordValue = (record: Record<string, unknown>, key: string) => record[key];

const errorCode = (error: unknown) => {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = recordValue(error, "code");
  return typeof code === "string" ? code : undefined;
};

const relatedErrors = (error: unknown) => {
  const values: unknown[] = [];
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    values.push(current);
    if (!isRecord(current)) {
      continue;
    }
    const cause = recordValue(current, "cause");
    if (cause !== undefined) {
      pending.push(cause);
    }
    const cleanupCause = recordValue(current, "cleanupCause");
    if (cleanupCause !== undefined) {
      pending.push(cleanupCause);
    }
  }
  return values;
};

const isDocumentFileCollision = (error: unknown) =>
  relatedErrors(error).some(
    (value) =>
      value instanceof DocumentFileAlreadyExistsError ||
      value instanceof DocumentFileTargetBusyError
  );

const defaultIsMetadataUniquenessCollision = (error: unknown) => {
  const code = errorCode(error);
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  if (code?.startsWith("SQLITE_CONSTRAINT_") === true) {
    return /unique|primary/i.test(describe(error));
  }
  return /(?:unique|duplicate|primary key).*?(?:constraint|id|document)|constraint.*?(?:unique|primary key)/i.test(
    describe(error)
  );
};

const defaultReadPublishedSize = async (
  id: DocumentId,
  documentFileStore: DocumentFileStore,
  signal?: AbortSignal,
  readTarget?: () => Promise<ReadStream>
) => {
  signal?.throwIfAborted();
  const stream = await (readTarget === undefined
    ? documentFileStore.readDocumentFile(id)
    : readTarget());
  const onAbort = () => stream.destroy(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let size = 0;
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      const chunkSize =
        typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : chunk instanceof Uint8Array
            ? chunk.byteLength
            : NaN;
      if (!Number.isSafeInteger(chunkSize) || chunkSize < 0) {
        throw new TypeError("The document stream yielded a non-byte chunk.");
      }
      size += chunkSize;
      if (!Number.isSafeInteger(size)) {
        throw new RangeError("The published document size is not a safe integer.");
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
  return validateSourceFileSize(size);
};

const isRetained = (state: DocumentFileResourceState): state is DocumentPublicationResourceState =>
  state !== "absent";

const stageFailureHasNoUnidentifiedArtifact = (cause: unknown) =>
  cause instanceof UnsupportedSourceExtensionError ||
  cause instanceof InvalidSourceFileSizeError ||
  cause instanceof SourceFileTooLargeError ||
  cause instanceof DocumentFileNotRegularError ||
  cause instanceof DocumentFileStoreClosedError ||
  cause instanceof DocumentFileStoreOpenError ||
  cause instanceof DocumentFileStorePathError ||
  (cause instanceof DocumentFileSourceError && cause.cleanupCause === undefined);

const cleanupCauseFor = (errors: readonly unknown[]) => {
  if (errors.length === 0) {
    return undefined;
  }
  return errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Multiple publication compensation failures.");
};

const makePublicationError = ({
  sourcePath,
  id,
  handle,
  cause,
  cleanupCause,
  orphan,
}: {
  readonly sourcePath: string;
  readonly id?: string | undefined;
  readonly handle?: string | undefined;
  readonly cause: unknown;
  readonly cleanupCause?: unknown | undefined;
  readonly orphan?: DocumentPublicationOrphanState | undefined;
}) =>
  new DocumentPublicationError({
    sourcePath,
    ...(id === undefined ? {} : { id }),
    ...(handle === undefined ? {} : { handle }),
    cause,
    ...(cleanupCause === undefined ? {} : { cleanupCause }),
    ...(orphan === undefined ? {} : { orphan }),
    message: `Could not publish document from ${sourcePath}: ${describe(cause)}${cleanupCause === undefined ? "" : `; compensation also failed: ${describe(cleanupCause)}`}${orphan === undefined ? "" : "; recoverable publication state was retained"}`,
  });

export const createDocumentPublicationCoordinator = (
  options: DocumentPublicationCoordinatorOptions
): DocumentPublicationCoordinator => {
  const {
    documentFileStore,
    metadataStore,
    randomBytes,
    generateId,
    now = Date.now,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    isMetadataUniquenessCollision = defaultIsMetadataUniquenessCollision,
    readPublishedSize = defaultReadPublishedSize,
  } = options;

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("Publication maxAttempts must be a positive safe integer.");
  }

  const nextId =
    generateId ??
    (() =>
      randomBytes === undefined ? generateDocumentId() : generateDocumentId({ randomBytes }));
  const reader = createMetadataGatedDocumentReader({ documentFileStore, metadataStore });

  const publishPromise = async (sourcePath: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    // Track handles per call so concurrent publications cannot compensate
    // one another's resources.
    const ownedHandles = new Map<string, OwnedHandleState>();
    const targetLockStates = new Map<string, DocumentFileResourceState>();
    // An adapter can create a resource and throw before returning its handle.
    // Count those unknown resources so recovery reports them.
    let possibleUnidentifiedStagedFiles = 0;
    let possibleUnidentifiedFinalizationLocks = 0;
    let snapshotHandle: StagedDocumentFileHandle | undefined;

    const rememberHandle = (handle: StagedDocumentFileHandle) => {
      const state: OwnedHandleState = {
        handle,
        staged: "retained",
        lock: "absent",
      };
      ownedHandles.set(handle, state);
      return state;
    };

    const handleFor = (handles?: ReadonlySet<string>) => {
      for (const entry of ownedHandles.values()) {
        if (
          (handles === undefined || handles.has(entry.handle)) &&
          (entry.staged !== "absent" || entry.lock !== "absent")
        ) {
          return entry.handle;
        }
      }
      return undefined;
    };

    const recoveryFor = ({
      id,
      targetState,
      metadataState,
      reason,
      handles,
    }: {
      readonly id?: string;
      readonly targetState: DocumentFileResourceState;
      readonly metadataState: MetadataObservation;
      readonly reason: DocumentPublicationOrphanState["reason"];
      readonly handles?: ReadonlySet<string>;
    }) => {
      const targetLockState = id === undefined ? undefined : targetLockStates.get(id);
      const targetLockResource =
        id === undefined || targetLockState === undefined || !isRetained(targetLockState)
          ? []
          : [{ id, state: targetLockState }];
      const resources: DocumentPublicationRecovery = {
        documentFiles:
          id !== undefined && isRetained(targetState) ? [{ id, state: targetState }] : [],
        metadataRows:
          id !== undefined && metadataState === "unknown" ? [{ id, state: "unknown" }] : [],
        stagedFiles: [
          ...[...ownedHandles.values()].flatMap((entry) =>
            (handles === undefined || handles.has(entry.handle)) && isRetained(entry.staged)
              ? [{ handle: entry.handle, state: entry.staged }]
              : []
          ),
          ...Array.from({ length: possibleUnidentifiedStagedFiles }, () => ({
            state: "unknown" as const,
          })),
        ],
        finalizationLocks: [
          ...[...ownedHandles.values()].flatMap((entry) =>
            (handles === undefined || handles.has(entry.handle)) && isRetained(entry.lock)
              ? [{ handle: entry.handle, state: entry.lock }]
              : []
          ),
          ...targetLockResource,
          ...Array.from({ length: possibleUnidentifiedFinalizationLocks }, () => ({
            state: "unknown" as const,
          })),
        ],
      };
      const hasFile = resources.documentFiles.length > 0;
      const hasMetadata = resources.metadataRows.length > 0;
      const hasStaged = resources.stagedFiles.length > 0;
      const hasLocks = resources.finalizationLocks.length > 0;
      if (!hasFile && !hasMetadata && !hasStaged && !hasLocks) {
        return undefined;
      }

      const kind =
        hasFile && hasMetadata
          ? "document-file-and-metadata-row"
          : hasFile && hasStaged
            ? "document-file-and-staged-file"
            : hasFile
              ? "document-file"
              : hasMetadata && hasStaged
                ? "metadata-row-and-staged-file"
                : hasMetadata
                  ? "metadata-row"
                  : hasStaged
                    ? "staged-file"
                    : "finalization-lock";
      const recoveryHandle = handleFor(handles);
      return {
        kind,
        ...(id === undefined ? {} : { id }),
        ...(recoveryHandle === undefined ? {} : { handle: recoveryHandle }),
        reason,
        resources,
      } satisfies DocumentPublicationOrphanState;
    };

    const discardOwnedHandles = async (handles?: ReadonlySet<string>) => {
      const errors: unknown[] = [];
      for (const entry of ownedHandles.values()) {
        if (
          (handles !== undefined && !handles.has(entry.handle)) ||
          entry.staged !== "retained" ||
          entry.lock !== "absent"
        ) {
          continue;
        }
        try {
          await documentFileStore.discardStagedFile(entry.handle);
          entry.staged = "absent";
          entry.lock = "absent";
        } catch (cause) {
          errors.push(cause);
          if (cause instanceof DocumentFileDiscardError) {
            entry.staged = cause.stagedFileState;
            entry.lock = cause.finalizationLockState;
          } else {
            entry.staged = "unknown";
            entry.lock = "unknown";
          }
        }
      }
      return errors;
    };

    const accountDocumentDeleteFailure = (id: DocumentId, error: unknown) => {
      if (error instanceof DocumentFileDeleteError) {
        if (error.targetLockState === "absent") {
          targetLockStates.delete(id);
        } else {
          targetLockStates.set(id, error.targetLockState);
        }
        return error.targetState;
      }

      // A generic adapter error provides no partial-operation boundary. The
      // target and its id-wide lock are both possibly retained.
      targetLockStates.set(id, "unknown");
      return "unknown";
    };

    const compensate = async (
      id: DocumentId,
      {
        targetState,
        targetCapability,
        targetRecoveryPolicy = "delete",
        metadataState,
        cause,
        handles,
      }: {
        readonly targetState: DocumentFileResourceState;
        readonly targetCapability?: DocumentFileTargetCapability;
        readonly targetRecoveryPolicy?: DocumentFileTargetRecoveryPolicy;
        readonly metadataState: MetadataObservation;
        readonly cause: unknown;
        readonly handles?: ReadonlySet<string>;
      }
    ) => {
      let residualTargetState = targetState;
      const cleanupErrors: unknown[] = [];

      // A target is deleted only when metadata absence is proven and every
      // relevant finalization lock is known gone. An ambiguous database or lock
      // boundary retains the file so a possible committed/replacement pair
      // remains recoverable and the metadata-gated reader keeps it invisible.
      const relevantHandles = [...ownedHandles.values()].filter(
        (entry) => handles === undefined || handles.has(entry.handle)
      );
      const finalizationStateIsKnown = relevantHandles.every((entry) => entry.lock === "absent");
      if (
        residualTargetState !== "absent" &&
        targetCapability !== undefined &&
        targetRecoveryPolicy !== "retain" &&
        metadataState === "absent" &&
        finalizationStateIsKnown
      ) {
        try {
          await documentFileStore.deleteDocumentFile(id, targetCapability);
          residualTargetState = "absent";
        } catch (cleanupError) {
          // The capability is the only proof that this coordinator created the
          // target. A mismatch is retained as unknown rather than falling back
          // to deletion by the document pathname. Typed delete failures also
          // carry the target-lock state, which must survive into recovery.
          residualTargetState = accountDocumentDeleteFailure(id, cleanupError);
          cleanupErrors.push(cleanupError);
        }
      }

      cleanupErrors.push(...(await discardOwnedHandles(handles)));
      const orphan = recoveryFor({
        id,
        targetState: residualTargetState,
        metadataState,
        reason: metadataState === "unknown" ? "process-crash-window" : "compensation-failed",
        ...(handles === undefined ? {} : { handles }),
      });
      if (cleanupErrors.length > 0 || orphan !== undefined) {
        throw makePublicationError({
          sourcePath,
          id,
          handle: handleFor(handles),
          cause,
          cleanupCause: cleanupCauseFor(cleanupErrors),
          orphan,
        });
      }
    };

    const compensateWithoutId = async (cause: unknown) => {
      const cleanupErrors = await discardOwnedHandles();
      const orphan = recoveryFor({
        targetState: "absent",
        metadataState: "absent",
        reason: "compensation-failed",
      });
      if (cleanupErrors.length > 0 || orphan !== undefined) {
        throw makePublicationError({
          sourcePath,
          handle: handleFor(),
          cause,
          cleanupCause: cleanupCauseFor(cleanupErrors),
          orphan,
        });
      }
    };

    const observeMetadata = (id: DocumentId) => {
      try {
        return metadataStore.getDocumentMetadata(id) === undefined
          ? { status: "absent" as const }
          : { status: "occupied" as const };
      } catch (cause) {
        return { status: "unknown" as const, cause };
      }
    };

    // Returns only when compensation proved that another id can be tried.
    const recoverMetadataCommitFailure = async ({
      id,
      attemptHandle,
      attempt,
      targetState,
      targetCapability,
      cause,
    }: {
      readonly id: DocumentId;
      readonly attemptHandle: StagedDocumentFileHandle;
      readonly attempt: number;
      readonly targetState: DocumentFileResourceState;
      readonly targetCapability: DocumentFileTargetCapability | undefined;
      readonly cause: unknown;
    }) => {
      let uniquenessCollision = false;
      try {
        uniquenessCollision = isMetadataUniquenessCollision(cause);
      } catch (classifierCause) {
        const observation = observeMetadata(id);
        const metadataState: MetadataObservation =
          observation.status === "absent" ? "absent" : "unknown";
        const observedCause = observation.cause;
        await compensate(id, {
          targetState,
          ...(targetCapability === undefined ? {} : { targetCapability }),
          targetRecoveryPolicy: metadataState === "absent" ? "delete" : "retain",
          metadataState,
          cause:
            observedCause === undefined
              ? classifierCause
              : new AggregateError([classifierCause, observedCause]),
        });
        throw makePublicationError({ sourcePath, id, cause: classifierCause });
      }

      // A row after an insert error is not proof that this invocation inserted
      // it. Retain an occupied or unreadable pair as an orphan.
      const observation = observeMetadata(id);
      const metadataState: MetadataObservation =
        observation.status === "absent" ? "absent" : "unknown";
      const targetRecoveryPolicy = metadataState === "absent" ? "delete" : "retain";
      if (uniquenessCollision && metadataState === "absent") {
        await compensate(id, {
          targetState,
          ...(targetCapability === undefined ? {} : { targetCapability }),
          targetRecoveryPolicy,
          metadataState,
          cause,
          handles: new Set([attemptHandle]),
        });
        if (attempt < maxAttempts) {
          return;
        }
        await compensateWithoutId(cause);
        throw new DocumentPublicationRetryLimitError({
          sourcePath,
          attempts: attempt,
          cause,
          message: `Could not publish document from ${sourcePath}: exhausted ${maxAttempts} attempts after metadata uniqueness collisions.`,
        });
      }

      const observedCause = observation.cause;
      await compensate(id, {
        targetState,
        ...(targetCapability === undefined ? {} : { targetCapability }),
        targetRecoveryPolicy,
        metadataState,
        cause: observedCause === undefined ? cause : new AggregateError([cause, observedCause]),
      });
      throw makePublicationError({ sourcePath, id, handle: attemptHandle, cause });
    };

    const compensateAfterSuccessfulMetadata = async ({
      id,
      targetCapability,
      cause,
    }: {
      readonly id: DocumentId;
      readonly targetCapability?: DocumentFileTargetCapability;
      readonly cause: unknown;
    }) => {
      let metadataState: MetadataObservation = "occupied";
      let targetState: DocumentFileResourceState = "retained";
      const cleanupErrors: unknown[] = [];

      try {
        metadataState = metadataStore.deleteDocument(id) ? "absent" : "unknown";
      } catch (cleanupError) {
        metadataState = "unknown";
        cleanupErrors.push(cleanupError);
      }
      if (metadataState === "absent" && targetCapability !== undefined) {
        try {
          await documentFileStore.deleteDocumentFile(id, targetCapability);
          targetState = "absent";
          targetLockStates.delete(id);
        } catch (cleanupError) {
          targetState = accountDocumentDeleteFailure(id, cleanupError);
          cleanupErrors.push(cleanupError);
        }
      }
      cleanupErrors.push(...(await discardOwnedHandles()));
      const orphan = recoveryFor({
        id,
        targetState,
        metadataState,
        reason: "compensation-failed",
      });
      if (cleanupErrors.length > 0 || orphan !== undefined) {
        throw makePublicationError({
          sourcePath,
          id,
          handle: handleFor(),
          cause,
          cleanupCause: cleanupCauseFor(cleanupErrors),
          orphan,
        });
      }
      throw makePublicationError({ sourcePath, id, handle: handleFor(), cause });
    };

    try {
      try {
        signal?.throwIfAborted();
        snapshotHandle = await documentFileStore.stageSourceFile(sourcePath, signal);
        rememberHandle(snapshotHandle);
      } catch (cause) {
        // A generic adapter failure has no typed boundary telling us whether
        // it created a staged pathname before failing. Retain an anonymous
        // unknown resource instead of presenting the stage as all-or-nothing.
        if (!stageFailureHasNoUnidentifiedArtifact(cause)) {
          possibleUnidentifiedStagedFiles += 1;
        }
        await compensateWithoutId(cause);
        throw makePublicationError({ sourcePath, cause });
      }

      let lastRetryCause: unknown = new Error("All publication ids were occupied.");
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal?.throwIfAborted();
        let id: DocumentId;
        try {
          id = validateDocumentId(nextId());
        } catch (cause) {
          await compensateWithoutId(cause);
          throw makePublicationError({ sourcePath, cause });
        }

        // A row observed before finalization is an occupied candidate, not a
        // uniqueness exception whose matching fields can prove our ownership.
        // Preflight keeps the normal collision path bounded and avoids creating
        // an unnecessary file for a row that already exists.
        const preflight = observeMetadata(id);
        if (preflight.status === "unknown") {
          const cause = preflight.cause ?? new Error("Metadata lookup was ambiguous.");
          await compensateWithoutId(cause);
          throw makePublicationError({ sourcePath, id, cause });
        }
        if (preflight.status === "occupied") {
          lastRetryCause = new Error(`A metadata row already occupies document id ${id}.`);
          continue;
        }

        let attemptHandle: StagedDocumentFileHandle;
        try {
          signal?.throwIfAborted();
          attemptHandle = await documentFileStore.cloneStagedFile(snapshotHandle);
          if (attemptHandle === snapshotHandle) {
            throw new Error("The staged-file clone must return an independent handle.");
          }
          rememberHandle(attemptHandle);
        } catch (cause) {
          if (cause instanceof DocumentFileCloneError) {
            const snapshot = ownedHandles.get(snapshotHandle);
            if (snapshot !== undefined) {
              snapshot.staged = cause.sourceFileState;
              snapshot.lock = cause.finalizationLockState;
            }
            if (cause.clonedHandle !== undefined) {
              const cloned = rememberHandle(cause.clonedHandle);
              cloned.staged = cause.clonedFileState;
              cloned.lock = "absent";
            }
          } else {
            // The private store seam normally reports a DocumentFileCloneError
            // with partial states. If an adapter violates that contract, the
            // fault could have occurred after a clone and lock were created.
            // Mark the known snapshot and anonymous possible resources rather
            // than treating a generic throw as an all-or-nothing failure.
            const snapshot = ownedHandles.get(snapshotHandle);
            if (snapshot !== undefined) {
              // The snapshot was known to exist before the adapter call. Let
              // the typed discard operation recheck its identity and lock;
              // those states become unknown only if that compensation cannot
              // prove a safe discard.
              snapshot.staged = "retained";
              snapshot.lock = "absent";
            }
            possibleUnidentifiedStagedFiles += 1;
            possibleUnidentifiedFinalizationLocks += 1;
          }
          await compensate(id, {
            targetState: "absent",
            metadataState: "absent",
            cause,
          });
          throw makePublicationError({ sourcePath, id, cause });
        }

        let targetState: DocumentFileResourceState = "absent";
        let targetCapability: DocumentFileTargetCapability | undefined;
        let targetRecoveryPolicy: DocumentFileTargetRecoveryPolicy = "delete";
        let targetCommitCause: unknown;
        let metadata: DocumentMetadata | undefined;
        try {
          // Once finalization starts, let the storage coordinator complete its
          // atomic file boundary. Cancellation is safe before this point, but
          // interrupting it after the hard-link would require guessing which
          // side of the publication boundary won.
          signal?.throwIfAborted();
          targetCapability = await documentFileStore.finalizeStagedFile(
            attemptHandle,
            id,
            async (_target, readTarget) => {
              try {
                const targetReadStore = {
                  ...documentFileStore,
                  readDocument: readTarget,
                  readDocumentFile: readTarget,
                };
                const size = await readPublishedSize(id, targetReadStore, signal, readTarget);
                signal?.throwIfAborted();
                const createdAt = now();
                const candidate = Object.freeze({
                  id,
                  createdAt,
                  lastAccessedAt: createdAt,
                  size,
                });
                // The file store holds the id-wide target lock here. This is
                // the visibility fence between a physical hard link and the
                // metadata commit; cleanup can only observe the target as busy
                // until this insertion has crossed its SQLite boundary.
                signal?.throwIfAborted();
                metadataStore.insertDocumentMetadata(candidate);
                metadata = candidate;
              } catch (cause) {
                targetCommitCause = cause;
                throw cause;
              }
            }
          );
          targetState = "retained";
          targetLockStates.delete(id);
          const state = ownedHandles.get(attemptHandle);
          if (state !== undefined) {
            state.staged = "absent";
            state.lock = "absent";
          }
        } catch (cause) {
          const state = ownedHandles.get(attemptHandle);
          if (cause instanceof DocumentFileFinalizeError) {
            targetState = cause.targetState;
            targetRecoveryPolicy = cause.targetRecoveryPolicy;
            targetCapability =
              cause.targetLockState === "absent" ? cause.targetCapability : undefined;
            if (cause.targetLockState === "absent") {
              targetLockStates.delete(id);
            } else {
              targetLockStates.set(id, cause.targetLockState);
            }
            if (state !== undefined) {
              state.staged = cause.stagedFileState;
              state.lock = cause.finalizationLockState;
            }
          } else if (
            cause instanceof DocumentFileAlreadyExistsError ||
            cause instanceof DocumentFileTargetBusyError ||
            cause instanceof DocumentFileNotRegularError
          ) {
            // These typed errors are emitted before a target is linked (or
            // after the file-store has already proved and compensated it).
            targetState = "absent";
          } else {
            // An adapter or fault seam that throws after any part of
            // finalization is indistinguishable from a target/lock residual.
            // Do not guess that either pathname is absent. The target lock is
            // id-wide and is not represented by the handle state.
            targetState = "unknown";
            targetLockStates.set(id, "unknown");
            if (state !== undefined) {
              state.staged = "unknown";
              state.lock = "unknown";
            }
          }

          if (cause instanceof DocumentFileFinalizeError && cause.targetCommitAttempted) {
            const commitCause = targetCommitCause ?? cause.cause;
            // The file store held the target lock through the failed callback.
            // Recovery still needs a metadata observation before deleting it.
            await recoverMetadataCommitFailure({
              id,
              attemptHandle,
              attempt,
              targetState,
              targetCapability,
              cause: commitCause,
            });
            lastRetryCause = commitCause;
            continue;
          }

          if (isDocumentFileCollision(cause) && targetState === "absent") {
            await compensate(id, {
              targetState,
              metadataState: "occupied",
              cause,
              handles: new Set([attemptHandle]),
            });
            lastRetryCause = cause;
            if (attempt < maxAttempts) {
              continue;
            }
            await compensateWithoutId(cause);
            throw new DocumentPublicationRetryLimitError({
              sourcePath,
              attempts: attempt,
              cause,
              message: `Could not publish document from ${sourcePath}: exhausted ${maxAttempts} attempts after document-file uniqueness collisions.`,
            });
          }

          await compensate(id, {
            targetState,
            ...(targetCapability === undefined ? {} : { targetCapability }),
            targetRecoveryPolicy,
            metadataState: "absent",
            cause,
          });
          throw makePublicationError({ sourcePath, id, handle: attemptHandle, cause });
        }

        if (metadata === undefined) {
          // Adapters written against the pre-fence store contract may ignore
          // the optional callback. Keep them usable, but the built-in store
          // never takes this path: its callback above commits while the
          // target lock is held.
          try {
            const size = await readPublishedSize(id, documentFileStore, signal);
            signal?.throwIfAborted();
            const createdAt = now();
            const candidate = Object.freeze({
              id,
              createdAt,
              lastAccessedAt: createdAt,
              size,
            });
            signal?.throwIfAborted();
            metadataStore.insertDocumentMetadata(candidate);
            metadata = candidate;
          } catch (cause) {
            await recoverMetadataCommitFailure({
              id,
              attemptHandle,
              attempt,
              targetState: "retained",
              targetCapability,
              cause,
            });
            lastRetryCause = cause;
            continue;
          }
        }

        if (metadata === undefined || targetCapability === undefined) {
          const cause = new Error("The publication metadata commit returned without a result.");
          await compensate(id, {
            targetState: "retained",
            ...(targetCapability === undefined ? {} : { targetCapability }),
            targetRecoveryPolicy: "retain",
            metadataState: "unknown",
            cause,
          });
          throw makePublicationError({ sourcePath, id, handle: attemptHandle, cause });
        }

        try {
          await documentFileStore.discardStagedFile(snapshotHandle);
          const snapshot = ownedHandles.get(snapshotHandle);
          if (snapshot !== undefined) {
            snapshot.staged = "absent";
            snapshot.lock = "absent";
          }
        } catch (cause) {
          const snapshot = ownedHandles.get(snapshotHandle);
          if (cause instanceof DocumentFileDiscardError && snapshot !== undefined) {
            snapshot.staged = cause.stagedFileState;
            snapshot.lock = cause.finalizationLockState;
          } else if (snapshot !== undefined) {
            snapshot.staged = "unknown";
            snapshot.lock = "unknown";
          }
          await compensateAfterSuccessfulMetadata({ id, targetCapability, cause });
        }

        return Object.freeze({ id, metadata });
      }

      await compensateWithoutId(lastRetryCause);
      throw new DocumentPublicationRetryLimitError({
        sourcePath,
        attempts: maxAttempts,
        cause: lastRetryCause,
        message: `Could not publish document from ${sourcePath}: exhausted ${maxAttempts} publication attempts.`,
      });
    } catch (cause) {
      if (
        cause instanceof DocumentPublicationError ||
        cause instanceof DocumentPublicationRetryLimitError
      ) {
        throw cause;
      }
      // Unexpected adapter errors get one compensation attempt for this call.
      await compensateWithoutId(cause);
      throw makePublicationError({ sourcePath, cause });
    }
  };

  const publish = (sourcePath: string, signal?: AbortSignal) =>
    Effect.tryPromise({
      try: (effectSignal) =>
        publishPromise(
          sourcePath,
          signal === undefined ? effectSignal : AbortSignal.any([effectSignal, signal])
        ),
      catch: (cause) =>
        cause instanceof DocumentPublicationError ||
        cause instanceof DocumentPublicationRetryLimitError
          ? cause
          : makePublicationError({ sourcePath, cause }),
    });

  return {
    publish,
    publishDocument: publish,
    readPublishedDocument: reader.readPublishedDocument,
    readPublishedDocumentLease: reader.readPublishedDocumentLease,
    inspectPublishedDocument: reader.inspectPublishedDocument,
    readPublishedDocumentEntryLease: reader.readPublishedDocumentEntryLease,
  };
};

export { defaultIsMetadataUniquenessCollision };
