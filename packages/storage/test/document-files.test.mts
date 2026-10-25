import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { ReadStream } from "node:fs";
import { renameSync, symlinkSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BUNDLE_HEADER_BYTES,
  type BundleManifestEntry,
  createBundleHeader,
  type DocumentId,
  encodeBundleManifest,
} from "@planview/core";
import { Effect, Exit, Scope } from "effect";
import type { DocumentFileStore, StagedDocumentFileHandle } from "../dist/index.js";
import {
  DocumentFileAlreadyExistsError,
  DocumentFileCloneError,
  DocumentFileDeleteError,
  DocumentFileFinalizeError,
  DocumentFileNotBundleError,
  DocumentFileNotRegularError,
  DocumentFileStoreClosedError,
  DocumentFileStorePathError,
  DocumentFileTargetBusyError,
  InvalidStagedDocumentFileHandleError,
  openDocumentFileStore,
  openDocumentFileStoreScoped,
} from "../dist/index.js";

const V1_MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type StoreEnvironment = Readonly<{
  readonly directory: string;
  readonly store: DocumentFileStore;
}>;
type BundleFile = Readonly<{
  readonly path: string;
  readonly contents: Uint8Array;
}>;
type ChildResult = Readonly<{
  readonly error?: Error;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}>;

const errorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

const errorCode = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") {
    return undefined;
  }
  return error.code;
};

const withTempDirectory = async <T,>(
  callback: (directory: string) => T | PromiseLike<T>
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "planview-document-files-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const validId = "a".repeat(21) as DocumentId;
const otherId = "b".repeat(21) as DocumentId;

const withStore = <T,>(callback: (environment: StoreEnvironment) => T | PromiseLike<T>) =>
  withTempDirectory(async (directory) => {
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir: join(directory, "documents"),
        stagingDir: join(directory, "staging"),
      })
    );
    try {
      return await callback({ directory, store });
    } finally {
      await store.close();
    }
  });

const readStream = async (stream: ReadStream): Promise<Buffer> =>
  Buffer.concat(await stream.toArray());

const makeBundle = (files: readonly BundleFile[]): Buffer => {
  let offset = 0;
  const entries: BundleManifestEntry[] = files.map(({ path, contents }) => {
    const entry = { path, offset, size: contents.byteLength };
    offset += contents.byteLength;
    return entry;
  });
  const manifest = encodeBundleManifest(entries);
  const header = createBundleHeader(manifest);
  assert.equal(BUNDLE_HEADER_BYTES, header.byteLength);
  return Buffer.concat([
    Buffer.from(header),
    Buffer.from(manifest),
    ...files.map(({ contents }) => contents),
  ]);
};

const waitForChild = (child: ChildProcess, timeoutMs: number): Promise<ChildResult> =>
  new Promise<ChildResult>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ error, code: null, signal: null, timedOut });
    });
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });

const createFifo = async (path: string): Promise<boolean> => {
  if (process.platform === "win32") {
    return false;
  }
  try {
    await execFileAsync("mkfifo", [path]);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw error;
  }
};

test("initializes private owned directories and safe staged files", () =>
  withStore(async ({ directory, store }) => {
    const documents = await stat(join(directory, "documents"));
    const staging = await stat(join(directory, "staging"));
    if (process.platform !== "win32") {
      assert.equal(documents.mode & 0o777, 0o700);
      assert.equal(staging.mode & 0o777, 0o700);
    }

    const source = join(directory, "source.html");
    await writeFile(source, "<p>safe</p>");
    const handle = await store.stageSourceFile(source);
    const staged = await stat(join(directory, "staging", handle));
    if (process.platform !== "win32") {
      assert.equal(staged.mode & 0o777, 0o600);
    }
  }));

test("rejects a same-size source mutation after the copy completes", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const source = join(directory, "same-size-mutation.html");
    await writeFile(source, "original source");
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        afterStagedSourceCopy: async (sourcePath) => {
          const contents = await readFile(sourcePath);
          contents[0] = (contents[0] ?? 0) ^ 0xff;
          await writeFile(sourcePath, contents);
        },
      })
    );
    try {
      await assert.rejects(
        store.stageSourceFile(source),
        (error) => errorName(error) === "DocumentFileSourceError"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    } finally {
      await store.close();
    }
  }));

