import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalApplication } from "@planview/local";
import { Effect } from "effect";
import { runInventoryCommand } from "../dist/commands/local.js";

test("pin/unpin help and invalid selection do no daemon work; successful JSON is bounded and generation explicit", async () => {
  const selection = { id: "a".repeat(21), generation: "12345678-1234-1234-1234-123456789012" };
  const calls: unknown[] = [];
  let output = "";
  const stdout = (chunk: string | Uint8Array) => {
    output += String(chunk);
  };
  const application = {
    ...createLocalApplication({ daemonScriptPath: "unused" }),
    setPinned: (input: typeof selection, pinned: boolean) => {
      calls.push({ input, pinned });
      return Effect.succeed({
        ...input,
        status: "updated" as const,
        retention: { pinned, expiresAt: pinned ? null : 1, unpinnedExpiresAt: 1 },
      });
    },
  };
  for (const command of ["pin", "unpin"] as const) {
    assert.equal(
      await Effect.runPromise(runInventoryCommand(command, application, ["--help"], stdout)),
      0
    );
    await assert.rejects(
      Effect.runPromise(runInventoryCommand(command, application, [selection.id], stdout)),
      /generation/
    );
    assert.deepEqual(calls, []);
  }
  for (const command of ["pin", "unpin"] as const) {
    output = "";
    assert.equal(
      await Effect.runPromise(
        runInventoryCommand(
          command,
          application,
          [selection.id, "--generation", selection.generation, "--json"],
          stdout
        )
      ),
      0
    );
    const value = JSON.parse(output);
    assert.equal(value.id, selection.id);
    assert.equal(value.generation, selection.generation);
    assert.equal(value.retention.pinned, command === "pin");
    assert.ok(output.length < 1024);
    assert.equal(output.split("\n").length, 2);
  }
  assert.deepEqual(calls, [
    { input: selection, pinned: true },
    { input: selection, pinned: false },
  ]);
});
