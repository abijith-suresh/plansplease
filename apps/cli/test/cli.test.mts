import assert from "node:assert/strict";
import {
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Exit } from "effect";
import { formatHelp, main, openUrl, parseGetReference, run } from "../dist/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cli = resolve(packageRoot, "dist/index.js");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

type OutputMessage = string | Uint8Array;
type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };
type DocumentMetadata = { readonly createdAt: number; readonly lastAccessedAt: number };
type SqliteRow = Readonly<{
  readonly createdAt?: unknown;
  readonly lastAccessedAt?: unknown;
}>;
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

const removeFixture = (path: string): Promise<void> =>
  rm(path, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 });

const temporaryBundleDirectories = () =>
  new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("planview-bundle-"))
      .map((entry) => entry.name)
  );

const waitFor = async <T,>(
  condition: () => T | false | undefined | PromiseLike<T | false | undefined>,
  timeout = 10_000
): Promise<T> => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch {
      // The fixture may not have been created yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for daemon lifecycle state.");
};

const waitForExit = (child: ChildProcess, timeout = 10_000): Promise<ChildExit> =>
  new Promise<ChildExit>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for starter process exit."));
    }, timeout);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });

const execute = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });

const readDocumentMetadata = (database: DatabaseSync, id: string): DocumentMetadata | undefined => {
  const row = database
    .prepare("SELECT createdAt, lastAccessedAt FROM documents WHERE id = :id")
    .get({ ":id": id }) as SqliteRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const createdAt = row.createdAt;
  const lastAccessedAt = row.lastAccessedAt;
  return typeof createdAt === "number" && typeof lastAccessedAt === "number"
    ? { createdAt, lastAccessedAt }
    : undefined;
};

const documentIdFromUrl = (url: string): string => {
  const id = url.split("/").at(-1);
  if (id === undefined) {
    throw new Error(`Expected a document id in ${url}.`);
  }
  return id;
};

const collectOutput =
  (target: string[]) =>
  (message: OutputMessage): void => {
    target.push(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
  };

test("--help and -h produce the same deterministic output", () => {
  const long = execute("--help");
  const short = execute("-h");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, short.stdout);
  assert.match(long.stdout, /^Usage: plansplease \[global-options\] <command>/);
});

test("help exposes the root and command-specific documentation", () => {
  const root = execute("help");
  assert.equal(root.status, 0, root.stderr);
  assert.equal(root.stderr, "");
  assert.equal(root.stdout, formatHelp());

  for (const command of [
    "publish",
    "upload",
    "login",
    "logout",
    "get",
    "start",
    "status",
    "stop",
    "restart",
    "clean",
    "help",
  ] as const) {
    const fromHelp = execute("help", command);
    const fromOption = execute(command, "--help");

    assert.equal(fromHelp.status, 0, fromHelp.stderr);
    assert.equal(fromOption.status, 0, fromOption.stderr);
    assert.equal(fromHelp.stderr, "");
    assert.equal(fromOption.stderr, "");
    assert.equal(fromHelp.stdout, fromOption.stdout);
  }

  assert.match(
    root.stdout,
    /npx skills add https:\/\/github\.com\/abijith-suresh\/planview\/tree\/main\/apps\/cli\/skills/
  );
  assert.match(root.stdout, /project by default; add -g/);

  const removedInstaller = execute("skills", "install");
  assert.equal(removedInstaller.status, 1);
  assert.match(removedInstaller.stderr, /^Unknown command: skills\n/);
});

test("command options reject unknown flags before doing work", () => {
  const commands = [
    ["publish", "--unknown"],
    ["upload", "--unknown"],
    ["login", "--unknown"],
    ["logout", "--unknown"],
    ["get", "--unknown"],
    ["start", "--unknown"],
    ["status", "--unknown"],
    ["stop", "--unknown"],
    ["restart", "--unknown"],
    ["clean", "--unknown"],
  ] as const;

  for (const args of commands) {
    const result = execute(...args);
    assert.equal(result.status, 1, `${args.join(" ")} should fail`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown option: --unknown\n/);
  }
});

test("profile selection is parsed before the command and validates its value", () => {
  const help = execute("--profile", "dev", "help");
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, formatHelp());

  const invalid = execute("--profile", "Work", "status");
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^Invalid profile name: Work/);

  const missing = execute("--profile");
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /^Option --profile requires a profile name/);

  const misplaced = execute("status", "--profile", "dev");
  assert.equal(misplaced.status, 1);
  assert.match(misplaced.stderr, /^Unknown option: --profile/);
});