test("accepts exactly 10 MiB and rejects oversize sources with staging cleanup", () =>
  withStore(async ({ directory, store }) => {
    const exact = join(directory, "exact.html");
    await writeFile(exact, "");
    await truncate(exact, V1_MAX_HTML_SIZE_BYTES);
    const handle = await store.stageSourceFile(exact);
    assert.equal((await stat(join(directory, "staging", handle))).size, V1_MAX_HTML_SIZE_BYTES);
    await store.finalizeStagedFile(handle, validId);

    const oversized = join(directory, "oversized.html");
    await writeFile(oversized, "");
    await truncate(oversized, V1_MAX_HTML_SIZE_BYTES + 1);
    await assert.rejects(
      store.stageSourceFile(oversized),
      (error) => errorName(error) === "SourceFileTooLargeError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects malformed extensions, directories, and symlinks", () =>
  withStore(async ({ directory, store }) => {
    const malformed = join(directory, "input.txt");
    await writeFile(malformed, "not html");
    await assert.rejects(store.stageSourceFile(malformed), /only \.html and \.htm/);

    const directorySource = join(directory, "directory.html");
    await mkdir(directorySource);
    await assert.rejects(
      store.stageSourceFile(directorySource),
      (error) => error instanceof DocumentFileNotRegularError
    );

    const linked = join(directory, "linked.html");
    try {
      await symlink(malformed, linked);
      await assert.rejects(
        store.stageSourceFile(linked),
        (error) => error instanceof DocumentFileNotRegularError
      );
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
    }
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects a FIFO in a bounded child process without opening it blocking", async (t) => {
  const probe = join(tmpdir(), `planview-fifo-probe-${process.pid}-${Date.now()}`);
  const fifoAvailable = await createFifo(probe);
  await rm(probe, { force: true });
  if (!fifoAvailable) {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }

  await withTempDirectory(async (directory) => {
    const fifo = join(directory, "input.html");
    await execFileAsync("mkfifo", [fifo]);
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    await mkdir(documentsDir);
    await mkdir(stagingDir);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fifo-stage-worker.mts", import.meta.url)),
        fifo,
        documentsDir,
        stagingDir,
      ],
      { stdio: "ignore" }
    );
    const result = await waitForChild(child, 1_000);
    assert.equal(result.timedOut, false, "FIFO validation must not leave an open() request hung");
    assert.equal(result.code, 0);
  });
});

test("out-of-model hostile external source replacement fails closed during staging", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "raced.html");
    const replacement = join(directory, "replacement.html");
    await writeFile(source, Buffer.alloc(V1_MAX_HTML_SIZE_BYTES, 0x61));
    const staging = store.stageSourceFile(source);
    renameSync(source, replacement);
    symlinkSync(replacement, source);
    await assert.rejects(
      staging,
      (error) =>
        errorName(error) === "DocumentFileSourceError" ||
        errorName(error) === "DocumentFileNotRegularError" ||
        errorName(error) === "SourceFileTooLargeError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("out-of-model concurrent source mutation above the limit cleans up", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "growing.html");
    await writeFile(source, Buffer.alloc(V1_MAX_HTML_SIZE_BYTES, 0x62));
    const staging = store.stageSourceFile(source);
    await appendFile(source, "x");
    await assert.rejects(
      staging,
      (error) =>
        errorName(error) === "SourceFileTooLargeError" ||
        errorName(error) === "DocumentFileSourceError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("out-of-model hostile external staged-path replacement is retained during compensation", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    let replacedPath = "";
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeStagedSourceCopy: async (stagedPath) => {
          replacedPath = stagedPath;
          renameSync(stagedPath, `${stagedPath}.original`);
          await writeFile(stagedPath, "replacement staged owner");
          throw new Error("copy interleaving fault");
        },
      })
    );
    try {
      const source = join(directory, "failed-stage-cleanup.html");
      await writeFile(source, "original staged owner");
      const staging = store.stageSourceFile(source);
      await assert.rejects(
        staging,
        (error) =>
          errorName(error) === "DocumentFileSourceError" ||
          errorName(error) === "SourceFileTooLargeError"
      );
      assert.equal(await readFile(replacedPath, "utf8"), "replacement staged owner");
      assert.equal((await stat(`${replacedPath}.original`)).isFile(), true);
    } finally {
      await store.close();
    }
  }));

