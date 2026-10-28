import { execFile } from "node:child_process";
import { type Stats } from "node:fs";
import { lstat, mkdir, opendir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  isValidProfileName,
  normalizeMacosSystemPath,
  resolveAppDataPaths,
  validateProfileName,
  type AppDataPathDependencies,
} from "@planview/core";
import { resolveDaemonPaths, type DaemonConfig } from "./configuration.js";

export const PROFILE_SCAN_LIMIT = 256;
export const PROFILE_LIST_LIMIT = 100;
export type ProfileLocation = Readonly<{
  name: string;
  appDataDir: string;
  runtimeDir: string;
  present: boolean;
}>;
export type ProfileCatalog = Readonly<{
  current: ProfileLocation;
  scope: "managed" | "isolated_override";
  profiles: readonly Readonly<{
    name: string;
    selected: boolean;
    present: boolean;
    daemon: "not_checked";
  }>[];
  scannedEntries: number;
  skippedEntries: number;
  limited: boolean;
}>;
export type ProfilePlan = Readonly<{
  target: ProfileLocation;
  launchCommand: string;
  openCommand: string;
  createCommand: string;
  requiresCleanEnvironment: true;
  message: string;
}>;
const OWNER_INPUT_LIMIT = 64 * 1024;
const OWNER_STAGES = ["streams", "input", "identity", "acl", "output", "cleanup"];
const ownerInput = (paths: readonly string[]) => {
  if (paths.length < 1 || paths.length > 100)
    throw new Error("Windows profile ownership supports one to 100 paths per batch.");
  const lines: string[] = [];
  let size = String(paths.length).length + 1;
  for (const path of paths) {
    if (typeof path !== "string" || !path || path.includes("\0"))
      throw new Error("Invalid Windows profile ownership path.");
    size += 4 * Math.ceil(Buffer.byteLength(path, "utf8") / 3) + 1;
    if (size > OWNER_INPUT_LIMIT)
      throw new Error("Windows profile ownership input exceeds the 64 KiB batch limit.");
    const bytes = Buffer.from(path, "utf8");
    if (bytes.toString("utf8") !== path)
      throw new Error("Invalid Windows profile ownership path encoding.");
    lines.push(bytes.toString("base64"));
  }
  const input = `${paths.length}\n${lines.join("\n")}\n`;
  return input;
};
/** Fixed vocabulary only: never return subprocess messages, commands, input or raw stderr. */
const ownerFailureDetails = (error: unknown, stderr: unknown, started: number) => {
  const fields = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const allowedCodes = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "EINVAL",
    "ENOEXEC",
    "ETIMEDOUT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
  ];
  const code =
    typeof fields["code"] === "number" &&
    Number.isSafeInteger(fields["code"]) &&
    fields["code"] >= -2147483648 &&
    fields["code"] <= 4294967295
      ? fields["code"]
      : typeof fields["code"] === "string" && allowedCodes.includes(fields["code"])
        ? (fields["code"] as string)
        : "other";
  const signal =
    typeof fields["signal"] === "string" &&
    ["SIGTERM", "SIGKILL", "SIGABRT", "SIGINT"].includes(fields["signal"])
      ? (fields["signal"] as string)
      : fields["signal"] == null
        ? "none"
        : "other";
  const killed = fields["killed"] === true;
  let stage = "unknown";
  for (const line of (typeof stderr === "string" ? stderr.slice(0, 64 * 1024) : "").split(
    /\r?\n/
  )) {
    const match = /^PVOWNER:stage:([a-z_]+)$/.exec(line);
    if (match && OWNER_STAGES.includes(match[1]!)) stage = match[1]!;
  }
  const category = ["ENOENT", "EACCES", "EPERM", "EINVAL", "ENOEXEC"].includes(String(code))
    ? "launch"
    : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "output_limit"
      : killed || (signal !== "none" && signal !== "other")
        ? "terminated"
        : typeof code === "number"
          ? "exit"
          : "other";
  return JSON.stringify({
    category,
    code,
    signal,
    killed,
    elapsedMs: Math.min(60000, Math.max(0, Math.round(performance.now() - started))),
    stage,
  });
};
// Node exposes no Windows owner SID. Use only .NET filesystem/stream APIs in
// one hidden WinPS 5.1 helper, with no module or Console text-wrapper bootstrap.
const windowsOwners = async (paths: readonly string[]): Promise<readonly boolean[]> => {
  if (process.platform !== "win32" || paths.length === 0) return paths.map(() => true);
  const input = ownerInput(paths);
  const script = `
$ErrorActionPreference = 'Stop'
$standardInput = $null
$standardOutput = $null
$standardError = $null
$identity = $null
$completed = $false
function Mark($stage) {
  $marker = [System.Text.Encoding]::ASCII.GetBytes('PVOWNER:stage:' + $stage + [char]10)
  $standardError.Write($marker, 0, $marker.Length)
  $standardError.Flush()
}
try {
  $standardError = [Console]::OpenStandardError()
  Mark 'streams'
  $standardInput = [Console]::OpenStandardInput()
  $standardOutput = [Console]::OpenStandardOutput()
  Mark 'input'
  $buffer = [byte[]]::new(${OWNER_INPUT_LIMIT + 1})
  $total = 0
  while ($total -lt $buffer.Length) {
    $read = $standardInput.Read($buffer, $total, $buffer.Length - $total)
    if ($read -eq 0) { break }
    $total += $read
  }
  if ($total -gt ${OWNER_INPUT_LIMIT}) { throw [System.FormatException]::new() }
  for ($i = 0; $i -lt $total; $i++) {
    if ($buffer[$i] -gt 127) { throw [System.FormatException]::new() }
  }
  $lines = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $total).Split([char]10)
  if ($lines[0] -cnotmatch '^[1-9][0-9]{0,2}$') { throw [System.FormatException]::new() }
  $count = [int]$lines[0]
  if ($count -gt 100 -or $lines.Length -ne ($count + 2) -or $lines[$count + 1] -cne '') { throw [System.FormatException]::new() }
  $decoded = [string[]]::new($count)
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  for ($i = 0; $i -lt $count; $i++) {
    $encoded = $lines[$i + 1]
    $bytes = [Convert]::FromBase64String($encoded)
    if ([Convert]::ToBase64String($bytes) -cne $encoded) { throw [System.FormatException]::new() }
    $path = $utf8.GetString($bytes)
    if ($path.Length -eq 0 -or $path.IndexOf([char]0) -ge 0) { throw [System.FormatException]::new() }
    $decoded[$i] = $path
  }
  Mark 'identity'
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $owners = @($identity.User.Value, $identity.Owner.Value)
  $flags = [string[]]::new($count)
  Mark 'acl'
  for ($i = 0; $i -lt $count; $i++) {
    $accepted = $false
    try {
      $acl = [System.IO.Directory]::GetAccessControl($decoded[$i], [System.Security.AccessControl.AccessControlSections]::Owner)
      $sid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
      $accepted = $owners -contains $sid
    } catch { $accepted = $false }
    if ($accepted) { $flags[$i] = 'true' } else { $flags[$i] = 'false' }
  }
  Mark 'output'
  $response = [System.Text.Encoding]::ASCII.GetBytes('[' + [string]::Join(',', $flags) + ']')
  $standardOutput.Write($response, 0, $response.Length)
  $standardOutput.Flush()
  Mark 'cleanup'
  $completed = $true
} catch { $completed = $false }
finally {
  foreach ($resource in @($identity, $standardInput, $standardOutput, $standardError)) {
    if ($null -ne $resource) {
      try { $resource.Dispose() } catch { $completed = $false }
    }
  }
}
if (-not $completed) { exit 1 }
`;
  const executable = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const started = performance.now();
  const failure = (error: unknown, stderr: unknown) =>
    new Error(
      `Could not verify Windows profile ownership with PowerShell. Safe diagnostic: ${ownerFailureDetails(error, stderr, started)}. Directories may already exist after creation; inspect them before retrying. Profile operations never start a daemon.`
    );
  const result = await new Promise<string>((accept, reject) => {
    let inputFailed = false;
    let child: ReturnType<typeof execFile> | undefined;
    try {
      child = execFile(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          // Preserve the caller; WinPS constructs its own module search path.
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")
          ),
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) reject(failure(error, stderr));
          else if (inputFailed)
            reject(new Error("Could not send Windows profile ownership input."));
          else accept(stdout);
        }
      );
      if (!child.stdin) {
        child.kill();
        reject(new Error("Could not send Windows profile ownership input."));
        return;
      }
      child.stdin.on("error", () => {
        inputFailed = true;
      });
      child.stdin.end(input, "ascii");
    } catch (error) {
      try {
        child?.kill();
      } catch {
        /* Keep subprocess details private. */
      }
      reject(failure(error, ""));
    }
  });
  // Only the complete canonical boolean array may authorize any path. Process
  // failure is rejected above even if it left apparently valid partial output.
  if (!/^\[(?:true|false)(?:,(?:true|false))*\]$/.test(result))
    throw new Error("Invalid Windows profile ownership response.");
  const flags = JSON.parse(result) as boolean[];
  if (flags.length !== paths.length) throw new Error("Invalid Windows profile ownership response.");
  return flags;
};
const canonical = (path: string) => normalizeMacosSystemPath(resolve(path));
const missing = (error: unknown) =>
  !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const directory = async (path: string, owned: boolean): Promise<Stats | undefined> => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error("Profile paths must be real directories, never symlinks or junctions.");
  if (process.platform !== "win32") {
    if (owned && process.getuid && stats.uid !== process.getuid())
      throw new Error("Profile directories must be owned by the current user.");
    if ((stats.mode & 0o022) !== 0 && !(stats.mode & 0o1000))
      throw new Error("Profile ancestors must not be writable by other users.");
    if (owned && (stats.mode & 0o077) !== 0)
      throw new Error("Profile directories must be private to the current user.");
  }
  return stats;
};
/** Inspect every ancestor without following links. No files, descriptors, databases or credentials are opened. */
const checkedDirectory = async (path: string, privateLeaf = true) => {
  const chain: string[] = [];
  for (let current = canonical(path); ; current = dirname(current)) {
    if (chain.length >= 64)
      throw new Error("Profile discovery supports at most 64 path ancestors.");
    chain.unshift(current);
    if (current === parse(current).root) break;
  }
  let last: Stats | undefined;
  for (const current of chain) {
    last = await directory(current, privateLeaf && current === canonical(path));
    if (!last) return undefined;
  }
  return last;
};
const unchanged = async (path: string, before: Stats) => {
  const after = await checkedDirectory(path);
  if (!after || after.dev !== before.dev || after.ino !== before.ino)
    throw new Error("Profile directory changed during discovery. Try again.");
};
const limitValue = (limit = 50) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROFILE_LIST_LIMIT)
    throw new Error("Profile list limit must be an integer from 1 to 100.");
  return limit;
};