test("browser opening uses the platform launcher", async () => {
  let command: string | undefined;
  let argumentsList: readonly string[] | undefined;
  let options: SpawnOptions | undefined;
  let unrefCalled = false;
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = () => {
    unrefCalled = true;
  };
  const fakeSpawn = (
    spawnCommand: string,
    spawnArguments: readonly string[],
    spawnOptions: SpawnOptions
  ): ChildProcess => {
    command = spawnCommand;
    argumentsList = spawnArguments;
    options = spawnOptions;
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  };

  await openUrl("http://localhost:4777/example", fakeSpawn as typeof spawn);

  const expected =
    process.platform === "win32"
      ? { command: "cmd.exe", arguments: ["/c", "start", "", "http://localhost:4777/example"] }
      : process.platform === "darwin"
        ? { command: "open", arguments: ["http://localhost:4777/example"] }
        : { command: "xdg-open", arguments: ["http://localhost:4777/example"] };
  assert.equal(command, expected.command);
  assert.deepEqual(argumentsList, expected.arguments);
  assert.ok(options);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(unrefCalled, true);
});

test("the public declaration does not reference private workspace packages", () => {
  const declaration = readFileSync(resolve(packageRoot, "dist/index.d.ts"), "utf8");
  assert.doesNotMatch(declaration, /@planview\//);
});

test("the public package retains its name and exposes only the plansplease command", () => {
  assert.equal(packageJson.name, "@abijith-suresh/planview");
  assert.deepEqual(packageJson.bin, {
    plansplease: "./dist/index.js",
  });
});

test("--version and -v follow the Changesets-managed package version", () => {
  const lockfile = JSON.parse(readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"));
  assert.equal(lockfile.packages["apps/cli"].version, packageJson.version);
  const long = execute("--version");
  const short = execute("-v");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, `plansplease ${packageJson.version}\n`);
  assert.equal(short.stdout, long.stdout);
});

test("unknown options fail as typed Effects and preserve boundary output", () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = run(["--unknown"], collectOutput(stdout), (message) => {
    stderr.push(message);
  });
  const exit = Effect.runSyncExit(program);
  stderr.length = 0;
  const error = Effect.runSync(Effect.flip(program));

  assert.equal(Exit.isFailure(exit), true);
  assert.equal(error._tag, "UnknownOptionError");
  assert.equal(error.option, "--unknown");
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [`Unknown option: --unknown\n\n${formatHelp()}`]);
});

test("the Effect boundary maps typed argument failures to the existing exit code", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await main(["--help", "unexpected"], collectOutput(stdout), (message) => {
      stderr.push(message);
    }),
    1
  );
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, [`Unexpected argument: unexpected\n\n${formatHelp()}`]);
});

test("programmatic help and version output await asynchronous writers", async () => {
  const outputs: string[] = [];
  const stdout = async (message: OutputMessage): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    outputs.push(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
  };

  assert.equal(await main(["--help"], stdout, () => undefined), 0);
  assert.equal(await main(["--version"], stdout, () => undefined), 0);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0], formatHelp());
  const versionOutput = outputs[1];
  assert.ok(versionOutput);
  assert.match(versionOutput, /^plansplease \d+\.\d+\.\d+\n$/);
});

test("unknown options fail with a useful error", () => {
  const result = execute("--unknown");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unknown option: --unknown\n/);
  assert.match(result.stderr, /Usage: plansplease \[global-options\] <command>/);
});

test("JSON errors stay machine-readable on stderr", () => {
  const result = execute("publish", "--json", "--unknown");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: "UnknownOptionError",
      message: "Unknown option: --unknown",
      option: "--unknown",
    },
  });
});

test("get keeps stdout available for raw document bytes", () => {
  const result = execute("get", "--json");

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: {
      code: "UnknownOptionError",
      message: "Unknown option: --json",
      option: "--json",
    },
  });
});

test("recognized options reject trailing arguments", () => {
  const result = execute("--help", "unexpected");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unexpected argument: unexpected\n/);
});

