import { isValidDocumentId } from "@planview/core";
import type { LocalApplication, LocalDaemonStatus } from "@planview/local";
import { Effect } from "effect";
import { parseOptions } from "../arguments.js";
import { formatHelp, type Command, type HelpTopic } from "../help.js";
import {
  DaemonCommandError,
  GetCommandError,
  PublishCommandError,
  cleanupResultForJson,
  describe,
  openBrowserFailure,
  unexpectedArguments,
  writeCommandResult,
  writeOutput,
  type CliError,
  type OutputFormat,
  type StdoutWriter,
} from "../output.js";

type DaemonCommand = Exclude<
  Command,
  "publish" | "upload" | "login" | "logout" | "get" | "help" | "list" | "usage" | "delete" | "ui"
>;

type OpenUrl = (url: string) => Promise<void>;

const writeHelp = (stdout: StdoutWriter, topic?: HelpTopic) =>
  writeOutput(stdout, formatHelp(topic)).pipe(Effect.as(0));

const formatRunning = (status: Extract<LocalDaemonStatus, { readonly state: "running" }>) =>
  `plansplease daemon is running at http://${status.host}:${status.port}/ (pid ${status.pid}).\n`;

const runPublishCommand = (
  application: LocalApplication,
  sourcePath: string,
  format: OutputFormat,
  open: boolean,
  stdout: StdoutWriter,
  openUrl: OpenUrl
) =>
  Effect.gen(function* () {
    const published = yield* application.publish(sourcePath).pipe(
      Effect.mapError(
        (cause) =>
          new PublishCommandError({
            sourcePath,
            cause,
            message: `Could not publish ${sourcePath}: ${describe(cause)}`,
          })
      )
    );
    yield* writeCommandResult(stdout, format, published, ({ url }) => `${url}\n`);
    if (open) {
      yield* Effect.tryPromise({
        try: () => openUrl(published.url),
        catch: (cause) => openBrowserFailure(sourcePath, published.url, cause),
      });
    }
    return 0;
  });

const runGetCommand = (application: LocalApplication, reference: string, stdout: StdoutWriter) =>
  application
    .get({
      reference,
      onChunk: stdout,
    })
    .pipe(
      Effect.map(() => 0),
      Effect.mapError(
        (cause) =>
          new GetCommandError({
            reference,
            cause,
            message: `Could not retrieve ${reference}: ${describe(cause)}`,
          })
      )
    );

const runDaemonCommand = Effect.fnUntraced(
  function* (
    command: DaemonCommand,
    application: LocalApplication,
    format: OutputFormat,
    stdout: StdoutWriter
  ) {
    if (command === "status") {
      const result = yield* application.inspect();
      yield* writeCommandResult(stdout, format, result, (status) =>
        status.state === "running" ? formatRunning(status) : "plansplease daemon is not running.\n"
      );
      return 0;
    }

    if (command === "stop") {
      yield* application.stop();
      yield* writeCommandResult(
        stdout,
        format,
        { state: "stopped" },
        () => "plansplease daemon stopped.\n"
      );
      return 0;
    }

    if (command === "restart") {
      const result = yield* application.restart();
      yield* writeCommandResult(
        stdout,
        format,
        result,
        (status) => `plansplease daemon restarted at http://${status.host}:${status.port}/.\n`
      );
      return 0;
    }

    if (command === "clean") {
      const result = yield* application.clean();
      const failures = result.failures.length;
      const summary =
        result.removedDocuments === 0 &&
        result.removedDocumentFiles === 0 &&
        result.removedMetadataRows === 0 &&
        result.removedStagedFiles === 0 &&
        result.removedReadReferences === 0 &&
        result.removedFinalizationLocks === 0 &&
        result.retainedEntries === 0
          ? "plansplease cleanup found no expired or inconsistent snapshots."
          : `plansplease cleanup removed ${result.removedDocuments} expired snapshot${result.removedDocuments === 1 ? "" : "s"}, reconciled ${result.removedMetadataRows} metadata row${result.removedMetadataRows === 1 ? "" : "s"} and ${result.removedDocumentFiles} document file${result.removedDocumentFiles === 1 ? "" : "s"}, reclaimed ${result.reclaimedBytes} bytes, and removed ${result.removedStagedFiles} staged file${result.removedStagedFiles === 1 ? "" : "s"}, ${result.removedReadReferences} crashed-read marker${result.removedReadReferences === 1 ? "" : "s"}, and ${result.removedFinalizationLocks} finalization lock${result.removedFinalizationLocks === 1 ? "" : "s"}.`;
      yield* writeCommandResult(stdout, format, cleanupResultForJson(result), (cleanup) => {
        const retained = cleanup.retainedEntries;
        return `${summary}${retained === 0 ? "" : ` ${retained} state${retained === 1 ? "" : "s"} retained for retry.`}\n`;
      });
      return failures === 0 ? 0 : 1;
    }

    const result = yield* application.start();
    yield* writeCommandResult(
      stdout,
      format,
      { ...result.status, reused: result.reused },
      (start) =>
        start.reused
          ? `plansplease daemon is already running at http://${start.host}:${start.port}/.\n`
          : `plansplease daemon started at http://${start.host}:${start.port}/.\n`
    );
    return 0;
  },
  (effect, command) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new DaemonCommandError({
            command,
            cause,
            message: `Could not ${command} the plansplease daemon: ${describe(cause)}`,
          })
      )
    )
);

