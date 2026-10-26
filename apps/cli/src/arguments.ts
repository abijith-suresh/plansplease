import { isValidProfileName } from "@planview/local";
import { Data, Effect } from "effect";
import { COMMANDS, type Command, formatHelp, type HelpTopic } from "./help.js";

export class UnknownOptionError extends Data.TaggedError("UnknownOptionError")<{
  readonly option: string;
  readonly message: string;
}> {}

export class InvalidOptionValueError extends Data.TaggedError("InvalidOptionValueError")<{
  readonly option: string;
  readonly value?: string;
  readonly message: string;
}> {}

export type ArgumentParsingError = UnknownOptionError | InvalidOptionValueError;

type ParsedArguments = Readonly<{
  readonly help: boolean;
  readonly json: boolean;
  readonly open: boolean;
  readonly cloudUrl?: string;
  readonly named?: Readonly<Record<string, string>>;
  readonly operands: readonly string[];
}>;

type ParsedGlobalArguments = Readonly<{
  readonly profile?: string;
  readonly commandArguments: readonly string[];
}>;

type OptionParserOptions = Readonly<{
  readonly flagOptions?: readonly string[];
  readonly valueOptions?: readonly string[];
  readonly allowCloudUrl?: boolean;
  readonly allowJson?: boolean;
  readonly allowOpen?: boolean;
  readonly allowLeadingHyphenOperand?: (argument: string) => boolean;
  readonly helpTopic: HelpTopic;
}>;

export const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && (COMMANDS as readonly string[]).includes(value);

export const isHelpOption = (value: string) => value === "--help" || value === "-h";

export const isVersionOption = (value: string) => value === "--version" || value === "-v";

export const unknownOption = (option: string, helpTopic?: HelpTopic) =>
  new UnknownOptionError({
    option,
    message: `Unknown option: ${option}\n\n${formatHelp(helpTopic)}`,
  });

const invalidOptionValue = (option: string, value: string | undefined, message: string) =>
  new InvalidOptionValueError({
    option,
    ...(value === undefined ? {} : { value }),
    message,
  });

export const parseOptions = (
  args: readonly string[],
  options: OptionParserOptions
): Effect.Effect<ParsedArguments, ArgumentParsingError> => {
  let optionsEnded = false;
  let help = false;
  let json = false;
  let open = false;
  let cloudUrl: string | undefined;
  const operands: string[] = [];
  const named: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;

    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && isHelpOption(argument)) {
      help = true;
      continue;
    }

    if (!optionsEnded && argument === "--json") {
      if (options.allowJson !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      json = true;
      continue;
    }

    if (!optionsEnded && argument === "--open") {
      if (options.allowOpen !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      open = true;
      continue;
    }

    if (!optionsEnded && options.flagOptions?.includes(argument)) {
      if (named[argument] !== undefined)
        return Effect.fail(
          invalidOptionValue(argument, undefined, `Option ${argument} cannot be repeated.`)
        );
      named[argument] = "true";
      continue;
    }
    const optionName = argument.split("=")[0] ?? argument;
    if (!optionsEnded && options.valueOptions?.includes(optionName)) {
      const hasEquals = argument.includes("=");
      const value = hasEquals ? argument.slice(optionName.length + 1) : args[index + 1];
      if (
        value === undefined ||
        value.length === 0 ||
        (!hasEquals && value.startsWith("--")) ||
        named[optionName] !== undefined
      ) {
        return Effect.fail(
          invalidOptionValue(
            optionName,
            value,
            `Option ${optionName} requires one value and cannot be repeated.`
          )
        );
      }
      named[optionName] = value;
      if (!hasEquals) index += 1;
      continue;
    }

    if (!optionsEnded && argument === "--cloud-url") {
      if (options.allowCloudUrl !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return Effect.fail(
          invalidOptionValue("--cloud-url", undefined, "Option --cloud-url requires a URL.")
        );
      }
      cloudUrl = value;
      index += 1;
      continue;
    }

    if (!optionsEnded && argument.startsWith("--cloud-url=")) {
      if (options.allowCloudUrl !== true) {
        return Effect.fail(unknownOption("--cloud-url", options.helpTopic));
      }
      const value = argument.slice("--cloud-url=".length);
      if (value.length === 0) {
        return Effect.fail(
          invalidOptionValue("--cloud-url", value, "Option --cloud-url requires a URL.")
        );
      }
      cloudUrl = value;
      continue;
    }

    if (
      !optionsEnded &&
      argument.startsWith("-") &&
      argument !== "-" &&
      options.allowLeadingHyphenOperand?.(argument) !== true
    ) {
      return Effect.fail(unknownOption(argument, options.helpTopic));
    }

    operands.push(argument);
  }

  return Effect.succeed({
    help,
    json,
    open,
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
    ...(Object.keys(named).length === 0 ? {} : { named }),
    operands,
  });
};

export const parseGlobalOptions = (
  args: readonly string[]
): Effect.Effect<ParsedGlobalArguments, InvalidOptionValueError> => {
  let profile: string | undefined;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) {
      break;
    }
    if (argument === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return Effect.fail(
          invalidOptionValue("--profile", undefined, "Option --profile requires a profile name.")
        );
      }
      if (!isValidProfileName(value)) {
        return Effect.fail(
          invalidOptionValue(
            "--profile",
            value,
            `Invalid profile name: ${value}. Profile names start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores.`
          )
        );
      }
      profile = value;
      index += 2;
      continue;
    }

    if (argument.startsWith("--profile=")) {
      const value = argument.slice("--profile=".length);
      if (value.length === 0 || !isValidProfileName(value)) {
        return Effect.fail(
          invalidOptionValue(
            "--profile",
            value,
            `Invalid profile name: ${value || "(empty)"}. Profile names start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores.`
          )
        );
      }
      profile = value;
      index += 1;
      continue;
    }

    break;
  }

  return Effect.succeed({
    ...(profile === undefined ? {} : { profile }),
    commandArguments: args.slice(index),
  });
};
