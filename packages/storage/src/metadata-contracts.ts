import type { ShareAttempt, ShareScope } from "./sharing.js";
import { Data } from "effect";

export type DocumentMetadata = {
  readonly id: string;
  readonly createdAt: number;
  readonly lastAccessedAt: number;
  readonly size: number;
};

export type DocumentAggregate = {
  readonly count: number;
  readonly size: number;
};

export type DocumentStorageUsage = Readonly<{
  /** Published HTML bytes plus the fixed metadata charge per document. */
  readonly bytes: number;
  readonly documentBytes: number;
  readonly metadataBytes: number;
  readonly documentCount: number;
}>;

export class StorageQuotaExceededError extends Data.TaggedError("StorageQuotaExceededError")<{
  readonly currentBytes: number;
  readonly requestedBytes: number;
  readonly quotaBytes: number;
  readonly message: string;
}> {}

export type DocumentMetadataSnapshot = Readonly<
  DocumentMetadata & {
    /** Immutable token for conditional cleanup deletion. */
    readonly generation: string;
    readonly pinned: boolean;
  }
>;

export type DocumentMetadataMatch = DocumentMetadataSnapshot;

export type DocumentMetadataAccessCursor = Readonly<{
  readonly lastAccessedAt: number;
  readonly id: string;
}>;

export type DocumentMetadataPage = Readonly<{
  readonly rows: readonly DocumentMetadataSnapshot[];
  readonly hasMore: boolean;
}>;

export class StoragePathError extends Data.TaggedError("StoragePathError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class StorageOpenError extends Data.TaggedError("StorageOpenError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class StorageMigrationError extends Data.TaggedError("StorageMigrationError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class StorageClosedError extends Data.TaggedError("StorageClosedError")<{
  readonly message: string;
}> {}

export class StorageInvariantError extends Data.TaggedError("StorageInvariantError")<{
  readonly field: string;
  readonly message: string;
}> {}

export interface MetadataStore {
  /** Conditional generation mutation; never updates the access clock. */
  readonly setDocumentPinned: (
    selection: { id: string; generation: string },
    pinned: boolean
  ) => "updated" | "not_found" | "stale";
  readonly getPinnedStorageUsage: () => { pinnedBytes: number; pinnedCount: number };
  readonly getShareAttempt: (key: string) => ShareAttempt | undefined;
  readonly latestShareAttempt: (scope: ShareScope) => ShareAttempt | undefined;
  readonly listShareAttempts: (id: string) => {
    attempts: readonly ShareAttempt[];
    hasMore: boolean;
  };
  readonly insertShareAttempt: (attempt: ShareAttempt) => void;
  readonly recordShareReceipt: (key: string, receipt: unknown) => ShareAttempt;
  readonly close: () => void;
  readonly insertDocumentMetadata: (metadata: DocumentMetadata) => void;
  readonly getDocumentMetadata: (id: string) => DocumentMetadata | undefined;
  readonly getDocumentMetadataSnapshot: (id: string) => DocumentMetadataSnapshot | undefined;
  readonly listDocumentMetadata: () => readonly DocumentMetadata[];
  /** The rowid high-water mark for a mutation-safe metadata pass. */
  readonly getDocumentMetadataScanWatermark: () => number;
  /** Returns a bounded, access-ordered page for retention cleanup. */
  readonly listDocumentMetadataCandidates: (
    cutoff: number,
    limit: number,
    after?: DocumentMetadataAccessCursor,
    watermark?: number
  ) => DocumentMetadataPage;
  /** Returns a bounded id-ordered page for reconciliation. */
  readonly listDocumentMetadataPage: (
    limit: number,
    afterId?: string,
    watermark?: number
  ) => DocumentMetadataPage;
  readonly recordDocumentAccess: (id: string, accessedAt?: number) => boolean;
  readonly getDocumentAggregate: () => DocumentAggregate;
  readonly getDocumentStorageUsage: () => DocumentStorageUsage;
  readonly deleteDocument: (id: string) => boolean;
  /** Automatic expiry deletion, fenced against current pins and refreshed access. */
  readonly deleteDocumentIfLastAccessedBefore: (
    candidate: string | DocumentMetadataSnapshot,
    cutoff: number
  ) => DocumentMetadata | undefined;
  /** Deletes only when fields/generation match. Automatic recovery also refuses current pins. */
  readonly deleteDocumentIfMatches: (
    metadata: DocumentMetadataMatch,
    automatic?: boolean
  ) => boolean;
}