test("publish explains that it needs a source path", async () => {
  const stderr: string[] = [];
  assert.equal(
    await main(
      ["publish"],
      () => undefined,
      (message) => stderr.push(message)
    ),
    1
  );
  assert.match(stderr[0] ?? "", /^Missing source file or folder:/);
});

test("cloud commands explain their required input without starting network work", () => {
  const upload = execute("upload");
  assert.equal(upload.status, 1);
  assert.equal(upload.stdout, "");
  assert.match(upload.stderr, /^Missing HTML file:/);

  const login = execute("login", "--cloud-url");
  assert.equal(login.status, 1);
  assert.equal(login.stdout, "");
  assert.match(login.stderr, /^Option --cloud-url requires a URL/);

  const uploadHelp = execute("help", "upload");
  assert.equal(uploadHelp.status, 0, uploadHelp.stderr);
  assert.match(uploadHelp.stdout, /Upload an HTML file or artifact folder/);
});

test("publish --open is recognized and preview is not a command", () => {
  const open = execute("publish", "--open");
  assert.equal(open.status, 1);
  assert.match(open.stderr, /^Missing source file or folder:/);

  const preview = execute("preview", "--help");
  assert.equal(preview.status, 1);
  assert.match(preview.stderr, /^Unknown command: preview\n/);
});

test("the built CLI entrypoint reports the package version", () => {
  const result = spawnSync(process.execPath, [cli, "--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, `plansplease ${packageJson.version}\n`);
  assert.equal(result.stderr, "");
});

test("importing the entrypoint does not execute the command", () => {
  const moduleUrl = pathToFileURL(cli).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)});`],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a starter crash after daemon lock adoption does not strand lifecycle commands", async () => {
  const { runtimeDir, environment, executeInFixture, cleanup } = await createLocalFixture(
    "daemon-adoption",
    { PLANVIEW_TEST_DAEMON_ADOPTION_PAUSE_MS: "2000" }
  );
  const starter = spawn(process.execPath, [cli, "start"], {
    env: environment,
    stdio: "ignore",
  });
  const lockPath = join(runtimeDir, "lifecycle.lock");

  try {
    const adopted = await waitFor(() => {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      return lock.pid !== starter.pid ? lock : undefined;
    });
    assert.notEqual(adopted.pid, starter.pid);

    starter.kill();
    await waitForExit(starter);
    await waitFor(() => JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8")));
    await waitFor(() => (existsSync(lockPath) ? undefined : true));

    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /restarted/);

    const stopped = executeInFixture("stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
  } finally {
    if (starter.exitCode === null && starter.signalCode === null) {
      starter.kill();
      await waitForExit(starter).catch(() => undefined);
    }
    await cleanup();
  }
});

test("start, status, stop, and restart are process-backed and private", async () => {
  const { runtimeDir, port, executeInFixture, cleanup } = await createLocalFixture("daemon");

  try {
    const before = executeInFixture("status");
    assert.equal(before.status, 0);
    assert.match(before.stdout, /not running/);
    assert.equal(existsSync(runtimeDir), false, "status must not create runtime state");

    const started = executeInFixture("start");
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /started/);

    const descriptor = JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8"));
    assert.equal(descriptor.host, "127.0.0.1");
    assert.equal(descriptor.port, port);
    if (process.platform !== "win32") {
      assert.equal(statSync(runtimeDir).mode & 0o077, 0);
      assert.equal(statSync(join(runtimeDir, "daemon.json")).mode & 0o077, 0);
    }

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/status`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Planview daemon running/);

    const status = executeInFixture("status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /is running/);
    const idempotent = executeInFixture("start");
    assert.equal(idempotent.status, 0, idempotent.stderr);
    assert.match(idempotent.stdout, /already running/);

    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /restarted/);

    const stopped = executeInFixture("stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(existsSync(join(runtimeDir, "daemon.json")), false);
    const after = executeInFixture("status");
    assert.equal(after.status, 0);
    assert.match(after.stdout, /not running/);
  } finally {
    await cleanup();
  }
});