test("rejects symlinked or replaced storage parents before using them", async () => {
  await withTempDirectory(async (directory) => {
    const outside = await mkdtemp(join(tmpdir(), "planview-outside-"));
    const linkedParent = join(directory, "linked-parent");
    await symlink(outside, linkedParent);
    assert.throws(
      () =>
        Effect.runSync(
          openDocumentFileStore({
            documentsDir: join(linkedParent, "documents"),
            stagingDir: join(directory, "staging"),
          })
        ),
      (error) => error instanceof DocumentFileStorePathError
    );
    await rm(outside, { recursive: true, force: true });
  });

  await withStore(async ({ directory, store }) => {
    const documents = join(directory, "documents");
    const outside = await mkdtemp(join(tmpdir(), "planview-replaced-"));
    await rm(documents, { recursive: true, force: true });
    await symlink(outside, documents);
    await assert.rejects(
      store.readDocument(validId),
      (error) => error instanceof DocumentFileStorePathError
    );
    await rm(documents, { force: true });
    await rm(outside, { recursive: true, force: true });
  });
});

test("rejects nonregular and symlink final targets without replacing them", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "target safety");
    const outside = join(directory, "outside.html");
    await writeFile(outside, "outside");
    const target = join(directory, "documents", `${validId}.html`);
    await symlink(outside, target);
    const symlinkHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(symlinkHandle, validId),
      (error) => error instanceof DocumentFileNotRegularError
    );
    assert.equal(await readFile(outside, "utf8"), "outside");
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    await rm(target, { force: true });

    await mkdir(target);
    const directoryHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(directoryHandle, validId),
      (error) => error instanceof DocumentFileNotRegularError
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    await rm(target, { recursive: true, force: true });
  }));

test("a document store scope waits for active operations before finalizing", () =>
  withTempDirectory(async (directory) => {
    const source = join(directory, "active.html");
    await writeFile(source, "active scoped operation");
    let signalCopyStarted!: () => void;
    let releaseCopy!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      signalCopyStarted = resolve;
    });
    const copyGate = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const scope = Effect.runSync(Scope.make("sequential"));
    const store = Effect.runSync(
      Scope.provide(scope)(
        openDocumentFileStoreScoped({
          documentsDir: join(directory, "documents"),
          stagingDir: join(directory, "staging"),
          beforeStagedSourceCopy: async () => {
            signalCopyStarted();
            await copyGate;
          },
        })
      )
    );
    const staging = store.stageSourceFile(source);
    await copyStarted;

    let scopeClosed = false;
    const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
      scopeClosed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(scopeClosed, false);
      releaseCopy();
      const handle = await staging;
      await closing;
      assert.equal(scopeClosed, true);
      assert.equal((await stat(join(directory, "staging", handle))).isFile(), true);
      await assert.rejects(
        store.stageSourceFile(source),
        (error) => error instanceof DocumentFileStoreClosedError
      );
    } finally {
      releaseCopy();
      await closing;
    }
  }));

test("recovers a crash-stale finalization lock", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "stale.html");
    await writeFile(source, "stale lock");
    const handle = await store.stageSourceFile(source);
    const lockPath = join(directory, "staging", `.${handle}.lock`);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./finalization-lock-worker.mts", import.meta.url)), lockPath],
      { stdio: "ignore" }
    );
    const result = await waitForChild(child, 1_000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 42);

    await store.finalizeStagedFile(handle, validId);
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("concurrent Planview stale-lock recovery has one atomic winner", async () => {
  await withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    let arrived = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const openRacingStore = () =>
      Effect.runSync(
        openDocumentFileStore({
          documentsDir,
          stagingDir,
          beforeFinalizationLockRecoveryClaim: async () => {
            arrived += 1;
            if (arrived === 2) {
              releaseBarrier();
            }
            await barrier;
          },
        })
      );
    const firstStore = openRacingStore();
    const secondStore = openRacingStore();
    try {
      const source = join(directory, "concurrent-stale.html");
      await writeFile(source, "one recovery winner");
      const handle = await firstStore.stageSourceFile(source);
      const lockPath = join(stagingDir, `.${handle}.lock`);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./finalization-lock-worker.mts", import.meta.url)), lockPath],
        { stdio: "ignore" }
      );
      const childResult = await waitForChild(child, 1_000);
      assert.equal(childResult.code, 42);

      const results = await Promise.allSettled([
        firstStore.finalizeStagedFile(handle, validId),
        secondStore.finalizeStagedFile(handle, validId),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.equal(
        rejected?.reason instanceof DocumentFileFinalizeError &&
          rejected.reason.finalizationLockState === "retained" &&
          rejected.reason.stagedFileState === "retained",
        true
      );
      assert.equal(
        (await readFile(join(documentsDir, `${validId}.html`))).toString(),
        "one recovery winner"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    } finally {
      await firstStore.close();
      await secondStore.close();
    }
  });
});

