import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  InvalidOptionValueError as PublicInvalidOptionValueError,
  run,
  UnknownOptionError as PublicUnknownOptionError,
} from "../dist/index.js";
import {
  InvalidOptionValueError,
  parseGlobalOptions,
  parseOptions,
  UnknownOptionError,
} from "../dist/arguments.js";

test("argument parsing preserves option boundaries and cloud URL forms", () => {
  const parsed = Effect.runSync(
    parseOptions(["--json", "--cloud-url=https://example.test", "--", "--report.html"], {
      allowJson: true,
      allowCloudUrl: true,
      helpTopic: "upload",
    })
  );

  assert.deepEqual(parsed, {
    help: false,
    json: true,
    open: false,
    cloudUrl: "https://example.test",
    operands: ["--report.html"],
  });
});

test("global profile parsing leaves the command arguments intact", () => {
  assert.deepEqual(
    Effect.runSync(parseGlobalOptions(["--profile=alpha", "upload", "--json", "page.html"])),
    { profile: "alpha", commandArguments: ["upload", "--json", "page.html"] }
  );
});

test("argument parsing keeps option failures typed", () => {
  const unknownOption = Effect.runSync(
    Effect.flip(parseOptions(["--unknown"], { helpTopic: "upload" }))
  );
  const removedForceOption = Effect.runSync(
    Effect.flip(parseOptions(["--force"], { helpTopic: "upload" }))
  );
  const invalidProfile = Effect.runSync(Effect.flip(parseGlobalOptions(["--profile", "Bad"])));

  assert.ok(unknownOption instanceof UnknownOptionError);
  assert.ok(removedForceOption instanceof UnknownOptionError);
  assert.ok(invalidProfile instanceof InvalidOptionValueError);
  const publicUnknownOption = Effect.runSync(
    Effect.flip(
      run(
        ["--unknown"],
        () => undefined,
        () => undefined
      )
    )
  );
  const publicInvalidProfile = Effect.runSync(
    Effect.flip(
      run(
        ["--profile", "Bad"],
        () => undefined,
        () => undefined
      )
    )
  );
  assert.ok(publicUnknownOption instanceof PublicUnknownOptionError);
  assert.ok(publicInvalidProfile instanceof PublicInvalidOptionValueError);
});
