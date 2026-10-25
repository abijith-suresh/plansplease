import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOCUMENT_ID_ALPHABET,
  DOCUMENT_ID_LENGTH,
  DocumentIdGenerationError,
  generateDocumentId,
  InvalidDocumentIdError,
  isValidDocumentId,
  validateDocumentId,
} from "../dist/index.js";

test("generates exact-length URL-safe document ids", () => {
  const id = generateDocumentId();

  assert.equal(id.length, DOCUMENT_ID_LENGTH);
  assert.ok([...id].every((character) => DOCUMENT_ID_ALPHABET.includes(character)));
  assert.equal(isValidDocumentId(id), true);
});

test("strictly validates document id length and alphabet", () => {
  const valid = "a".repeat(DOCUMENT_ID_LENGTH);
  assert.equal(isValidDocumentId(valid), true);
  assert.equal(validateDocumentId(valid), valid);

  for (const invalid of [
    "",
    "a".repeat(DOCUMENT_ID_LENGTH - 1),
    "a".repeat(DOCUMENT_ID_LENGTH + 1),
    `${"a".repeat(DOCUMENT_ID_LENGTH - 1)}!`,
    `${"a".repeat(DOCUMENT_ID_LENGTH - 1)} `,
    `${"a".repeat(DOCUMENT_ID_LENGTH - 1)}~`,
    123,
    null,
  ]) {
    assert.equal(isValidDocumentId(invalid), false, `expected ${String(invalid)} to be invalid`);
    assert.throws(
      () => validateDocumentId(invalid),
      (error) => {
        assert.ok(error instanceof InvalidDocumentIdError);
        assert.equal(error.code, "INVALID_DOCUMENT_ID");
        assert.equal(error.value, invalid);
        return true;
      }
    );
  }
});

test("reports invalid injected random sources with typed errors", () => {
  assert.throws(
    () => generateDocumentId({ randomBytes: () => new Uint8Array(DOCUMENT_ID_LENGTH - 1) }),
    (error) => {
      assert.ok(error instanceof DocumentIdGenerationError);
      assert.equal(error.code, "DOCUMENT_ID_GENERATION_FAILED");
      return true;
    }
  );

  assert.throws(
    () =>
      generateDocumentId({
        randomBytes: () => {
          throw new Error("deterministic source failed");
        },
      }),
    (error) => error instanceof DocumentIdGenerationError && error.cause instanceof Error
  );
});
