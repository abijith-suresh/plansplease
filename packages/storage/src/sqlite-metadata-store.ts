import {
  matchCloudUploadReceipt,
  parseCloudUploadReceipt,
  uploadOperationKey,
} from "@planview/core";
import {
  MAX_SHARE_ATTEMPTS,
  SHARE_INSPECTION_LIMIT,
  parseShareAttempt,
  validateShareScope,
  type ShareAttempt,
  type ShareScope,
} from "./sharing.js";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { V1_STORAGE_METADATA_BYTES_PER_DOCUMENT, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Effect } from "effect";
import { inTransaction, readInteger, readText, rowValue } from "./sqlite-primitives.js";
import { CURRENT_SCHEMA_VERSION, GENERATION_TABLE_NAME, migrate } from "./sqlite-schema.js";
import {
  type DocumentMetadata,
  type DocumentMetadataAccessCursor,
  type DocumentMetadataMatch,
  type DocumentMetadataPage,
  type DocumentMetadataSnapshot,
  type DocumentStorageUsage,
  type MetadataStore,
  StorageClosedError,
  StorageInvariantError,
  StorageMigrationError,
  StorageOpenError,
  StoragePathError,
  StorageQuotaExceededError,
} from "./metadata-contracts.js";

const MEMORY_DATABASE_PATH = ":memory:";

const isStorageError = (error: unknown) =>
  error instanceof StoragePathError ||
  error instanceof StorageOpenError ||
  error instanceof StorageMigrationError;

const validateDatabasePath = (path: string) => {
  if (typeof path !== "string" || path.length === 0) {
    throw new StoragePathError({
      path,
      reason: "The SQLite database path must be a non-empty string.",
      message:
        "Could not open SQLite metadata storage: the database path must be a non-empty string.",
    });
  }

  if (path !== MEMORY_DATABASE_PATH && !isAbsolute(path)) {
    throw new StoragePathError({
      path,
      reason: "The SQLite database path must be absolute.",
      message: `Could not open SQLite metadata storage at ${path}: the database path must be absolute.`,
    });
  }
};

