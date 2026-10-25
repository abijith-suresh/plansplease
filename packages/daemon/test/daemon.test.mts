import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type BundleManifestEntry,
  createBundleHeader,
  type DocumentId,
  encodeBundleManifest,
  validateDocumentId,
} from "@planview/core";
import type { MetadataStore } from "@planview/storage";
import {
  createDocumentPublicationCoordinator,
  openDocumentFileStore,
  openStorage,
  V1_CLEANUP_ITEM_BUDGET,
} from "@planview/storage";
import { Effect } from "effect";
import * as daemon from "../dist/index.js";

const runEffect = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const packageRoot = new URL("..", import.meta.url);
const entry = fileURLToPath(new URL("./dist/entry.js", packageRoot));

type DaemonDescriptor = Readonly<{
  readonly version: number;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly profile?: string;
  readonly secret: string;
  readonly startedAt: number;
}>;
type BundleFile = Readonly<{
  readonly path: string;
  readonly contents: Uint8Array;
}>;
type ChildExit = Readonly<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}>;
type TaggedError = Readonly<{
  readonly _tag: unknown;
  readonly message: string;
  readonly configHost?: unknown;
  readonly configPort?: unknown;
  readonly descriptorHost?: unknown;
  readonly descriptorPort?: unknown;
  readonly [key: string]: unknown;
}>;

const isTaggedError = (error: unknown, tag: string): error is TaggedError => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as TaggedError;
  return record._tag === tag && typeof record.message === "string";
};

const waitFor = async <T,>(
  condition: () => T | false | undefined | PromiseLike<T | false | undefined>,
  timeout = 5_000
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
  throw new Error("Timed out waiting for daemon process state.");
};

const waitForExit = (child: ChildProcess, timeout = 10_000): Promise<ChildExit> =>
  new Promise<ChildExit>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for daemon process exit."));
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

const stopChild = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process can exit between the state check and kill on Windows.
  }
  await waitForExit(child);
};

const removeFixture = async (fixture: string): Promise<void> => {
  await rm(fixture, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 });
};

const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
};

const occupyPort = async (port: number): Promise<Server | undefined> => {
  const server = createServer();
  const bound = await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const onListening = () => {
      cleanup();
      resolvePromise(true);
    };
    const onError = (cause: NodeJS.ErrnoException) => {
      cleanup();
      if (cause.code === "EADDRINUSE") {
        resolvePromise(false);
        return;
      }
      rejectPromise(cause);
    };
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });
  return bound ? server : undefined;
};

const startChild = (
  appDataDir: string,
  runtimeDir: string,
  port: number,
  environment: Record<string, string> = {}
): ChildProcess =>
  spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PLANVIEW_APP_DATA_DIR: appDataDir,
      PLANVIEW_RUNTIME_DIR: runtimeDir,
      PLANVIEW_TEST_DAEMON_PORT: String(port),
      ...environment,
    },
    stdio: "ignore",
  });

const seedPublishedDocument = async (
  appDataDir: string,
  fixture: string,
  documentId: DocumentId,
  contents: string | Uint8Array
): Promise<string> => {
  const sourcePath = join(fixture, `${documentId}.source.html`);
  const documentsDir = join(appDataDir, "documents");
  const stagingDir = join(appDataDir, "staging");
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, contents);
  const metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
  const documentFileStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
  try {
    const publication = createDocumentPublicationCoordinator({
      documentFileStore,
      metadataStore,
      generateId: () => documentId,
    });
    await runEffect(publication.publish(sourcePath));
  } finally {
    await documentFileStore.close();
    metadataStore.close();
  }
  return sourcePath;
};

const makeBundle = (files: readonly BundleFile[]): Buffer => {
  let offset = 0;
  const entries: BundleManifestEntry[] = files.map(({ path, contents }) => {
    const entry = { path, offset, size: contents.byteLength };
    offset += contents.byteLength;
    return entry;
  });
  const manifest = encodeBundleManifest(entries);
  return Buffer.concat([
    Buffer.from(createBundleHeader(manifest)),
    Buffer.from(manifest),
    ...files.map(({ contents }) => contents),
  ]);
};

