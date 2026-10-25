import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AppDataPlatform,
  DEFAULT_PROFILE_NAME,
  isValidProfileName,
  normalizeMacosSystemPath,
  resolveAppDataPaths,
  validateProfileName,
} from "../dist/index.js";

const dependencies = (
  platform: AppDataPlatform,
  homeDir: string,
  env: Record<string, string> = {}
) => ({
  platform,
  homeDir,
  env,
});

const paths = (appDataDir: string, separator = "/") => ({
  appDataDir,
  databasePath: `${appDataDir}${separator}metadata.sqlite`,
  documentsDir: `${appDataDir}${separator}documents`,
  stagingDir: `${appDataDir}${separator}staging`,
});

test("keeps the default profile path and isolates named profiles below it", () => {
  const base = dependencies("linux", "/home/alice", {
    XDG_DATA_HOME: "/mnt/data/alice-data",
  });
  assert.equal(DEFAULT_PROFILE_NAME, "default");
  assert.deepEqual(resolveAppDataPaths(base), paths("/mnt/data/alice-data/planview"));
  assert.deepEqual(
    resolveAppDataPaths({ ...base, profile: "work" }),
    paths("/mnt/data/alice-data/planview/profiles/work")
  );
});

test("accepts safe profile names and rejects names that can escape the profile directory", () => {
  for (const name of ["dev", "work-2026", "a_profile", "9"]) {
    assert.equal(isValidProfileName(name), true);
    assert.equal(validateProfileName(name), name);
  }
  for (const name of ["", ".", "..", "Dev", "work/feature", "a".repeat(33)]) {
    assert.equal(isValidProfileName(name), false);
    assert.throws(() => validateProfileName(name), /profile name must start/);
  }
});

test("uses the Linux XDG default when XDG_DATA_HOME is absent or empty", () => {
  for (const env of [{}, { XDG_DATA_HOME: "" }]) {
    assert.deepEqual(
      resolveAppDataPaths(dependencies("linux", "/home/alice", env)),
      paths("/home/alice/.local/share/planview")
    );
  }
});

test("ignores a relative XDG_DATA_HOME instead of resolving storage below the cwd", () => {
  assert.deepEqual(
    resolveAppDataPaths(dependencies("linux", "/home/alice", { XDG_DATA_HOME: "relative-data" })),
    paths("/home/alice/.local/share/planview")
  );
});

test("uses macOS Application Support and ignores Linux and Windows variables", () => {
  assert.deepEqual(
    resolveAppDataPaths(
      dependencies("darwin", "/Users/alice", {
        XDG_DATA_HOME: "/tmp/not-used",
        LOCALAPPDATA: "C:\\not-used",
      })
    ),
    paths("/Users/alice/Library/Application Support/Planview")
  );
});

test("normalizes only the stable macOS system path aliases", () => {
  assert.equal(normalizeMacosSystemPath("/tmp/planview", "darwin"), "/private/tmp/planview");
  assert.equal(normalizeMacosSystemPath("/var/folders", "darwin"), "/private/var/folders");
  assert.equal(normalizeMacosSystemPath("/etc", "darwin"), "/private/etc");
  assert.equal(normalizeMacosSystemPath("/temporary", "darwin"), "/temporary");
  assert.equal(normalizeMacosSystemPath("/tmp/planview", "linux"), "/tmp/planview");
});

test("uses LOCALAPPDATA on Windows with Windows path semantics", () => {
  assert.deepEqual(
    resolveAppDataPaths(
      dependencies("win32", "C:\\Users\\alice", {
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      })
    ),
    paths("C:\\Users\\alice\\AppData\\Local\\Planview", "\\")
  );
});

test("uses the safe Windows local-data fallback when LOCALAPPDATA is absent or relative", () => {
  for (const env of [{}, { LOCALAPPDATA: "relative-data" }]) {
    assert.deepEqual(
      resolveAppDataPaths(dependencies("win32", "C:\\Users\\alice", env)),
      paths("C:\\Users\\alice\\AppData\\Local\\Planview", "\\")
    );
  }
});

test("uses the POSIX data fallback for other Unix-like platforms", () => {
  assert.deepEqual(
    resolveAppDataPaths(dependencies("freebsd", "/home/alice", { XDG_DATA_HOME: "/srv/data" })),
    paths("/srv/data/planview")
  );
});

test("rejects a relative injected home directory", () => {
  assert.throws(
    () => resolveAppDataPaths(dependencies("linux", "alice")),
    /home directory must be an absolute path/
  );
});
