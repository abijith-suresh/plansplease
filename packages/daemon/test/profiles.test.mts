import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAppDataPaths } from "@planview/core";
import { createProfileOperations, PROFILE_SCAN_LIMIT } from "../dist/profiles.js";

async function fixture(
  run: (env: {
    root: string;
    home: string;
    profiles: ReturnType<typeof createProfileOperations>;
    named: (name: string) => string;
  }) => Promise<void>
) {
  const home = await mkdtemp(join(tmpdir(), "profile-catalog-"));
  const dependencies = {
    homeDir: home,
    env: { XDG_DATA_HOME: join(home, "data"), LOCALAPPDATA: join(home, "local") },
  };
  const root = resolveAppDataPaths(dependencies).appDataDir;
  const named = (name: string) => join(root, "profiles", name);
  const profiles = createProfileOperations(
    { profile: "default", appDataDir: root, runtimeDir: join(root, "runtime") },
    dependencies
  );
  try {
    await run({ home, root, profiles, named });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("offline directory discovery/create preserve default paths, never inspect descriptors/databases/credentials, and selection changes nothing", () =>
  fixture(async ({ profiles, root, named }) => {
    const initial = await profiles.list();
    assert.equal(initial.current.appDataDir, root);
    assert.equal(initial.current.present, false);
    assert.deepEqual(initial.profiles, [
      { name: "default", selected: true, present: false, daemon: "not_checked" },
    ]);
    const before = await profiles.plan("research");
    assert.equal(before.target.appDataDir, named("research"));
    assert.equal(before.target.present, false);
    assert.equal(before.openCommand, "plansplease --profile research ui --open");
    await assert.rejects(readFile(join(root, "metadata.sqlite")));
    assert.equal((await profiles.create("research")).created, true);
    assert.equal((await profiles.create("research")).created, false);
    assert.deepEqual(
      await readdir(named("research")),
      [],
      "creation opens no database/daemon/vault"
    );
    await writeFile(join(named("research"), "metadata.sqlite"), "invalid database");
    await writeFile(join(named("research"), "cloud-credentials.json"), "DO_NOT_READ_OR_RETURN", {
      mode: 0o600,
    });
    await mkdir(join(named("research"), "runtime"), { mode: 0o700 });
    await writeFile(join(named("research"), "runtime/daemon.json"), "malformed descriptor", {
      mode: 0o600,
    });
    const listed = await profiles.list();
    assert.deepEqual(
      listed.profiles.map((profile) => profile.name),
      ["default", "research"]
    );
    assert.equal(JSON.stringify(listed).includes("DO_NOT_READ"), false);
    assert.equal((await profiles.current()).name, "default");
    assert.equal((await profiles.plan("research")).target.present, true);
    assert.equal(
      await readFile(join(named("research"), "runtime/daemon.json"), "utf8"),
      "malformed descriptor"
    );
    assert.equal((await profiles.list()).current.name, "default", "no global default is persisted");
  }));

test("malformed names and traversal fail before profile creation", () =>
  fixture(async ({ profiles, root }) => {
    for (const name of [
      "",
      "../outside",
      "a/b",
      "a\\b",
      "A",
      "-bad",
      "a".repeat(33),
      "a;start",
      "foo bar",
    ]) {
      await assert.rejects(profiles.plan(name));
      await assert.rejects(profiles.create(name));
    }
    await assert.rejects(readdir(root));
    for (const limit of [0, -1, 101, NaN, 1.1, Infinity])
      await assert.rejects(profiles.list(limit));
  }));

test("symlinks/junctions, foreign/private roots and unsupported entries are excluded or refused", () =>
  fixture(async ({ profiles, root, home, named }) => {
    await profiles.create("safe");
    const outside = join(home, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, named("linked"), process.platform === "win32" ? "junction" : "dir");
    await mkdir(named("INVALID"), { mode: 0o700 });
    await writeFile(named("plain-file"), "not a profile");
    const listed = await profiles.list();
    assert.deepEqual(
      listed.profiles.map((profile) => profile.name),
      ["default", "safe"]
    );
    assert.equal(listed.skippedEntries, 3);
    await assert.rejects(profiles.plan("linked"), /symlinks|junctions/);
    await assert.rejects(profiles.create("linked"), /symlinks|junctions/);
    if (process.platform !== "win32") {
      await chmod(root, 0o755);
      await assert.rejects(profiles.list(), /private/);
      await chmod(root, 0o700);
    }
    await rm(join(root, "profiles"), { recursive: true });
    await symlink(
      outside,
      join(root, "profiles"),
      process.platform === "win32" ? "junction" : "dir"
    );
    await assert.rejects(profiles.list(), /symlinks|junctions/);
    await assert.rejects(profiles.create("never-created"), /symlinks|junctions/);
    assert.deepEqual(await readdir(outside), []);
  }));

test("profile count and examined-directory bounds remain explicit without recursive artifact scans", () =>
  fixture(async ({ profiles, named }) => {
    await profiles.create("first");
    await Promise.all(
      Array.from({ length: 120 }, (_, i) => mkdir(named(`p${i}`), { mode: 0o700 }))
    );
    const page = await profiles.list(20);
    assert.equal(page.profiles.length, 20);
    assert.equal(page.limited, true);
    assert.ok(page.scannedEntries <= PROFILE_SCAN_LIMIT);
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => mkdir(named(`INVALID${i}`), { mode: 0o700 }))
    );
    const bounded = await profiles.list(100);
    assert.ok(bounded.profiles.length <= 100);
    assert.ok(bounded.scannedEntries <= PROFILE_SCAN_LIMIT);
    assert.equal(bounded.limited, true);
  }));

test("custom storage/runtime overrides are scoped, never inferred as a sibling catalog or silently rebound by launch instructions", () =>
  fixture(async ({ home, root }) => {
    const custom = join(home, "custom");
    await mkdir(custom, { mode: 0o700 });
    const operations = createProfileOperations({
      profile: "work",
      appDataDir: custom,
      runtimeDir: join(custom, "runtime"),
    });
    const listed = await operations.list();
    assert.equal(listed.scope, "isolated_override");
    assert.deepEqual(
      listed.profiles.map((row) => row.name),
      ["work"]
    );
    await assert.rejects(operations.plan("work"), /custom storage/);
    await assert.rejects(operations.plan("default"));
    await assert.rejects(operations.create("other"));
    await assert.rejects(readdir(root));
  }));

test(
  "POSIX roots owned by another user are refused",
  { skip: process.platform === "win32" },
  async (t) =>
    fixture(async ({ profiles }) => {
      await profiles.create("safe");
      const uid = process.getuid!();
      t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => uid + 1);
      await assert.rejects(profiles.list(), /owned by the current user/);
      await assert.rejects(profiles.create("other"), /owned by the current user/);
    })
);

test("unsupported entries alone hit the fixed scan bound", () =>
  fixture(async ({ profiles, named }) => {
    await profiles.create("default");
    await mkdir(join(named("x"), ".."), { recursive: true, mode: 0o700 });
    await Promise.all(
      Array.from({ length: 300 }, (_, i) => mkdir(named(`INVALID${i}`), { mode: 0o700 }))
    );
    const result = await profiles.list(100);
    assert.equal(result.scannedEntries, PROFILE_SCAN_LIMIT);
    assert.equal(result.skippedEntries, PROFILE_SCAN_LIMIT);
    assert.equal(result.limited, true);
    assert.equal(result.profiles.length, 1);
  }));