export const runDocumentCommand = (
  commandName: "publish" | "get",
  application: LocalApplication,
  args: readonly string[],
  stdout: StdoutWriter,
  openUrl: OpenUrl
): Effect.Effect<number, CliError> =>
  parseOptions(args, {
    allowJson: commandName === "publish",
    allowOpen: commandName === "publish",
    allowLeadingHyphenOperand: (argument) => commandName === "get" && isValidDocumentId(argument),
    helpTopic: commandName,
  }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) {
        return writeHelp(stdout, commandName);
      }

      if (parsed.operands.length !== 1 || parsed.operands[0] === undefined) {
        const label =
          parsed.operands.length === 0
            ? commandName === "get"
              ? "Missing document id or URL"
              : "Missing source file or folder"
            : "Unexpected arguments";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}: ${parsed.operands.join(" ")}\n\n${formatHelp(commandName)}`
          )
        );
      }

      const format: OutputFormat = parsed.json ? "json" : "text";
      const operand = parsed.operands[0];
      if (commandName === "publish") {
        return runPublishCommand(application, operand, format, parsed.open, stdout, openUrl);
      }
      return runGetCommand(application, operand, stdout);
    })
  );

export const runDaemonCommandFromArgs = (
  commandName: DaemonCommand,
  application: LocalApplication,
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowJson: true, helpTopic: commandName }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) {
        return writeHelp(stdout, commandName);
      }
      if (parsed.operands.length > 0) {
        const label = parsed.operands.length === 1 ? "Unexpected argument" : "Unexpected arguments";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}: ${parsed.operands.join(" ")}\n\n${formatHelp(commandName)}`
          )
        );
      }
      return runDaemonCommand(commandName, application, parsed.json ? "json" : "text", stdout);
    })
  );

