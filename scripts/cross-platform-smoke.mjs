import assert from "node:assert/strict";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import { npmPackFilename } from "./npm-pack-result.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";

const text = (value) => (value === null ? "" : value.toString("utf8"));

// These arguments contain only fixed smoke commands and generated fixture paths.
const shellArgument = (value) => (shell ? `"${value}"` : value);
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args.map(shellArgument), {
    cwd: root,
    encoding: null,
    shell,
    ...options,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}.\n${text(result.stdout)}${text(result.stderr)}`
    );
  }
  return result;
};

const freePort = () =>
  new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a test port."));
        return;
      }
      server.close((error) =>
        error === undefined ? resolvePort(address.port) : rejectPort(error)
      );
    });
  });

const pack = (destination) => {
  const result = run(
    npm,
    [
      "pack",
      "--workspace",
      "@abijith-suresh/planview",
      "--pack-destination",
      destination,
      "--json",
    ],
    { env: { ...process.env, npm_config_loglevel: "warn" } }
  );
  let packages;
  try {
    packages = JSON.parse(text(result.stdout));
  } catch (cause) {
    throw new Error(`npm pack did not return JSON.\n${text(result.stdout)}${text(result.stderr)}`, {
      cause,
    });
  }
  const tarball = npmPackFilename(packages);
  return join(destination, tarball);
};

const findInstalledCli = (prefix) => {
  const candidates =
    process.platform === "win32"
      ? [join(prefix, "plansplease.cmd"), join(prefix, "node_modules", ".bin", "plansplease.cmd")]
      : [join(prefix, "bin", "plansplease"), join(prefix, "node_modules", ".bin", "plansplease")];
  const cli = candidates.find((candidate) => existsSync(candidate));
  assert.ok(cli, `npm did not install a plansplease executable. Tried: ${candidates.join(", ")}`);
  return cli;
};

const assertSuccessful = (result, label) => {
  assert.equal(result.error, undefined, `${label} should start`);
  assert.equal(result.status, 0, `${label} failed:\n${text(result.stderr)}`);
};

const runSmoke = async () => {
  for (const directory of [
    "apps/cli/dist",
    "packages/core/dist",
    "packages/daemon/dist",
    "packages/local/dist",
    "packages/storage/dist",
  ]) {
    rmSync(resolve(root, directory), { force: true, recursive: true });
  }

  const workspace = mkdtempSync(join(tmpdir(), "planview-cross-platform-"));
  const packageDestination = join(workspace, "package");
  const installPrefix = join(workspace, "installed CLI");
  mkdirSync(packageDestination);
  const home = join(workspace, "home");
  // Keep using the legacy default root, including for a pre-existing named profile.
  const dataRoot =
    process.platform === "win32"
      ? join(home, "AppData", "Local", "Planview")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Planview")
        : join(home, ".local", "share", "planview");
  const appData = join(dataRoot, "profiles", "branding");
  const source = join(workspace, "fixture.html");
  const port = await freePort();
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: "test",
    XDG_DATA_HOME: join(home, ".local", "share"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PLANVIEW_TEST_DAEMON_PORT: String(port),
  };

  // Do not let inherited overrides redirect the compatibility fixture elsewhere.
  delete environment.PLANVIEW_APP_DATA_DIR;
  delete environment.PLANVIEW_DATA_DIR;
  delete environment.PLANVIEW_RUNTIME_DIR;
  let execute;
  try {
    const tarball = pack(packageDestination);
    run(npm, ["install", "--global", "--prefix", installPrefix, "--ignore-scripts", tarball]);
    const installedRoot =
      process.platform === "win32"
        ? join(installPrefix, "node_modules", "@abijith-suresh", "planview")
        : join(installPrefix, "lib", "node_modules", "@abijith-suresh", "planview");
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.deepEqual(manifest.bin, { plansplease: "./dist/index.js" });
    assert.equal(
      existsSync(
        join(installPrefix, process.platform === "win32" ? "planview.cmd" : "bin/planview")
      ),
      false
    );
    const cli = findInstalledCli(installPrefix);
    execute = (args, options = {}) =>
      spawnSync(shellArgument(cli), ["--profile", "branding", ...args].map(shellArgument), {
        cwd: root,
        env: environment,
        encoding: null,
        shell,
        ...options,
      });

    const version = execute(["--version"]);
    assertSuccessful(version, "packed CLI --version");
    assert.match(text(version.stdout), /^plansplease \d+\.\d+\.\d+\n$/);

    const before = execute(["status"]);
    assertSuccessful(before, "initial packed CLI status");
    assert.match(text(before.stdout), /not running/);

    const original = "<!doctype html><html><body>cross-platform smoke</body></html>\n";
    writeFileSync(source, original);
    // Seed existing profile state through the unchanged local API before the new command uses it.
    const { createLocalApplication } = await import(
      pathToFileURL(join(root, "packages/local/dist/index.js")).href
    );
    const { resolveDaemonConfigForTest } = await import(
      pathToFileURL(join(root, "packages/daemon/dist/index.js")).href
    );
    const existingProfile = createLocalApplication({
      config: resolveDaemonConfigForTest({ appDataDir: appData, profile: "branding", port }),
      daemonScriptPath: join(installedRoot, "dist", "daemon.js"),
    });
    const existing = await Effect.runPromise(existingProfile.publish(source));
    const existingStatus = await Effect.runPromise(existingProfile.inspect());
    assert.equal(existingStatus.state, "running");
    const existingRead = execute(["get", existing.id]);
    assertSuccessful(existingRead, "packed CLI reads existing profile document");
    assert.deepEqual(existingRead.stdout, Buffer.from(original));
    const published = execute(["publish", source]);
    assertSuccessful(published, "packed CLI publish");
    const url = text(published.stdout).trim();
    assert.match(url, new RegExp(`^http://localhost:${port}/[A-Za-z0-9_-]{21}$`));
    const id = url.slice(url.lastIndexOf("/") + 1);

    assert.ok(
      existsSync(join(appData, "metadata.sqlite")),
      "CLI uses the existing Planview profile path"
    );
    const running = execute(["status", "--json"]);
    assertSuccessful(running, "running packed CLI status");
    const status = JSON.parse(text(running.stdout));
    assert.equal(status.state, "running");
    assert.equal(status.profile, "branding");
    assert.equal(status.pid, existingStatus.pid, "CLI reuses the existing profile daemon");
    const reused = execute(["start", "--json"]);
    assertSuccessful(reused, "packed CLI reuses existing profile daemon");
    const reusedStatus = JSON.parse(text(reused.stdout));
    assert.equal(reusedStatus.pid, status.pid);
    assert.equal(reusedStatus.reused, true);

    const retrieved = execute(["get", id]);
    assertSuccessful(retrieved, "packed CLI get");
    assert.deepEqual(retrieved.stdout, Buffer.from(original));

    const artifact = join(workspace, "artifact");
    mkdirSync(join(artifact, "assets"), { recursive: true });
    const artifactHtml =
      '<!doctype html><link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script><h1>Artifact smoke</h1>';
    const artifactCss = "h1{color:rgb(12,34,56)}";
    const artifactJs = 'document.body.dataset.artifact="works";';
    const artifactImage = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVVkAAAAASUVORK5CYII=",
      "base64"
    );
    writeFileSync(join(artifact, "index.html"), artifactHtml);
    writeFileSync(join(artifact, "assets", "style.css"), artifactCss);
    writeFileSync(join(artifact, "assets", "app.js"), artifactJs);
    writeFileSync(join(artifact, "assets", "icon.png"), artifactImage);
    const artifactPublished = execute(["publish", artifact]);
    assertSuccessful(artifactPublished, "packed CLI artifact folder publish");
    const artifactUrl = text(artifactPublished.stdout).trim();
    const artifactPage = await fetch(artifactUrl);
    assert.equal(artifactPage.status, 200);
    assert.equal(await artifactPage.text(), artifactHtml);
    assert.equal(await (await fetch(`${artifactUrl}/assets/style.css`)).text(), artifactCss);
    assert.equal(await (await fetch(`${artifactUrl}/assets/app.js`)).text(), artifactJs);
    const artifactImageResponse = await fetch(`${artifactUrl}/assets/icon.png`);
    assert.equal(artifactImageResponse.status, 200);
    assert.equal(artifactImageResponse.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await artifactImageResponse.arrayBuffer()), artifactImage);

    const stopped = execute(["stop"]);
    assertSuccessful(stopped, "packed CLI stop");
    assert.match(text(stopped.stdout), /stopped/);
    const after = execute(["status"]);
    assertSuccessful(after, "stopped packed CLI status");
    assert.match(text(after.stdout), /not running/);
  } finally {
    if (execute !== undefined) {
      execute(["stop"]);
    }
    rmSync(workspace, { force: true, recursive: true });
  }
};

await runSmoke();
process.stdout.write(`Cross-platform packed CLI smoke passed on ${process.platform}.\n`);
