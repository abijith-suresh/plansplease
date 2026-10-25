import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type {
  DocumentFileStore,
  DocumentFileStoreOptions,
  MetadataStore,
} from "../../dist/index.js";
import { openDocumentFileStore, openStorage } from "../../dist/index.js";

export type StorageTestEnvironment = Readonly<{
  readonly directory: string;
  readonly documentsDir: string;
  readonly stagingDir: string;
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
}>;

export type StorageTestStoreOptions = Omit<DocumentFileStoreOptions, "documentsDir" | "stagingDir">;

export const withStorageTestEnvironment = async <T,>(
  prefix: string,
  callback: (environment: StorageTestEnvironment) => T | PromiseLike<T>,
  storeOptions: StorageTestStoreOptions = {}
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const documentsDir = join(directory, "documents");
  const stagingDir = join(directory, "staging");
  let documentFileStore: DocumentFileStore | undefined;
  let metadataStore: MetadataStore | undefined;
  try {
    documentFileStore = Effect.runSync(
      openDocumentFileStore({ documentsDir, stagingDir, ...storeOptions })
    );
    metadataStore = Effect.runSync(openStorage(join(directory, "metadata.sqlite")));
    return await callback({
      directory,
      documentsDir,
      stagingDir,
      documentFileStore,
      metadataStore,
    });
  } finally {
    try {
      await documentFileStore?.close();
    } finally {
      try {
        metadataStore?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
};
