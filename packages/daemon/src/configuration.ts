import { isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  DEFAULT_PROFILE_NAME,
  resolveAppDataPaths,
  V1_PORT,
  validateProfileName,
} from "@planview/core";
import { Data } from "effect";

export const DAEMON_HOST = "127.0.0.1" as const;
/** Preferred listener port for the public CLI. */
export const DAEMON_PORT = V1_PORT;
export const DAEMON_DESCRIPTOR_NAME = "daemon.json";
export const DAEMON_LOCK_NAME = "lifecycle.lock";

const TEST_PORT_ENV = "PLANVIEW_TEST_DAEMON_PORT";
export const LIFECYCLE_TOKEN_ENV = "PLANVIEW_DAEMON_LIFECYCLE_TOKEN";
const STRICT_PORT_ENV = "PLANVIEW_DAEMON_STRICT_PORT";
export const TEST_ADOPTION_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_ADOPTION_PAUSE_MS";
export const TEST_PUBLISH_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS";
export const TEST_PUBLISH_PAUSE_ONCE_ENV = "PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_ONCE";
export const TEST_UNCOOPERATIVE_PUBLISH_ENV = "PLANVIEW_TEST_DAEMON_UNCOOPERATIVE_PUBLISH";
export const TEST_CLEANUP_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_CLEANUP_PAUSE_MS";

// Detached daemons inherit platform variables needed by Node and native tools,
// but not credentials or Node flags.
const SAFE_RUNTIME_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "ComSpec",
] as const;
const TEST_DAEMON_ENVIRONMENT_KEYS = [
  TEST_ADOPTION_PAUSE_ENV,
  TEST_PUBLISH_PAUSE_ENV,
  TEST_PUBLISH_PAUSE_ONCE_ENV,
  TEST_UNCOOPERATIVE_PUBLISH_ENV,
  TEST_CLEANUP_PAUSE_ENV,
] as const;

export type DaemonPathOptions = Readonly<{
  readonly appDataDir?: string;
  readonly profile?: string;
  readonly runtimeDir?: string;
}>;

export type DaemonPaths = Readonly<{
  readonly appDataDir: string;
  readonly runtimeDir: string;
  readonly descriptorPath: string;
  readonly lockPath: string;
}>;

export type DaemonConfig = Readonly<{
  readonly appDataDir: string;
  readonly profile: string;
  readonly runtimeDir: string;
  readonly host: typeof DAEMON_HOST;
  readonly port: number;
  readonly strictPort: boolean;
  readonly testOnly: boolean;
}>;

export type DaemonConfigOptions = DaemonPathOptions &
  Readonly<{
    readonly strictPort?: boolean;
  }>;

/** @internal Test-only configuration; the public daemon port remains fixed. */
export type DaemonTestConfigOptions = DaemonPathOptions &
  Readonly<{
    readonly port: number;
    readonly strictPort?: boolean;
  }>;

export class DaemonPathError extends Data.TaggedError("DaemonPathError")<{
  readonly path: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export const resolveDaemonEnvironment = (
  config: Pick<DaemonConfig, "appDataDir" | "runtimeDir" | "port"> &
    Partial<Pick<DaemonConfig, "profile" | "strictPort" | "testOnly">>,
  lifecycleToken: string,
  source: Readonly<Record<string, string | undefined>> = process.env
) => {
  const environment: Record<string, string> = {
    PLANVIEW_APP_DATA_DIR: config.appDataDir,
    PLANVIEW_PROFILE: config.profile ?? DEFAULT_PROFILE_NAME,
    PLANVIEW_RUNTIME_DIR: config.runtimeDir,
    [STRICT_PORT_ENV]: String(config.strictPort ?? false),
    [LIFECYCLE_TOKEN_ENV]: lifecycleToken,
  };
  for (const key of SAFE_RUNTIME_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  const testProcess =
    config.testOnly === true || (config.testOnly === undefined && source["NODE_ENV"] === "test");
  if (testProcess) {
    environment["NODE_ENV"] = "test";
    environment[TEST_PORT_ENV] = String(config.port);
    for (const key of TEST_DAEMON_ENVIRONMENT_KEYS) {
      const value = source[key];
      if (value !== undefined) {
        environment[key] = value;
      }
    }
  }
  return environment;
};

const envValue = (env: Readonly<Record<string, string | undefined>>, ...keys: string[]) => {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
};

const booleanEnvironmentValue = (value: string | undefined, label: string) => {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${label} must be true or false.`);
};

const validateAbsolutePath = (value: string, label: string) => {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root) {
    throw new DaemonPathError({
      path: value,
      message: `${label} must be an absolute path below a filesystem root.`,
    });
  }
  return resolve(value);
};

const validatePort = (port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("The daemon port must be an integer between 1 and 65535.");
  }
  return port;
};

export const isContainedPath = (root: string, child: string) => {
  const childRelativePath = relative(root, child);
  return (
    childRelativePath !== "" &&
    !childRelativePath.startsWith("..") &&
    !isAbsolute(childRelativePath)
  );
};

export const resolveDaemonPaths = (options: DaemonPathOptions = {}) => {
  const appDataDir = validateAbsolutePath(
    options.appDataDir ??
      resolveAppDataPaths({
        ...(options.profile === undefined ? {} : { profile: options.profile }),
      }).appDataDir,
    "The Planview app-data directory"
  );
  const runtimeDir = validateAbsolutePath(
    options.runtimeDir ?? join(appDataDir, "runtime"),
    "The Planview runtime directory"
  );
  if (!isContainedPath(appDataDir, runtimeDir)) {
    throw new DaemonPathError({
      path: runtimeDir,
      message: "The Planview runtime directory must be contained below app-data.",
    });
  }

  return {
    appDataDir,
    runtimeDir,
    descriptorPath: join(runtimeDir, DAEMON_DESCRIPTOR_NAME),
    lockPath: join(runtimeDir, DAEMON_LOCK_NAME),
  } satisfies DaemonPaths;
};

const resolveConfig = (
  options: DaemonConfigOptions,
  env: Readonly<Record<string, string | undefined>>,
  port: number,
  testOnly: boolean
) => {
  const profile = validateProfileName(
    options.profile ?? envValue(env, "PLANVIEW_PROFILE") ?? DEFAULT_PROFILE_NAME
  );
  const appDataDir =
    options.appDataDir ?? envValue(env, "PLANVIEW_APP_DATA_DIR", "PLANVIEW_DATA_DIR");
  const runtimeDir = options.runtimeDir ?? envValue(env, "PLANVIEW_RUNTIME_DIR");
  const paths = resolveDaemonPaths({
    appDataDir: appDataDir ?? resolveAppDataPaths({ profile, env }).appDataDir,
    profile,
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
  });
  const strictPort =
    options.strictPort ??
    booleanEnvironmentValue(envValue(env, STRICT_PORT_ENV), STRICT_PORT_ENV) ??
    testOnly;

  return {
    ...paths,
    profile,
    host: DAEMON_HOST,
    port: validatePort(port),
    strictPort,
    testOnly,
  } satisfies DaemonConfig & DaemonPaths;
};

export const resolveDaemonConfig = (
  options: DaemonConfigOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env
) => resolveConfig(options, env, DAEMON_PORT, false);

/** @internal Test-only port injection; production configuration always uses 4777. */
export const resolveDaemonConfigForTest = (
  options: DaemonTestConfigOptions,
  env: Readonly<Record<string, string | undefined>> = process.env
) => resolveConfig(options, env, options.port, true);
