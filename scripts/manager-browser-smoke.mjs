import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { npmPackFilename } from "./npm-pack-result.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "planview-manager-browser-"));
const prefix = join(fixture, "installed CLI é");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";
const quote = (value) => (shell ? `"${value}"` : value);
const command = (exe, args, options = {}) => {
  const result = spawnSync(exe, args.map(quote), {
    cwd: root,
    encoding: "utf8",
    shell,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolvePort(address.port));
  });
});
const environment = {
  ...process.env,
  NODE_ENV: "test",
  PLANVIEW_TEST_DAEMON_PORT: String(port),
  PLANVIEW_APP_DATA_DIR: join(fixture, "data"),
  PLANVIEW_RUNTIME_DIR: join(fixture, "data", "runtime"),
};
let execute;
let browser;
try {
  const tarball =
    process.env.TARBALL ??
    join(
      fixture,
      npmPackFilename(
        JSON.parse(
          command(npm, [
            "pack",
            "--workspace",
            "@abijith-suresh/planview",
            "--ignore-scripts",
            "--pack-destination",
            fixture,
            "--json",
          ])
        )
      )
    );
  command(npm, ["install", "--global", "--prefix", prefix, "--ignore-scripts", tarball]);
  const installed = join(
    prefix,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "@abijith-suresh/planview/dist/index.js"
  );
  execute = (...args) =>
    JSON.parse(
      command(process.execPath, [installed, ...args, "--json"], { cwd: fixture, env: environment })
    );
  const launch = execute("ui");
  const running = execute("status");
  assert.equal(running.state, "running");
  const relaunch = execute("ui");
  assert.equal(relaunch.origin, launch.origin);
  assert.equal(execute("status").pid, running.pid, "same daemon owns both listeners");
  assert.notEqual(new URL(launch.origin).port, String(port));
  const source = join(fixture, "hostile.html");
  writeFileSync(
    source,
    `<!doctype html><h1>Artifact origin</h1><script>fetch(${JSON.stringify(launch.origin + "/api/status")},{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",credentials:"include"}).then(()=>document.body.dataset.managerAccess="allowed").catch(()=>document.body.dataset.managerAccess="blocked")</script>`
  );
  const published = execute("publish", source);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const sessionResponse = page.waitForResponse(
    (response) => response.url() === `${launch.origin}/api/session` && response.status() === 200
  );
  await page.goto(launch.url);
  const { token } = await (await sessionResponse).json();
  await page.getByRole("heading", { name: "Your local shelf." }).waitFor();
  await page.getByText("Snapshot " + published.id.slice(0, 7), { exact: true }).waitFor();
  assert.equal(page.url(), launch.origin + "/", "fragment is removed before requests");
  assert.deepEqual(await context.cookies(launch.origin), []);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const nativeSecret = JSON.parse(
    readFileSync(join(fixture, "data/runtime/daemon.json"), "utf8")
  ).secret;
  const nativeWithBrowserSession = await fetch(`http://127.0.0.1:${port}/__planview/manager`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(nativeWithBrowserSession.status, 401);
  const browserWithNativeSecret = await fetch(`${launch.origin}/api/status`, {
    method: "POST",
    headers: {
      Origin: launch.origin,
      Authorization: `Bearer ${nativeSecret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(browserWithNativeSecret.status, 401);
  await page.getByRole("button", { name: `Copy link ${published.id}`, exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    `http://127.0.0.1:${port}/${published.id}`
  );
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: `Open ${published.id}`, exact: true }).click();
  const popup = await popupPromise;
  await popup.locator('body[data-manager-access="blocked"]').waitFor();
  assert.equal(new URL(popup.url()).port, String(port));
  await popup.close();
  const original = Buffer.from(
    "\ufeff<!doctype html><h1>Browser import é</h1>\r\n<script>window.artifactExecuted=true</script>"
  );
  await page
    .getByLabel("Choose HTML file", { exact: true })
    .setInputFiles({ name: "report.html", mimeType: "text/html", buffer: original });
  await page.getByRole("button", { name: "Save to local shelf", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
  const imported = execute("list").snapshots.find((row) => row.id !== published.id);
  assert.ok(imported);
  const retrieved = spawnSync(process.execPath, [installed, "get", imported.id], {
    cwd: fixture,
    env: environment,
  });
  assert.equal(retrieved.status, 0);
  assert.deepEqual(retrieved.stdout, original);
  assert.equal(await page.evaluate(() => window.artifactExecuted), undefined);
  assert.equal((await fetch(`${launch.origin}/${imported.id}`)).status, 404);
  const artifacts = process.env.PLANVIEW_BROWSER_ARTIFACT_DIR;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, "manager-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(artifacts, "manager-mobile.png"), fullPage: true });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "mobile page must not overflow horizontally"
    );
  }
  await page.getByRole("button", { name: `Delete ${imported.id}`, exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Delete local snapshot", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Local snapshot deleted" }).waitFor();
  assert.equal(execute("usage").documentCount, 1);
  const second = await context.newPage();
  await second.goto(launch.url);
  await second.getByRole("alert").filter({ hasText: "one-use launch link" }).waitFor();
  await second.close();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Signed out" }).waitFor();
  assert.equal(
    (
      await fetch(`${launch.origin}/api/usage`, {
        method: "POST",
        headers: {
          Origin: launch.origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status,
    401
  );
  await page.goto(execute("ui").url);
  await page.getByRole("button", { name: "Stop daemon & previews", exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Stop daemon & previews", exact: true }).click();
  await page.getByRole("heading", { name: "Manager and previews stopped.", exact: true }).waitFor();
  assert.deepEqual(execute("status"), { state: "stopped" });
  await assert.rejects(fetch(launch.origin, { signal: AbortSignal.timeout(1000) }));
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/${published.id}`, { signal: AbortSignal.timeout(1000) })
  );
  assert.deepEqual(failures, []);
  await context.close();
  process.stdout.write(
    "Installed manager browser smoke passed: session isolation, exact-byte import, open/copy/delete, hostile preview boundary, mobile layout, logout, and both-listener shutdown.\n"
  );
} finally {
  await browser?.close();
  try {
    execute?.("stop");
  } catch {}
  rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
