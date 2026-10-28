import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
const OWNER_STAGES = [
  "start",
  "input_encoding",
  "output_encoding",
  "identity",
  "stdin",
  "acl",
  "output",
];
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
const OWNER_PATH_STATES = [
  "checking",
  "acl_lookup_failed",
  "owner_extraction_failed",
  "owner_mismatch",
  "match",
];
const OWNER_ERROR_CATEGORIES = [
  "ObjectNotFound",
  "PermissionDenied",
  "InvalidArgument",
  "InvalidData",
  "InvalidOperation",
  "SecurityError",
  "NotImplemented",
  "NotSpecified",
  "ResourceUnavailable",
  "ReadError",
  "MetadataError",
  "OpenError",
  "ParserError",
  "SyntaxError",
  "LimitsExceeded",
  "OperationStopped",
];
/** Numeric batch positions and fixed states only. Path digests never leave this comparison. */
const ownerPathDetails = (stderr: unknown, paths: readonly string[]) => {
  const results = paths.slice(0, 100).map((_, index) => ({
    index,
    state: "unknown",
    category: "none",
    pathMatches: null as boolean | null,
  }));
  for (const line of (typeof stderr === "string" ? stderr.slice(0, 64 * 1024) : "").split(
    /\r?\n/
  )) {
    const match = /^PVOWNER:path:([0-9]{1,3}):(state|category|digest):([A-Za-z0-9_]+)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const result = results[index];
    if (!result) continue;
    const value = match[3]!;
    if (match[2] === "state" && OWNER_PATH_STATES.includes(value)) result.state = value;
    if (match[2] === "category")
      result.category = OWNER_ERROR_CATEGORIES.includes(value) ? value : "other";
    if (match[2] === "digest" && /^[a-fA-F0-9]{64}$/.test(value))
      result.pathMatches =
        createHash("sha256").update(paths[index]!, "utf8").digest("hex") === value.toLowerCase();
  }
  return JSON.stringify(results);
};
// Node exposes no Windows file-owner SID. Query only ACL owner metadata in one
// bounded, hidden native helper; it never reads profile files or starts services.
const windowsOwners = async (
  paths: readonly string[],
  report?: (safeDiagnostic: string) => void
): Promise<readonly boolean[]> => {
  if (process.platform !== "win32" || paths.length === 0) return paths.map(() => true);
  // Preserve statement order and PowerShell error behavior while recording only
  // fixed stage labels. In particular, encoding setters still precede Stop.
  const script = `
[Console]::Error.WriteLine('PVOWNER:stage:start')
[Console]::Error.WriteLine('PVOWNER:stage:input_encoding')
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::Error.WriteLine('PVOWNER:stage:output_encoding')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('PVOWNER:stage:identity')
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owners = @($identity.User.Value, $identity.Owner.Value)
[Console]::Error.WriteLine('PVOWNER:stage:stdin')
$paths = ConvertFrom-Json ([Console]::In.ReadToEnd())
[Console]::Error.WriteLine('PVOWNER:stage:acl')
$ownerBatchIndex = -1
$result = @($paths | ForEach-Object {
  $ownerBatchIndex++
  $ownerPath = $_
  # This independent diagnostic never changes the path or ownership decision.
  try {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      $digest = [BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$ownerPath))).Replace('-', '').ToLowerInvariant()
      [Console]::Error.WriteLine('PVOWNER:path:' + $ownerBatchIndex + ':digest:' + $digest)
    } finally { $hasher.Dispose() }
  } catch { }
  [Console]::Error.WriteLine('PVOWNER:path:' + $ownerBatchIndex + ':state:checking')
  $ownerPathStage = 'acl_lookup'
  $ownerErrorCategory = 'none'
  try {
    $acl = Get-Acl -LiteralPath $ownerPath -ErrorAction Stop
    $ownerPathStage = 'owner_extraction'
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $ownerFlag = $owners -contains $ownerSid
    if ($ownerFlag) { $ownerPathState = 'match' }
    else { $ownerPathState = 'owner_mismatch' }
  } catch {
    $ownerPathState = $ownerPathStage + '_failed'
    $ownerErrorCategory = $_.CategoryInfo.Category
    $ownerFlag = $false
  }
  [Console]::Error.WriteLine('PVOWNER:path:' + $ownerBatchIndex + ':state:' + $ownerPathState)
  if ($ownerErrorCategory -ne 'none') { [Console]::Error.WriteLine('PVOWNER:path:' + $ownerBatchIndex + ':category:' + $ownerErrorCategory) }
  $ownerFlag
})
[Console]::Error.WriteLine('PVOWNER:stage:output')
ConvertTo-Json -InputObject $result -Compress`;

  const executable = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const started = performance.now();
  const result = await new Promise<{ output: string; diagnostic: string }>((accept, reject) => {
    const child = execFile(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        // WinPS must construct its own module path when reached through Node
        // from PowerShell 7. Leave the caller's environment unchanged.
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath")
        ),
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                `Could not verify Windows profile ownership with PowerShell. Safe diagnostic: ${ownerFailureDetails(
                  error,
                  stderr,
                  started
                )}. Safe path diagnostic: ${ownerPathDetails(stderr, paths)}. Directories may already exist after creation; inspect them before retrying. Profile operations never start a daemon.`
              )
            )
          : accept({ output: stdout, diagnostic: ownerPathDetails(stderr, paths) })
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(paths));
  });
  let flags: unknown;
  try {
    flags = JSON.parse(result.output.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Invalid Windows profile ownership response.");
  }
  if (
    !Array.isArray(flags) ||
    flags.length !== paths.length ||
    flags.some((value) => typeof value !== "boolean")
  )
    throw new Error("Invalid Windows profile ownership response.");
  report?.(result.diagnostic);
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
    let ownerDiagnostic = "";
    const ownerFlags = await windowsOwners([...existing.keys()], (value) => {
      ownerDiagnostic = value;
    });
    if (ownerFlags.some((flag) => !flag))
      throw new Error(
        `Profile roots must belong to the current Windows user or token owner. Safe path diagnostic: ${ownerDiagnostic}`
      );
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
