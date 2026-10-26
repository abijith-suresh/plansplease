import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalApplication,
  type LocalApplication,
  parseDocumentReference,
} from "@planview/local";
import { Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  isCommand,
  isHelpOption,
  isVersionOption,
  parseGlobalOptions,
  parseOptions,
  unknownOption,
} from "./arguments.js";
import { loginToCloud, removeCloudCredentials, uploadCloudDocument } from "./cloud.js";
import {
  runManagerCommand,
  runInventoryCommand,
  runDaemonCommandFromArgs,
  runDocumentCommand,
} from "./commands/local.js";
import { formatHelp, type HelpTopic } from "./help.js";
import {
  CloudCommandError,
  OutputCommandError,
  UnknownCommandError,
  describe,
  formatError,
  outputFormatFromArgs,
  openBrowserFailure,
  unexpectedArguments,
  writeCommandResult,
  writeOutput,
  writeStderr,
  writeStdout,
  type CliError,
  type OutputFormat,
  type StdoutWriter,
} from "./output.js";

export { formatHelp, HELP } from "./help.js";
export { InvalidOptionValueError, UnknownOptionError } from "./arguments.js";
export {
  CloudCommandError,
  DaemonCommandError,
  GetCommandError,
  OpenBrowserCommandError,
  OutputCommandError,
  PublishCommandError,
  UnknownCommandError,
  UnexpectedArgumentsError,
  type CliError,
} from "./output.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const packageVersion = packageJson.version;
if (packageJson.name !== "@abijith-suresh/planview" || !SEMVER_PATTERN.test(packageVersion)) {
  throw new Error(`Invalid planview package metadata version: ${JSON.stringify(packageVersion)}`);
}

export const VERSION = packageVersion;

export const formatVersion = () => `plansplease ${VERSION}\n`;

const daemonScriptPath = () => fileURLToPath(new URL("./daemon.js", import.meta.url));

const applicationFor = (profile?: string): LocalApplication =>
  createLocalApplication({
    daemonScriptPath: daemonScriptPath(),
    ...(profile === undefined ? {} : { profile }),
  });

const browserCommand = () =>
  process.platform === "win32"
    ? { command: "cmd.exe", arguments: ["/c", "start", ""] }
    : process.platform === "darwin"
      ? { command: "open", arguments: [] }
      : { command: "xdg-open", arguments: [] };

export const openUrl = (url: string, spawnProcess: typeof spawn = spawn) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    const browser = browserCommand();
    let settled = false;
    const child = spawnProcess(browser.command, [...browser.arguments, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const cleanup = () => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };
    const onError = (cause: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(cause);
    };
    const onSpawn = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.unref();
      resolvePromise();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });

export const parseGetReference = (reference: string, port?: number) =>
  String(parseDocumentReference(reference, port));

const writeHelp = (stdout: StdoutWriter, topic?: HelpTopic) =>
  writeOutput(stdout, formatHelp(topic)).pipe(Effect.as(0));

const runHelpCommand = (
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, { helpTopic: "help" }).pipe(
    Effect.flatMap(({ help, operands }): Effect.Effect<number, CliError> => {
      if (operands.length === 0) {
        return writeHelp(stdout, help ? "help" : undefined);
      }

      const topic = operands.length === 1 && isCommand(operands[0]) ? operands[0] : undefined;
      if (topic === undefined) {
        const requestedTopic = operands.join(" ");
        return Effect.fail(
          new UnknownCommandError({
            command: requestedTopic,
            message: `Unknown help topic: ${requestedTopic}\n\n${formatHelp("help")}`,
          })
        );
      }
      return writeHelp(stdout, topic);
    })
  );

const runLoginCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowCloudUrl: true, helpTopic: "login" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "login");
      if (parsed.operands.length > 0) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Unexpected arguments: ${parsed.operands.join(" ")}\n\n${formatHelp("login")}`
          )
        );
      }

      return Effect.tryPromise({
        try: () =>
          loginToCloud({
            ...(profile === undefined ? {} : { profile }),
            ...(parsed.cloudUrl === undefined ? {} : { cloudUrl: parsed.cloudUrl }),
            openBrowser: openUrl,
            writeStatus: (message) => stdout(message),
          }),
        catch: (cause) =>
          new CloudCommandError({
            operation: "login",
            cause,
            message: `Cloud sign-in failed: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(({ cloudUrl }) =>
          writeOutput(stdout, `Signed in to ${cloudUrl}.\n`).pipe(Effect.as(0))
        )
      );
    })
  );

const runLogoutCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { helpTopic: "logout" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "logout");
      if (parsed.operands.length > 0) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Unexpected arguments: ${parsed.operands.join(" ")}\n\n${formatHelp("logout")}`
          )
        );
      }

      return Effect.tryPromise({
        try: async () => {
          await removeCloudCredentials(profile);
          return 0;
        },
        catch: (cause) =>
          new CloudCommandError({
            operation: "logout",
            cause,
            message: `Could not remove the saved cloud sign-in: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(() =>
          writeOutput(stdout, "Removed the cloud sign-in saved on this computer.\n").pipe(
            Effect.as(0)
          )
        )
      );
    })
  );

const runCloudUploadCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowJson: true, allowOpen: true, helpTopic: "upload" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "upload");
      if (parsed.operands.length !== 1 || parsed.operands[0] === undefined) {
        const label = parsed.operands.length === 0 ? "Missing HTML file:" : "Unexpected arguments:";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}${parsed.operands.length === 0 ? "" : ` ${parsed.operands.join(" ")}`}\n\n${formatHelp("upload")}`
          )
        );
      }

      const sourcePath = parsed.operands[0];
      const format: OutputFormat = parsed.json ? "json" : "text";
      return Effect.tryPromise({
        try: () => uploadCloudDocument(sourcePath, profile),
        catch: (cause) =>
          new CloudCommandError({
            operation: "upload",
            sourcePath,
            cause,
            message: `Could not upload ${sourcePath}: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap((uploaded) =>
          writeCommandResult(stdout, format, uploaded, ({ url }) => `${url}\n`).pipe(
            Effect.flatMap(() =>
              parsed.open
                ? Effect.tryPromise({
                    try: () => openUrl(uploaded.url),
                    catch: (cause) => openBrowserFailure(sourcePath, uploaded.url, cause),
                  })
                : Effect.succeed(undefined)
            ),
            Effect.map(() => 0)
          )
        )
      );
    })
  );

const commandWithProfile = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    return writeHelp(stdout);
  }

  if (isHelpOption(argument) || isVersionOption(argument)) {
    if (trailing.length > 0) {
      const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
      return Effect.fail(
        unexpectedArguments(trailing, `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`)
      );
    }

    return isVersionOption(argument)
      ? writeOutput(stdout, formatVersion()).pipe(Effect.as(0))
      : writeHelp(stdout);
  }

  if (!isCommand(argument)) {
    if (argument.startsWith("-")) {
      return Effect.fail(unknownOption(argument));
    }
    return Effect.fail(
      new UnknownCommandError({
        command: argument,
        message: `Unknown command: ${argument}\n\n${formatHelp()}`,
      })
    );
  }

  if (argument === "help") {
    return runHelpCommand(trailing, stdout);
  }

  if (argument === "login") {
    return runLoginCommand(trailing, stdout, profile);
  }

  if (argument === "logout") {
    return runLogoutCommand(trailing, stdout, profile);
  }

  if (argument === "upload") {
    return runCloudUploadCommand(trailing, stdout, profile);
  }

  const application = applicationFor(profile);

  if (argument === "ui") return runManagerCommand(application, trailing, stdout, openUrl);

  if (argument === "publish" || argument === "get") {
    return runDocumentCommand(argument, application, trailing, stdout, openUrl);
  }

  if (argument === "list" || argument === "usage" || argument === "delete") {
    return runInventoryCommand(argument, application, trailing, stdout);
  }

  return runDaemonCommandFromArgs(argument, application, trailing, stdout);
};

const command = (args: readonly string[], stdout: StdoutWriter): Effect.Effect<number, CliError> =>
  parseGlobalOptions(args).pipe(
    Effect.flatMap(({ profile, commandArguments }) =>
      commandWithProfile(commandArguments, stdout, profile)
    )
  );

export const run = (
  args: readonly string[],
  stdout = writeStdout,
  stderr = writeStderr
): Effect.Effect<number, CliError> =>
  command(args, stdout).pipe(
    Effect.tapError((error) =>
      Effect.try({
        try: () => stderr(formatError(error, outputFormatFromArgs(args))),
        catch: (cause) =>
          new OutputCommandError({
            cause,
            message: `Could not write command error: ${describe(cause)}`,
          }),
      })
    )
  );

const boundary = (program: Effect.Effect<number, CliError>) =>
  program.pipe(
    Effect.catchTag(
      [
        "UnknownOptionError",
        "InvalidOptionValueError",
        "UnknownCommandError",
        "UnexpectedArgumentsError",
        "DaemonCommandError",
        "PublishCommandError",
        "OpenBrowserCommandError",
        "GetCommandError",
        "CloudCommandError",
        "OutputCommandError",
      ],
      () => Effect.succeed(1)
    )
  );

export const main = (args = process.argv.slice(2), stdout = writeStdout, stderr = writeStderr) => {
  const program = boundary(run(args, stdout, stderr));
  return Effect.runPromise(program);
};

const isMain = (() => {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const result = main();
  if (result instanceof Promise) {
    result.then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = result;
  }
}