test("profiles run side by side, keep separate documents, and return their actual ports", async () => {
  const home = mkdtempSync(join(tmpdir(), "planview-profile-cli-test-"));
  const dataHome = join(home, "data");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: dataHome,
    NODE_ENV: "production",
  };
  delete environment["PLANVIEW_APP_DATA_DIR"];
  delete environment["PLANVIEW_RUNTIME_DIR"];
  delete environment["PLANVIEW_TEST_DAEMON_PORT"];
  const executeInHome = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
  const devSource = join(home, "dev.html");
  const workSource = join(home, "work.html");
  writeFileSync(devSource, "<p>dev</p>\n");
  writeFileSync(workSource, "<p>work</p>\n");

  try {
    const devPublished = executeInHome("--profile", "dev", "publish", "--json", devSource);
    assert.equal(devPublished.status, 0, devPublished.stderr);
    const devDocument = JSON.parse(devPublished.stdout) as {
      readonly id: string;
      readonly url: string;
    };

    const workPublished = executeInHome("--profile=work", "publish", "--json", workSource);
    assert.equal(workPublished.status, 0, workPublished.stderr);
    const workDocument = JSON.parse(workPublished.stdout) as {
      readonly id: string;
      readonly url: string;
    };

    assert.notEqual(devDocument.url, workDocument.url);
    assert.equal(
      existsSync(join(dataHome, "planview", "profiles", "dev", "metadata.sqlite")),
      true
    );
    assert.equal(
      existsSync(join(dataHome, "planview", "profiles", "work", "metadata.sqlite")),
      true
    );

    const devStatus = executeInHome("--profile", "dev", "status", "--json");
    const workStatus = executeInHome("--profile", "work", "status", "--json");
    assert.equal(devStatus.status, 0, devStatus.stderr);
    assert.equal(workStatus.status, 0, workStatus.stderr);
    const devRunning = JSON.parse(devStatus.stdout);
    const workRunning = JSON.parse(workStatus.stdout);
    assert.equal(devRunning.profile, "dev");
    assert.equal(workRunning.profile, "work");
    assert.equal(devRunning.port, Number(new URL(devDocument.url).port));
    assert.equal(workRunning.port, Number(new URL(workDocument.url).port));

    const devContents = executeInHome("--profile", "dev", "get", devDocument.url);
    assert.equal(devContents.status, 0, devContents.stderr);
    assert.equal(devContents.stdout, "<p>dev</p>\n");
    const crossProfile = executeInHome("--profile", "work", "get", devDocument.url);
    assert.equal(crossProfile.status, 1);
    assert.match(crossProfile.stderr, /uses port/);
  } finally {
    executeInHome("--profile", "dev", "stop");
    executeInHome("--profile", "work", "stop");
    await removeFixture(home);
  }
});

const freePort = (): Promise<number> =>
  new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error)
      );
    });
  });

const createLocalFixture = async (name: string, overrides: NodeJS.ProcessEnv = {}) => {
  const port = await freePort();
  const runtimeRoot = mkdtempSync(join(tmpdir(), `planview-${name}-test-`));
  const appDataDir = join(runtimeRoot, "data");
  const runtimeDir = join(appDataDir, "runtime");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: appDataDir,
    PLANVIEW_RUNTIME_DIR: runtimeDir,
    PLANVIEW_TEST_DAEMON_PORT: String(port),
    ...overrides,
  };
  const executeInFixture = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment });
  const cleanup = async () => {
    executeInFixture("stop");
    await removeFixture(runtimeRoot);
  };
  return { runtimeRoot, appDataDir, runtimeDir, port, environment, executeInFixture, cleanup };
};

