import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { resolveAppDataPaths } from "@planview/core";
import type { ProfileOperations } from "../dist/profiles.js";

// Run the actual source across its Windows async owner boundary on every OS.
// Only the OS metadata helper is replaced; directory I/O and fences remain real.
for (const operation of ["list", "current", "plan"] as const)
  test(`profile ${operation} refuses a root swapped during native ownership checking`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "profile-owner-fence-"));
    const env = { XDG_DATA_HOME: join(fixture, "data"), LOCALAPPDATA: join(fixture, "local") };
    const root = resolveAppDataPaths({ env, homeDir: fixture }).appDataDir;
    const outside = join(fixture, "outside");
    try {
      await mkdir(join(root, "profiles/research"), { recursive: true, mode: 0o700 });
      await mkdir(outside, { mode: 0o700 });
      const helper = join(fixture, "helper.mjs");
      await writeFile(
        helper,
        `import { rename, symlink } from 'node:fs/promises'; let calls=0; export function execFile(exe,args,options,callback) { return { stdin: { on(){}, end(payload){ void (async()=> { calls++; if(calls===${operation === "list" ? 2 : 1}) { await rename(${JSON.stringify(root)}, ${JSON.stringify(root + "-kept")}); await symlink(${JSON.stringify(outside)}, ${JSON.stringify(root)}, ${JSON.stringify(process.platform === "win32" ? "junction" : "dir")}); } callback(null,JSON.stringify(JSON.parse(payload).map(()=>true))); })().catch(error=>callback(error,'')); } } }; }`
      );
      const sourcePath = fileURLToPath(new URL("../src/profiles.ts", import.meta.url));
      const corePath = fileURLToPath(new URL("../../core/dist/index.js", import.meta.url));
      const configurationPath = fileURLToPath(new URL("../dist/configuration.js", import.meta.url));
      const source = (await readFile(sourcePath, "utf8"))
        .replace('from "node:child_process"', `from ${JSON.stringify(pathToFileURL(helper).href)}`)
        .replaceAll("process.platform", '"win32"')
        .replace('from "@planview/core"', `from ${JSON.stringify(pathToFileURL(corePath).href)}`)
        .replace(
          'from "./configuration.js"',
          `from ${JSON.stringify(pathToFileURL(configurationPath).href)}`
        );
      const emitted = join(fixture, "profile-source.mjs");
      await writeFile(
        emitted,
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
        }).outputText
      );
      const { createProfileOperations } = (await import(pathToFileURL(emitted).href)) as {
        createProfileOperations: (...args: unknown[]) => ProfileOperations;
      };
      const operations = createProfileOperations(
        { profile: "default", appDataDir: root, runtimeDir: join(root, "runtime") },
        { env, homeDir: fixture }
      );
      await assert.rejects(
        operation === "plan" ? operations.plan("research") : operations[operation](),
        /symlinks|junctions|changed/
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
