// Native CI-only comparison on exact, generation-checked fixture directories.
// Never query arbitrary paths or return raw stdout/stderr, paths, SIDs or env.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const TYPES = [
  "none",
  "other",
  "System.Management.Automation.CommandNotFoundException",
  "System.Management.Automation.ItemNotFoundException",
  "System.Management.Automation.ProviderInvocationException",
  "System.Management.Automation.CmdletInvocationException",
  "System.Management.Automation.MethodInvocationException",
  "System.IO.DirectoryNotFoundException",
  "System.IO.FileNotFoundException",
  "System.IO.PathTooLongException",
  "System.UnauthorizedAccessException",
  "System.Security.SecurityException",
  "System.InvalidOperationException",
  "System.NotSupportedException",
  "System.TypeInitializationException",
];

export function inspectFixtureDirectories(workspace, paths) {
  assert.ok(paths.length > 0 && paths.length <= 3, "Probe accepts at most three fixture roots.");
  const scope = resolve(workspace);
  const observations = new Map();
  for (const path of paths) {
    const offset = relative(scope, resolve(path));
    assert.ok(
      offset &&
        !isAbsolute(offset) &&
        offset !== ".." &&
        !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
      "Probe path must be inside its owned fixture."
    );
    let depth = 0;
    for (let current = resolve(path); ; current = dirname(current)) {
      assert.ok(++depth <= 64, "Probe fixture ancestors exceed the metadata bound.");
      let stats;
      try {
        stats = lstatSync(current);
      } catch {
        throw new Error("Probe fixture directory is missing or inaccessible.");
      }
      assert.ok(
        stats.isDirectory() && !stats.isSymbolicLink(),
        "Probe refuses fixture links or non-directories."
      );
      observations.set(current, { dev: stats.dev, ino: stats.ino });
      if (relative(scope, current) === "") break;
    }
  }
  return () => {
    for (const [path, before] of observations) {
      let after;
      try {
        after = lstatSync(path);
      } catch {
        throw new Error("Probe fixture directory disappeared.");
      }
      assert.ok(
        after.isDirectory() &&
          !after.isSymbolicLink() &&
          after.dev === before.dev &&
          after.ino === before.ino,
        "Probe fixture directory generation changed."
      );
    }
  };
}

export function parseOwnerProbe(stdout, count) {
  assert.ok(Number.isInteger(count) && count > 0 && count <= 3);
  const check = () => ({ ok: null, type: "none", inner: "none", ownerAccepted: null });
  const result = {
    windowsPowerShell5: null,
    modulePathPresent: null,
    ps7ModulePath: null,
    winpsModulePath: null,
    securityCommandModule: null,
    getCommand: check(),
    paths: Array.from({ length: count }, (_, index) => ({
      index,
      verified: null,
      exists: null,
      getAcl: check(),
      dotNetAcl: check(),
    })),
  };
  for (const line of (typeof stdout === "string" ? stdout.slice(0, 64 * 1024) : "").split(
    /\r?\n/
  )) {
    const host =
      /^PVPROBE:host:(windowsPowerShell5|modulePathPresent|ps7ModulePath|winpsModulePath|securityCommandModule):(0|1)$/.exec(
        line
      );
    if (host) {
      result[host[1]] = host[2] === "1";
      continue;
    }
    const path = /^PVPROBE:path:([0-2]):(verified|exists):(0|1)$/.exec(line);
    if (path && result.paths[Number(path[1])]) {
      result.paths[Number(path[1])][path[2]] = path[3] === "1";
      continue;
    }
    const outcome =
      /^PVPROBE:check:(host|[0-2]):(getCommand|getAcl|dotNetAcl):(0|1):([A-Za-z.]+):([A-Za-z.]+):(0|1)$/.exec(
        line
      );
    if (!outcome) continue;
    const target =
      outcome[1] === "host"
        ? outcome[2] === "getCommand"
          ? result.getCommand
          : undefined
        : outcome[2] !== "getCommand"
          ? result.paths[Number(outcome[1])]?.[outcome[2]]
          : undefined;
    if (!target) continue;
    target.ok = outcome[3] === "1";
    target.type = TYPES.includes(outcome[4]) ? outcome[4] : "other";
    target.inner = TYPES.includes(outcome[5]) ? outcome[5] : "other";
    target.ownerAccepted = outcome[6] === "1";
  }
  return result;
}