test("does not recover an expired lock whose owner is still active", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "active-lock.html");
    await writeFile(source, "active lock");
    const handle = await store.stageSourceFile(source);
    const lockPath = join(directory, "staging", `.${handle}.lock`);
    await mkdir(lockPath);
    const now = Date.now();
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        version: 1,
        owner: { pid: process.pid, host: hostname(), token: "active-lock" },
        acquiredAt: now - 60_000,
        leaseExpiresAt: now - 30_000,
      })
    );

    await assert.rejects(store.finalizeStagedFile(handle, validId), /already being finalized/);
    assert.equal((await stat(join(directory, "staging", handle))).isFile(), true);
    assert.equal((await stat(lockPath)).isDirectory(), true);
    await rm(lockPath, { recursive: true, force: true });
    await store.finalizeStagedFile(handle, validId);
  }));

test("out-of-model hostile external lock replacement is retained", async () => {
  await withTempDirectory(async (directory) => {
    let lockPath = "";
    let replacedLockPath = "";
    let replaced = false;
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeFinalizationLockRecoveryClaim: async (candidate) => {
          if (replaced) {
            return;
          }
          replaced = true;
          replacedLockPath = `${lockPath}.replaced`;
          renameSync(lockPath, replacedLockPath);
          await mkdir(lockPath);
          const now = Date.now();
          await writeFile(
            join(candidate, "owner.json"),
            JSON.stringify({
              version: 1,
              owner: { pid: process.pid, host: hostname(), token: "replacement-owner" },
              acquiredAt: now,
              leaseExpiresAt: now + 30_000,
            })
          );
        },
      })
    );
    try {
      const source = join(directory, "replacement-race.html");
      await writeFile(source, "replacement race");
      const handle = await store.stageSourceFile(source);
      lockPath = join(stagingDir, `.${handle}.lock`);
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./finalization-lock-worker.mts", import.meta.url)), lockPath],
        { stdio: "ignore" }
      );
      const result = await waitForChild(child, 1_000);
      assert.equal(result.code, 42);

      await assert.rejects(
        store.finalizeStagedFile(handle, validId),
        (error) =>
          error instanceof DocumentFileFinalizeError &&
          error.finalizationLockState === "retained" &&
          error.stagedFileState === "retained"
      );
      assert.equal(
        JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).owner.token,
        "replacement-owner"
      );
      await rm(lockPath, { recursive: true, force: true });
      await store.finalizeStagedFile(handle, validId);
      await rm(replacedLockPath, { recursive: true, force: true });
    } finally {
      await store.close();
    }
  });
});

test("out-of-model hostile external source replacement cannot change clone bytes", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    let handle!: StagedDocumentFileHandle;
    let raced = false;
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeStagedCloneLink: async () => {
          if (raced) {
            return;
          }
          raced = true;
          renameSync(join(stagingDir, handle), join(stagingDir, "original-snapshot"));
          await writeFile(join(stagingDir, handle), "replacement bytes");
        },
      })
    );
    try {
      const source = join(directory, "clone-race.html");
      await writeFile(source, "original bytes");
      handle = await store.stageSourceFile(source);
      await assert.rejects(
        store.cloneStagedFile(handle),
        (error) =>
          error instanceof DocumentFileCloneError &&
          error.sourceFileState === "unknown" &&
          error.clonedFileState === "absent" &&
          error.finalizationLockState === "absent"
      );
      assert.equal(await readFile(join(stagingDir, "original-snapshot"), "utf8"), "original bytes");
      assert.equal(await readFile(join(stagingDir, handle), "utf8"), "replacement bytes");
    } finally {
      await store.close();
    }
  }));

