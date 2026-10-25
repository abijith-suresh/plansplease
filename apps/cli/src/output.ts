import { Data, Effect } from "effect";
import { InvalidOptionValueError, UnknownOptionError } from "./arguments.js";

export type StdoutWriter = (message: string | Uint8Array) => void | Promise<void>;

export const writeStdout: StdoutWriter = (message) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.once("error", rejectPromise);
    try {
      process.stdout.write(message, (cause) => {
        if (cause) {
          // EPIPE can also emit an error event after the callback rejects.
          // Keep the once listener until that event consumes it.
          rejectPromise(cause);
          return;
        }
        process.stdout.off("error", rejectPromise);
        resolvePromise();
      });
    } catch (cause) {
      rejectPromise(cause instanceof Error ? cause : new Error(String(cause)));
    }
  });

export const writeStderr = (message: string) => {
  process.stderr.write(message);
};

export class UnknownCommandError extends Data.TaggedError("UnknownCommandError")<{
  readonly command: string;
  readonly message: string;
}> {}

export class UnexpectedArgumentsError extends Data.TaggedError("UnexpectedArgumentsError")<{
  readonly arguments: readonly string[];
  readonly message: string;
}> {}

export class DaemonCommandError extends Data.TaggedError("DaemonCommandError")<{
  readonly command: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class PublishCommandError extends Data.TaggedError("PublishCommandError")<{
  readonly sourcePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class OpenBrowserCommandError extends Data.TaggedError("OpenBrowserCommandError")<{
  readonly sourcePath: string;
  readonly url: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class GetCommandError extends Data.TaggedError("GetCommandError")<{
  readonly reference: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CloudCommandError extends Data.TaggedError("CloudCommandError")<{
  readonly operation: "login" | "logout" | "upload";
  readonly cause: unknown;
  readonly message: string;
  readonly sourcePath?: string;
}> {}

export class OutputCommandError extends Data.TaggedError("OutputCommandError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CliError =
  | UnknownOptionError
  | InvalidOptionValueError
  | UnknownCommandError
  | UnexpectedArgumentsError
  | DaemonCommandError
  | PublishCommandError
  | OpenBrowserCommandError
  | GetCommandError
  | CloudCommandError
  | OutputCommandError;

export const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const openBrowserFailure = (sourcePath: string, url: string, cause: unknown) =>
  new OpenBrowserCommandError({
    sourcePath,
    url,
    cause,
    message: `Could not open ${url} in a browser: ${describe(cause)}`,
  });

export type OutputFormat = "text" | "json";

export const unexpectedArguments = (argumentsList: readonly string[], message: string) =>
  new UnexpectedArgumentsError({
    arguments: argumentsList,
    message,
  });

const formatJson = (value: unknown) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("The command result could not be represented as JSON.");
  }
  return `${serialized}\n`;
};

type CleanupFailureForJson = Readonly<{
  readonly phase: string;
  readonly id?: string;
  readonly message: string;
}>;

export const cleanupResultForJson = <
  T extends { readonly failures: readonly CleanupFailureForJson[] },
>(
  result: T
) => ({
  ...result,
  failures: result.failures.map(({ phase, id, message }) => ({
    phase,
    ...(id === undefined ? {} : { id }),
    message,
  })),
});

export const writeOutput = (stdout: StdoutWriter, message: string | Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      await stdout(message);
    },
    catch: (cause) =>
      new OutputCommandError({
        cause,
        message: `Could not write command output: ${describe(cause)}`,
      }),
  });

export const writeCommandResult = <A>(
  stdout: StdoutWriter,
  format: OutputFormat,
  value: A,
  text: (value: A) => string
) =>
  Effect.try({
    try: () => (format === "json" ? formatJson(value) : text(value)),
    catch: (cause) =>
      new OutputCommandError({
        cause,
        message: `Could not format command output: ${describe(cause)}`,
      }),
  }).pipe(Effect.flatMap((message) => writeOutput(stdout, message)));

export const outputFormatFromArgs = (args: readonly string[]): OutputFormat => {
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      return "json";
    }
  }
  return "text";
};

const conciseErrorMessage = (message: string) => message.split("\n\n", 1)[0] ?? message;

type JsonErrorDetails = {
  code: string;
  message: string;
  option?: string;
  value?: string;
  command?: string;
  arguments?: readonly string[];
  sourcePath?: string;
  reference?: string;
  operation?: string;
};

export const formatError = (error: CliError, format: OutputFormat) => {
  if (format === "text") {
    return error.message.endsWith("\n") ? error.message : `${error.message}\n`;
  }

  const details: JsonErrorDetails = {
    code: error._tag,
    message: conciseErrorMessage(error.message),
  };
  if (error instanceof UnknownOptionError) {
    details.option = error.option;
  } else if (error instanceof InvalidOptionValueError) {
    details.option = error.option;
    if (error.value !== undefined) {
      details.value = error.value;
    }
  } else if (error instanceof UnknownCommandError) {
    details.command = error.command;
  } else if (error instanceof UnexpectedArgumentsError) {
    details.arguments = error.arguments;
  } else if (error instanceof DaemonCommandError) {
    details.command = error.command;
  } else if (error instanceof PublishCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof OpenBrowserCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof GetCommandError) {
    details.reference = error.reference;
  } else if (error instanceof CloudCommandError) {
    details.operation = error.operation;
    if (error.sourcePath !== undefined) details.sourcePath = error.sourcePath;
  }
  return formatJson({ error: details });
};