// No JSON/module cmdlets for transport: Get-Command/Get-Acl are the subjects.
// All directory queries occur only after decoded path checksum equality.
const SCRIPT = String.raw`
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
function Bit($value) { if ($value) { return '1' } else { return '0' } }
function SafeType($exception) {
  if ($null -eq $exception) { return 'none' }
  $name = $exception.GetType().FullName
  if ($name -in @('System.Management.Automation.CommandNotFoundException','System.Management.Automation.ItemNotFoundException','System.Management.Automation.ProviderInvocationException','System.Management.Automation.CmdletInvocationException','System.Management.Automation.MethodInvocationException','System.IO.DirectoryNotFoundException','System.IO.FileNotFoundException','System.IO.PathTooLongException','System.UnauthorizedAccessException','System.Security.SecurityException','System.InvalidOperationException','System.NotSupportedException','System.TypeInitializationException')) { return $name }
  return 'other'
}
function EmitCheck($position, $kind, $ok, $exception, $accepted) {
  $type = SafeType $exception
  $inner = 'none'
  if ($null -ne $exception) { $inner = SafeType $exception.InnerException }
  [Console]::Out.WriteLine('PVPROBE:check:' + $position + ':' + $kind + ':' + (Bit $ok) + ':' + $type + ':' + $inner + ':' + (Bit $accepted))
}
[Console]::Out.WriteLine('PVPROBE:host:windowsPowerShell5:' + (Bit ($PSVersionTable.PSVersion.Major -eq 5)))
[Console]::Out.WriteLine('PVPROBE:host:modulePathPresent:' + (Bit (-not [string]::IsNullOrEmpty($env:PSModulePath))))
[Console]::Out.WriteLine('PVPROBE:host:ps7ModulePath:' + (Bit ($env:PSModulePath -match '\\PowerShell\\7\\Modules(?:;|$)')))
[Console]::Out.WriteLine('PVPROBE:host:winpsModulePath:' + (Bit (($env:PSModulePath -split ';') -contains ($PSHOME + '\Modules'))))
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owners = @($identity.User.Value, $identity.Owner.Value)
$lines = [Console]::In.ReadToEnd().Split([char]10)
$position = -1
foreach ($line in $lines) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $position++
  $parts = $line.TrimEnd([char]13).Split([char]':', 2)
  $path = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($path))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  $verified = $digest -eq $parts[0]
  [Console]::Out.WriteLine('PVPROBE:path:' + $position + ':verified:' + (Bit $verified))
  if (-not $verified) { continue }
  [Console]::Out.WriteLine('PVPROBE:path:' + $position + ':exists:' + (Bit ([System.IO.Directory]::Exists($path))))
  try {
    $acl = Get-Acl -LiteralPath $path -ErrorAction Stop
    $sid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    EmitCheck $position 'getAcl' $true $null ($owners -contains $sid)
  } catch { EmitCheck $position 'getAcl' $false $_.Exception $false }
  try {
    $acl = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Owner)
    $sid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    EmitCheck $position 'dotNetAcl' $true $null ($owners -contains $sid)
  } catch { EmitCheck $position 'dotNetAcl' $false $_.Exception $false }
}
try {
  $command = Get-Command -Name Get-Acl -CommandType Cmdlet -ErrorAction Stop
  [Console]::Out.WriteLine('PVPROBE:host:securityCommandModule:' + (Bit ($command.ModuleName -eq 'Microsoft.PowerShell.Security')))
  EmitCheck 'host' 'getCommand' $true $null $false
} catch { EmitCheck 'host' 'getCommand' $false $_.Exception $false }
`;

export function probeWindowsFixtureOwners({ workspace, paths, env }) {
  assert.equal(process.platform, "win32", "This probe requires native Windows.");
  const unchanged = inspectFixtureDirectories(workspace, paths);
  const clean = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toLowerCase() !== "psmodulepath")
  );
  const input = paths
    .map(
      (path) =>
        `${createHash("sha256").update(path).digest("hex")}:${Buffer.from(path).toString("base64")}`
    )
    .join("\n");
  const variants = [];
  for (const [name, childEnv] of [
    ["inherited", env],
    ["default_module_path", clean],
  ]) {
    unchanged();
    const started = performance.now();
    const child = spawnSync(
      join(
        env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64"),
      ],
      {
        env: childEnv,
        input,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      }
    );
    unchanged();
    variants.push({
      name,
      completed: child.status === 0 && !child.error,
      elapsedMs: Math.min(60000, Math.max(0, Math.round(performance.now() - started))),
      ...parseOwnerProbe(child.stdout, paths.length),
    });
  }
  const evidence = {
    fixtureOwnerProbe: true,
    paths: paths.map((path, index) => ({
      index,
      length: path.length,
      extendedPrefix: path.startsWith("\\\\?\\"),
      unicode: Array.from(path).some((character) => character.codePointAt(0) > 127),
    })),
    variants,
  };
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  assert.ok(
    variants.every(
      (value) => value.completed && value.paths.every((path) => path.verified === true)
    ),
    "Native owner probe did not complete with exact fixture input."
  );
}
