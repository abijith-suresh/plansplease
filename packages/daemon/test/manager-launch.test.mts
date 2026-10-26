import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import type { DaemonApplication } from "../dist/application.js";
import { openManager, type ManagerLaunch, type ManagerServer } from "../dist/manager.js";
import { createOperationGate } from "../dist/operation-gate.js";

// Exercise the production closure without exporting daemon internals or racing
// a client disconnect against listen(). AST selection tolerates formatting and
// comments; a renamed/moved declaration fails explicitly instead of testing a copy.
const source = ts.createSourceFile(
  "index.ts",
  readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ESNext,
  true
);
const declarations: ts.VariableStatement[] = [];
const visit = (node: ts.Node): void => {
  if (
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && declaration.name.text === "launchManager"
    )
  ) {
    declarations.push(node);
  }
  ts.forEachChild(node, visit);
};
visit(source);
assert.equal(declarations.length, 1, "Expected one production manager-launch declaration.");
const declaration = declarations[0];
assert.ok(declaration);
const compiled = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText;
const createLauncher = new Function(
  "operationGate",
  "openManager",
  "application",
  "config",
  "runtimeDescriptor",
  "requestShutdown",
  `let managerServer; const shutdownInitiated = false; ${compiled}; return launchManager;`
) as (
  gate: ReturnType<typeof createOperationGate>,
  open: typeof openManager,
  application: DaemonApplication,
  config: { profile: string; appDataDir: string },
  descriptor: { port: number },
  shutdown: () => void
) => (signal?: AbortSignal) => Promise<ManagerLaunch>;

for (const failClose of [false, true]) {
  test(`a cancelled first manager launch can retry${failClose ? " after cleanup fails" : ""}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "planview-manager-launch-"));
    const gate = createOperationGate();
    const servers: ManagerServer[] = [];
    const controller = new AbortController();
    const unexpected = () => {
      throw new Error("Snapshot operations are outside this listener lifecycle test.");
    };
    try {
      await mkdir(join(directory, "assets"));
      await writeFile(join(directory, "index.html"), "<!doctype html><h1>Manager shell</h1>");
      const launch = createLauncher(
        gate,
        async (options) => {
          const server = await openManager({
            ...options,
            assetsRoot: pathToFileURL(directory + sep),
          });
          servers.push(server);
          assert.equal(server.server.listening, true);
          if (servers.length !== 1) return server;
          // openManager has actually bound its listener. Cancellation wins before
          // the awaiting production closure resumes and publishes the launch link.
          controller.abort(new Error("Caller cancelled immediately after listen."));
          return {
            ...server,
            close: async () => {
              await server.close();
              if (failClose) throw new Error("Injected close acknowledgement failure.");
            },
          };
        },
        {
          list: unexpected,
          usage: unexpected,
          deleteSnapshot: unexpected,
          setPinned: unexpected,
          publishSource: unexpected,
          importHtml: unexpected,
        },
        { profile: "testing", appDataDir: directory },
        { port: 4777 },
        () => {}
      );
      await assert.rejects(
        launch(controller.signal),
        failClose ? /Injected close acknowledgement failure/ : /stopped during manager startup/
      );
      assert.equal(servers.length, 1);
      assert.equal(servers[0]!.server.listening, false);
      const retry = await launch();
      assert.equal(
        servers.length,
        2,
        "Retry must create a new listener, not reuse the closed one."
      );
      const shell = await fetch(retry.origin, { signal: AbortSignal.timeout(5000) });
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /Manager shell/);
      const session = await fetch(`${retry.origin}/api/session`, {
        method: "POST",
        headers: { Origin: retry.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ code: new URL(retry.url).hash.slice(1) }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(session.status, 200, "The retried link must create a usable browser session.");
      await session.arrayBuffer();
      assert.equal((await launch()).origin, retry.origin);
      assert.equal(servers.length, 2, "Later launches reuse the healthy listener.");
    } finally {
      gate.close();
      for (const server of servers) {
        server.revoke();
        server.stopAccepting();
        server.forceClose();
        await server.close();
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
}
