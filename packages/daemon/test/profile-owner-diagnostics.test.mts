import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Test the production sanitizer without exporting diagnostic internals or
// replacing native ownership decisions. Native execution remains a CI check.
const source = ts.createSourceFile(
  "profiles.ts",
  readFileSync(new URL("../src/profiles.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ESNext,
  true
);
const names = [
  "OWNER_STAGES",
  "ownerFailureDetails",
  "OWNER_PATH_STATES",
  "OWNER_ERROR_CATEGORIES",
  "ownerPathDetails",
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
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  }
).outputText;
const details = new Function(`${emitted}; return ownerFailureDetails;`)() as (
  error: unknown,
  stderr: unknown,
  started: number
) => string;

test("native failure diagnostics preserve safe exit/stage data without stderr, commands, credentials or path lists", () => {
  const secret = "sensitive-fixture-value";
  const result = details(
    {
      code: 1,
      signal: null,
      killed: false,
      message: secret,
      cmd: secret,
      stdin: [secret],
      environment: secret,
    },
    `uri=https://example.test/${secret}\nPVOWNER:stage:start\r\nPVOWNER:stage:input_encoding\r\nPVOWNER:exception:System.Management.Automation.MethodInvocationException\nPVOWNER:inner:System.IO.IOException\n${secret}`,
    performance.now()
  );
  const value = JSON.parse(result);
  assert.equal(value.category, "exit");
  assert.equal(value.code, 1);
  assert.equal(value.signal, "none");
  assert.equal(value.killed, false);
  assert.equal(value.stage, "input_encoding");
  assert.equal(result.includes(secret), false);
  assert.equal(result.includes("https"), false);
  assert.ok(result.length < 700);
});

test("launch, termination and output-limit metadata stay distinguishable while untrusted field values fail closed", () => {
  assert.equal(JSON.parse(details({ code: "ENOENT" }, "", performance.now())).category, "launch");
  const terminated = JSON.parse(
    details({ signal: "SIGTERM", killed: true }, "PVOWNER:stage:stdin\n", performance.now() - 5000)
  );
  assert.equal(terminated.category, "terminated");
  assert.equal(terminated.killed, true);
  assert.equal(terminated.signal, "SIGTERM");
  assert.ok(terminated.elapsedMs >= 5000);
  assert.equal(terminated.stage, "stdin");
  assert.equal(
    JSON.parse(details({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", performance.now()))
      .category,
    "output_limit"
  );
  const sensitive = { secret: "never-return", toString: () => "ENOENT" };
  const value = details(
    { code: sensitive, signal: { ...sensitive, toString: () => "SIGTERM" } },
    "PVOWNER:stage:private_path\nPVOWNER:exception:Custom.never_return\n",
    performance.now() - 100000
  );
  assert.equal(value.includes("never"), false);
  assert.deepEqual(JSON.parse(value), {
    category: "other",
    code: "other",
    signal: "other",
    killed: false,
    elapsedMs: 60000,
    stage: "unknown",
  });
});

test("marker parsing is bounded and never interprets arbitrary stderr or non-string values", () => {
  assert.equal(
    JSON.parse(details(null, { secret: "not string" }, performance.now())).stage,
    "unknown"
  );
  const stderr = "x".repeat(64 * 1024) + "\nPVOWNER:stage:identity\n";
  assert.equal(JSON.parse(details({}, stderr, performance.now())).stage, "unknown");
});

// Guard diagnostic observer effects: no changed error preference, new handler,
// forced exit or command after the original output operation.
test("stage instrumentation preserves original helper ordering and resource bounds", () => {
  const text = source.getFullText();
  const helper = text.slice(text.indexOf("const windowsOwners"), text.indexOf("const canonical"));
  const script = helper.slice(
    helper.indexOf("const script = `") + "const script = `".length,
    helper.indexOf("`;")
  );
  const operations = script
    .split("\n")
    .filter((line) => line.trim() && !line.includes("PVOWNER:stage:"));
  assert.deepEqual(operations.slice(0, 6), [
    "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding",
    "$ErrorActionPreference = 'Stop'",
    "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$owners = @($identity.User.Value, $identity.Owner.Value)",
    "$paths = ConvertFrom-Json ([Console]::In.ReadToEnd())",
  ]);
  assert.equal(operations.at(-1), "ConvertTo-Json -InputObject $result -Compress");
  assert.match(script, /\$ownerPath = \$_/);
  assert.match(script, /\$acl = Get-Acl -LiteralPath \$ownerPath -ErrorAction Stop/);
  assert.match(
    script,
    /\$ownerSid = \$acl\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value/
  );
  assert.match(script, /\$ownerFlag = \$owners -contains \$ownerSid/);
  assert.match(script, /\$ownerFlag = \$false\s+}/);
  assert.match(script, /\$ownerFlag\s+}\)/);
  assert.match(helper, /windowsHide: true,\s+timeout: 5000,\s+maxBuffer: 64 \* 1024/);
  assert.match(helper, /child\.stdin\?\.end\(JSON\.stringify\(paths\)\)/);
  assert.doesNotMatch(helper, /ExecutionPolicy|cause:/);
});

const pathDetails = new Function("createHash", `${emitted}; return ownerPathDetails;`)(
  createHash
) as (stderr: unknown, paths: readonly string[]) => string;

test("per-path diagnostics distinguish lookup, extraction and mismatch without returning path or SID material", () => {
  const paths = ["private é path", "another secret path", "third private", "fourth private"];
  const digest = createHash("sha256").update(paths[0]!).digest("hex");
  const result = pathDetails(
    [
      "raw secret SID URI environment and command",
      `PVOWNER:path:0:digest:${digest}`,
      "PVOWNER:path:0:state:checking",
      "PVOWNER:path:0:state:acl_lookup_failed",
      "PVOWNER:path:0:category:ObjectNotFound",
      "PVOWNER:path:1:state:owner_extraction_failed",
      "PVOWNER:path:1:category:InvalidOperation",
      `PVOWNER:path:1:digest:${digest}`,
      "PVOWNER:path:2:state:owner_mismatch",
      "PVOWNER:path:3:state:match",
      "PVOWNER:path:4:state:match",
      "PVOWNER:path:3:category:private_data",
      "PVOWNER:path:3:state:private_data",
    ].join("\n"),
    paths
  );
  assert.deepEqual(JSON.parse(result), [
    { index: 0, state: "acl_lookup_failed", category: "ObjectNotFound", pathMatches: true },
    {
      index: 1,
      state: "owner_extraction_failed",
      category: "InvalidOperation",
      pathMatches: false,
    },
    { index: 2, state: "owner_mismatch", category: "none", pathMatches: null },
    { index: 3, state: "match", category: "other", pathMatches: null },
  ]);
  for (const value of [...paths, digest, "private_data", "SID", "URI", "command", "environment"])
    assert.equal(result.includes(value), false);
});

test("path diagnostics are bounded and incomplete native evidence stays unknown", () => {
  const paths = Array.from({ length: 101 }, () => "private path");
  const result = JSON.parse(pathDetails("PVOWNER:path:100:state:match", paths));
  assert.equal(result.length, 100);
  assert.ok(result.every((value: { state: string }) => value.state === "unknown"));
  assert.equal(JSON.parse(pathDetails({ secret: "not stderr" }, ["x"]))[0].pathMatches, null);
  assert.equal(
    JSON.parse(pathDetails("x".repeat(64 * 1024) + "\nPVOWNER:path:0:state:match", ["x"]))[0].state,
    "unknown"
  );
});