test("metadata commands emit one JSON object when requested", async () => {
  const { runtimeRoot, port, executeInFixture, cleanup } = await createLocalFixture("json-cli");

  try {
    const stopped = executeInFixture("status", "--json");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(JSON.parse(stopped.stdout), { state: "stopped" });

    const started = executeInFixture("start", "--json");
    assert.equal(started.status, 0, started.stderr);
    const startedDocument = JSON.parse(started.stdout);
    assert.equal(startedDocument.state, "running");
    assert.equal(startedDocument.host, "127.0.0.1");
    assert.equal(startedDocument.port, port);
    assert.equal(startedDocument.reused, false);

    const sourcePath = join(runtimeRoot, "json.html");
    writeFileSync(sourcePath, "<main>json</main>");
    const published = executeInFixture("publish", "--json", sourcePath);
    assert.equal(published.status, 0, published.stderr);
    const publication = JSON.parse(published.stdout);
    assert.match(publication.id, /^[A-Za-z0-9_-]{21}$/);
    assert.equal(publication.url, `http://localhost:${port}/${publication.id}`);

    const running = executeInFixture("status", "--json");
    assert.equal(running.status, 0, running.stderr);
    const runningDocument = JSON.parse(running.stdout);
    assert.deepEqual(runningDocument, {
      state: "running",
      profile: "default",
      host: "127.0.0.1",
      port,
      pid: runningDocument.pid,
      startedAt: runningDocument.startedAt,
    });

    const restarted = executeInFixture("restart", "--json");
    assert.equal(restarted.status, 0, restarted.stderr);
    const restartedDocument = JSON.parse(restarted.stdout);
    assert.equal(restartedDocument.state, "running");
    assert.equal(restartedDocument.host, "127.0.0.1");
    assert.equal(restartedDocument.port, port);

    const cleaned = executeInFixture("clean", "--json");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    const cleanup = JSON.parse(cleaned.stdout);
    assert.equal(Array.isArray(cleanup.failures), true);
    assert.equal(
      cleanup.failures.some((failure: Record<string, unknown>) => "cause" in failure),
      false
    );

    const finalStop = executeInFixture("stop", "--json");
    assert.equal(finalStop.status, 0, finalStop.stderr);
    assert.deepEqual(JSON.parse(finalStop.stdout), { state: "stopped" });
  } finally {
    await cleanup();
  }
});

test("publish validates before startup and preserves the source file", async (t) => {
  const { runtimeRoot, runtimeDir, executeInFixture, cleanup } =
    await createLocalFixture("publish-validation");
  t.after(cleanup);
  const invalidPath = join(runtimeRoot, "source.txt");
  writeFileSync(invalidPath, "not html");
  const invalid = executeInFixture("publish", invalidPath);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /only \.html and \.htm files are supported/);
  assert.equal(existsSync(runtimeDir), false);

  const oversizedPath = join(runtimeRoot, "oversized.html");
  writeFileSync(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
  const oversized = executeInFixture("publish", oversizedPath);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, "");
  assert.match(oversized.stderr, /must not exceed 10485760 bytes/);
  assert.equal(existsSync(runtimeDir), false);
});

test("publish removes a prepared page bundle when daemon startup fails", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-publish-cleanup-test-"));
  const site = join(runtimeRoot, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<h1>blocked</h1>");

  const blocker = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    blocker.once("error", rejectPromise);
    blocker.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = blocker.address();
  assert.ok(address !== null && typeof address !== "string");
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: join(runtimeRoot, "data"),
    PLANVIEW_RUNTIME_DIR: join(runtimeRoot, "data", "runtime"),
    PLANVIEW_TEST_DAEMON_PORT: String(address.port),
  };
  const before = temporaryBundleDirectories();

  try {
    const result = spawnSync(process.execPath, [cli, "publish", site], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Could not publish/);
    const leaked = [...temporaryBundleDirectories()].filter((name) => !before.has(name));
    assert.deepEqual(leaked, []);
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      blocker.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)));
    });
    await removeFixture(runtimeRoot);
  }
});