test("out-of-model hostile external clone-path replacement is retained", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    let replaced = false;
    let clonedPath = "";
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeStagedCloneCleanup: async (clonedPathValue) => {
          if (replaced) {
            return;
          }
          replaced = true;
          clonedPath = clonedPathValue;
          renameSync(clonedPathValue, `${clonedPathValue}.original`);
          await writeFile(clonedPath, "replacement staged bytes");
        },
      })
    );
    try {
      const source = join(directory, "clone-cleanup-race.html");
      await writeFile(source, "original staged bytes");
      const handle = await store.stageSourceFile(source);
      await assert.rejects(
        store.cloneStagedFile(handle),
        (error) =>
          error instanceof DocumentFileCloneError &&
          error.clonedFileState === "unknown" &&
          error.finalizationLockState === "absent"
      );
      assert.equal(await readFile(`${clonedPath}.original`, "utf8"), "original staged bytes");
      assert.equal(await readFile(clonedPath, "utf8"), "replacement staged bytes");
    } finally {
      await store.close();
    }
  }));

test("out-of-model hostile external target replacement is retained during finalization", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeFinalizationTargetCleanup: async () => {
          const target = join(documentsDir, `${validId}.html`);
          renameSync(target, `${target}.original`);
          await writeFile(target, "replacement target bytes");
          throw new Error("fault after target link");
        },
      })
    );
    try {
      const source = join(directory, "target-cleanup-race.html");
      await writeFile(source, "original target bytes");
      const handle = await store.stageSourceFile(source);
      await assert.rejects(
        store.finalizeStagedFile(handle, validId),
        (error) =>
          error instanceof DocumentFileFinalizeError &&
          error.targetState === "unknown" &&
          error.finalizationLockState === "absent"
      );
      assert.equal(
        await readFile(join(documentsDir, `${validId}.html`), "utf8"),
        "replacement target bytes"
      );
      assert.equal(
        await readFile(join(documentsDir, `${validId}.html.original`), "utf8"),
        "original target bytes"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    } finally {
      await store.close();
    }
  }));

test("target identity inspection failure retains the target as unknown", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeFinalizationTargetInspection: async () => {
          throw new Error("target inspection fault");
        },
      })
    );
    try {
      const source = join(directory, "target-inspection-fault.html");
      await writeFile(source, "target inspection fault");
      const handle = await store.stageSourceFile(source);
      await assert.rejects(
        store.finalizeStagedFile(handle, validId),
        (error) =>
          error instanceof DocumentFileFinalizeError &&
          error.targetCreated === true &&
          error.targetState === "unknown" &&
          error.targetCapability === undefined
      );
      assert.equal(
        await readFile(join(documentsDir, `${validId}.html`), "utf8"),
        "target inspection fault"
      );
      assert.deepEqual(await readdir(stagingDir), []);
    } finally {
      await store.close();
    }
  }));

test("out-of-model hostile external target replacement is retained during deletion", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir,
        stagingDir,
        beforeDocumentTargetDelete: async (targetPath) => {
          renameSync(targetPath, `${targetPath}.original`);
          await writeFile(targetPath, "replacement target owner");
        },
      })
    );
    try {
      const source = join(directory, "target-delete-race.html");
      await writeFile(source, "original target owner");
      const handle = await store.stageSourceFile(source);
      const capability = await store.finalizeStagedFile(handle, validId);
      await assert.rejects(
        store.deleteDocumentFile(validId, capability),
        (error) => error instanceof DocumentFileDeleteError && error.targetState === "unknown"
      );
      assert.equal(
        await readFile(join(documentsDir, `${validId}.html`), "utf8"),
        "replacement target owner"
      );
      assert.equal(
        await readFile(join(documentsDir, `${validId}.html.original`), "utf8"),
        "original target owner"
      );
    } finally {
      await store.close();
    }
  }));

test("concurrent Planview finalization of one id has one atomic winner", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const firstStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
    const secondStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
    try {
      const firstSource = join(directory, "first.html");
      const secondSource = join(directory, "second.html");
      await writeFile(firstSource, "first");
      await writeFile(secondSource, "second");
      const firstHandle = await firstStore.stageSourceFile(firstSource);
      const secondHandle = await secondStore.stageSourceFile(secondSource);
      const results = await Promise.allSettled([
        firstStore.finalizeStagedFile(firstHandle, validId),
        secondStore.finalizeStagedFile(secondHandle, validId),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected);
      assert.equal(
        rejected.reason instanceof DocumentFileAlreadyExistsError ||
          rejected.reason instanceof DocumentFileTargetBusyError,
        true
      );
      assert.deepEqual(await readdir(stagingDir), []);
      const published = await readFile(join(documentsDir, `${validId}.html`));
      assert.equal(
        [Buffer.from("first"), Buffer.from("second")].some((contents) =>
          contents.equals(published)
        ),
        true
      );
    } finally {
      firstStore.close();
      secondStore.close();
    }
  }));

