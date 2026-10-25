import { DEFAULT_PROFILE_NAME, type DocumentId } from "@planview/core";
import {
  listDaemonSnapshots,
  getDaemonStorageUsage,
  deleteDaemonSnapshot,
  cleanDaemon,
  type DaemonConfig,
  type DaemonError,
  inspectDaemon,
  publishDocument,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  restartDaemon,
  retrieveDocument,
  startDetachedDaemon,
  stopDaemon,
} from "@planview/daemon";
import type {
  SnapshotListOptions,
  SnapshotSelection,
  SnapshotInventory,
  SnapshotUsage,
  SnapshotDeleteResult,
  DocumentCleanupResult,
} from "@planview/storage";
import { Data, Effect } from "effect";
import { preparePublishSource } from "./publish-source.js";
import { parseDocumentReferenceDetails } from "./reference.js";

export type LocalOperation =
  | "publish"
  | "get"
  | "start"
  | "stop"
  | "restart"
  | "inspect"
  | "clean"
  | "list"
  | "usage"
  | "delete";

export class LocalApplicationError extends Data.TaggedError("LocalApplicationError")<{
  readonly operation: LocalOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type LocalApplicationFailure = LocalApplicationError | DaemonError;

export type LocalApplicationOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly config?: DaemonConfig;
  readonly profile?: string;
}>;

export type LocalPublishedDocument = Readonly<{
  readonly id: DocumentId;
  readonly url: string;
}>;

export type LocalDaemonRunningStatus = Readonly<{
  readonly state: "running";
  readonly profile: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}>;

export type LocalDaemonStatus = Readonly<{ readonly state: "stopped" }> | LocalDaemonRunningStatus;

export type LocalDaemonStartResult = Readonly<{
  readonly status: LocalDaemonRunningStatus;
  readonly reused: boolean;
}>;

export type LocalGetOptions = Readonly<{
  readonly reference: string;
  readonly onChunk: (chunk: Uint8Array) => void | Promise<void>;
}>;

