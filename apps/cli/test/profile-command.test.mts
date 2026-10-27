import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { createLocalApplication } from "@planview/local";
import { runProfilesCommand } from "../dist/commands/local.js";

test("profiles help and invalid subcommands perform no I/O; selection prints a command without launching or changing a default", async () => {
  let calls = 0;
  let output = "";
  const stdout = (chunk: string | Uint8Array) => {
    output += String(chunk);
  };
  const application = {
    ...createLocalApplication({ daemonScriptPath: "unused" }),
    profilePlan: (name: string) => {
      calls++;
      return Effect.succeed({
        target: { name, appDataDir: "/selected", runtimeDir: "/selected/runtime", present: false },
        launchCommand: `plansplease --profile ${name} ui`,
        openCommand: `plansplease --profile ${name} ui --open`,
        createCommand: `plansplease profiles create ${name}`,
        requiresCleanEnvironment: true as const,
        message: "No global default changes; old profiles keep running.",
      });
    },
  };
  assert.equal(await Effect.runPromise(runProfilesCommand(application, ["--help"], stdout)), 0);
  for (const args of [
    ["delete", "work"],
    ["select"],
    ["current", "extra"],
    ["create", "work", "--limit", "1"],
  ])
    await assert.rejects(Effect.runPromise(runProfilesCommand(application, args, stdout)));
  assert.equal(calls, 0);
  output = "";
  assert.equal(
    await Effect.runPromise(runProfilesCommand(application, ["select", "work", "--json"], stdout)),
    0
  );
  assert.equal(JSON.parse(output).openCommand, "plansplease --profile work ui --open");
  assert.equal(calls, 1);
  assert.ok(output.length < 2048);
});