const seedPublishedBundle = async (
  appDataDir: string,
  fixture: string,
  documentId: DocumentId,
  files: readonly BundleFile[]
): Promise<string> => {
  const sourcePath = join(fixture, `${documentId}.source.html`);
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(sourcePath, makeBundle(files));
  const metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
  const documentFileStore = Effect.runSync(
    openDocumentFileStore({
      documentsDir: join(appDataDir, "documents"),
      stagingDir: join(appDataDir, "staging"),
    })
  );
  try {
    const publication = createDocumentPublicationCoordinator({
      documentFileStore,
      metadataStore,
      generateId: () => documentId,
    });
    await runEffect(publication.publish(sourcePath));
  } finally {
    await documentFileStore.close();
    metadataStore.close();
  }
  return sourcePath;
};

const openStalledDocument = async (port: number, documentId: string): Promise<Socket> => {
  const socket = createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes(Buffer.from("\r\n\r\n"))) {
        socket.off("error", reject);
        socket.pause();
        resolve();
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(
      `GET /${documentId} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`
    );
  });
  return socket;
};

const within = async <T,>(promise: PromiseLike<T>, milliseconds: number): Promise<T> => {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation exceeded ${milliseconds}ms`)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const descriptorAt = (runtimeDir: string): DaemonDescriptor | undefined => {
  try {
    return JSON.parse(readFileSync(join(runtimeDir, "daemon.json"), "utf8")) as DaemonDescriptor;
  } catch {
    return undefined;
  }
};

const waitForReady = async (port: number, secret: string) =>
  waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
      headers: { "x-planview-secret": secret },
    });
    if (response.status !== 200) {
      return undefined;
    }
    const payload = (await response.json()) as Readonly<{ readonly ready?: unknown }>;
    return payload.ready === true ? payload : undefined;
  });

test("public configuration fixes 4777, while test injection is explicit and contained", () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-config-"));
  const appDataDir = join(fixture, "app-data");
  try {
    const publicConfig = daemon.resolveDaemonConfig(
      { appDataDir },
      { PLANVIEW_DAEMON_PORT: "4999", PLANVIEW_PORT: "4998" }
    );
    assert.equal(publicConfig.port, daemon.DAEMON_PORT);
    assert.equal(publicConfig.port, 4777);
    assert.equal(publicConfig.profile, "default");
    assert.equal(publicConfig.strictPort, false);
    assert.equal(publicConfig.testOnly, false);

    const testConfig = daemon.resolveDaemonConfigForTest({ appDataDir, port: 4997 });
    assert.equal(testConfig.port, 4997);
    assert.equal(testConfig.profile, "default");
    assert.equal(testConfig.strictPort, true);
    assert.equal(testConfig.testOnly, true);
    assert.throws(
      () => daemon.resolveDaemonPaths({ appDataDir, runtimeDir: join(fixture, "outside") }),
      /contained below app-data/
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("detached daemon environments contain Planview settings and safe runtime plumbing", () => {
  const environment = daemon.resolveDaemonEnvironment(
    { appDataDir: "/tmp/planview-app-data", runtimeDir: "/tmp/planview-runtime", port: 4777 },
    "lifecycle-token",
    {
      NODE_ENV: "test",
      PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "250",
      NPM_TOKEN: "should-not-be-forwarded",
      NODE_OPTIONS: "--not-a-real-node-option",
      PATH: "/unrelated/path",
      HOME: "/home/test-user",
      USERPROFILE: "C:\\Users\\test-user",
      SystemRoot: "C:\\Windows",
    }
  );

  assert.deepEqual(environment, {
    PLANVIEW_APP_DATA_DIR: "/tmp/planview-app-data",
    PLANVIEW_PROFILE: "default",
    PLANVIEW_RUNTIME_DIR: "/tmp/planview-runtime",
    PLANVIEW_DAEMON_STRICT_PORT: "false",
    PLANVIEW_DAEMON_LIFECYCLE_TOKEN: "lifecycle-token",
    PATH: "/unrelated/path",
    HOME: "/home/test-user",
    USERPROFILE: "C:\\Users\\test-user",
    SystemRoot: "C:\\Windows",
    NODE_ENV: "test",
    PLANVIEW_TEST_DAEMON_PORT: "4777",
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "250",
  });
});

test("a production fallback configuration does not inherit test-only port plumbing", () => {
  const environment = daemon.resolveDaemonEnvironment(
    {
      appDataDir: "/tmp/planview-app-data",
      profile: "work",
      runtimeDir: "/tmp/planview-runtime",
      port: daemon.DAEMON_PORT,
      strictPort: false,
      testOnly: false,
    },
    "lifecycle-token",
    { NODE_ENV: "production" }
  );

  assert.equal(environment["NODE_ENV"], undefined);
  assert.equal(environment["PLANVIEW_TEST_DAEMON_PORT"], undefined);
  assert.equal(environment["PLANVIEW_DAEMON_STRICT_PORT"], "false");
});

test("binds the next available port and publishes that port in every daemon response", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-port-fallback-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const preferredPort = await freePort();
  const owner = createServer((socket) => socket.end());
  await new Promise<void>((resolvePromise, rejectPromise) => {
    owner.once("error", rejectPromise);
    owner.listen(preferredPort, "127.0.0.1", () => resolvePromise());
  });
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: preferredPort,
    strictPort: false,
  });

  try {
    const started = await runEffect(
      daemon.startDetachedDaemon(config, { daemonScriptPath: entry })
    );
    assert.equal(started.reused, false);
    assert.ok(started.descriptor.port > preferredPort);
    assert.equal(descriptorAt(runtimeDir)?.port, started.descriptor.port);

    const response = await fetch(
      `http://${started.descriptor.host}:${started.descriptor.port}${daemon.DAEMON_STATUS_PATH}`,
      { headers: { "x-planview-secret": started.descriptor.secret } }
    );
    assert.equal(response.status, 200);
    const status = (await response.json()) as Readonly<{ readonly port?: unknown }>;
    assert.equal(status.port, started.descriptor.port);

    const inspected = await runEffect(daemon.inspectDaemon(config));
    assert.equal(inspected.state, "running");
    if (inspected.state === "running") {
      assert.equal(inspected.status.port, started.descriptor.port);
    }
  } finally {
    await runEffect(daemon.stopDaemon(config)).catch(() => undefined);
    await new Promise<void>((resolvePromise, rejectPromise) =>
      owner.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)))
    );
    await removeFixture(fixture);
  }
});

