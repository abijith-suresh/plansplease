import assert from "node:assert/strict";
import { test } from "node:test";
import { npmPackFilename } from "./npm-pack-result.mjs";

const packageResult = { filename: "abijith-suresh-planview-0.1.7.tgz" };

test("normalizes npm 11 array and npm 12 workspace object pack output", () => {
  assert.equal(npmPackFilename([packageResult]), packageResult.filename);
  assert.equal(
    npmPackFilename({ "@abijith-suresh/planview": packageResult }),
    packageResult.filename
  );
});

test("requires exactly one packed package with a filename", () => {
  for (const invalid of [
    [],
    [packageResult, packageResult],
    {},
    { a: packageResult, b: packageResult },
  ]) {
    assert.throws(() => npmPackFilename(invalid), /exactly one package/);
  }
  assert.throws(() => npmPackFilename([{}]), /filename/);
  assert.throws(() => npmPackFilename(null), /exactly one package/);
});
