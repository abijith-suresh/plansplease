import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { DocumentId } from "@planview/core";
import { V1_STORAGE_METADATA_BYTES_PER_DOCUMENT, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Effect } from "effect";
import type {
  DocumentFileStore,
  DocumentMetadata,
  DocumentPublicationCoordinator,
  DocumentPublicationCoordinatorOptions,
  MetadataStore,
} from "../dist/index.js";
import {
  createDocumentPublicationCoordinator,
  createMetadataGatedDocumentReader,
  DocumentFileDeleteError,
  DocumentFileFinalizeError,
  DocumentPublicationError,
  DocumentPublicationNotFoundError,
  DocumentPublicationReadError,
  DocumentPublicationRetryLimitError,
  StorageQuotaExceededError,
} from "../dist/index.js";
import {
  type StorageTestEnvironment,
  type StorageTestStoreOptions,
  withStorageTestEnvironment,
} from "./support/storage-environment.mts";

const id = (character: string): DocumentId => character.repeat(21) as DocumentId;
const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const firstId = id("a");
const secondId = id("b");
const thirdId = id("c");

const idAt = (values: readonly DocumentId[], index: number): DocumentId => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Test ID index ${index} is out of range.`);
  }
  return value;
};

type CoordinatorOverrides = Partial<
  Omit<DocumentPublicationCoordinatorOptions, "documentFileStore" | "metadataStore">
>;

const withEnvironment = <T,>(
  callback: (environment: StorageTestEnvironment) => T | PromiseLike<T>,
  storeOptions: StorageTestStoreOptions = {}
): Promise<T> => withStorageTestEnvironment("planview-publication-", callback, storeOptions);

const coordinator = (
  documentFileStore: DocumentFileStore,
  metadataStore: MetadataStore,
  overrides: CoordinatorOverrides = {}
): DocumentPublicationCoordinator =>
  createDocumentPublicationCoordinator({
    documentFileStore,
    metadataStore,
    now: () => 1_700_000_000_000,
    generateId: () => secondId,
    ...overrides,
  });

const publicationFile = (documentsDir: string, documentId: string): string =>
  join(documentsDir, `${documentId}.html`);

test("rejects a publication at the fixed quota and compensates its finalized file", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      metadataStore.insertDocumentMetadata({
        id: firstId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
      });
      const source = join(directory, "over-quota.html");
      await writeFile(source, "x");

      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, metadataStore, { generateId: () => secondId }).publish(
            source
          )
        ),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.cause instanceof StorageQuotaExceededError &&
          /fixed 1 GiB limit/.test(error.cause.message)
      );
      await assert.rejects(readFile(publicationFile(documentsDir, secondId)), { code: "ENOENT" });
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("publishes one durable immutable result without changing source input", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      const original = Buffer.from("<p>snapshot</p>");
      await writeFile(source, original);

      const result = await runEffect(coordinator(documentFileStore, metadataStore).publish(source));

      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.metadata), true);
      assert.deepEqual(await readFile(source), original);
      assert.deepEqual(await readFile(publicationFile(documentsDir, result.id)), original);
      assert.deepEqual(metadataStore.getDocumentMetadata(result.id), result.metadata);
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("rechecks cancellation before the metadata publication commit", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "abort-before-commit.html");
      await writeFile(source, "abort before commit");
      const controller = new AbortController();
      const publication = coordinator(documentFileStore, metadataStore, {
        generateId: () => firstId,
        readPublishedSize: async () => {
          controller.abort(new Error("publication canceled"));
          return 18;
        },
      });

      await assert.rejects(
        runEffect(publication.publish(source, controller.signal)),
        (error) => error instanceof DocumentPublicationError
      );
      assert.equal(metadataStore.getDocumentMetadata(firstId), undefined);
      await assert.rejects(readFile(publicationFile(documentsDir, firstId)), { code: "ENOENT" });
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("standalone metadata-gated readers do not open uncommitted files", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore }) => {
    const source = join(directory, "standalone-reader.html");
    await writeFile(source, "not committed");
    const handle = await documentFileStore.stageSourceFile(source);
    await documentFileStore.finalizeStagedFile(handle, firstId);

    let fileOperations = 0;
    const instrumentedStore: DocumentFileStore = {
      ...documentFileStore,
      readDocumentLease: async (documentId) => {
        fileOperations += 1;
        return documentFileStore.readDocumentLease(documentId);
      },
      inspectDocumentFormat: async (documentId) => {
        fileOperations += 1;
        return documentFileStore.inspectDocumentFormat(documentId);
      },
      readDocumentEntryLease: async (documentId, path) => {
        fileOperations += 1;
        return documentFileStore.readDocumentEntryLease(documentId, path);
      },
    };
    const reader = createMetadataGatedDocumentReader({
      documentFileStore: instrumentedStore,
      metadataStore,
    });

    await assert.rejects(
      runEffect(reader.readPublishedDocument(firstId)),
      (error) => error instanceof DocumentPublicationNotFoundError
    );
    await assert.rejects(
      runEffect(reader.readPublishedDocumentLease(firstId)),
      (error) => error instanceof DocumentPublicationNotFoundError
    );
    await assert.rejects(
      runEffect(reader.inspectPublishedDocument(firstId)),
      (error) => error instanceof DocumentPublicationNotFoundError
    );
    await assert.rejects(
      runEffect(reader.readPublishedDocumentEntryLease(firstId, "index.html")),
      (error) => error instanceof DocumentPublicationNotFoundError
    );
    assert.equal(fileOperations, 0);
    metadataStore.insertDocumentMetadata({
      id: firstId,
      createdAt: 1,
      lastAccessedAt: 1,
      size: 13,
    });
    const stream = await runEffect(reader.readPublishedDocument(firstId));
    assert.equal((await stream.toArray()).toString(), "not committed");
  }));

test("metadata-gated reads fail closed when metadata lookup is ambiguous", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore }) => {
    const source = join(directory, "metadata-read-fault.html");
    await writeFile(source, "metadata read fault");
    const reader = coordinator(documentFileStore, {
      ...metadataStore,
      getDocumentMetadata: () => {
        throw new Error("metadata lookup fault");
      },
    });

    await assert.rejects(
      runEffect(reader.readPublishedDocument(firstId)),
      (error) => error instanceof DocumentPublicationReadError
    );
  }));

test("keeps a staged snapshot across file collisions even when input is deleted or mutated", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      await writeFile(source, "original");
      await writeFile(publicationFile(documentsDir, firstId), "pre-existing");

      let generated = 0;
      const wrappedStore: DocumentFileStore = {
        ...documentFileStore,
        stageSourceFile: async (sourcePath: string) => {
          const handle = await documentFileStore.stageSourceFile(sourcePath);
          await writeFile(sourcePath, "mutated after staging");
          await rm(sourcePath);
          return handle;
        },
      };
      const result = await runEffect(
        coordinator(wrappedStore, metadataStore, {
          generateId: () => idAt([firstId, secondId], generated++),
        }).publish(source)
      );

      assert.equal(result.id, secondId);
      assert.equal(
        (await readFile(publicationFile(documentsDir, secondId))).toString(),
        "original"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("commit does not treat matching metadata fields as ownership after a unique error", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "ambiguous-commit.html");
      await writeFile(source, "committed despite throw");
      let generated = 0;
      const throwingMetadata: MetadataStore = {
        ...metadataStore,
        insertDocumentMetadata: (metadata: DocumentMetadata) => {
          metadataStore.insertDocumentMetadata(metadata);
          const error = Object.assign(new Error("unique after commit"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
          throw error;
        },
      };

      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, throwingMetadata, {
            generateId: () => idAt([firstId, secondId], generated++),
          }).publish(source)
        ),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.orphan?.kind === "document-file-and-metadata-row" &&
          error.orphan.resources.metadataRows[0]?.state === "unknown"
      );
      assert.equal(generated, 1);
      assert.notEqual(metadataStore.getDocumentMetadata(firstId), undefined);
      assert.equal(
        (await readFile(publicationFile(documentsDir, firstId))).toString(),
        "committed despite throw"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("commit retains an ambiguous unique publication pair instead of silently retrying", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "ambiguous-unique.html");
      await writeFile(source, "possibly committed");
      let generated = 0;
      let metadataLookups = 0;
      const ambiguousMetadata: MetadataStore = {
        ...metadataStore,
        insertDocumentMetadata: () => {
          const error = Object.assign(new Error("unique boundary failed"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
          throw error;
        },
        getDocumentMetadata: () => {
          if (metadataLookups++ === 0) {
            return undefined;
          }
          throw new Error("metadata read boundary failed");
        },
      };

      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, ambiguousMetadata, {
            generateId: () => idAt([firstId, secondId], generated++),
          }).publish(source)
        ),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.orphan?.kind === "document-file-and-metadata-row" &&
          error.orphan.resources.metadataRows[0]?.state === "unknown" &&
          error.orphan.resources.documentFiles[0]?.id === firstId
      );
      assert.equal(generated, 1);
      assert.equal(
        (await readFile(publicationFile(documentsDir, firstId))).toString(),
        "possibly committed"
      );
      assert.equal((await readdir(stagingDir)).length, 0);
    }
  ));

test("commit retries a unique error only after metadata proves the id is absent", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore, stagingDir }) => {
    const source = join(directory, "absent-after-unique.html");
    await writeFile(source, "retry after proof");
    let generated = 0;
    const throwingMetadata: MetadataStore = {
      ...metadataStore,
      insertDocumentMetadata: (metadata: DocumentMetadata) => {
        if (metadata.id === firstId) {
          const error = Object.assign(new Error("rolled back unique boundary"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
          throw error;
        }
        metadataStore.insertDocumentMetadata(metadata);
      },
    };
    const result = await runEffect(
      coordinator(documentFileStore, throwingMetadata, {
        generateId: () => idAt([firstId, secondId], generated++),
      }).publish(source)
    );
    assert.equal(result.id, secondId);
    assert.equal(generated, 2);
    assert.deepEqual(await readdir(stagingDir), []);
  }));

test("an adapter without the commit callback still retries a rolled-back metadata collision", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore, stagingDir }) => {
    const source = join(directory, "absent-after-unique.html");
    await writeFile(source, "retry after proof");
    let generated = 0;
    const throwingMetadata: MetadataStore = {
      ...metadataStore,
      insertDocumentMetadata: (metadata: DocumentMetadata) => {
        if (metadata.id === firstId) {
          const error = Object.assign(new Error("rolled back unique boundary"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          });
          throw error;
        }
        metadataStore.insertDocumentMetadata(metadata);
      },
    };
    const result = await runEffect(
      coordinator(
        {
          ...documentFileStore,
          finalizeStagedFile: (handle, documentId) =>
            documentFileStore.finalizeStagedFile(handle, documentId),
        },
        throwingMetadata,
        {
          generateId: () => idAt([firstId, secondId], generated++),
        }
      ).publish(source)
    );
    assert.equal(result.id, secondId);
    assert.equal(generated, 2);
    assert.deepEqual(await readdir(stagingDir), []);
  }));

test("commit bounds metadata collision retries and removes owned artifacts", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "metadata-retry-limit.html");
      await writeFile(source, "never committed");
      const cause = Object.assign(new Error("unique metadata boundary"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
      const throwingMetadata: MetadataStore = {
        ...metadataStore,
        insertDocumentMetadata: () => {
          throw cause;
        },
      };
      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, throwingMetadata, {
            generateId: () => firstId,
            maxAttempts: 2,
          }).publish(source)
        ),
        (error) =>
          error instanceof DocumentPublicationRetryLimitError &&
          error.attempts === 2 &&
          error.cause === cause
      );
      assert.deepEqual(await readdir(documentsDir), []);
      assert.deepEqual(await readdir(stagingDir), []);
      assert.equal(metadataStore.getDocumentMetadata(firstId), undefined);
    }
  ));

test("retries file and SQLite metadata uniqueness collisions without exposing partial state", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      await writeFile(source, "retry me");
      await writeFile(publicationFile(documentsDir, firstId), "file collision");
      metadataStore.insertDocumentMetadata({
        id: thirdId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });

      let generated = 0;
      const result = await runEffect(
        coordinator(documentFileStore, metadataStore, {
          generateId: () => idAt([firstId, thirdId, secondId], generated++),
        }).publish(source)
      );

      assert.equal(result.id, secondId);
      assert.equal(metadataStore.getDocumentMetadata(firstId), undefined);
      assert.deepEqual(metadataStore.getDocumentMetadata(thirdId), {
        id: thirdId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("retains anonymous staged recovery state when stage fails after creating an artifact", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, stagingDir }) => {
    const source = join(stagingDir, "../stage-adapter-fault.html");
    await writeFile(source, "hidden staged artifact");
    const adapter: DocumentFileStore = {
      ...documentFileStore,
      stageSourceFile: async (sourcePath) => {
        await documentFileStore.stageSourceFile(sourcePath);
        throw new Error("stage adapter failed after creating its artifact");
      },
    };

    await assert.rejects(
      runEffect(coordinator(adapter, metadataStore, { generateId: () => firstId }).publish(source)),
      (error) =>
        error instanceof DocumentPublicationError &&
        error.orphan?.kind === "staged-file" &&
        error.orphan.resources.stagedFiles.some(
          (resource) => resource.handle === undefined && resource.state === "unknown"
        )
    );
    assert.equal((await readdir(stagingDir)).length > 0, true);
  }));

test("reports and compensates clone, finalization, and metadata failures", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      await writeFile(source, "failure boundary");

      const failures = [
        {
          name: "snapshot clone",
          store: {
            ...documentFileStore,
            cloneStagedFile: async () => {
              throw new Error("clone fault");
            },
          },
        },
        {
          name: "finalization",
          store: {
            ...documentFileStore,
            finalizeStagedFile: async () => {
              throw new Error("finalization fault");
            },
          },
        },
        {
          name: "metadata",
          metadata: {
            ...metadataStore,
            insertDocumentMetadata: () => {
              throw new Error("database fault");
            },
          },
        },
      ];

      let residualStaging = 0;
      for (const [index, failure] of failures.entries()) {
        const documentId = id(String.fromCharCode(100 + index));
        const store = failure.store ?? documentFileStore;
        const metadata = failure.metadata ?? metadataStore;
        await assert.rejects(
          runEffect(
            coordinator(store, metadata, {
              generateId: () => documentId,
            }).publish(source)
          ),
          (error) =>
            error instanceof DocumentPublicationError &&
            (failure.name !== "snapshot clone" ||
              (error.orphan?.resources.stagedFiles.some(
                (resource) => resource.handle === undefined && resource.state === "unknown"
              ) &&
                error.orphan.resources.finalizationLocks.some(
                  (resource) => resource.handle === undefined && resource.state === "unknown"
                ))) &&
            (failure.name !== "finalization" ||
              (error.orphan?.resources.documentFiles[0]?.state === "unknown" &&
                error.orphan.resources.finalizationLocks.some(
                  (resource) => resource.id === documentId && resource.state === "unknown"
                )))
        );
        assert.equal(metadataStore.getDocumentMetadata(documentId), undefined, failure.name);
        await assert.rejects(readFile(publicationFile(documentsDir, documentId)), {
          code: "ENOENT",
        });
        const stagingEntries = await readdir(stagingDir);
        if (failure.name === "finalization") {
          residualStaging = stagingEntries.length;
          assert.equal(residualStaging > 0, true, failure.name);
        } else {
          assert.equal(stagingEntries.length, residualStaging, failure.name);
        }
      }
    }
  ));

test("preserves a durable target after post-publication staging fsync failure", () =>
  withEnvironment(
    async ({ documentFileStore, metadataStore, documentsDir }) => {
      const source = join(documentsDir, "../post-publication-sync.html");
      await writeFile(source, "durable before staging sync");

      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, metadataStore, { generateId: () => firstId }).publish(
            source
          )
        ),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.cause instanceof DocumentFileFinalizeError &&
          error.cause.targetRecoveryPolicy === "retain" &&
          error.cause.targetState === "retained" &&
          error.cause.targetLockState === "unknown" &&
          error.cause.stagedFileState === "unknown" &&
          error.cause.finalizationLockState === "unknown" &&
          error.orphan?.resources.documentFiles[0]?.state === "retained" &&
          error.orphan.resources.finalizationLocks.some(
            (resource) => resource.id === firstId && resource.state === "unknown"
          ) &&
          error.orphan.resources.finalizationLocks.some(
            (resource) => resource.handle !== undefined && resource.state === "unknown"
          )
      );
      assert.equal(
        (await readFile(publicationFile(documentsDir, firstId))).toString(),
        "durable before staging sync"
      );
      assert.equal(metadataStore.getDocumentMetadata(firstId), undefined);
    },
    {
      beforePostPublicationStagingDirectorySync: async () => {
        throw new Error("post-publication staging fsync failed");
      },
    }
  ));

test("propagates typed target and lock cleanup states into recovery", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore, documentsDir }) => {
    const source = join(directory, "typed-delete-state.html");
    await writeFile(source, "typed delete state");
    const failingDeleteStore = {
      ...documentFileStore,
      deleteDocumentFile: async () => {
        throw new DocumentFileDeleteError({
          id: firstId,
          targetState: "retained",
          targetLockState: "unknown",
          cause: new Error("target delete boundary"),
          message: "target and lock state are partial",
        });
      },
    };

    await assert.rejects(
      runEffect(
        coordinator(failingDeleteStore, metadataStore, {
          generateId: () => firstId,
          readPublishedSize: async () => {
            throw new Error("publication failed after finalization");
          },
        }).publish(source)
      ),
      (error) =>
        error instanceof DocumentPublicationError &&
        error.orphan?.resources.documentFiles[0]?.state === "retained" &&
        error.orphan.resources.finalizationLocks.some(
          (resource) => resource.id === firstId && resource.state === "unknown"
        )
    );
    assert.equal(
      (await readFile(publicationFile(documentsDir, firstId))).toString(),
      "typed delete state"
    );
  }));

test("out-of-model hostile external target replacement survives delayed compensation", () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore, documentsDir }) => {
    const source = join(directory, "delayed-target-compensation.html");
    await writeFile(source, "original target owner");
    const target = publicationFile(documentsDir, firstId);
    let replaced = false;
    const racingStore: DocumentFileStore = {
      ...documentFileStore,
      deleteDocumentFile: async (documentId, capability) => {
        if (!replaced) {
          replaced = true;
          renameSync(target, `${target}.original-owner`);
          await writeFile(target, "concurrent target owner");
        }
        return documentFileStore.deleteDocumentFile(documentId, capability);
      },
    };

    await assert.rejects(
      runEffect(
        coordinator(racingStore, metadataStore, {
          generateId: () => firstId,
          readPublishedSize: async () => {
            throw new Error("publication failed after finalization");
          },
        }).publish(source)
      ),
      (error) =>
        error instanceof DocumentPublicationError &&
        error.orphan?.resources.documentFiles[0]?.state === "unknown"
    );
    assert.equal(await readFile(target, "utf8"), "concurrent target owner");
    assert.equal(await readFile(`${target}.original-owner`, "utf8"), "original target owner");
  }));

test("reports a recoverable orphan when staging compensation fails", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      await writeFile(source, "orphan staging");
      const failingDiscardStore: DocumentFileStore = {
        ...documentFileStore,
        discardStagedFile: async () => {
          throw new Error("discard fault");
        },
      };

      await assert.rejects(
        runEffect(
          coordinator(failingDiscardStore, metadataStore, {
            generateId: () => firstId,
            readPublishedSize: async () => {
              throw new Error("read fault");
            },
          }).publish(source)
        ),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.orphan?.kind === "staged-file" &&
          error.cleanupCause instanceof Error
      );
      assert.equal((await readdir(stagingDir)).length > 0, true);
      await assert.rejects(readFile(publicationFile(documentsDir, firstId)), { code: "ENOENT" });
    }
  ));

test("does not report success when cleanup rolls back a committed publication", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "rollback-cleanup.html");
      await writeFile(source, "rollback cleanup");
      let firstDiscard = true;
      const store: DocumentFileStore = {
        ...documentFileStore,
        discardStagedFile: async (handle) => {
          if (firstDiscard) {
            firstDiscard = false;
            throw new Error("one-shot cleanup fault");
          }
          return documentFileStore.discardStagedFile(handle);
        },
      };

      await assert.rejects(
        runEffect(coordinator(store, metadataStore, { generateId: () => firstId }).publish(source)),
        (error) =>
          error instanceof DocumentPublicationError &&
          error.orphan?.kind === "staged-file" &&
          error.orphan.resources.stagedFiles[0]?.state === "unknown"
      );
      assert.equal(metadataStore.getDocumentMetadata(firstId), undefined);
      await assert.rejects(readFile(publicationFile(documentsDir, firstId)), { code: "ENOENT" });
      assert.equal((await readdir(stagingDir)).length > 0, true);
    }
  ));

test("bounds repeated collisions and leaves no staged state", () =>
  withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const source = join(directory, "input.html");
      await writeFile(source, "never published");
      await writeFile(publicationFile(documentsDir, firstId), "occupied");

      await assert.rejects(
        runEffect(
          coordinator(documentFileStore, metadataStore, {
            generateId: () => firstId,
            maxAttempts: 2,
          }).publish(source)
        ),
        (error) => error instanceof DocumentPublicationRetryLimitError && error.attempts === 2
      );
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("concurrent Planview publications keep compensation invocation-local", async () =>
  withEnvironment(async ({ directory, documentFileStore, metadataStore, documentsDir }) => {
    const firstSource = join(directory, "first-fault.html");
    const secondSource = join(directory, "second-survivor.html");
    await writeFile(firstSource, "first fault");
    await writeFile(secondSource, "second survives");

    let firstStagedResolve!: () => void;
    const firstStaged = new Promise<void>((resolve) => {
      firstStagedResolve = resolve;
    });
    let firstCloneResolve!: () => void;
    const firstCloneDone = new Promise<void>((resolve) => {
      firstCloneResolve = resolve;
    });
    let secondCloneEnteredResolve!: () => void;
    const secondCloneEntered = new Promise<void>((resolve) => {
      secondCloneEnteredResolve = resolve;
    });
    let releaseSecondClone!: () => void;
    const secondCloneRelease = new Promise<void>((resolve) => {
      releaseSecondClone = resolve;
    });
    let cloneCalls = 0;
    let generated = 0;
    const store: DocumentFileStore = {
      ...documentFileStore,
      stageSourceFile: async (sourcePath) => {
        const handle = await documentFileStore.stageSourceFile(sourcePath);
        if (sourcePath === firstSource) {
          firstStagedResolve();
        }
        return handle;
      },
      cloneStagedFile: async (handle) => {
        cloneCalls += 1;
        if (cloneCalls === 1) {
          const cloned = await documentFileStore.cloneStagedFile(handle);
          firstCloneResolve();
          return cloned;
        }
        secondCloneEnteredResolve();
        await secondCloneRelease;
        return documentFileStore.cloneStagedFile(handle);
      },
      finalizeStagedFile: async (handle, documentId) => {
        if (documentId === firstId) {
          await secondCloneEntered;
          throw new Error("first invocation finalization fault");
        }
        return documentFileStore.finalizeStagedFile(handle, documentId);
      },
    };
    const publication = coordinator(store, metadataStore, {
      generateId: () => idAt([firstId, secondId], generated++),
    });

    const first = runEffect(publication.publish(firstSource));
    await firstStaged;
    await firstCloneDone;
    const second = runEffect(publication.publish(secondSource));
    await secondCloneEntered;
    await assert.rejects(
      first,
      (error) =>
        error instanceof DocumentPublicationError &&
        error.orphan?.resources.stagedFiles[0]?.handle !== undefined
    );
    releaseSecondClone();
    const result = await second;
    assert.equal(result.id, secondId);
    assert.equal(
      (await readFile(publicationFile(documentsDir, secondId))).toString(),
      "second survives"
    );
  }));

test("retries a live target-lock collision instead of retaining the peer lock as an orphan", () => {
  let targetLockEnteredResolve!: () => void;
  const targetLockEntered = new Promise<void>((resolve) => {
    targetLockEnteredResolve = resolve;
  });
  let holdWinnerTargetLock = true;

  return withEnvironment(
    async ({ directory, documentFileStore, metadataStore, documentsDir, stagingDir }) => {
      const firstSource = join(directory, "target-lock-winner.html");
      const secondSource = join(directory, "target-lock-collision.html");
      await writeFile(firstSource, "winner holds target lock");
      await writeFile(secondSource, "collision retries");

      let winnerGenerated = 0;
      let contenderGenerated = 0;
      const winner = coordinator(documentFileStore, metadataStore, {
        generateId: () => idAt([firstId, thirdId], winnerGenerated++),
      });
      const contender = coordinator(documentFileStore, metadataStore, {
        generateId: () => idAt([firstId, secondId], contenderGenerated++),
      });

      const winnerPublication = runEffect(winner.publish(firstSource));
      await targetLockEntered;
      const contenderPublication = runEffect(contender.publish(secondSource));
      const [winnerResult, contenderResult] = await Promise.all([
        winnerPublication,
        contenderPublication,
      ]);

      assert.equal(winnerResult.id, firstId);
      assert.equal(contenderResult.id, secondId);
      assert.equal(metadataStore.getDocumentAggregate().count, 2);
      assert.deepEqual(await readdir(stagingDir), []);
      assert.equal(
        (await readFile(publicationFile(documentsDir, firstId))).toString(),
        "winner holds target lock"
      );
      assert.equal(
        (await readFile(publicationFile(documentsDir, secondId))).toString(),
        "collision retries"
      );
    },
    {
      beforeFinalizationTargetInspection: async () => {
        if (!holdWinnerTargetLock) {
          return;
        }
        holdWinnerTargetLock = false;
        targetLockEnteredResolve();
        // Deliberately exceed the historical 32ms target-lock wait. The
        // contender must classify this as a retryable collision, not own the
        // winner's lock in its recovery report.
        await new Promise<void>((resolve) => setTimeout(resolve, 64));
      },
    }
  );
});
