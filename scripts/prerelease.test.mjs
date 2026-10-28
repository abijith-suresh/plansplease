import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeBuildIdentity } from "../packages/core/src/build-identity.ts";
import {
  installPrepared,
  preparePrerelease,
  snapshotCommit,
  validateDispatch,
  validateManifest,
  verifyInstalledContents,
  verifyPrepared,
} from "./prerelease.mjs";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const build = makeBuildIdentity({
  sourceSha: "a".repeat(40),
  sourceVersion: "0.1.7",
  channel: "dev",
  date: "20261028",
  runId: "12",
  attempt: "1",
});
const runtime = {
  version: "4.0.6",
  resolved: "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz",
  integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
};
const scope = async (callback) => {
  const directory = mkdtempSync(join(tmpdir(), "plansplease candidate guards é "));
  try {
    await callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
function fixture(directory) {
  const bytes = Buffer.from("bounded test archive");
  const metadata = Buffer.from(
    JSON.stringify({
      name: "@abijith-suresh/planview",
      version: build.version,
      private: true,
      planviewBuild: build,
      dependencies: { effect: "4.0.6" },
    })
  );
  const manifest = {
    schemaVersion: 1,
    build,
    tag: "dev",
    publication: "disabled",
    requirements: { node: ">=24.19.0 <25", npm: "11.16.0" },
    runtime,
    packages: [
      {
        name: "@abijith-suresh/planview",
        version: build.version,
        filename: "candidate.tgz",
        sha256: sha256(bytes),
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        files: [{ path: "package.json", size: metadata.length, sha256: sha256(metadata) }],
      },
    ],
  };
  const encoded = JSON.stringify(manifest);
  writeFileSync(join(directory, "manifest.json"), encoded);
  writeFileSync(join(directory, "candidate.tgz"), bytes);
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${sha256(bytes)}  candidate.tgz\n${sha256(encoded)}  manifest.json\n`
  );
  return { manifest, metadata };
}
test("manual dispatch is trusted main only and publication requests fail before output", async () => {
  const context = {
    identity: build,
    eventName: "workflow_dispatch",
    repository: "abijith-suresh/plansplease",
    ref: "refs/heads/main",
    sourceSha: build.sourceSha,
    checkedOutSha: build.sourceSha,
    publishRequested: false,
  };
  assert.deepEqual(validateDispatch(context), build);
  for (const patch of [
    { eventName: "push" },
    { repository: "fork/plansplease" },
    { ref: "refs/heads/topic" },
    { checkedOutSha: "b".repeat(40) },
    ...[true, "true", "yes", 1].map((publishRequested) => ({ publishRequested })),
  ])
    assert.throws(() => validateDispatch({ ...context, ...patch }));
  await scope(async (dir) => {
    await assert.rejects(
      preparePrerelease(dir, join(dir, "absent"), build, { publish: true }),
      /Publication is disabled/
    );
    assert.deepEqual(readdirSync(dir), []);
  });
});
test("bounded manifest and hashes reject tampering before install/tool execution", async () =>
  scope((dir) => {
    const { manifest } = fixture(dir);
    assert.deepEqual(verifyPrepared(dir), manifest);
    assert.throws(
      () => installPrepared(dir, join(dir, "absent"), "b".repeat(40)),
      /approved source SHA/
    );
    for (const patch of [
      { publication: "enabled" },
      { packages: [...manifest.packages, manifest.packages[0]] },
      { runtime: { ...runtime, version: "4.0.7" } },
      { runtime: { ...runtime, resolved: "https://other.invalid/effect.tgz" } },
      { unknown: true },
    ])
      assert.throws(() => validateManifest({ ...manifest, ...patch }));
    for (const path of [
      "../outside",
      "dist/../escape",
      "dist/link\\file",
      "dist/:drive",
      "dist/\u0000",
      "unexpected/file",
    ])
      assert.throws(() =>
        validateManifest({
          ...manifest,
          packages: [
            { ...manifest.packages[0], files: [{ path, size: 0, sha256: "a".repeat(64) }] },
          ],
        })
      );
    writeFileSync(join(dir, "candidate.tgz"), "changed");
    assert.throws(() => installPrepared(dir, join(dir, "absent"), build.sourceSha), /checksum/);
    assert.equal(readdirSync(dir).includes("absent"), false);
  }));
test("installed per-file hashes, exact graph and symlink refusal precede execution", async () =>
  scope((dir) => {
    const { manifest, metadata } = fixture(dir);
    const home = join(dir, "node_modules/@abijith-suresh/planview"),
      effect = join(dir, "node_modules/effect");
    mkdirSync(home, { recursive: true });
    mkdirSync(effect);
    writeFileSync(join(home, "package.json"), metadata);
    writeFileSync(
      join(effect, "package.json"),
      JSON.stringify({ name: "effect", version: "4.0.6" })
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/effect": runtime } })
    );
    verifyInstalledContents(dir, manifest);
    writeFileSync(join(home, "package.json"), Buffer.concat([metadata, Buffer.from(" ")]));
    assert.throws(() => verifyInstalledContents(dir, manifest), /content verification/);
    writeFileSync(join(home, "package.json"), metadata);
    writeFileSync(
      join(effect, "package.json"),
      JSON.stringify({ name: "effect", version: "4.0.7" })
    );
    assert.throws(() => verifyInstalledContents(dir, manifest), /runtime graph/);
    if (process.platform !== "win32") {
      rmSync(join(dir, "candidate.tgz"));
      symlinkSync(join(dir, "manifest.json"), join(dir, "candidate.tgz"));
      assert.throws(() => verifyPrepared(dir));
    }
  }));
test("Git object snapshot uses committed exact bytes without moving or changing dirty source", async () =>
  scope((dir) => {
    const source = join(dir, "source"),
      snapshot = join(dir, "snapshot");
    mkdirSync(source);
    mkdirSync(snapshot);
    const git = (args) =>
      execFileSync("git", args, { cwd: source, encoding: "utf8", windowsHide: true });
    git(["init", "--quiet"]);
    writeFileSync(join(source, "tracked é.txt"), "committed exact\r\n");
    git(["-c", "core.autocrlf=false", "add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    const head = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(source, "tracked é.txt"), "uncommitted");
    writeFileSync(join(source, "untracked"), "keep");
    const before = git(["status", "--porcelain=v1", "-z"]);
    snapshotCommit(source, snapshot, head);
    assert.equal(readFileSync(join(snapshot, "tracked é.txt"), "utf8"), "committed exact\r\n");
    assert.deepEqual(readdirSync(snapshot), ["tracked é.txt"]);
    assert.equal(git(["status", "--porcelain=v1", "-z"]), before);
    assert.equal(readFileSync(join(source, "tracked é.txt"), "utf8"), "uncommitted");
    assert.equal(readFileSync(join(source, "untracked"), "utf8"), "keep");
    assert.equal(git(["rev-parse", "HEAD"]).trim(), head);
  }));
test("manual workflow has read-only permissions and canonical transfer, no publisher", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/prepare-prerelease.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  (push|pull_request|schedule):/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(
    workflow,
    /(?:id-token:|packages:|contents:) write|secrets\.|npm (publish|login)|gh release|version-packages/
  );
  assert.match(workflow, /Download the canonical Linux bytes without rebuilding the candidate/);
  assert.match(workflow, /npm\.cmd run check:prerelease/);
});