test("reports an exhausted production fallback range as a typed port error", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-port-exhausted-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const occupied: Server[] = [];

  try {
    for (let offset = 0; offset <= daemon.DAEMON_PORT_FALLBACK_ATTEMPTS; offset += 1) {
      const server = await occupyPort(daemon.DAEMON_PORT + offset);
      if (server !== undefined) {
        occupied.push(server);
      }
    }

    const config = daemon.resolveDaemonConfig({ appDataDir, runtimeDir });
    await assert.rejects(
      runEffect(daemon.startDetachedDaemon(config, { daemonScriptPath: entry })),
      (error) =>
        isTaggedError(error, "DaemonPortInUseError") &&
        error["port"] === daemon.DAEMON_PORT &&
        /No available port was found/.test(error.message)
    );
  } finally {
    await Promise.all(
      occupied.map(
        (server) =>
          new Promise<void>((resolvePromise, rejectPromise) =>
            server.close((cause) => (cause === undefined ? resolvePromise() : rejectPromise(cause)))
          )
      )
    );
    await removeFixture(fixture);
  }
});

test("a detached daemon keeps the selected profile in its descriptor", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-profile-child-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port, { PLANVIEW_PROFILE: "work" });

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.profile, "work");
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("a detached child failure is observed and the starter releases its lifecycle lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-start-failure-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });

  try {
    await assert.rejects(
      runEffect(
        daemon.startDetachedDaemon(config, {
          daemonScriptPath: join(fixture, "missing-daemon-entry.js"),
        })
      ),
      (error) =>
        isTaggedError(error, "DaemonRequestError") && /failed before readiness/.test(error.message)
    );
    assert.equal(existsSync(join(runtimeDir, daemon.DAEMON_LOCK_NAME)), false);
  } finally {
    await removeFixture(fixture);
  }
});

