import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// Execute actual private production functions without adding a public native API.
// Captured process boundaries prove transport/error handling, not native ACLs.
const source = ts.createSourceFile(
  "profiles.ts",
  readFileSync(new URL("../src/profiles.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ESNext,
  true
);
const names = [
  "OWNER_INPUT_LIMIT",
  "OWNER_STAGES",
  "ownerInput",
  "ownerFailureDetails",
  "windowsOwners",
];
const statements = source.statements.filter(
  (statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)
    )
);
assert.equal(statements.length, names.length);
const emitted = ts.transpileModule(
  statements.map((statement) => statement.getText(source)).join("\n"),
  {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }
).outputText;
const encode = new Function(`${emitted}; return ownerInput;`)() as (
  paths: readonly string[]
) => string;
const details = new Function(`${emitted}; return ownerFailureDetails;`)() as (
  error: unknown,
  stderr: unknown,
  started: number
) => string;
const environment = Object.freeze({
  PSModulePath: "PowerShell 7 modules",
  PSMODULEPATH: "another casing",
  pSmOdUlEpAtH: "mixed casing",
  SystemRoot: "C:\\Windows",
  PATH: "preserved executable path",
  UNRELATED: "preserved value",
});
type Options = {
  env: Record<string, string>;
  windowsHide: boolean;
  timeout: number;
  maxBuffer: number;
  encoding: string;
};
type Callback = (error: unknown, stdout: string, stderr: string) => void;
const loadHelper = (
  exec: (exe: string, args: string[], options: Options, callback: Callback) => unknown
) =>
  new Function("execFile", "process", "join", `${emitted}; return windowsOwners;`)(
    exec,
    { platform: "win32", env: environment },
    win32.join
  ) as (paths: readonly string[]) => Promise<readonly boolean[]>;
function capture(
  paths: readonly string[],
  response = "[true]",
  error: unknown = null,
  stderr = "",
  inputError = false
) {
  const calls: {
    exe: string;
    args: string[];
    options: Options;
    input?: string;
    encoding?: string;
  }[] = [];
  const helper = loadHelper((exe, args, options, callback) => {
    const call = { exe, args, options, input: "", encoding: "" };
    calls.push(call);
    let onError = () => {};
    return {
      stdin: {
        on: (_event: string, handler: () => void) => {
          onError = handler;
        },
        end: (input: string, encoding: string) => {
          call.input = input;
          call.encoding = encoding;
          if (inputError) onError();
          queueMicrotask(() => callback(error, response, stderr));
        },
      },
    };
  });
  return { result: helper(paths), calls };
}

test("actual helper preserves parent env, uses one hidden bounded process and exact ASCII/base64 data only on stdin", async () => {
  const paths = ["C:\\private fixture é\\研究 👩‍💻", "C:\\space ` $() ' \"\n\r\t \\leaf"];
  const run = capture(paths, "[true,false]");
  assert.deepEqual(await run.result, [true, false]);
  assert.equal(run.calls.length, 1);
  const call = run.calls[0]!;
  assert.deepEqual(call.options.env, {
    SystemRoot: environment.SystemRoot,
    PATH: environment.PATH,
    UNRELATED: environment.UNRELATED,
  });
  assert.equal(environment.PSModulePath, "PowerShell 7 modules");
  assert.equal(environment.PSMODULEPATH, "another casing");
  assert.equal(environment.pSmOdUlEpAtH, "mixed casing");
  assert.equal(call.exe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(call.args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.timeout, 5000);
  assert.equal(call.options.maxBuffer, 64 * 1024);
  assert.equal(call.encoding, "ascii");
  const lines = call.input!.split("\n");
  assert.equal(lines[0], "2");
  assert.equal(lines.at(-1), "");
  assert.deepEqual(
    lines.slice(1, -1).map((line) => Buffer.from(line, "base64").toString("utf8")),
    paths
  );
  assert.ok([...call.input!].every((character) => character.charCodeAt(0) < 128));
  const script = Buffer.from(call.args[4]!, "base64").toString("utf16le");
  for (const path of paths) assert.equal(script.includes(path), false);
  const other = capture(["C:\\different"], "[false]");
  assert.deepEqual(await other.result, [false]);
  assert.equal(other.calls[0]!.args[4], call.args[4], "paths never become script code");
});

test("actual script uses explicit streams and owner-only .NET policy without console/cmdlet bootstrap", async () => {
  const run = capture(["C:\\fixture"]);
  await run.result;
  const script = Buffer.from(run.calls[0]!.args[4]!, "base64").toString("utf16le");
  assert.doesNotMatch(
    script,
    /New-Object|ConvertFrom-Json|ConvertTo-Json|Get-Acl|ForEach-Object|InputEncoding|OutputEncoding|Console\]::(?:In|Out|Error)\b/
  );
  for (const name of ["Input", "Output", "Error"])
    assert.ok(script.includes(`[Console]::OpenStandard${name}()`));
  assert.ok(script.includes("[System.Text.UTF8Encoding]::new($false, $true)"));
  assert.ok(
    script.includes(
      "[System.IO.Directory]::GetAccessControl($decoded[$i], [System.Security.AccessControl.AccessControlSections]::Owner)"
    )
  );
  assert.ok(script.includes("$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value"));
  assert.ok(script.includes("$owners = @($identity.User.Value, $identity.Owner.Value)"));
  assert.ok(script.includes("$accepted = $owners -contains $sid"));
  assert.ok(script.includes("catch { $accepted = $false }"));
  assert.ok(script.includes("[byte[]]::new(65537)"));
  assert.ok(script.includes("$total -gt 65536"));
  assert.ok(script.includes("$count -gt 100"));
  assert.ok(script.includes("$standardOutput.Flush()"));
  assert.ok(script.includes("$resource.Dispose() } catch { $completed = $false }"));
  assert.ok(script.includes("if (-not $completed) { exit 1 }"));
  assert.ok(
    script.indexOf("$decoded[$i] = $path") < script.indexOf("Mark 'acl'"),
    "validate entire batch before ACL queries/output"
  );
});

test("input is bounded by count and bytes and rejects lossy/NUL paths before launching", async () => {
  assert.ok(Buffer.byteLength(encode(["x".repeat(48000)]), "ascii") <= 65536);
  for (const paths of [Array(101).fill("x"), [""], ["x\0y"], ["x\ud800"], ["x".repeat(50000)]]) {
    const run = capture(paths);
    await assert.rejects(run.result, /Windows profile ownership/);
    assert.equal(run.calls.length, 0);
  }
  const empty = capture([]);
  assert.deepEqual(await empty.result, []);
  assert.equal(empty.calls.length, 0);
});

test("missing, partial, extra, malformed and nonboolean helper output never authorizes", async () => {
  for (const output of [
    "",
    "[]",
    "[true",
    "[true,]",
    "[true][true]",
    "[1]",
    '{"0":true}',
    '["true"]',
    "[true,false]",
    "[true]\n",
    "[True]",
    "\ufeff[true]",
  ]) {
    await assert.rejects(
      capture(["C:\\fixture"], output).result,
      /^Error: Invalid Windows profile ownership response\.$/
    );
  }
  assert.deepEqual(await capture(["C:\\fixture"], "[false]").result, [false]);
});

test("helper errors or input errors reject even with a complete apparently successful array", async () => {
  const sensitive = "never-return URI SID path credentials command environment";
  await assert.rejects(
    capture(["C:\\fixture"], "[true]", { code: 1, message: sensitive, cmd: sensitive }, sensitive)
      .result,
    (error: Error) =>
      !error.message.includes(sensitive) && error.message.includes('"category":"exit"')
  );
  await assert.rejects(
    capture(["C:\\fixture"], "[true]", null, "", true).result,
    /Could not send Windows profile ownership input/
  );
  let killed = false;
  const missingInput = loadHelper(() => ({
    kill: () => {
      killed = true;
    },
  }));
  await assert.rejects(
    missingInput(["C:\\fixture"]),
    /Could not send Windows profile ownership input/
  );
  assert.equal(killed, true);
  const throwing = loadHelper(() => {
    throw { code: "ENOENT", message: sensitive };
  });
  await assert.rejects(
    throwing(["C:\\fixture"]),
    (error: Error) =>
      error.message.includes('"category":"launch"') && !error.message.includes(sensitive)
  );
});

test("safe process categories and stage labels are bounded and never return raw errors/stderr", () => {
  const secret = "private-path URI SID env stdin error-command";
  const value = details(
    { code: 1, message: secret, cmd: secret },
    `${secret}\nPVOWNER:stage:streams\r\nPVOWNER:stage:input\nPVOWNER:stage:private_path\n`,
    performance.now()
  );
  assert.equal(JSON.parse(value).stage, "input");
  assert.equal(JSON.parse(value).category, "exit");
  assert.equal(value.includes(secret), false);
  assert.ok(value.length < 500);
  const terminated = JSON.parse(
    details({ killed: true, signal: "SIGTERM" }, "PVOWNER:stage:acl\n", performance.now() - 5000)
  );
  assert.equal(terminated.category, "terminated");
  assert.ok(terminated.elapsedMs >= 5000);
  assert.equal(terminated.stage, "acl");
  assert.equal(
    JSON.parse(details({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", performance.now()))
      .category,
    "output_limit"
  );
  assert.equal(JSON.parse(details(null, { secret }, performance.now())).stage, "unknown");
  assert.equal(
    JSON.parse(details({}, "x".repeat(65536) + "\nPVOWNER:stage:acl", performance.now())).stage,
    "unknown"
  );
  const malicious = { secret, toString: () => "ENOENT" };
  const unknown = details({ code: malicious, signal: malicious }, "", performance.now() - 100000);
  assert.deepEqual(JSON.parse(unknown), {
    category: "other",
    code: "other",
    signal: "other",
    killed: false,
    elapsedMs: 60000,
    stage: "unknown",
  });
});