test("finalization uses a validated id, consumes the handle, and never replaces a file", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "first");
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, validId);
    await assert.rejects(store.readDocument("../escape"), /Document id must be exactly/);
    await assert.rejects(
      store.finalizeStagedFile("../escape" as StagedDocumentFileHandle, otherId),
      (error) => error instanceof InvalidStagedDocumentFileHandleError
    );

    await writeFile(source, "second");
    const duplicateHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(duplicateHandle, validId),
      (error) => error instanceof DocumentFileAlreadyExistsError
    );
    assert.deepEqual(
      await readFile(join(directory, "documents", `${validId}.html`)),
      Buffer.from("first")
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("reads and deletes safely, including missing documents", () =>
  withStore(async ({ directory, store }) => {
    await assert.rejects(store.readDocument(otherId), /Could not open document file/);
    assert.equal(await store.deleteDocumentFile(otherId), false);
    await assert.rejects(
      store.deleteDocumentFile("../../etc/passwd"),
      /Document id must be exactly/
    );

    const source = join(directory, "input.html");
    await writeFile(source, "read me");
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, otherId);
    assert.equal((await readStream(await store.readDocument(otherId))).toString(), "read me");
    assert.equal(await store.deleteDocumentFile(otherId), true);
    assert.equal(await store.deleteDocumentFile(otherId), false);
    assert.deepEqual(await readdir(join(directory, "documents")), []);
  }));

test("inspects bundles and reads only the requested entry range", () =>
  withStore(async ({ directory, store }) => {
    const bundle = makeBundle([
      { path: "index.html", contents: Buffer.from("<h1>home</h1>") },
      { path: "assets/app.css", contents: Buffer.from("body { color: red; }") },
      { path: "empty.txt", contents: Buffer.alloc(0) },
    ]);
    const source = join(directory, "bundle.html");
    await writeFile(source, bundle);
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, validId);

    const format = await store.inspectDocumentFormat(validId);
    assert.equal(format.kind, "bundle");
    assert.deepEqual(
      format.manifest.entries.map(({ path, size }) => ({ path, size })),
      [
        { path: "index.html", size: 13 },
        { path: "assets/app.css", size: 20 },
        { path: "empty.txt", size: 0 },
      ]
    );

    const cssLease = await store.readDocumentEntryLease(validId, "assets/app.css");
    try {
      assert.equal((await readStream(cssLease.stream)).toString(), "body { color: red; }");
    } finally {
      cssLease.release();
    }
    const emptyLease = await store.readDocumentEntryLease(validId, "empty.txt");
    try {
      assert.equal((await readStream(emptyLease.stream)).byteLength, 0);
    } finally {
      emptyLease.release();
    }
    await assert.rejects(
      store.readDocumentEntryLease(validId, "../secret"),
      (error) => errorName(error) === "InvalidBundleError"
    );
  }));

test("does not treat a raw HTML document as a page bundle", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "raw.html");
    await writeFile(source, "<p>raw</p>");
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, validId);
    assert.deepEqual(await store.inspectDocumentFormat(validId), { kind: "html" });
    await assert.rejects(
      store.readDocumentEntryLease(validId, "index.html"),
      (error) => error instanceof DocumentFileNotBundleError
    );
  }));

test("cleans a failed finalization and reports path initialization errors", async () => {
  await withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "cleanup");
    const handle = await store.stageSourceFile(source);
    await rm(join(directory, "staging", handle));
    await assert.rejects(store.finalizeStagedFile(handle, validId));
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    store.close();
    await assert.rejects(
      store.stageSourceFile(source),
      (error) => error instanceof DocumentFileStoreClosedError
    );
  });

  assert.throws(
    () =>
      Effect.runSync(
        openDocumentFileStore({ documentsDir: "relative", stagingDir: "/tmp/staging" })
      ),
    (error) => error instanceof DocumentFileStorePathError
  );
});
