import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const viteEntry = createRequire(import.meta.url).resolve("vite");
const appPlugin = new URL("../local-nitro.ts", import.meta.url).href;

test("local Nitro and Vite load only the generated env directory; ordinary dev keeps source dotenv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plansplease-env-isolation-"));
  const app = join(directory, "app");
  const generated = join(directory, "generated-env");
  const probe = join(directory, "env-isolation-probe.mjs");
  const files = new Map([
    [join(directory, ".env.local"), "VITE_ROOT_ISOLATION_SENTINEL=root-must-not-load\n"],
    [join(app, ".env"), "VITE_SOURCE_BASE_SENTINEL=source-base-must-not-load\n"],
    [
      join(app, ".env.local"),
      "VITE_SOURCE_LOCAL_SENTINEL=source-local-must-not-load\nPRIVATE_SOURCE_SENTINEL=server-source-must-not-load\n",
    ],
    [join(app, ".env.development"), "VITE_SOURCE_MODE_SENTINEL=source-mode-must-not-load\n"],
    [
      join(app, ".env.development.local"),
      "VITE_SOURCE_MODE_LOCAL_SENTINEL=source-mode-local-must-not-load\n",
    ],
    [
      join(generated, ".env.local"),
      "VITE_GENERATED_ENV_SENTINEL=generated-directory-is-readable\n",
    ],
  ]);
  try {
    await mkdir(app);
    await mkdir(generated);
    for (const [file, contents] of files) await writeFile(file, contents, { flag: "wx" });
    await writeFile(join(app, "client.ts"), "export const environment = import.meta.env;\n");
    const script = `
      import { createServer } from ${JSON.stringify(pathToFileURL(viteEntry).href)};
      import { appNitroPlugin } from ${JSON.stringify(appPlugin)};
      const server = await createServer({
        configFile: false, root: ${JSON.stringify(app)}, envDir: ${JSON.stringify(generated)},
        mode: 'development', logLevel: 'silent',
        plugins: [await appNitroPlugin(${JSON.stringify(app)}, 'serve')],
        server: { host: '127.0.0.1', port: 0 },
      });
      try {
        await server.listen();
        const response = await fetch('http://127.0.0.1:' + server.httpServer.address().port + '/client.ts');
        console.log('ENV_RESULT=' + JSON.stringify({ status: response.status, code: await response.text(),
          privateSourceLoaded: process.env.PRIVATE_SOURCE_SENTINEL !== undefined }));
      } finally { await server.close(); }
    `;
    await writeFile(probe, script, { flag: "wx" });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(VITE_|PUBLIC_|CONVEX_|PLANVIEW_|PRIVATE_SOURCE_SENTINEL$)/.test(key)
      )
    );
    Object.assign(env, {
      NODE_ENV: "development",
      SITE_URL: "http://127.0.0.1:3000",
      CONVEX_URL: "http://127.0.0.1:3210",
      VITE_CONVEX_URL: "http://127.0.0.1:3210",
      VITE_CONVEX_SITE_URL: "http://127.0.0.1:3211",
      PLANVIEW_ENV_DIR: generated,
    });
    const run = async (local: boolean) => {
      const { stdout } = await execute(process.execPath, ["--experimental-strip-types", probe], {
        cwd: directory,
        env: { ...env, ...(local ? { PLANVIEW_LOCAL: "true" } : {}) },
        timeout: 30_000,
      });
      const line = stdout.split("\n").find((value) => value.startsWith("ENV_RESULT="));
      assert.ok(line, "The real dev server must return its transformed client module");
      return JSON.parse(line.slice("ENV_RESULT=".length)) as {
        status: number;
        code: string;
        privateSourceLoaded: boolean;
      };
    };
    const local = await run(true);
    assert.equal(local.status, 200);
    assert.equal(local.privateSourceLoaded, false);
    assert.doesNotMatch(local.code, /VITE_SOURCE_|VITE_ROOT_ISOLATION_SENTINEL|must-not-load/);
    assert.match(local.code, /generated-directory-is-readable/);
    assert.match(local.code, /http:\/\/127\.0\.0\.1:3210/);
    assert.match(local.code, /http:\/\/127\.0\.0\.1:3211/);

    const ordinary = await run(false);
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.privateSourceLoaded, true);
    assert.match(ordinary.code, /source-local-must-not-load/);
    assert.match(ordinary.code, /source-mode-local-must-not-load/);
    for (const [file, contents] of files) assert.equal(await readFile(file, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
