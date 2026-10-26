import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction, readInteger, readText, rowValue } from "./sqlite-primitives.js";

export const CURRENT_SCHEMA_VERSION = 4;

const DOCUMENT_COLUMNS = ["id", "createdAt", "lastAccessedAt", "size"] as const;
const DOCUMENT_INDEX_NAME = "documents_last_accessed_at_idx";
export const GENERATION_TABLE_NAME = "document_generations";
const DOCUMENT_INDEX_SCHEMA = `
  CREATE INDEX ${DOCUMENT_INDEX_NAME} ON documents (lastAccessedAt, id)
`;
const DOCUMENT_SCHEMA = `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY NOT NULL
      CHECK (typeof(id) = 'text' AND length(trim(id)) > 0),
    createdAt INTEGER NOT NULL
      CHECK (typeof(createdAt) = 'integer' AND createdAt >= 0),
    lastAccessedAt INTEGER NOT NULL
      CHECK (typeof(lastAccessedAt) = 'integer' AND lastAccessedAt >= createdAt),
    size INTEGER NOT NULL
      CHECK (typeof(size) = 'integer' AND size >= 0)
  ) STRICT
`;
const GENERATION_SCHEMA = `
  CREATE TABLE ${GENERATION_TABLE_NAME} (
    id TEXT PRIMARY KEY NOT NULL
      CHECK (typeof(id) = 'text' AND length(trim(id)) > 0),
    generation TEXT NOT NULL
      CHECK (typeof(generation) = 'text' AND length(generation) > 0)
  ) STRICT
`;

export const SHARE_SCHEMA = `
  CREATE TABLE share_attempts (
    operationKey TEXT PRIMARY KEY NOT NULL,
    localId TEXT NOT NULL,
    origin TEXT NOT NULL,
    accountId TEXT NOT NULL,
    record TEXT NOT NULL CHECK (length(record) <= 8192 AND json_valid(record))
  ) STRICT
`;
export const SHARE_INDEX_SCHEMA = `CREATE INDEX share_scope_idx ON share_attempts (localId, origin, accountId)`;

export const PIN_SCHEMA = `CREATE TABLE snapshot_pins (
  id TEXT PRIMARY KEY NOT NULL,
  generation TEXT NOT NULL
) STRICT`;

const normalizeSchemaSql = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