test("publish budgets a slow maximum-size publication before returning its committed URL", async () => {
  const { runtimeRoot, port, environment, cleanup } = await createLocalFixture("publish-timeout", {
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "1500",
  });
  const sourcePath = join(runtimeRoot, "slow.html");
  writeFileSync(sourcePath, Buffer.alloc(10 * 1024 * 1024, 0x61));

  try {
    const published = spawnSync(process.execPath, [cli, "publish", sourcePath], {
      encoding: "utf8",
      env: environment,
      timeout: 30_000,
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.stderr, "");
    assert.match(published.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    const retrieved = await fetch(published.stdout.trim().replace("localhost", "127.0.0.1"));
    assert.equal(retrieved.status, 200);
    assert.equal((await retrieved.arrayBuffer()).byteLength, 10 * 1024 * 1024);
  } finally {
    await cleanup();
  }
});

test("publish starts or reuses the daemon, serves raw immutable HTML, and records access after retrieval", async () => {
  const { runtimeRoot, appDataDir, port, executeInFixture, cleanup } =
    await createLocalFixture("publish");
  const sourcePath = join(runtimeRoot, "source.html");
  const original = "<!doctype html><html><body><h1>snapshot one</h1></body></html>";
  writeFileSync(sourcePath, original);
  let database: DatabaseSync | undefined;

  try {
    const first = executeInFixture("publish", sourcePath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.match(first.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    assert.equal(readFileSync(sourcePath, "utf8"), original);
    const firstUrl = first.stdout.trim();
    const firstBrowserUrl = firstUrl.replace("localhost", "127.0.0.1");

    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const before = readDocumentMetadata(database, documentIdFromUrl(firstUrl));
    assert.ok(before);
    database.close();
    database = undefined;

    writeFileSync(sourcePath, "<!doctype html><html><body>changed source</body></html>");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const retrieved = await fetch(firstBrowserUrl);
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await retrieved.text(), original);
    const after = await waitFor(() => {
      database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
      try {
        const result = readDocumentMetadata(database, documentIdFromUrl(firstUrl));
        return result !== undefined && result.lastAccessedAt > before.lastAccessedAt
          ? result
          : undefined;
      } finally {
        database.close();
        database = undefined;
      }
    });
    assert.equal(after.createdAt, before.createdAt);

    const missing = await fetch(`http://127.0.0.1:${port}/_____________________`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await missing.text(), /<h1>Not found<\/h1>/);
    const method = await fetch(firstBrowserUrl, { method: "POST" });
    assert.equal(method.status, 405);
    assert.match(method.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await method.text(), /<h1>Method not allowed<\/h1>/);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/publish`, {
      method: "POST",
      body: JSON.stringify({ sourcePath }),
    });
    assert.equal(unauthorized.status, 401);

    const second = executeInFixture("publish", sourcePath);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, "");
    assert.match(second.stdout, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}\\n$`));
    assert.notEqual(second.stdout, first.stdout);
    const secondRetrieved = await fetch(second.stdout.trim().replace("localhost", "127.0.0.1"));
    assert.equal(
      await secondRetrieved.text(),
      "<!doctype html><html><body>changed source</body></html>"
    );
    const firstAgain = await fetch(firstBrowserUrl);
    assert.equal(await firstAgain.text(), original);
  } finally {
    database?.close();
    await cleanup();
  }
});

test("publish accepts a page folder and serves its root and assets", async () => {
  const { runtimeRoot, port, executeInFixture, cleanup } = await createLocalFixture("page-folder");
  const site = join(runtimeRoot, "site");
  mkdirSync(join(site, "assets"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>folder home</h1>");
  writeFileSync(join(site, "assets", "app.css"), "body { color: blue; }");

  try {
    const published = executeInFixture("publish", site);
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.stderr, "");
    const url = published.stdout.trim();
    const id = documentIdFromUrl(url);
    assert.match(id, /^[A-Za-z0-9_-]{21}$/);

    const page = await fetch(url.replace("localhost", "127.0.0.1"));
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>folder home</h1>");
    const stylesheet = await fetch(`http://127.0.0.1:${port}/${id}/assets/app.css`);
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await stylesheet.text(), "body { color: blue; }");
    assert.equal(readFileSync(join(site, "index.html"), "utf8"), "<h1>folder home</h1>");
  } finally {
    await cleanup();
  }
});

test("get accepts ids and exact local URLs but rejects ambiguous references before startup", async () => {
  const port = 49123;
  const id = "a".repeat(21);
  assert.equal(parseGetReference(id, port), id);
  assert.equal(parseGetReference(`http://localhost:${port}/${id}`, port), id);
  assert.equal(parseGetReference(`http://127.0.0.1:${port}/${id}`, port), id);

  for (const reference of [
    "a",
    `http://localhost:${port}/${id}/`,
    `http://localhost:${port}/${id}?download=1`,
    `https://localhost:${port}/${id}`,
    `http://example.test:${port}/${id}`,
    `http://localhost:${port + 1}/${id}`,
  ]) {
    assert.throws(
      () => parseGetReference(reference, port),
      /valid 21-character id or an exact local Planview URL/
    );
  }

  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-get-validation-test-"));
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: join(runtimeRoot, "data"),
    PLANVIEW_RUNTIME_DIR: join(runtimeRoot, "data", "runtime"),
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };
  try {
    const result = spawnSync(process.execPath, [cli, "get", `https://localhost:${port}/${id}`], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /exact local Planview URL/);
    assert.equal(existsSync(environment.PLANVIEW_RUNTIME_DIR), false);
  } finally {
    await removeFixture(runtimeRoot);
  }
});

