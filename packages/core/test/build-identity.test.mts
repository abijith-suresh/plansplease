import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeBuildIdentity,
  matchesCandidateBuild,
  validateBuildIdentity,
} from "../dist/build-identity.js";

const input = {
  sourceSha: "a".repeat(40),
  sourceVersion: "0.1.7",
  channel: "dev",
  date: "20261028",
  runId: "123",
  attempt: "1",
};
test("candidate identity is exact, canonical and source/attempt specific", () => {
  const build = makeBuildIdentity(input);
  assert.equal(build.version, "0.0.0-dev.20261028.123.1");
  assert.deepEqual(validateBuildIdentity(build, build.version), build);
  for (const patch of [
    { channel: "latest" },
    { channel: "alpha\n" },
    { runId: "01" },
    { attempt: "0" },
    { attempt: "9007199254740992" },
    { date: "20260230" },
    { sourceSha: "0".repeat(40) },
    { sourceSha: "A".repeat(40) },
    { sourceVersion: "0.1.7-dev" },
    { extra: true },
    { version: "0.1.7" },
  ])
    assert.throws(() => makeBuildIdentity({ ...input, ...patch }));
  assert.throws(() => validateBuildIdentity(input));
  assert.throws(() => validateBuildIdentity(build, "0.1.7"));
});
test("candidate reuse requires complete matching version and source, stable compatibility remains", () => {
  const build = makeBuildIdentity(input),
    descriptor = { packageVersion: build.version, build };
  assert.equal(matchesCandidateBuild(build, build.version, descriptor), true);
  for (const other of [
    null,
    {},
    { ...descriptor, packageVersion: "0.1.7" },
    { ...descriptor, build: { ...build, sourceSha: "b".repeat(40) } },
    { ...descriptor, build: { ...build, unknown: true } },
  ])
    assert.equal(matchesCandidateBuild(build, build.version, other), false);
  assert.equal(matchesCandidateBuild(null, "0.1.7", {}), true);
});
