import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidSourceFileSizeError,
  SourceFileTooLargeError,
  UnsupportedSourceExtensionError,
  V1_MAX_HTML_SIZE_BYTES,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "../dist/index.js";

test("supports only HTML source extensions, case-insensitively", () => {
  for (const [path, extension] of [
    ["index.html", ".html"],
    ["index.htm", ".htm"],
    ["/tmp/site/INDEX.HTML", ".html"],
    ["C:\\Users\\alice\\site.HtM", ".htm"],
    ["nested\\path/mixed.HtMl", ".html"],
  ]) {
    assert.equal(validateSourceFileExtension(path), extension);
  }
});

test("rejects source extension and path edge cases with a typed error", () => {
  for (const path of [
    "index.css",
    "index.html.txt",
    "index.html?download=1",
    "index.html/",
    "/tmp/.html",
    ".html",
    "index.",
    "index",
    "",
    "/",
    "C:\\site\\",
  ]) {
    assert.throws(
      () => validateSourceFileExtension(path),
      (error) => {
        assert.ok(error instanceof UnsupportedSourceExtensionError);
        assert.equal(error.code, "UNSUPPORTED_SOURCE_EXTENSION");
        assert.equal(error.path, path);
        return true;
      }
    );
  }
});

test("rejects oversized and invalid source sizes with distinct typed errors", () => {
  assert.throws(
    () => validateSourceFileSize(V1_MAX_HTML_SIZE_BYTES + 1),
    (error) => {
      assert.ok(error instanceof SourceFileTooLargeError);
      assert.equal(error.code, "SOURCE_FILE_TOO_LARGE");
      assert.equal(error.sizeBytes, V1_MAX_HTML_SIZE_BYTES + 1);
      assert.equal(error.maxSizeBytes, V1_MAX_HTML_SIZE_BYTES);
      return true;
    }
  );

  for (const sizeBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
    assert.throws(
      () => validateSourceFileSize(sizeBytes),
      (error) => {
        assert.ok(error instanceof InvalidSourceFileSizeError);
        assert.equal(error.code, "INVALID_SOURCE_FILE_SIZE");
        assert.equal(error.sizeBytes, sizeBytes);
        return true;
      }
    );
  }
});
