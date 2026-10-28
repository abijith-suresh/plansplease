import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testInstalledRetention } from "./offline-retention-smoke.mjs";
import { installPrepared, verifyInstalledContents, verifyPrepared } from "./prerelease.mjs";
import { testInstalledProfiles } from "./profile-controls-smoke.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const waitFor = async (condition) => {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Timed out waiting for the owned candidate fixture.");
};

/** Exercise already hash-verified bytes; every fixture owns and stops its profiles. */
export async function checkInstalledPrerelease(installation, manifest, options = {}) {
  verifyInstalledContents(installation.directory, manifest);
  assert.deepEqual(installation.build, manifest.build);
  const workspace = mkdtempSync(join(tmpdir(), "plansplease candidate execution é "));
  const data = join(workspace, "local data");
  const port = await new Promise((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => accept(address.port));
    });
  });
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PLANVIEW_APP_DATA_DIR: data,
    PLANVIEW_RUNTIME_DIR: join(data, "runtime"),
    PLANVIEW_TEST_DAEMON_PORT: String(port),
    PLANVIEW_DAEMON_STRICT_PORT: "false",
  };
  delete env.PLANVIEW_PROFILE;
  delete env.PLANVIEW_DATA_DIR;
  const command = (...args) =>
    spawnSync(process.execPath, [installation.cli, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  const execute = (...args) => {
    const result = command(...args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  let legacy;
  try {
    assert.equal(execute("--version").trim(), `plansplease ${manifest.build.version}`);
    assert.deepEqual(JSON.parse(execute("build-info", "--json")), {
      name: "@abijith-suresh/planview",
      version: manifest.build.version,
      build: manifest.build,
    });
    assert.match(execute("--help"), /Usage: plansplease/);
    assert.match(execute("share", "--help"), /local-id/);
    assert.equal(existsSync(data), false, "Version, help and build identity remain offline");
    const home = join(installation.directory, "node_modules/@abijith-suresh/planview");
    assert.match(readFileSync(join(home, "skills/planview/SKILL.md"), "utf8"), /plansplease/);
    assert.match(readFileSync(join(home, "man/plansplease.1"), "utf8"), /build-info/);
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& $env:PLANVIEW_CANDIDATE_LAUNCHER build-info; exit $LASTEXITCODE",
        ],
        {
          cwd: workspace,
          env: { ...env, PLANVIEW_CANDIDATE_LAUNCHER: installation.executable },
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).build, manifest.build);
    }
    // Real source-built production entrypoint has no candidate identity. A candidate
    // must inspect/stop this owned process deliberately, rather than reuse it.
    legacy = spawn(process.execPath, [join(root, "packages/daemon/dist/entry.js")], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    await waitFor(() => {
      try {
        return JSON.parse(execute("status", "--json")).state === "running";
      } catch {
        return false;
      }
    });
    const mismatch = command("start", "--json");
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /different build/);
    assert.equal(JSON.parse(execute("status", "--json")).pid, legacy.pid);
    execute("stop", "--json");
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null);
    const first = JSON.parse(execute("start", "--json"));
    assert.deepEqual(first.build, manifest.build);
    assert.equal(first.packageVersion, manifest.build.version);
    assert.equal(first.reused, false);
    const second = JSON.parse(execute("start", "--json"));
    assert.equal(second.pid, first.pid);
    assert.equal(second.reused, true);
    const status = JSON.parse(execute("status", "--json"));
    assert.deepEqual(status.build, manifest.build);
    assert.equal(status.packageVersion, manifest.build.version);
    execute("stop", "--json");
    assert.equal(JSON.parse(execute("status", "--json")).state, "stopped");
    await testInstalledProfiles({ root, installed: installation.cli, workspace });
    await testInstalledRetention({ root, installed: installation.cli, workspace });
    // These existing fixtures now accept an explicitly supplied verified install.
    // They use synthetic credentials/local protocol handlers and stop their daemon.
    for (const script of [
      "upload-protocol-smoke.mjs",
      ...(options.browser ? ["manager-browser-smoke.mjs"] : []),
    ]) {
      execFileSync(process.execPath, [join(root, "scripts", script)], {
        cwd: workspace,
        env: { ...process.env, PLANVIEW_TEST_VERIFIED_CLI: installation.cli },
        stdio: "inherit",
        windowsHide: true,
        timeout: 180000,
      });
    }
    process.stdout.write(
      `${JSON.stringify({
        candidateInstalled: true,
        platform: process.platform,
        sourceSha: manifest.build.sourceSha,
        version: manifest.build.version,
        exactContents: true,
        offlineIdentity: true,
        explicitLegacyStop: true,
        matchingDaemonReuse: true,
        profiles: true,
        retention: true,
        sharingProtocol: true,
        browser: options.browser === true,
      })}\n`
    );
  } finally {
    command("stop", "--json");
    if (legacy && legacy.exitCode === null && legacy.signalCode === null) {
      legacy.kill();
      await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null);
    }
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export async function main(args = process.argv.slice(2)) {
  let bundle, expectedSha;
  let browser = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--browser" && !browser) {
      browser = true;
      continue;
    }
    const name = args[i],
      value = args[++i];
    if (!value) throw new Error("Supply --bundle DIRECTORY --expected-sha FULL_SHA [--browser].");
    if (name === "--bundle" && bundle === undefined) bundle = resolve(value);
    else if (name === "--expected-sha" && expectedSha === undefined) expectedSha = value;
    else throw new Error("Unsupported candidate check argument.");
  }
  if (!bundle || !/^[a-f0-9]{40}$/.test(expectedSha ?? "") || /^0+$/.test(expectedSha))
    throw new Error("Supply --bundle DIRECTORY --expected-sha FULL_SHA [--browser].");
  const manifest = verifyPrepared(bundle);
  assert.equal(manifest.build.sourceSha, expectedSha, "Bundle does not match approved source SHA");
  const temporary = mkdtempSync(join(tmpdir(), "plansplease candidate transfer é "));
  try {
    const installation = installPrepared(
      bundle,
      join(temporary, "consumer install é"),
      expectedSha
    );
    await checkInstalledPrerelease(installation, manifest, { browser });
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
