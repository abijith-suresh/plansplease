import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkReleasePolicy } from "./release-policy.mjs";

const releasePolicyScript = fileURLToPath(new URL("./release-policy.mjs", import.meta.url));
const publicPackageName = "@abijith-suresh/planview";
const changeset = (bump) => `---\n"${publicPackageName}": ${bump}\n---\n\nA change.\n`;

const withTemporaryRepository = (
  changesets,
  callback,
  version = "0.1.0",
  packageName = publicPackageName
) => {
  const root = mkdtempSync(join(tmpdir(), "planview-release-policy-"));
  mkdirSync(join(root, "apps", "cli"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  writeFileSync(
    join(root, "apps", "cli", "package.json"),
    JSON.stringify({ name: packageName, version })
  );
  for (const [file, contents] of Object.entries(changesets)) {
    writeFileSync(join(root, ".changeset", file), contents);
  }

  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("allows a patch bump and ignores Changesets support files and other packages", () => {
  const result = withTemporaryRepository(
    {
      "patch.md": `---\n"${publicPackageName}": patch\n"private-tool": major\n---\n\nPatch the CLI.\n`,
      "README.md": "Changesets documentation, not a pending change.\n",
      "config.json": '{"ignore": []}\n',
    },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, []);
});

test("fails closed with a file diagnostic for malformed frontmatter", () => {
  assert.throws(
    () =>
      withTemporaryRepository(
        { "malformed.md": `---\n"${publicPackageName}": [minor\n---\n\nMalformed YAML.\n` },
        (root) => checkReleasePolicy({ root })
      ),
    (error) => {
      assert.match(error.message, /Could not parse \.changeset\/malformed\.md/);
      return true;
    }
  );
});

test("enforces the policy for prereleases below 1.0.0 and the 1.0.0 prerelease", () => {
  for (const version of ["0.9.0-beta.1", "1.0.0-beta.1"]) {
    const result = withTemporaryRepository(
      { "minor.md": changeset("minor") },
      (root) => checkReleasePolicy({ root }),
      version
    );
    assert.equal(result.enforcePatchOnly, true, `${version} should enforce patch-only releases`);
    assert.equal(result.violations.length, 1, `${version} should reject minor releases`);
  }
});

test("stops enforcing patch-only releases at stable 1.0.0, including build metadata", () => {
  for (const version of ["1.0.0", "1.0.0+build-feature"]) {
    const result = withTemporaryRepository(
      { "minor.md": changeset("minor") },
      (root) => checkReleasePolicy({ root }),
      version
    );
    assert.equal(result.enforcePatchOnly, false, `${version} should allow all release types`);
    assert.deepEqual(result.violations, []);
  }
});

test("fails closed for invalid package versions that could bypass the policy", () => {
  for (const version of ["01.0.0", "1.0.0-01", "1.0.0+build..metadata", "1.0.0.0"]) {
    assert.throws(
      () =>
        withTemporaryRepository(
          { "minor.md": changeset("minor") },
          (root) => checkReleasePolicy({ root }),
          version
        ),
      (error) => {
        assert.match(error.message, /Package version/);
        assert.match(error.message, /not a valid semantic version/);
        return true;
      },
      version
    );
  }
});

test("CLI exits nonzero and reports malformed relevant frontmatter", () => {
  const result = withTemporaryRepository(
    { "malformed.md": `---\n"${publicPackageName}": [minor\n---\n\nMalformed YAML.\n` },
    (root) =>
      spawnSync(process.execPath, [releasePolicyScript], {
        cwd: root,
        encoding: "utf8",
      })
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release policy check failed:/);
  assert.match(result.stderr, /\.changeset\/malformed\.md/);
});