test("get streams exact bytes across daemon restart and only records successful access", async () => {
  const { runtimeRoot, appDataDir, environment, executeInFixture, cleanup } =
    await createLocalFixture("get");
  const executeRawInFixture = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: null,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
  const sourcePath = join(runtimeRoot, "large.html");
  const original = Buffer.concat([
    Buffer.from("<!doctype html><html><body>\0"),
    Buffer.alloc(2 * 1024 * 1024, 0x61),
    Buffer.from("</body></html>\n"),
  ]);
  writeFileSync(sourcePath, original);
  let database: DatabaseSync | undefined;

  try {
    const published = executeInFixture("publish", sourcePath);
    assert.equal(published.status, 0, published.stderr);
    const url = published.stdout.trim();
    const id = url.slice(url.lastIndexOf("/") + 1);
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const before = readDocumentMetadata(database, id);
    assert.ok(before);
    database.close();
    database = undefined;

    const retrieved = executeRawInFixture("get", id);
    assert.equal(retrieved.status, 0, retrieved.stderr?.toString());
    assert.equal(retrieved.stderr.length, 0);
    assert.deepEqual(retrieved.stdout, original);

    const after = await waitFor(() => {
      database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
      try {
        const row = readDocumentMetadata(database, id);
        return row !== undefined && row.lastAccessedAt > before.lastAccessedAt ? row : undefined;
      } finally {
        database.close();
        database = undefined;
      }
    });
    assert.equal(after.createdAt, before.createdAt);

    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    const retrievedByUrl = executeRawInFixture("get", url);
    assert.equal(retrievedByUrl.status, 0, retrievedByUrl.stderr?.toString());
    assert.deepEqual(retrievedByUrl.stdout, original);

    const missing = executeRawInFixture("get", "z".repeat(21));
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout.length, 0);
    assert.match(missing.stderr.toString(), /was not found/);
  } finally {
    database?.close();
    await cleanup();
  }
});

test("get honors stdout backpressure and records access after the slow consumer finishes", async () => {
  const { runtimeRoot, appDataDir, environment, executeInFixture, cleanup } =
    await createLocalFixture("get-backpressure");
  const sourcePath = join(runtimeRoot, "backpressure.html");
  const original = Buffer.concat([
    Buffer.from("<!doctype html><body>"),
    Buffer.alloc(2 * 1024 * 1024, 0x62),
    Buffer.from("</body>"),
  ]);
  writeFileSync(sourcePath, original);
  let child: PipedChild | undefined;

  try {
    const published = executeInFixture("publish", sourcePath);
    assert.equal(published.status, 0, published.stderr);
    const id = documentIdFromUrl(published.stdout.trim());

    const beforeDatabase = new DatabaseSync(join(appDataDir, "metadata.sqlite"), {
      timeout: 5000,
    });
    const before = readDocumentMetadata(beforeDatabase, id);
    beforeDatabase.close();
    assert.ok(before);

    const transfer = spawn(process.execPath, [cli, "get", id], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = transfer;
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    transfer.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const consume = (async () => {
      for await (const chunk of transfer.stdout) {
        output.push(chunk);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    })();
    const result = await Promise.all([consume, waitForExit(transfer)]).then((values) => values[1]);

    assert.equal(result.code, 0, Buffer.concat(errors).toString("utf8"));
    assert.deepEqual(Buffer.concat(output), original);
    const afterDatabase = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const after = readDocumentMetadata(afterDatabase, id);
    afterDatabase.close();
    assert.ok(after);
    assert.ok(after.lastAccessedAt > before.lastAccessedAt);
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
    }
    await cleanup();
  }
});

test("get aborts the daemon transfer on a closed stdout consumer without recording access", async () => {
  const { runtimeRoot, appDataDir, environment, executeInFixture, cleanup } =
    await createLocalFixture("get-epipe");
  const sourcePath = join(runtimeRoot, "epipe.html");
  writeFileSync(
    sourcePath,
    Buffer.concat([
      Buffer.from("<!doctype html><body>"),
      Buffer.alloc(9 * 1024 * 1024, 0x63),
      Buffer.from("</body></html>"),
    ])
  );
  let child: PipedChild | undefined;
  let database: DatabaseSync | undefined;

  try {
    const published = executeInFixture("publish", sourcePath);
    assert.equal(published.status, 0, published.stderr);
    const id = documentIdFromUrl(published.stdout.trim());
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const before = readDocumentMetadata(database, id);
    assert.ok(before);
    database.close();
    database = undefined;

    const transfer = spawn(process.execPath, [cli, "get", id], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = transfer;
    transfer.stdout.pause();
    const errors: Buffer[] = [];
    transfer.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    transfer.stdout.destroy();
    const result = await waitForExit(transfer);

    assert.equal(result.code, 1, Buffer.concat(errors).toString("utf8"));
    assert.match(Buffer.concat(errors).toString("utf8"), /Could not retrieve/);
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    const after = readDocumentMetadata(database, id);
    assert.ok(after);
    assert.equal(after.lastAccessedAt, before.lastAccessedAt);
  } finally {
    database?.close();
    if (child?.exitCode === null && child?.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
    }
    await cleanup();
  }
});

test("start never stops an unknown owner of the daemon port", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "planview-port-owner-test-"));
  const port = await freePort();
  const owner = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    owner.once("error", reject);
    owner.listen(port, "127.0.0.1", () => resolve());
  });
  const result = spawnSync(process.execPath, [cli, "start"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PLANVIEW_APP_DATA_DIR: join(runtimeRoot, "data"),
      PLANVIEW_RUNTIME_DIR: join(runtimeRoot, "data", "runtime"),
      PLANVIEW_TEST_DAEMON_PORT: String(port),
    },
  });

  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown process/);
    assert.match(result.stderr, /\n$/);
    assert.equal(owner.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      owner.close((error) => (error ? reject(error) : resolve()))
    );
    await removeFixture(runtimeRoot);
  }
});