const EXPECTED_COLUMN_INFO = [
  { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { cid: 1, name: "createdAt", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 2, name: "lastAccessedAt", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { cid: 3, name: "size", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
] as const;

const validateDocumentTable = (database: DatabaseSync, version: 1 | 2) => {
  const table = database
    .prepare("PRAGMA table_list")
    .all()
    .find(
      (row) =>
        rowValue(row, "schema") === "main" &&
        rowValue(row, "name") === "documents" &&
        rowValue(row, "type") === "table"
    );
  if (
    table === undefined ||
    rowValue(table, "ncol") !== DOCUMENT_COLUMNS.length ||
    rowValue(table, "wr") !== 0 ||
    rowValue(table, "strict") !== 1
  ) {
    throw new Error(`The documents table is not a strict v${version} table.`);
  }

  const columns = database.prepare("PRAGMA table_info(documents)").all();
  if (
    columns.length !== EXPECTED_COLUMN_INFO.length ||
    columns.some((column, index) => {
      const expected = EXPECTED_COLUMN_INFO[index];
      return (
        expected === undefined ||
        rowValue(column, "cid") !== expected.cid ||
        rowValue(column, "name") !== expected.name ||
        rowValue(column, "type") !== expected.type ||
        rowValue(column, "notnull") !== expected.notnull ||
        rowValue(column, "dflt_value") !== expected.dflt_value ||
        rowValue(column, "pk") !== expected.pk
      );
    })
  ) {
    throw new Error(
      `The documents columns do not match the supported v${version} metadata schema.`
    );
  }

  const schemaRow = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'documents' AND tbl_name = 'documents'"
    )
    .get();
  const schemaSql = schemaRow === undefined ? undefined : rowValue(schemaRow, "sql");
  if (
    typeof schemaSql !== "string" ||
    normalizeSchemaSql(schemaSql) !== normalizeSchemaSql(DOCUMENT_SCHEMA)
  ) {
    throw new Error(
      `The documents constraints do not match the supported v${version} metadata schema.`
    );
  }
};

const validateIndex = (database: DatabaseSync, required: boolean, version: 1 | 2) => {
  const indexRow = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = :name AND tbl_name = 'documents'"
    )
    .get({ ":name": DOCUMENT_INDEX_NAME });
  const indexSql = indexRow === undefined ? undefined : rowValue(indexRow, "sql");
  if (
    (required && typeof indexSql !== "string") ||
    (indexSql !== undefined &&
      (typeof indexSql !== "string" ||
        normalizeSchemaSql(indexSql) !== normalizeSchemaSql(DOCUMENT_INDEX_SCHEMA)))
  ) {
    throw new Error(
      `The lastAccessedAt index does not match the supported v${version} metadata schema.`
    );
  }
};

const validateV1Schema = (database: DatabaseSync) => {
  const unexpectedObject = database
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND NOT (type = 'table' AND name = 'documents')
         AND NOT (type = 'index' AND name = '${DOCUMENT_INDEX_NAME}')`
    )
    .get();
  if (unexpectedObject !== undefined) {
    throw new Error(
      `The v1 database contains an unexpected user schema object: ${rowValue(unexpectedObject, "type")} ${rowValue(unexpectedObject, "name")}.`
    );
  }

  validateDocumentTable(database, 1);
  validateIndex(database, false, 1);
};

const validateV2Schema = (database: DatabaseSync, shares = false, pins = false) => {
  const unexpectedObject = database
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND NOT (type = 'table' AND name IN ('documents', '${GENERATION_TABLE_NAME}'${shares ? ", 'share_attempts'" : ""}${pins ? ", 'snapshot_pins'" : ""}))
         AND NOT (type = 'index' AND name IN ('${DOCUMENT_INDEX_NAME}'${shares ? ", 'share_scope_idx'" : ""}))`
    )
    .get();
  if (unexpectedObject !== undefined) {
    throw new Error(
      `The v2 database contains an unexpected user schema object: ${rowValue(unexpectedObject, "type")} ${rowValue(unexpectedObject, "name")}.`
    );
  }
  validateDocumentTable(database, 2);
  validateIndex(database, true, 2);
  const generationTable = database
    .prepare("PRAGMA table_list")
    .all()
    .find(
      (row) =>
        rowValue(row, "schema") === "main" &&
        rowValue(row, "name") === GENERATION_TABLE_NAME &&
        rowValue(row, "type") === "table"
    );
  if (
    generationTable === undefined ||
    rowValue(generationTable, "ncol") !== 2 ||
    rowValue(generationTable, "wr") !== 0 ||
    rowValue(generationTable, "strict") !== 1
  ) {
    throw new Error("The document generations table is not a strict v2 table.");
  }
  const generationSchemaRow = database
    .prepare(
      `SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '${GENERATION_TABLE_NAME}' AND tbl_name = '${GENERATION_TABLE_NAME}'`
    )
    .get();
  const generationSchemaSql =
    generationSchemaRow === undefined ? undefined : rowValue(generationSchemaRow, "sql");
  if (
    typeof generationSchemaSql !== "string" ||
    normalizeSchemaSql(generationSchemaSql) !== normalizeSchemaSql(GENERATION_SCHEMA)
  ) {
    throw new Error("The document generation constraints do not match the supported v2 schema.");
  }
};

export const migrate = (database: DatabaseSync) =>
  inTransaction(database, () => {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = readInteger(
      versionRow === undefined ? undefined : rowValue(versionRow, "user_version"),
      "user_version"
    );

    if (
      version !== 0 &&
      version !== 1 &&
      version !== 2 &&
      version !== 3 &&
      version !== CURRENT_SCHEMA_VERSION
    ) {
      throw new Error(
        `Database schema version ${version} is not supported; expected 0, 1, 2, 3, or ${CURRENT_SCHEMA_VERSION}.`
      );
    }

    if (version === 0) {
      database.exec(DOCUMENT_SCHEMA);
      database.exec(GENERATION_SCHEMA);
    } else if (version === 1) {
      // Validate before changing a claimed legacy database. A malformed v1
      // file must remain untouched so operators can recover its original bytes.
      validateV1Schema(database);
      database.exec(GENERATION_SCHEMA);
      const rows = database.prepare("SELECT id FROM documents").all();
      const insertGeneration = database.prepare(
        `INSERT INTO ${GENERATION_TABLE_NAME} (id, generation) VALUES (:id, :generation)`
      );
      for (const row of rows) {
        insertGeneration.run({
          ":id": readText(rowValue(row, "id"), "id"),
          ":generation": randomUUID(),
        });
      }
    }

    database.exec(
      `CREATE INDEX IF NOT EXISTS ${DOCUMENT_INDEX_NAME} ON documents (lastAccessedAt, id)`
    );
    if (version < 3) {
      validateV2Schema(database);
      database.exec(SHARE_SCHEMA);
      database.exec(SHARE_INDEX_SCHEMA);
    }
    if (version < 4) {
      validateV2Schema(database, true);
      database.exec(PIN_SCHEMA);
    }
    validateV2Schema(database, true, true);
    for (const [name, expected] of [
      ["snapshot_pins", PIN_SCHEMA],
      ["share_attempts", SHARE_SCHEMA],
      ["share_scope_idx", SHARE_INDEX_SCHEMA],
    ]) {
      const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name!)?.[
        "sql"
      ];
      if (typeof sql !== "string" || normalizeSchemaSql(sql) !== normalizeSchemaSql(expected!))
        throw new Error("Invalid metadata schema.");
    }
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  });