test("startup failure diagnostics include stderr written before child close", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-startup-diagnostics-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const failedEntry = join(fixture, "failed-daemon-entry.mjs");
  const marker = "startup-diagnostic-marker";
  const diagnostics = `${"x".repeat(128 * 1024)}${marker}`;
  writeFileSync(
    failedEntry,
    `process.stderr.write(${JSON.stringify(diagnostics)}, () => { process.exitCode = 1; });`,
    { encoding: "utf8", mode: 0o700 }
  );
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });

  try {
    await assert.rejects(
      runEffect(daemon.startDetachedDaemon(config, { daemonScriptPath: failedEntry })),
      (error) => isTaggedError(error, "DaemonRequestError") && error.message.includes(marker)
    );
    assert.equal(existsSync(join(runtimeDir, daemon.DAEMON_LOCK_NAME)), false);
  } finally {
    await removeFixture(fixture);
  }
});

test("a stale protected malformed lifecycle lock is recovered only after its conservative lease", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  writeFileSync(lockPath, "not json", { encoding: "utf8", mode: 0o600 });
  const staleTime = new Date(
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000
  );
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.port, port);
    assert.equal(descriptor.host, "127.0.0.1");
    assert.equal(descriptor.profile, "default");
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("reclaims an old well-formed lock whose local owner is dead", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-dead-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const owner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await waitForExit(owner);
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  const staleTimestamp =
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000;
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: owner.pid,
      host: hostname(),
      token: "dead-lock-token-that-is-long-enough-to-validate",
      acquiredAt: staleTimestamp,
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  const staleTime = new Date(staleTimestamp);
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.port, port);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("does not reclaim an old well-formed lock whose local owner is alive", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-live-lock-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, daemon.DAEMON_LOCK_NAME);
  writeFileSync(
    lockPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: hostname(),
      token: "live-lock-token-that-is-long-enough-to-validate",
      acquiredAt:
        Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000,
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  const staleTime = new Date(
    Date.now() - daemon.DAEMON_STARTUP_LEASE_MS - daemon.DAEMON_STARTUP_GRACE_MS - 1_000
  );
  utimesSync(lockPath, staleTime, staleTime);
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    assert.equal(descriptorAt(runtimeDir), undefined);
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("status and stop surface corrupt and insecure descriptors as typed errors", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-descriptor-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const descriptorPath = join(runtimeDir, daemon.DAEMON_DESCRIPTOR_NAME);

  try {
    writeFileSync(descriptorPath, "{not-json", { encoding: "utf8", mode: 0o600 });
    await assert.rejects(runEffect(daemon.inspectDaemon(config)), (error) =>
      isTaggedError(error, "DaemonDescriptorError")
    );
    await assert.rejects(runEffect(daemon.stopDaemon(config)), (error) =>
      isTaggedError(error, "DaemonDescriptorError")
    );

    if (process.platform !== "win32") {
      writeFileSync(
        descriptorPath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          host: "127.0.0.1",
          port: config.port,
          secret: "private-descriptor-secret-that-is-long-enough",
          startedAt: Date.now(),
        }),
        { encoding: "utf8", mode: 0o600 }
      );
      chmodSync(descriptorPath, 0o644);
      await assert.rejects(runEffect(daemon.inspectDaemon(config)), (error) =>
        isTaggedError(error, "DaemonDescriptorError")
      );
      await assert.rejects(runEffect(daemon.stopDaemon(config)), (error) =>
        isTaggedError(error, "DaemonDescriptorError")
      );
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("lifecycle and status reject a descriptor endpoint mismatch with a typed error", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-endpoint-mismatch-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfig({ appDataDir, runtimeDir });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtimeDir, daemon.DAEMON_DESCRIPTOR_NAME),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "localhost",
      port: 4776,
      secret: "private-descriptor-secret-that-is-long-enough",
      startedAt: Date.now(),
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  try {
    for (const operation of [
      () => runEffect(daemon.inspectDaemon(config)),
      () => runEffect(daemon.startDetachedDaemon(config, { daemonScriptPath: entry })),
      () => runEffect(daemon.stopDaemon(config)),
      () => runEffect(daemon.restartDaemon(config, { daemonScriptPath: entry })),
    ]) {
      await assert.rejects(
        operation(),
        (error) =>
          isTaggedError(error, "DaemonDescriptorEndpointMismatchError") &&
          error.descriptorHost === "localhost" &&
          error.descriptorPort === 4776 &&
          error.configHost === "127.0.0.1" &&
          error.configPort === 4777
      );
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("lifecycle rejects a descriptor from another profile", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-profile-mismatch-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfig({ appDataDir, runtimeDir, profile: "work" });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtimeDir, daemon.DAEMON_DESCRIPTOR_NAME),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: config.port,
      profile: "other",
      secret: "private-descriptor-secret-that-is-long-enough",
      startedAt: Date.now(),
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  try {
    await assert.rejects(
      runEffect(daemon.inspectDaemon(config)),
      (error) =>
        isTaggedError(error, "DaemonDescriptorProfileMismatchError") &&
        error["descriptorProfile"] === "other" &&
        error["configProfile"] === "work"
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("exact management paths do not shadow a published id beginning with __planview", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-document-route-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const stagingDir = join(appDataDir, "staging");
  const port = await freePort();
  const sourcePath = join(fixture, "source.html");
  const documentId = validateDocumentId("__planviewabcdefghijk");
  writeFileSync(sourcePath, "<!doctype html><p>private-looking id</p>");
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });

  const metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
  const documentFileStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
  const publication = createDocumentPublicationCoordinator({
    documentFileStore,
    metadataStore,
    generateId: () => documentId,
  });
  await runEffect(publication.publish(sourcePath));
  await documentFileStore.close();
  metadataStore.close();

  const child = startChild(appDataDir, runtimeDir, port);
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    const document = await fetch(`http://127.0.0.1:${port}/${documentId}`);
    assert.equal(document.status, 200);
    assert.equal(await document.text(), "<!doctype html><p>private-looking id</p>");

    const management = await fetch(`http://127.0.0.1:${port}/__planview/status`);
    assert.equal(management.status, 401);
    const authorized = await fetch(`http://127.0.0.1:${port}/__planview/status`, {
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("serves a page bundle root and its asset entries", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-page-bundle-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const documentId = validateDocumentId("e".repeat(21));
  let child: ChildProcess | undefined;
  try {
    await seedPublishedBundle(appDataDir, fixture, documentId, [
      { path: "index.html", contents: Buffer.from("<h1>bundle home</h1>") },
      { path: "assets/app.css", contents: Buffer.from("body { color: red; }") },
    ]);
    child = startChild(appDataDir, runtimeDir, port);
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitForReady(port, descriptor.secret);

    const redirect = await fetch(`http://127.0.0.1:${port}/${documentId}`, {
      redirect: "manual",
    });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), `/${documentId}/`);

    const page = await fetch(`http://127.0.0.1:${port}/${documentId}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await page.text(), "<h1>bundle home</h1>");

    const stylesheet = await fetch(`http://127.0.0.1:${port}/${documentId}/assets/app.css`);
    assert.equal(stylesheet.status, 200);
    assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(await stylesheet.text(), "body { color: red; }");

    const encodedSlash = await fetch(`http://127.0.0.1:${port}/${documentId}/assets%2Fapp.css`);
    assert.equal(encodedSlash.status, 404);
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("the daemon is a private, graceful process with POSIX ownership checks", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-process-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);

  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    assert.equal(descriptor.host, "127.0.0.1");
    assert.equal(descriptor.port, port);
    assert.equal(typeof descriptor.secret, "string");
    if (process.platform !== "win32") {
      assert.equal(statSync(appDataDir).mode & 0o077, 0);
      assert.equal(statSync(runtimeDir).mode & 0o077, 0);
      assert.equal(statSync(join(runtimeDir, "daemon.json")).mode & 0o077, 0);
      const getuid = process.getuid;
      assert.ok(getuid);
      assert.equal(statSync(join(runtimeDir, "daemon.json")).uid, getuid());
    }

    await waitForReady(port, descriptor.secret);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /Planview daemon running/);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/__planview/ready`);
    assert.equal(unauthorized.status, 401);
    const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(ready.status, 200);
    const readyPayload = (await ready.json()) as Readonly<{ readonly ready?: unknown }>;
    assert.equal(readyPayload.ready, true);

    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    await waitFor(() => (descriptorAt(runtimeDir) === undefined ? true : undefined));
  } finally {
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("concurrent starts, stops, and restarts share one lifecycle lock", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-stress-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const config = daemon.resolveDaemonConfigForTest({
    appDataDir,
    runtimeDir,
    port: await freePort(),
  });
  const options = { daemonScriptPath: entry };

  try {
    const starts = await Promise.all(
      Array.from({ length: 20 }, () => runEffect(daemon.startDetachedDaemon(config, options)))
    );
    assert.equal(starts.filter((result) => result.reused === false).length, 1);
    assert.equal(new Set(starts.map((result) => result.descriptor.pid)).size, 1);

    const stops = await Promise.all(
      Array.from({ length: 20 }, () => runEffect(daemon.stopDaemon(config)))
    );
    assert.ok(stops.every((result) => result.state === "stopped"));
    assert.equal(descriptorAt(runtimeDir), undefined);

    const restarts = await Promise.all(
      Array.from({ length: 20 }, () => runEffect(daemon.restartDaemon(config, options)))
    );
    assert.ok(restarts.every((result) => result.state === "running"));
    assert.ok(descriptorAt(runtimeDir));
  } finally {
    await runEffect(daemon.stopDaemon(config)).catch(() => undefined);
    await removeFixture(fixture);
  }
});

test("a stalled raw-socket read does not block publish or clean", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-read-concurrency-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const documentId = validateDocumentId("c".repeat(21));
  let socket: Socket | undefined;
  let child: ChildProcess | undefined;
  try {
    await seedPublishedDocument(
      appDataDir,
      fixture,
      documentId,
      Buffer.alloc(10 * 1024 * 1024, "x")
    );
    child = startChild(appDataDir, runtimeDir, port);
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    socket = await openStalledDocument(port, documentId);
    const publishSource = join(fixture, "unrelated.html");
    writeFileSync(publishSource, "unrelated publish");
    const publishResponse = await within(
      fetch(`http://127.0.0.1:${port}/__planview/publish`, {
        method: "POST",
        headers: {
          "x-planview-secret": descriptor.secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourcePath: publishSource }),
      }),
      2_000
    );
    assert.equal(publishResponse.status, 201);
    const cleanResponse = await within(
      fetch(`http://127.0.0.1:${port}/__planview/clean`, {
        method: "POST",
        headers: { "x-planview-secret": descriptor.secret },
      }),
      2_000
    );
    assert.equal(cleanResponse.status, 200);
    await stopChild(child);
    child = undefined;
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown aborts a stalled document read before closing storage", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-read-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const documentId = validateDocumentId("d".repeat(21));
  let socket: Socket | undefined;
  let child: ChildProcess | undefined;
  try {
    await seedPublishedDocument(appDataDir, fixture, documentId, "shutdown read");
    child = startChild(appDataDir, runtimeDir, port);
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    socket = await openStalledDocument(port, documentId);
    const startedAt = Date.now();
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    assert.equal(result.state, "stopped");
    assert.ok(Date.now() - startedAt < daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000);
    await waitForExit(child);
    child = undefined;
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown waits for a manual cleanup before closing storage", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-clean-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let metadataStore: MetadataStore | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    const currentMetadataStore = metadataStore;
    assert.ok(currentMetadataStore);
    // One bounded cleanup slice must leave work for shutdown to overlap.
    const documents = V1_CLEANUP_ITEM_BUDGET + 1;
    for (let index = 0; index < documents; index += 1) {
      const documentId = `a${index.toString(36).padStart(20, "0")}`;
      writeFileSync(join(documentsDir, `${documentId}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id: documentId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }
    const cleanResponsePromise = fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
      headers: { "x-planview-secret": descriptor.secret },
    });
    await waitFor(() => {
      const remaining = currentMetadataStore.getDocumentAggregate().count;
      return remaining > 0 && remaining < documents ? remaining : undefined;
    });
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    const cleanResponse = await cleanResponsePromise;
    assert.equal(cleanResponse.status, 200);
    const cleanupResult = (await cleanResponse.json()) as Readonly<{
      readonly removedDocuments: number;
      readonly resumable: boolean;
    }>;
    assert.equal(cleanupResult.removedDocuments > 0, true);
    assert.equal(cleanupResult.removedDocuments < documents, true);
    assert.equal(cleanupResult.resumable, true);
    assert.equal(result.state, "stopped");
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown cancels a slow request-originated publication before staging", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-publish-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const sourcePath = join(fixture, "slow.html");
  writeFileSync(sourcePath, "slow publication");
  const child = startChild(appDataDir, runtimeDir, port, {
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "10000",
  });
  let metadataStore: MetadataStore | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    const publishPromise = fetch(`http://127.0.0.1:${port}/__planview/publish`, {
      method: "POST",
      headers: {
        "x-planview-secret": descriptor.secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourcePath }),
    });
    publishPromise.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    assert.equal(result.state, "stopped");
    assert.ok(Date.now() - startedAt < daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000);
    await publishPromise.catch(() => undefined);
    await waitForExit(child);
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    assert.equal(metadataStore.getDocumentAggregate().count, 0);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("closing a publish response cancels the request before it reaches the gate", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-publish-response-close-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const sourcePath = join(fixture, "response-close.html");
  writeFileSync(sourcePath, "response closed publication");
  const child = startChild(appDataDir, runtimeDir, port, {
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "10000",
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_ONCE: "1",
  });
  let metadataStore: MetadataStore | undefined;
  let socket: Socket | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    const body = JSON.stringify({ sourcePath });
    const connection = createConnection({ host: "127.0.0.1", port });
    socket = connection;
    connection.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      connection.once("connect", () => resolve());
      connection.once("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      connection.write(
        `POST /__planview/publish HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          `x-planview-secret: ${descriptor.secret}\r\ncontent-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
        (error?: Error | null) => (error ? reject(error) : resolve())
      );
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    connection.destroy();

    const sourceForSecondPublish = join(fixture, "second.html");
    writeFileSync(sourceForSecondPublish, "second publication");
    const second = await within(
      fetch(`http://127.0.0.1:${port}/__planview/publish`, {
        method: "POST",
        headers: {
          "x-planview-secret": descriptor.secret,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourcePath: sourceForSecondPublish }),
      }),
      3_000
    );
    assert.equal(second.status, 201);
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    const currentMetadataStore = metadataStore;
    assert.ok(currentMetadataStore);
    assert.equal(metadataStore.getDocumentAggregate().count, 1);
  } finally {
    socket?.destroy();
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("an uncooperative operation is terminated before descriptor recovery", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-uncooperative-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const sourcePath = join(fixture, "uncooperative.html");
  writeFileSync(sourcePath, "uncooperative publication");
  const child = startChild(appDataDir, runtimeDir, port, {
    PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS: "10000",
    PLANVIEW_TEST_DAEMON_UNCOOPERATIVE_PUBLISH: "1",
  });
  let metadataStore: MetadataStore | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    const publishPromise = fetch(`http://127.0.0.1:${port}/__planview/publish`, {
      method: "POST",
      headers: {
        "x-planview-secret": descriptor.secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourcePath }),
    });
    publishPromise.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    assert.equal(result.state, "stopped");
    assert.ok(Date.now() - startedAt < daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000);
    await publishPromise.catch(() => undefined);
    const exit = await waitForExit(child);
    assert.ok(exit.signal === "SIGKILL" || exit.code !== 0);
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    assert.equal(metadataStore.getDocumentAggregate().count, 0);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown cancels a large cleanup at a deterministic fault seam", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-clean-cancel-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const port = await freePort();
  const documents = V1_CLEANUP_ITEM_BUDGET + 1;
  const child = startChild(appDataDir, runtimeDir, port, {
    PLANVIEW_TEST_DAEMON_CLEANUP_PAUSE_MS: "10000",
  });
  let metadataStore: MetadataStore | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    for (let index = 0; index < documents; index += 1) {
      const documentId = `b${index.toString(36).padStart(20, "0")}`;
      writeFileSync(join(documentsDir, `${documentId}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id: documentId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }
    const cleanPromise = fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
      headers: { "x-planview-secret": descriptor.secret },
    });
    cleanPromise.catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    assert.equal(result.state, "stopped");
    assert.ok(Date.now() - startedAt < daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000);
    await cleanPromise.catch(() => undefined);
    await waitForExit(child);
    assert.equal(metadataStore.getDocumentAggregate().count, documents);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("automatic cleanup drains resumable work after a bounded manual slice", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-clean-drain-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const documentsDir = join(appDataDir, "documents");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let metadataStore: MetadataStore | undefined;
  try {
    const descriptor = await waitFor(() => descriptorAt(runtimeDir));
    await waitFor(async () => {
      const ready = await fetch(`http://127.0.0.1:${port}/__planview/ready`, {
        headers: { "x-planview-secret": descriptor.secret },
      });
      return ready.status === 200 ? true : undefined;
    });
    metadataStore = Effect.runSync(openStorage(join(appDataDir, "metadata.sqlite")));
    const currentMetadataStore = metadataStore;
    assert.ok(currentMetadataStore);
    const documents = 700;
    for (let index = 0; index < documents; index += 1) {
      const documentId = `a${index.toString(36).padStart(20, "0")}`;
      writeFileSync(join(documentsDir, `${documentId}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id: documentId,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }
    const startedAt = Date.now();
    const cleanResponse = await fetch(`http://127.0.0.1:${port}/__planview/clean`, {
      method: "POST",
      headers: { "x-planview-secret": descriptor.secret },
    });
    assert.equal(cleanResponse.status, 200);
    assert.equal(Date.now() - startedAt < 4_000, true);
    await waitFor(
      () => (currentMetadataStore.getDocumentAggregate().count === 0 ? true : undefined),
      15_000
    );
    await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    await waitForExit(child);
  } finally {
    metadataStore?.close();
    await stopChild(child);
    await removeFixture(fixture);
  }
});

test("shutdown force-closes an idle connection by its deadline", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "planview-daemon-shutdown-"));
  const appDataDir = join(fixture, "app-data");
  const runtimeDir = join(appDataDir, "runtime");
  const port = await freePort();
  const child = startChild(appDataDir, runtimeDir, port);
  let socket: Socket | undefined;

  try {
    await waitFor(() => descriptorAt(runtimeDir));
    const connection = createConnection({ host: "127.0.0.1", port });
    socket = connection;
    await new Promise<void>((resolve, reject) => {
      connection.once("error", reject);
      connection.once("connect", () => resolve());
    });
    const startedAt = Date.now();
    const result = await runEffect(
      daemon.stopDaemon(daemon.resolveDaemonConfigForTest({ appDataDir, runtimeDir, port }))
    );
    assert.equal(result.state, "stopped");
    const exit = await waitForExit(child, daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 5_000);
    assert.equal(exit.code, 0);
    assert.ok(Date.now() - startedAt <= daemon.DAEMON_SHUTDOWN_TIMEOUT_MS + 3_000);
  } finally {
    socket?.destroy();
    await stopChild(child);
    await removeFixture(fixture);
  }
});
