import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectFixtureDirectories, parseOwnerProbe } from "./windows-profile-owner-probe.mjs";

test("native fixture evidence separates command lookup, provider errors and direct ACL success without raw data", () => {
  const value = parseOwnerProbe(
    [
      "private path SID credential environment raw stderr",
      "PVPROBE:host:ps7ModulePath:1",
      "PVPROBE:check:host:getCommand:0:System.Management.Automation.CommandNotFoundException:none:0",
      "PVPROBE:path:0:verified:1",
      "PVPROBE:path:0:exists:1",
      "PVPROBE:check:0:getAcl:0:System.Management.Automation.ItemNotFoundException:none:0",
      "PVPROBE:check:0:dotNetAcl:1:none:none:1",
      "PVPROBE:check:1:getAcl:0:private.secret:private.secret:0",
      "PVPROBE:path:2:exists:1",
      "PVPROBE:path:9:exists:1",
      "PVPROBE:host:private:1",
    ].join("\n"),
    2
  );
  assert.equal(value.ps7ModulePath, true);
  assert.equal(value.getCommand.type, "System.Management.Automation.CommandNotFoundException");
  assert.equal(value.getCommand.ok, false);
  assert.equal(value.paths[0].verified, true);
  assert.equal(value.paths[0].exists, true);
  assert.equal(value.paths[0].getAcl.type, "System.Management.Automation.ItemNotFoundException");
  assert.deepEqual(value.paths[0].dotNetAcl, {
    ok: true,
    type: "none",
    inner: "none",
    ownerAccepted: true,
  });
  assert.equal(value.paths[1].getAcl.type, "other");
  assert.equal(value.paths.length, 2);
  for (const secret of ["private", "SID", "credential", "environment", "stderr"])
    assert.equal(JSON.stringify(value).includes(secret), false);
});

test("native probe parser is bounded and missing evidence stays unknown", () => {
  assert.equal(parseOwnerProbe({ secret: "not text" }, 1).getCommand.ok, null);
  assert.equal(
    parseOwnerProbe("x".repeat(64 * 1024) + "\nPVPROBE:path:0:verified:1", 1).paths[0].verified,
    null
  );
  assert.throws(() => parseOwnerProbe("", 4));
});

test("fixture queries require real directories below the owned scope and unchanged generations", () => {
  const fixture = mkdtempSync(join(tmpdir(), "native-owner-fixture-"));
  const outside = mkdtempSync(join(tmpdir(), "native-owner-outside-"));
  try {
    const path = join(fixture, "profile home é", "data");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const unchanged = inspectFixtureDirectories(fixture, [path]);
    unchanged();
    assert.throws(() => inspectFixtureDirectories(fixture, [outside]), /inside its owned fixture/);
    assert.throws(() => inspectFixtureDirectories(fixture, [fixture]), /inside its owned fixture/);
    const link = join(fixture, "linked");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => inspectFixtureDirectories(fixture, [link]), /refuses fixture links/);
    renameSync(path, `${path}-kept`);
    mkdirSync(path, { mode: 0o700 });
    assert.throws(unchanged, /generation changed/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("native comparison does not preload Get-Acl before its original lookup and recognizes the documented module path", () => {
  const source = readFileSync(
    new URL("./windows-profile-owner-probe.mjs", import.meta.url),
    "utf8"
  );
  assert.ok(source.indexOf("$acl = Get-Acl") < source.indexOf("$command = Get-Command"));
  assert.ok(!source.includes("ConvertFrom-Json") && !source.includes("ConvertTo-Json"));
  const pattern = /-match '([^']+)'/.exec(source)[1];
  assert.ok(
    new RegExp(pattern, "i").test("C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\System32")
  );
  assert.equal(
    new RegExp(pattern, "i").test("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules"),
    false
  );
});