export const runInventoryCommand = (
  command: "list" | "usage" | "delete" | "pin" | "unpin",
  application: LocalApplication,
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, {
    allowJson: true,
    helpTopic: command,
    valueOptions:
      command === "list"
        ? ["--limit", "--after"]
        : command === "delete" || command === "pin" || command === "unpin"
          ? ["--generation"]
          : [],
    allowLeadingHyphenOperand: (argument) =>
      (command === "delete" || command === "pin" || command === "unpin") &&
      isValidDocumentId(argument),
  }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, command);
      if (
        parsed.operands.length !== (["delete", "pin", "unpin"].includes(command) ? 1 : 0) ||
        (["delete", "pin", "unpin"].includes(command) &&
          parsed.named?.["--generation"] === undefined)
      ) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Expected ${["delete", "pin", "unpin"].includes(command) ? "one id and --generation" : "no operands"}.\n\n${formatHelp(command)}`
          )
        );
      }
      const format: OutputFormat = parsed.json ? "json" : "text";
      return Effect.gen(function* () {
        if (command === "list") {
          const limit = parsed.named?.["--limit"];
          const after = parsed.named?.["--after"];
          const result = yield* application.list({
            ...(limit === undefined ? {} : { limit: Number(limit) }),
            ...(after === undefined ? {} : { after }),
          });
          yield* writeCommandResult(
            stdout,
            format,
            result,
            (page) =>
              page.snapshots
                .map(
                  (row) =>
                    `${row.id} ${row.generation} ${row.size} bytes pinned=${row.pinned} expiresAt=${row.expiresAt} unpinnedExpiresAt=${row.unpinnedExpiresAt}\n`
                )
                .join("") +
              (page.nextAfter === undefined ? "" : `Continue with --after ${page.nextAfter}\n`)
          );
          return 0;
        }
        if (command === "usage") {
          const result = yield* application.usage();
          yield* writeCommandResult(
            stdout,
            format,
            result,
            (usage) =>
              `${usage.documentCount} snapshots, ${usage.bytes}/${usage.quotaBytes} logical bytes (${usage.documentBytes} document + ${usage.metadataBytes} metadata). Pinned: ${usage.pinnedCount} snapshots, ${usage.pinnedBytes} logical bytes. Unpinned retention: ${usage.retentionMilliseconds / 86400000} days since last access.\n`
          );
          return 0;
        }
        if (command === "pin" || command === "unpin") {
          const result = yield* application.setPinned(
            { id: parsed.operands[0] ?? "", generation: parsed.named?.["--generation"] ?? "" },
            command === "pin"
          );
          yield* writeCommandResult(
            stdout,
            format,
            result,
            (value) =>
              `${value.id}: ${value.status}.${value.retention ? ` Pinned: ${value.retention.pinned}. Effective expiry: ${value.retention.expiresAt ?? "none while pinned"}. Unpinned expiry: ${value.retention.unpinnedExpiresAt}. Unpin may make an expired snapshot immediately eligible for cleanup.` : " Refresh list before retrying."}\n`
          );
          return result.status === "updated" ? 0 : 1;
        }
        const result = yield* application.deleteSnapshot({
          id: parsed.operands[0] ?? "",
          generation: parsed.named?.["--generation"] ?? "",
        });
        yield* writeCommandResult(
          stdout,
          format,
          result,
          (deletion) =>
            `${deletion.id}: ${deletion.status}. Recovery: ${deletion.recovery}.${deletion.message === undefined ? "" : ` ${deletion.message}`}\n`
        );
        return result.status === "deleted" || result.status === "not_found" ? 0 : 1;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonCommandError({
              command,
              cause,
              message: `Could not ${command} local snapshots: ${describe(cause)}`,
            })
        )
      );
    })
  );

export const runManagerCommand = (
  application: LocalApplication,
  args: readonly string[],
  stdout: StdoutWriter,
  openUrl: OpenUrl
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowJson: true, allowOpen: true, helpTopic: "ui" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "ui");
      if (parsed.operands.length !== 0)
        return Effect.fail(unexpectedArguments(parsed.operands, formatHelp("ui")));
      return Effect.gen(function* () {
        const launch = yield* application.manager();
        yield* writeCommandResult(
          stdout,
          parsed.json ? "json" : "text",
          launch,
          (result) => `${result.url}\n`
        );
        if (parsed.open)
          yield* Effect.tryPromise({
            try: () => openUrl(launch.url),
            catch: (cause) => openBrowserFailure("local manager", launch.url, cause),
          });
        return 0;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DaemonCommandError({
              command: "ui",
              cause,
              message: `Could not open the local manager: ${describe(cause)}. If the daemon predates this installation, run plansplease restart.`,
            })
        )
      );
    })
  );