const formatBytes = (bytes: number) => {
  if (bytes % (1024 * 1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024 * 1024)} GiB`;
  }
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)} MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
};

const validateId = (id: unknown) => {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new StorageInvariantError({
      field: "id",
      message: "Document id must be a non-empty string.",
    });
  }

  return id;
};

const validateNonNegativeInteger = (value: unknown, field: string) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageInvariantError({
      field,
      message: `${field} must be a non-negative safe integer epoch value.`,
    });
  }

  return value;
};

const validatePageLimit = (value: unknown) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw new StorageInvariantError({
      field: "limit",
      message: "limit must be a positive safe integer smaller than Number.MAX_SAFE_INTEGER.",
    });
  }

  return value;
};

const validateGeneration = (generation: unknown) => {
  if (typeof generation !== "string" || generation.length === 0) {
    throw new StorageInvariantError({
      field: "generation",
      message: "Document metadata generation must be a non-empty string.",
    });
  }

  return generation;
};

const storageUsageFor = (documentBytes: number, documentCount: number) => {
  const metadataBytes =
    documentCount >=
    Math.ceil((V1_STORAGE_QUOTA_BYTES + 1) / V1_STORAGE_METADATA_BYTES_PER_DOCUMENT)
      ? V1_STORAGE_QUOTA_BYTES + 1
      : documentCount * V1_STORAGE_METADATA_BYTES_PER_DOCUMENT;
  const bytes =
    documentBytes >= V1_STORAGE_QUOTA_BYTES + 1 - metadataBytes
      ? V1_STORAGE_QUOTA_BYTES + 1
      : documentBytes + metadataBytes;
  return {
    bytes,
    documentBytes,
    metadataBytes,
    documentCount,
  } satisfies DocumentStorageUsage;
};

const quotaChargeFor = (documentBytes: number) =>
  documentBytes > V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT
    ? V1_STORAGE_QUOTA_BYTES + 1
    : documentBytes + V1_STORAGE_METADATA_BYTES_PER_DOCUMENT;

const validateMetadata = (metadata: DocumentMetadata) => {
  if (metadata === null || typeof metadata !== "object") {
    throw new StorageInvariantError({
      field: "metadata",
      message: "Document metadata must be an object.",
    });
  }

  const normalized = {
    id: validateId(metadata.id),
    createdAt: validateNonNegativeInteger(metadata.createdAt, "createdAt"),
    lastAccessedAt: validateNonNegativeInteger(metadata.lastAccessedAt, "lastAccessedAt"),
    size: validateNonNegativeInteger(metadata.size, "size"),
  };

  if (normalized.lastAccessedAt < normalized.createdAt) {
    throw new StorageInvariantError({
      field: "lastAccessedAt",
      message: "lastAccessedAt must not be earlier than createdAt.",
    });
  }

  return normalized;
};

const documentFromRow = (row: Record<string, unknown>) => ({
  id: readText(rowValue(row, "id"), "id"),
  createdAt: readInteger(rowValue(row, "createdAt"), "createdAt"),
  lastAccessedAt: readInteger(rowValue(row, "lastAccessedAt"), "lastAccessedAt"),
  size: readInteger(rowValue(row, "size"), "size"),
});

const documentSnapshotFromRow = (row: Record<string, unknown>) => ({
  ...documentFromRow(row),
  generation: validateGeneration(rowValue(row, "generation")),
});

const createStore = (database: DatabaseSync): MetadataStore => {
  let closed = false;

  const ensureOpen = () => {
    if (closed || !database.isOpen) {
      throw new StorageClosedError({ message: "SQLite metadata storage is closed." });
    }
  };

  const close = () => {
    if (!closed) {
      database.close();
      closed = true;
    }
  };

  const insertDocumentMetadata = (metadata: DocumentMetadata) => {
    ensureOpen();
    const normalized = validateMetadata(metadata);
    inTransaction(database, () => {
      // Check an existing id first so a normal uniqueness error keeps its
      // precedence over quota admission. BEGIN IMMEDIATE makes the usage
      // observation and both metadata writes one serialized decision across
      // cooperating storage instances and processes.
      const existing = database
        .prepare("SELECT id FROM documents WHERE id = :id")
        .get({ ":id": normalized.id });
      if (existing !== undefined) {
        database
          .prepare(
            `INSERT INTO documents (id, createdAt, lastAccessedAt, size)
             VALUES (:id, :createdAt, :lastAccessedAt, :size)`
          )
          .run({
            ":id": normalized.id,
            ":createdAt": normalized.createdAt,
            ":lastAccessedAt": normalized.lastAccessedAt,
            ":size": normalized.size,
          });
        return;
      }

      const aggregate = database
        .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM documents")
        .get();
      const current = storageUsageFor(
        readInteger(aggregate === undefined ? undefined : rowValue(aggregate, "size"), "size"),
        readInteger(aggregate === undefined ? undefined : rowValue(aggregate, "count"), "count")
      );
      const requestedBytes = quotaChargeFor(normalized.size);
      if (current.bytes + requestedBytes > V1_STORAGE_QUOTA_BYTES) {
        throw new StorageQuotaExceededError({
          currentBytes: current.bytes,
          requestedBytes,
          quotaBytes: V1_STORAGE_QUOTA_BYTES,
          message: `plansplease storage quota exceeded: this publication needs ${formatBytes(requestedBytes)} but only ${formatBytes(Math.max(0, V1_STORAGE_QUOTA_BYTES - current.bytes))} remains of the fixed ${formatBytes(V1_STORAGE_QUOTA_BYTES)} limit. Run plansplease clean to remove expired snapshots, then try again.`,
        });
      }

      database
        .prepare(
          `INSERT INTO documents (id, createdAt, lastAccessedAt, size)
           VALUES (:id, :createdAt, :lastAccessedAt, :size)`
        )
        .run({
          ":id": normalized.id,
          ":createdAt": normalized.createdAt,
          ":lastAccessedAt": normalized.lastAccessedAt,
          ":size": normalized.size,
        });
      database
        .prepare(
          `INSERT INTO ${GENERATION_TABLE_NAME} (id, generation)
           VALUES (:id, :generation)
           ON CONFLICT(id) DO UPDATE SET generation = excluded.generation`
        )
        .run({ ":id": normalized.id, ":generation": randomUUID() });
    });
  };

  const getDocumentMetadata = (id: string) => {
    ensureOpen();
    const row = database
      .prepare("SELECT id, createdAt, lastAccessedAt, size FROM documents WHERE id = :id")
      .get({ ":id": validateId(id) });
    return row === undefined ? undefined : documentFromRow(row);
  };

  const listDocumentMetadata = () => {
    ensureOpen();
    return database
      .prepare(
        "SELECT id, createdAt, lastAccessedAt, size FROM documents ORDER BY lastAccessedAt ASC, id COLLATE BINARY ASC"
      )
      .all()
      .map(documentFromRow);
  };

  const getDocumentMetadataScanWatermark = () => {
    ensureOpen();
    const row = database
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS watermark FROM documents")
      .get();
    return readInteger(row === undefined ? undefined : rowValue(row, "watermark"), "watermark");
  };

  const listDocumentMetadataCandidates = (
    cutoff: number,
    limit: number,
    after?: DocumentMetadataAccessCursor,
    watermark?: number
  ) => {
    ensureOpen();
    const normalizedCutoff = validateNonNegativeInteger(cutoff, "cutoff");
    const normalizedLimit = validatePageLimit(limit);
    const normalizedWatermark =
      watermark === undefined ? undefined : validateNonNegativeInteger(watermark, "watermark");
    const cursor =
      after === undefined
        ? undefined
        : {
            lastAccessedAt: validateNonNegativeInteger(
              after.lastAccessedAt,
              "lastAccessedAt cursor"
            ),
            id: validateId(after.id),
          };
    const cursorClause =
      cursor === undefined
        ? ""
        : " AND (d.lastAccessedAt > :afterLastAccessedAt OR (d.lastAccessedAt = :afterLastAccessedAt AND d.id COLLATE BINARY > :afterId))";
    const watermarkClause = normalizedWatermark === undefined ? "" : " AND d.rowid <= :watermark";
    const rows = database
      .prepare(
        `SELECT d.id, d.createdAt, d.lastAccessedAt, d.size, g.generation
         FROM documents AS d
         JOIN ${GENERATION_TABLE_NAME} AS g ON g.id = d.id
         WHERE d.lastAccessedAt < :cutoff${watermarkClause}${cursorClause}
         ORDER BY d.lastAccessedAt ASC, d.id COLLATE BINARY ASC
         LIMIT :limit`
      )
      .all({
        ":cutoff": normalizedCutoff,
        ":limit": normalizedLimit + 1,
        ...(normalizedWatermark === undefined ? {} : { ":watermark": normalizedWatermark }),
        ...(cursor === undefined
          ? {}
          : {
              ":afterLastAccessedAt": cursor.lastAccessedAt,
              ":afterId": cursor.id,
            }),
      })
      .map(documentSnapshotFromRow);
    const hasMore = rows.length > normalizedLimit;
    return {
      rows: hasMore ? rows.slice(0, normalizedLimit) : rows,
      hasMore,
    } satisfies DocumentMetadataPage;
  };

  const getDocumentMetadataSnapshot = (id: string) => {
    ensureOpen();
    const row = database
      .prepare(
        `SELECT d.id, d.createdAt, d.lastAccessedAt, d.size, g.generation
       FROM documents AS d JOIN ${GENERATION_TABLE_NAME} AS g ON g.id = d.id
       WHERE d.id = :id`
      )
      .get({ ":id": validateId(id) });
    return row === undefined ? undefined : documentSnapshotFromRow(row);
  };

  const listDocumentMetadataPage = (limit: number, afterId?: string, watermark?: number) => {
    ensureOpen();
    const normalizedLimit = validatePageLimit(limit);
    const cursor = afterId === undefined ? undefined : validateId(afterId);
    const normalizedWatermark =
      watermark === undefined ? undefined : validateNonNegativeInteger(watermark, "watermark");
    const watermarkClause = normalizedWatermark === undefined ? "" : "WHERE d.rowid <= :watermark";
    const cursorClause =
      cursor === undefined
        ? ""
        : `${watermarkClause === "" ? "WHERE" : " AND"} d.id COLLATE BINARY > :afterId`;
    const rows = database
      .prepare(
        `SELECT d.id, d.createdAt, d.lastAccessedAt, d.size, g.generation
         FROM documents AS d
         JOIN ${GENERATION_TABLE_NAME} AS g ON g.id = d.id
         ${watermarkClause}${cursorClause}
         ORDER BY d.id COLLATE BINARY ASC
         LIMIT :limit`
      )
      .all({
        ":limit": normalizedLimit + 1,
        ...(normalizedWatermark === undefined ? {} : { ":watermark": normalizedWatermark }),
        ...(cursor === undefined ? {} : { ":afterId": cursor }),
      })
      .map(documentSnapshotFromRow);
    const hasMore = rows.length > normalizedLimit;
    return {
      rows: hasMore ? rows.slice(0, normalizedLimit) : rows,
      hasMore,
    } satisfies DocumentMetadataPage;
  };

  const recordDocumentAccess = (id: string, accessedAt = Date.now()) => {
    ensureOpen();
    const documentId = validateId(id);
    const timestamp = validateNonNegativeInteger(accessedAt, "accessedAt");

    return inTransaction(database, () => {
      const result = database
        .prepare(
          `UPDATE documents
           SET lastAccessedAt = :accessedAt
           WHERE id = :id
             AND :accessedAt >= createdAt
             AND :accessedAt >= lastAccessedAt`
        )
        .run({ ":id": documentId, ":accessedAt": timestamp });

      if (result.changes > 0) {
        return true;
      }

      const document = database
        .prepare("SELECT createdAt, lastAccessedAt FROM documents WHERE id = :id")
        .get({ ":id": documentId });
      if (document === undefined) {
        return false;
      }

      const createdAt = readInteger(rowValue(document, "createdAt"), "createdAt");
      const lastAccessedAt = readInteger(rowValue(document, "lastAccessedAt"), "lastAccessedAt");
      throw new StorageInvariantError({
        field: "accessedAt",
        message:
          timestamp < createdAt
            ? "accessedAt must not be earlier than createdAt."
            : `accessedAt must not be earlier than lastAccessedAt (${lastAccessedAt}).`,
      });
    });
  };

  const getDocumentAggregate = () => {
    ensureOpen();
    const row = database
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM documents")
      .get();
    return {
      count: readInteger(row === undefined ? undefined : rowValue(row, "count"), "count"),
      size: readInteger(row === undefined ? undefined : rowValue(row, "size"), "size"),
    };
  };

  const getDocumentStorageUsage = () => {
    const aggregate = getDocumentAggregate();
    return storageUsageFor(aggregate.size, aggregate.count);
  };

  const deleteGenerationAfterDocumentDelete = (id: string, generation?: string) => {
    const generationClause = generation === undefined ? "" : " AND generation = :generation";
    database
      .prepare(
        `DELETE FROM ${GENERATION_TABLE_NAME}
         WHERE id = :id${generationClause}
           AND NOT EXISTS (SELECT 1 FROM documents WHERE documents.id = :id)`
      )
      .run({
        ":id": id,
        ...(generation === undefined ? {} : { ":generation": generation }),
      });
  };

  const deleteDocument = (id: string) => {
    ensureOpen();
    return inTransaction(database, () => {
      const documentId = validateId(id);
      const result = database
        .prepare("DELETE FROM documents WHERE id = :id")
        .run({ ":id": documentId });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(documentId);
      }
      return result.changes > 0;
    });
  };

  const deleteDocumentIfLastAccessedBefore = (
    candidate: string | DocumentMetadataSnapshot,
    cutoff: number
  ) => {
    ensureOpen();
    const timestamp = validateNonNegativeInteger(cutoff, "cutoff");
    const expected =
      typeof candidate === "string"
        ? { id: validateId(candidate), generation: undefined }
        : {
            ...validateMetadata(candidate),
            generation: validateGeneration(candidate.generation),
          };
    return inTransaction(database, () => {
      const row = database
        .prepare("SELECT id, createdAt, lastAccessedAt, size FROM documents WHERE id = :id")
        .get({ ":id": expected.id });
      if (row === undefined) {
        return undefined;
      }
      const metadata = documentFromRow(row);
      const generationClause =
        expected.generation === undefined ? "" : " AND g.generation = :generation";
      const result = database
        .prepare(
          `DELETE FROM documents
           WHERE id = :id
             AND lastAccessedAt < :cutoff
             AND EXISTS (
               SELECT 1 FROM ${GENERATION_TABLE_NAME} AS g
               WHERE g.id = documents.id${generationClause}
             )`
        )
        .run({
          ":id": expected.id,
          ":cutoff": timestamp,
          ...(expected.generation === undefined ? {} : { ":generation": expected.generation }),
        });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(expected.id, expected.generation);
        return metadata;
      }
      return undefined;
    });
  };

  const deleteDocumentIfMatches = (metadata: DocumentMetadataMatch) => {
    ensureOpen();
    const normalized = {
      ...validateMetadata(metadata),
      generation: validateGeneration(metadata.generation),
    };
    return inTransaction(database, () => {
      const result = database
        .prepare(
          `DELETE FROM documents
           WHERE id = :id
             AND createdAt = :createdAt
             AND lastAccessedAt = :lastAccessedAt
             AND size = :size
             AND EXISTS (
               SELECT 1 FROM ${GENERATION_TABLE_NAME} AS g
               WHERE g.id = documents.id AND g.generation = :generation
             )`
        )
        .run({
          ":id": normalized.id,
          ":createdAt": normalized.createdAt,
          ":lastAccessedAt": normalized.lastAccessedAt,
          ":size": normalized.size,
          ":generation": normalized.generation,
        });
      if (result.changes > 0) {
        deleteGenerationAfterDocumentDelete(normalized.id, normalized.generation);
        return true;
      }
      return false;
    });
  };

  const attemptFromRow = (row: Record<string, unknown> | undefined) => {
    if (row === undefined) return undefined;
    const attempt = parseShareAttempt(JSON.parse(readText(row["record"], "share record")));
    if (
      attempt.key !== row["operationKey"] ||
      attempt.id !== row["localId"] ||
      attempt.origin !== row["origin"] ||
      attempt.accountId !== row["accountId"]
    )
      throw new Error("Stored share operation identity mismatch.");
    return attempt;
  };
  const getShareAttempt = (key: string) => {
    ensureOpen();
    return attemptFromRow(
      database
        .prepare(
          "SELECT operationKey, localId, origin, accountId, record FROM share_attempts WHERE operationKey = ?"
        )
        .get(uploadOperationKey(key))
    );
  };
  const latestShareAttempt = (scope: ShareScope) => {
    ensureOpen();
    const value = validateShareScope(scope);
    return attemptFromRow(
      database
        .prepare(
          "SELECT operationKey, localId, origin, accountId, record FROM share_attempts WHERE localId = ? AND origin = ? AND accountId = ? ORDER BY rowid DESC LIMIT 1"
        )
        .get(value.id, value.origin, value.accountId)
    );
  };
  const listShareAttempts = (id: string) => {
    ensureOpen();
    const rows = database
      .prepare(
        "SELECT operationKey, localId, origin, accountId, record FROM share_attempts WHERE localId = ? ORDER BY rowid DESC LIMIT ?"
      )
      .all(validateId(id), SHARE_INSPECTION_LIMIT + 1);
    return {
      attempts: rows.slice(0, SHARE_INSPECTION_LIMIT).map((row) => attemptFromRow(row)!),
      hasMore: rows.length > SHARE_INSPECTION_LIMIT,
    };
  };
  const insertShareAttempt = (input: ShareAttempt) => {
    ensureOpen();
    const attempt = parseShareAttempt(input);
    inTransaction(database, () => {
      const latest = latestShareAttempt(attempt);
      if (latest && latest.status !== "failed")
        throw new Error("An unresolved or committed share already owns this scope.");
      const count = database.prepare("SELECT COUNT(*) AS count FROM share_attempts").get();
      if (Number(count?.["count"]) >= MAX_SHARE_ATTEMPTS)
        throw new Error(
          "Local share attempt capacity reached; existing operations remain recoverable."
        );
      database
        .prepare(
          "INSERT INTO share_attempts (operationKey, localId, origin, accountId, record) VALUES (?, ?, ?, ?, ?)"
        )
        .run(attempt.key, attempt.id, attempt.origin, attempt.accountId, JSON.stringify(attempt));
    });
  };
  const recordShareReceipt = (key: string, value: unknown) => {
    ensureOpen();
    return inTransaction(database, () => {
      const current = getShareAttempt(key);
      if (!current) throw new Error("The local share operation is missing. Do not upload again.");
      const receipt = matchCloudUploadReceipt(parseCloudUploadReceipt(value), current);
      const status = receipt.status === "pending" ? "unknown" : receipt.status;
      if (current.status !== "unknown") {
        if (status === "unknown") return current;
        if (current.status !== status || current.receipt?.documentId !== receipt.documentId)
          throw new Error(
            "Conflicting terminal cloud receipt. Keep the original operation for investigation."
          );
        return current;
      }
      const next = parseShareAttempt({ ...current, status, receipt });
      database
        .prepare("UPDATE share_attempts SET record = ? WHERE operationKey = ?")
        .run(JSON.stringify(next), key);
      return next;
    });
  };

  return {
    getShareAttempt,
    latestShareAttempt,
    listShareAttempts,
    insertShareAttempt,
    recordShareReceipt,
    close,
    insertDocumentMetadata,
    getDocumentMetadata,
    listDocumentMetadata,
    getDocumentMetadataScanWatermark,
    listDocumentMetadataCandidates,
    listDocumentMetadataPage,
    getDocumentMetadataSnapshot,
    recordDocumentAccess,
    getDocumentAggregate,
    getDocumentStorageUsage,
    deleteDocument,
    deleteDocumentIfLastAccessedBefore,
    deleteDocumentIfMatches,
  };
};

export const openStorage = (databasePath: string) =>
  Effect.try({
    try: () => {
      validateDatabasePath(databasePath);

      let database: DatabaseSync;
      try {
        database = new DatabaseSync(databasePath, { timeout: 5_000 });
      } catch (cause) {
        throw new StorageOpenError({
          path: databasePath,
          cause,
          message: `Could not open SQLite metadata storage at ${databasePath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }

      try {
        migrate(database);
        return createStore(database);
      } catch (cause) {
        try {
          database.close();
        } catch {
          // Preserve the migration diagnostic.
        }
        throw new StorageMigrationError({
          path: databasePath,
          cause,
          message: `Could not migrate SQLite metadata storage at ${databasePath}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
    },
    catch: (cause) =>
      isStorageError(cause)
        ? cause
        : new StorageOpenError({
            path: databasePath,
            cause,
            message: `Could not open SQLite metadata storage at ${databasePath}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
  });

/** Acquires metadata storage and closes it with the surrounding Effect scope. */
export const openStorageScoped = (databasePath: string) =>
  Effect.acquireRelease(openStorage(databasePath), (store) => Effect.sync(() => store.close()));

export { CURRENT_SCHEMA_VERSION };