test("clean uses the authenticated daemon policy and startup reconciliation", async () => {
  const { runtimeRoot, appDataDir, runtimeDir, port, executeInFixture, cleanup } =
    await createLocalFixture("clean-cli");
  const sourcePath = join(runtimeRoot, "cleanup.html");
  writeFileSync(sourcePath, "cleanup me");
  let database: DatabaseSync | undefined;

  try {
    const published = executeInFixture("publish", sourcePath);
    assert.equal(published.status, 0, published.stderr);
    const documentId = documentIdFromUrl(published.stdout.trim());
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    database
      .prepare("UPDATE documents SET createdAt = 1, lastAccessedAt = 1 WHERE id = :id")
      .run({ ":id": documentId });
    database.close();
    database = undefined;

    assert.equal(executeInFixture("stop").status, 0);
    const restartedForStartupCleanup = executeInFixture("start");
    assert.equal(restartedForStartupCleanup.status, 0, restartedForStartupCleanup.stderr);
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    assert.equal(
      database.prepare("SELECT id FROM documents WHERE id = :id").get({ ":id": documentId }),
      undefined
    );
    database.close();
    database = undefined;

    const secondPublished = executeInFixture("publish", sourcePath);
    assert.equal(secondPublished.status, 0, secondPublished.stderr);
    const secondDocumentId = documentIdFromUrl(secondPublished.stdout.trim());
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    database
      .prepare("UPDATE documents SET createdAt = 1, lastAccessedAt = 1 WHERE id = :id")
      .run({ ":id": secondDocumentId });
    database.close();
    database = undefined;

    const descriptor = JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8"));
    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
    });
    assert.equal(unauthorized.status, 401);

    const cleaned = executeInFixture("clean");
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stderr, "");
    assert.match(cleaned.stdout, /plansplease cleanup removed 1 expired snapshot/);
    database = new DatabaseSync(join(appDataDir, "metadata.sqlite"), { timeout: 5000 });
    assert.equal(
      database.prepare("SELECT id FROM documents WHERE id = :id").get({ ":id": secondDocumentId }),
      undefined
    );
    database.close();
    database = undefined;

    const orphanId = "z".repeat(21);
    writeFileSync(join(appDataDir, "documents", `${orphanId}.html`), "orphan");
    const stale = new Date(Date.now() - 35_001);
    utimesSync(join(appDataDir, "documents", `${orphanId}.html`), stale, stale);
    const restarted = executeInFixture("restart");
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(existsSync(join(appDataDir, "documents", `${orphanId}.html`)), false);
    assert.equal(descriptor.host, "127.0.0.1");
  } finally {
    database?.close();
    await cleanup();
  }
});
