import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalApplication } from "@planview/local";
import { Effect } from "effect";
import { runManagerCommand } from "../dist/commands/local.js";

test("ui opens a browser only with --open and help does not request a session", async () => {
  let launches = 0;
  const opened: string[] = [];
  const output: string[] = [];
  const launch = {
    url: `http://127.0.0.1:49000/#${"a".repeat(43)}`,
    origin: "http://127.0.0.1:49000",
    expiresAt: Date.now() + 60000,
  };
  const application = {
    ...createLocalApplication({ daemonScriptPath: "unused" }),
    manager: () => {
      launches += 1;
      return Effect.succeed(launch);
    },
  };
  const stdout = (chunk: string | Uint8Array) => {
    output.push(String(chunk));
  };
  const open = async (url: string) => {
    opened.push(url);
  };
  assert.equal(
    await Effect.runPromise(runManagerCommand(application, ["--help"], stdout, open)),
    0
  );
  assert.equal(launches, 0);
  output.length = 0;
  assert.equal(
    await Effect.runPromise(runManagerCommand(application, ["--json"], stdout, open)),
    0
  );
  assert.deepEqual(JSON.parse(output.join("")), launch);
  assert.equal(launches, 1);
  assert.deepEqual(opened, []);
  assert.equal(
    await Effect.runPromise(runManagerCommand(application, ["--open"], stdout, open)),
    0
  );
  assert.equal(launches, 2);
  assert.deepEqual(opened, [launch.url]);
});