export type LocalApplication = Readonly<{
  readonly list: (
    options?: SnapshotListOptions
  ) => Effect.Effect<SnapshotInventory, LocalApplicationFailure>;
  readonly usage: () => Effect.Effect<SnapshotUsage, LocalApplicationFailure>;
  readonly deleteSnapshot: (
    selection: SnapshotSelection
  ) => Effect.Effect<SnapshotDeleteResult, LocalApplicationFailure>;
  readonly publish: (
    sourcePath: string
  ) => Effect.Effect<LocalPublishedDocument, LocalApplicationFailure>;
  readonly get: (options: LocalGetOptions) => Effect.Effect<void, LocalApplicationFailure>;
  readonly start: () => Effect.Effect<LocalDaemonStartResult, LocalApplicationFailure>;
  readonly stop: () => Effect.Effect<void, LocalApplicationFailure>;
  readonly restart: () => Effect.Effect<LocalDaemonRunningStatus, LocalApplicationFailure>;
  readonly inspect: () => Effect.Effect<LocalDaemonStatus, LocalApplicationFailure>;
  readonly clean: () => Effect.Effect<DocumentCleanupResult, LocalApplicationFailure>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const localFailure = (operation: LocalOperation, cause: unknown) =>
  new LocalApplicationError({
    operation,
    cause,
    message: `Local ${operation} failed: ${describe(cause)}`,
  });

const statusFromDescriptor = (descriptor: {
  readonly profile?: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}): LocalDaemonRunningStatus => ({
  state: "running",
  profile: descriptor.profile ?? DEFAULT_PROFILE_NAME,
  pid: descriptor.pid,
  host: descriptor.host,
  port: descriptor.port,
  startedAt: descriptor.startedAt,
});

const withConfig = Effect.fnUntraced(function* <A, E>(
  operation: LocalOperation,
  resolveConfig: () => DaemonConfig,
  run: (config: DaemonConfig) => Effect.Effect<A, E>
): Effect.fn.Return<A, E | LocalApplicationError> {
  const config = yield* Effect.try({
    try: resolveConfig,
    catch: (cause) => localFailure(operation, cause),
  });
  return yield* run(config);
});

export const createLocalApplication = (options: LocalApplicationOptions): LocalApplication => {
  const resolveConfig = () => {
    if (options.config !== undefined) {
      return options.config;
    }
    const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
    const profile = options.profile === undefined ? {} : { profile: options.profile };
    return NODE_ENV === "test" && configuredTestPort !== undefined
      ? resolveDaemonConfigForTest({ ...profile, port: Number(configuredTestPort) })
      : resolveDaemonConfig(profile);
  };
  const daemonOptions = { daemonScriptPath: options.daemonScriptPath };

  const publish = Effect.fn("LocalApplication.publish")(function* (sourcePath: string) {
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => preparePublishSource(sourcePath),
        catch: (cause) => localFailure("publish", cause),
      }),
      (prepared) =>
        withConfig("publish", resolveConfig, (config) =>
          publishDocument(config, {
            ...daemonOptions,
            sourcePath: prepared.sourcePath,
            sourceSizeBytes: prepared.sourceSizeBytes,
          }).pipe(
            Effect.map((published) => ({
              id: published.id,
              url: `http://localhost:${published.descriptor.port}/${published.id}`,
            }))
          )
        ),
      (prepared) =>
        Effect.tryPromise({
          try: () => prepared.cleanup(),
          catch: (cause) => localFailure("publish", cause),
        })
    );
  });

  const get = Effect.fn("LocalApplication.get")(function* ({
    reference,
    onChunk,
  }: LocalGetOptions) {
    const config = yield* Effect.try({
      try: resolveConfig,
      catch: (cause) => localFailure("get", cause),
    });
    const parsed = yield* Effect.try({
      try: () => parseDocumentReferenceDetails(reference),
      catch: (cause) => localFailure("get", cause),
    });
    if (parsed.port !== undefined) {
      const running = yield* startDetachedDaemon(config, daemonOptions);
      if (running.descriptor.port !== parsed.port) {
        return yield* Effect.fail(
          localFailure(
            "get",
            new Error(
              `The URL uses port ${parsed.port}, but profile ${config.profile} is running on port ${running.descriptor.port}.`
            )
          )
        );
      }
    }
    yield* retrieveDocument(config, {
      ...daemonOptions,
      documentId: parsed.documentId,
      onChunk,
    });
  });

  const start = Effect.fn("LocalApplication.start")(function* () {
    return yield* withConfig("start", resolveConfig, (config) =>
      startDetachedDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor, reused }) => ({
          status: statusFromDescriptor(descriptor),
          reused,
        }))
      )
    );
  });

  const stop = Effect.fn("LocalApplication.stop")(function* () {
    return yield* withConfig("stop", resolveConfig, (config) =>
      stopDaemon(config).pipe(Effect.asVoid)
    );
  });

  const restart = Effect.fn("LocalApplication.restart")(function* () {
    return yield* withConfig("restart", resolveConfig, (config) =>
      restartDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor }) => statusFromDescriptor(descriptor))
      )
    );
  });

  const inspect = Effect.fn("LocalApplication.inspect")(function* () {
    return yield* withConfig("inspect", resolveConfig, (config) =>
      inspectDaemon(config).pipe(
        Effect.map((status) =>
          status.state === "running" ? statusFromDescriptor(status.status) : status
        )
      )
    );
  });

  const clean = Effect.fn("LocalApplication.clean")(function* () {
    return yield* withConfig("clean", resolveConfig, (config) =>
      cleanDaemon(config, daemonOptions).pipe(Effect.map(({ result }) => result))
    );
  });

  const list = (input: SnapshotListOptions = {}) =>
    withConfig("list", resolveConfig, (config) =>
      listDaemonSnapshots(config, daemonOptions, input)
    );
  const usage = () =>
    withConfig("usage", resolveConfig, (config) => getDaemonStorageUsage(config, daemonOptions));
  const deleteSnapshot = (input: SnapshotSelection) =>
    withConfig("delete", resolveConfig, (config) =>
      deleteDaemonSnapshot(config, daemonOptions, input)
    );
  return { publish, get, start, stop, restart, inspect, clean, list, usage, deleteSnapshot };
};

export {
  isValidProfileName,
  normalizeMacosSystemPath,
  resolveAppDataPaths,
  validateProfileName,
} from "@planview/core";
export {
  parseDocumentReference,
  parseDocumentReferenceDetails,
} from "./reference.js";
export { preparePublishSource };

export type {
  SnapshotListOptions,
  SnapshotSelection,
  SnapshotInventory,
  SnapshotUsage,
  SnapshotDeleteResult,
} from "@planview/storage";
