import { resolveDaemonConfig, resolveDaemonConfigForTest, runDaemon } from "./index.js";
import { Effect } from "effect";

try {
  const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
  const testPort = NODE_ENV === "test" ? configuredTestPort : undefined;
  const config =
    testPort === undefined
      ? resolveDaemonConfig()
      : resolveDaemonConfigForTest({ port: Number(testPort) });
  await Effect.runPromise(runDaemon(config));
} catch (cause) {
  process.stderr.write(
    `Planview daemon failed: ${cause instanceof Error ? cause.message : String(cause)}\n`
  );
  process.exitCode = 1;
}