/** Shared offline operations. A browser may discover and plan; only the native host exposes create. */
export const createProfileOperations = (
  config: Pick<DaemonConfig, "profile" | "appDataDir" | "runtimeDir">,
  paths: Partial<AppDataPathDependencies> = {}
) => {
  resolveDaemonPaths(config);
  const name = validateProfileName(config.profile);
  const root = canonical(
    resolveAppDataPaths({ ...paths, profile: DEFAULT_PROFILE_NAME }).appDataDir
  );
  const managedPath = (profile: string) =>
    profile === DEFAULT_PROFILE_NAME ? root : join(root, "profiles", profile);
  const managed =
    canonical(config.appDataDir) === managedPath(name) &&
    canonical(config.runtimeDir) === join(managedPath(name), "runtime");
  const location = async (profile: string): Promise<ProfileLocation> => {
    validateProfileName(profile);
    if (!managed && profile !== name)
      throw new Error(
        "This profile uses a custom storage/runtime override. Discover and select other profiles from a terminal without PLANVIEW_APP_DATA_DIR, PLANVIEW_DATA_DIR or PLANVIEW_RUNTIME_DIR overrides."
      );
    const appDataDir = managed ? managedPath(profile) : canonical(config.appDataDir);
    if (managed) {
      await checkedDirectory(root);
      if (profile !== DEFAULT_PROFILE_NAME) await checkedDirectory(join(root, "profiles"));
    }
    const present = (await checkedDirectory(appDataDir)) !== undefined;
    const runtimeDir =
      profile === name ? canonical(config.runtimeDir) : join(appDataDir, "runtime");
    const runtime = await checkedDirectory(runtimeDir);
    const owned = managed
      ? [
          root,
          ...(profile === DEFAULT_PROFILE_NAME ? [] : [join(root, "profiles")]),
          ...(profile === DEFAULT_PROFILE_NAME ? [] : [appDataDir]),
        ]
      : [appDataDir];
    if (runtime) owned.push(runtimeDir);
    const existing = new Map<string, Stats>();
    for (const path of new Set(owned)) {
      const observation = await directory(path, true);
      if (observation) existing.set(path, observation);
    }
    if ((await windowsOwners([...existing.keys()])).some((flag) => !flag))
      throw new Error("Profile roots must belong to the current Windows user or token owner.");
    // The native ACL helper yields. Recheck the same directories before a caller
    // uses this location, including current-profile descriptor inspection.
    for (const [path, observation] of existing) await unchanged(path, observation);
    return { name: profile, appDataDir, runtimeDir, present };
  };
  const current = () => location(name);
  const list = async (limit = 50): Promise<ProfileCatalog> => {
    limitValue(limit);
    const selected = await current();
    const base = {
      current: selected,
      scope: managed ? ("managed" as const) : ("isolated_override" as const),
    };
    if (!managed)
      return {
        ...base,
        profiles: [{ name, selected: true, present: selected.present, daemon: "not_checked" }],
        scannedEntries: 0,
        skippedEntries: 0,
        limited: false,
      };
    const rootStats = await checkedDirectory(root);
    const profiles = [
      {
        name: DEFAULT_PROFILE_NAME,
        selected: name === DEFAULT_PROFILE_NAME,
        present: rootStats !== undefined,
        daemon: "not_checked" as const,
      },
    ];
    const observations = new Map<string, Stats>();
    if (rootStats) observations.set(DEFAULT_PROFILE_NAME, rootStats);
    const profilesRoot = join(root, "profiles");
    const parentStats = await checkedDirectory(profilesRoot);
    let scannedEntries = 0,
      skippedEntries = 0,
      limited = false;
    if (parentStats) {
      const handle = await opendir(profilesRoot, { bufferSize: 1 });
      try {
        for (;;) {
          if (scannedEntries >= PROFILE_SCAN_LIMIT) {
            limited = true;
            break;
          }
          const entry = await handle.read();
          if (!entry) break;
          scannedEntries++;
          if (profiles.length >= limit) {
            limited = true;
            break;
          }
          if (
            !isValidProfileName(entry.name) ||
            entry.name === DEFAULT_PROFILE_NAME ||
            !entry.isDirectory() ||
            entry.isSymbolicLink()
          ) {
            skippedEntries++;
            continue;
          }
          try {
            const observation = await directory(join(profilesRoot, entry.name), true);
            if (!observation) {
              skippedEntries++;
              continue;
            }
            observations.set(entry.name, observation);
            profiles.push({
              name: entry.name,
              selected: entry.name === name,
              present: true,
              daemon: "not_checked",
            });
          } catch {
            skippedEntries++;
          }
        }
      } finally {
        await handle.close();
      }
    }
    const owned = await windowsOwners(
      profiles
        .map((profile) => managedPath(profile.name))
        .filter((_, index) => profiles[index]?.present)
    );
    let ownerIndex = 0;
    const safeProfiles: ProfileCatalog["profiles"][number][] = [];
    for (const profile of profiles) {
      if (!profile.present) {
        safeProfiles.push(profile);
        continue;
      }
      if (!owned[ownerIndex++]) {
        skippedEntries++;
        continue;
      }
      const observation = observations.get(profile.name);
      try {
        if (!observation) throw new Error("Missing directory observation.");
        await unchanged(managedPath(profile.name), observation);
        safeProfiles.push(profile);
      } catch {
        skippedEntries++;
      }
    }
    if (parentStats) await unchanged(profilesRoot, parentStats);
    if (rootStats) await unchanged(root, rootStats);
    safeProfiles.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return { ...base, profiles: safeProfiles, scannedEntries, skippedEntries, limited };
  };
  const plan = async (targetName: string): Promise<ProfilePlan> => {
    if (!managed)
      throw new Error(
        "Cross-profile instructions are unavailable with custom storage/runtime overrides. Use a terminal with the intended environment; no global selection has changed."
      );
    const target = await location(targetName);
    const prefix = `plansplease --profile ${target.name}`;
    return {
      target,
      launchCommand: `${prefix} ui`,
      openCommand: `${prefix} ui --open`,
      createCommand: `plansplease profiles create ${target.name}`,
      requiresCleanEnvironment: true,
      message:
        "Run in a terminal without app-data/runtime overrides. This selects only that invocation, creates missing profile storage and starts or reuses its daemon. --open explicitly opens its manager. Other profiles and their preview links keep running; stop each deliberately with --profile NAME stop. No global default changes.",
    };
  };
  const create = async (targetName: string) => {
    const target = await location(targetName);
    if (target.present) return { ...target, created: false };
    const chain = [target.appDataDir];
    while (!(await checkedDirectory(dirname(chain[0]!), false))) chain.unshift(dirname(chain[0]!));
    let created = false;
    for (const path of chain) {
      await checkedDirectory(dirname(path), false);
      try {
        await mkdir(path, { mode: 0o700 });
        if (path === target.appDataDir) created = true;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
          throw error;
      }
      await checkedDirectory(path);
    }
    return { ...(await location(targetName)), created };
  };
  return { current, list, plan, create };
};
export type ProfileOperations = ReturnType<typeof createProfileOperations>;
