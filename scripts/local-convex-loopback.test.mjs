import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { installLoopbackBackendSpawn, loopbackBackendArguments } from "./local-convex-loopback.mjs";
import { localConvexArguments } from "./local-dev.mjs";

const native = join(
  tmpdir(),
  process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend"
);
const serverArgs = ["--port", "3210", "--site-proxy-port", "3211", "database.sqlite"];

test("only the exact native backend server gets loopback arguments, without mutating inputs", () => {
  const input = [...serverArgs];
  assert.deepEqual(loopbackBackendArguments(native, input), [
    ...serverArgs,
    "--interface",
    "127.0.0.1",
  ]);
  assert.deepEqual(input, serverArgs);
  for (const command of [process.execPath, `${native}-other`, `${native}.backup`])
    assert.equal(loopbackBackendArguments(command, input), input);
  for (const args of [["keygen", "admin-key"], ["help"], ["--version"], [...input, "--help"]])
    assert.equal(loopbackBackendArguments(native, args), args);
  // An option value named keygen is still a server invocation.
  assert.deepEqual(
    loopbackBackendArguments(native, [...input, "--instance-name", "keygen"]).slice(-2),
    ["--interface", "127.0.0.1"]
  );
});

test("explicit interfaces cannot broaden the bind and unfamiliar server launches fail closed", () => {
  for (const suffix of [
    ["--interface", "127.0.0.1"],
    ["-i", "127.0.0.1"],
    ["--interface=127.0.0.1"],
    ["-i127.0.0.1"],
  ]) {
    const args = [...serverArgs, ...suffix];
    assert.equal(loopbackBackendArguments(native, args), args);
  }
  for (const suffix of [
    ["--interface", "0.0.0.0"],
    ["-i", "192.168.1.2"],
    ["--interface=0.0.0.0"],
    ["-i0.0.0.0"],
    ["--interface"],
  ])
    assert.throws(
      () => loopbackBackendArguments(native, [...serverArgs, ...suffix]),
      /must bind to 127/
    );
  for (const args of [
    undefined,
    {},
    [],
    ["--port", "3210"],
    ["--port", "bad", "--site-proxy-port", "3211"],
    [...serverArgs, "--port", "5000"],
    [...serverArgs, "--"],
  ])
    assert.throws(() => loopbackBackendArguments(native, args), /Unsupported local Convex backend/);
});

test("spawn and spawnSync retain optional signatures, options, receiver, and return values", () => {
  const calls = [];
  const result = {};
  const childProcess = Object.fromEntries(
    ["spawn", "spawnSync"].map((method) => [
      method,
      function (...args) {
        calls.push({ method, receiver: this, args });
        return result;
      },
    ])
  );
  installLoopbackBackendSpawn(childProcess);
  for (const method of ["spawn", "spawnSync"]) {
    const options = { stdio: "pipe", env: { TEST: "kept" } };
    for (const parameters of [
      [process.execPath],
      [process.execPath, options],
      [process.execPath, undefined, options],
      [process.execPath, ["--version"], options],
    ]) {
      assert.equal(childProcess[method](...parameters), result);
      const call = calls.at(-1);
      assert.equal(call.receiver, childProcess);
      assert.deepEqual(call.args, parameters);
      assert.equal(call.args.at(-1), parameters.at(-1));
    }
    assert.equal(childProcess[method](native, serverArgs, options), result);
    assert.equal(calls.at(-1).args[2], options);
    assert.deepEqual(calls.at(-1).args[1], [...serverArgs, "--interface", "127.0.0.1"]);
  }
});

test("bootstrap, environment configuration, and normal dev use the same explicit CLI preload", () => {
  for (const command of [
    ["dev", "--skip-push"],
    ["env", "set", "--from-file", "backend.env"],
    ["dev"],
  ]) {
    const args = localConvexArguments(command);
    assert.equal(args[0], "--import");
    assert.equal(
      fileURLToPath(args[1]),
      fileURLToPath(new URL("./local-convex-preload.mjs", import.meta.url))
    );
    assert.match(args[2], /node_modules[/\\]convex[/\\]bin[/\\]main\.js$/);
    assert.deepEqual(args.slice(3), command);
  }
});

test("the actual preload binds both fake-native listeners to loopback through ESM spawn and CJS spawnSync", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "plansplease-convex-bind-"));
  try {
    const executable = join(directory, "convex-local-backend");
    await writeFile(
      executable,
      `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
const interfaceIndex = args.indexOf('--interface');
const host = interfaceIndex < 0 ? '0.0.0.0' : args[interfaceIndex + 1];
const servers = [net.createServer(), net.createServer()];
Promise.all(servers.map(server => new Promise(resolve => server.listen(0, host, () => resolve(server.address())))))
  .then(addresses => { console.log(JSON.stringify(addresses)); servers.forEach(server => server.close()); });
`,
      { mode: 0o700 }
    );
    const expression = `
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { spawnSync } = createRequire(import.meta.url)('node:child_process');
const command = process.argv[1];
const args = ['--port', '0', '--site-proxy-port', '0'];
const sync = spawnSync(command, args, { encoding: 'utf8' });
if (sync.status !== 0) throw new Error(sync.stderr);
const child = spawn(command, args);
let output = '';
child.stdout.on('data', chunk => output += chunk);
await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('fake native failed'))); });
console.log(JSON.stringify([JSON.parse(sync.stdout), JSON.parse(output)]));
`;
    const preload = fileURLToPath(new URL("./local-convex-preload.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", preload, "--input-type=module", "--eval", expression, executable],
      { encoding: "utf8", timeout: 10_000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const groups = JSON.parse(result.stdout);
    assert.equal(groups.length, 2);
    for (const addresses of groups) {
      assert.equal(addresses.length, 2);
      for (const address of addresses) {
        assert.equal(address.address, "127.0.0.1");
        assert.equal(address.family, "IPv4");
        assert.ok(address.port > 0);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
