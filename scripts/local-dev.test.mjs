import assert from "node:assert/strict";
import { test } from "node:test";
import { localEnvironment, resetLocal } from "./local-dev.mjs";

test("local runner discards cloud deployment selection and credentials from inherited environment", () => {
  const result = localEnvironment(
    {
      PATH: "/bin",
      CONVEX_DEPLOY_KEY: "cloud-secret",
      CONVEX_DEPLOYMENT: "prod:real",
      CONVEX_SELF_HOSTED_URL: "https://real.example",
      GITHUB_CLIENT_SECRET: "real",
      UPLOADTHING_TOKEN: "real",
      VITE_CONVEX_URL: "https://real.convex.cloud",
      PUBLIC_APP_URL: "https://real.example",
      BETTER_AUTH_SECRET: "real",
      NODE_ENV: "production",
    },
    { BETTER_AUTH_SECRET: "generated-test-secret" }
  );
  assert.equal(result.PATH, "/bin");
  assert.equal(result.CONVEX_DEPLOY_KEY, undefined);
  assert.equal(result.CONVEX_DEPLOYMENT, undefined);
  assert.equal(result.CONVEX_SELF_HOSTED_URL, undefined);
  assert.equal(result.GITHUB_CLIENT_SECRET, "");
  assert.equal(result.UPLOADTHING_TOKEN, "");
  assert.equal(result.BETTER_AUTH_SECRET, "generated-test-secret");
  assert.equal(result.CONVEX_URL, "http://127.0.0.1:3210");
  assert.equal(result.SITE_URL, "http://127.0.0.1:3000");
  assert.equal(result.NODE_ENV, "development");
});

test("reset requires an explicit confirmation before touching local data", async () => {
  await assert.rejects(resetLocal(false), /--yes to confirm/);
});

test("source mirroring handles additions, nested directories, renames and deletions", async () => {
  const { mkdtemp, mkdir, readFile, rename, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { mirrorSourceFile, syncGeneratedBindings } = await import("./local-dev.mjs");
  const directory = await mkdtemp(join(tmpdir(), "plansplease-mirror-"));
  const source = join(directory, "source");
  const destination = join(directory, "backend");
  try {
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested/query.ts"), "export const query = 1;");
    await mirrorSourceFile(source, destination, "nested");
    assert.equal(
      await readFile(join(destination, "nested/query.ts"), "utf8"),
      "export const query = 1;"
    );
    await rename(join(source, "nested/query.ts"), join(source, "nested/renamed.ts"));
    await mirrorSourceFile(source, destination, "nested/query.ts");
    await mirrorSourceFile(source, destination, "nested/renamed.ts");
    await assert.rejects(readFile(join(destination, "nested/query.ts")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(destination, "nested/renamed.ts"), "utf8"),
      "export const query = 1;"
    );
    await rm(join(source, "nested"), { recursive: true });
    await mirrorSourceFile(source, destination, "nested");
    await assert.rejects(readFile(join(destination, "nested/renamed.ts")), { code: "ENOENT" });
    await mkdir(join(destination, "_generated"));
    await writeFile(join(destination, "_generated/api.d.ts"), "export type NewQuery = string;");
    await writeFile(join(destination, "deployment.env"), "must not copy");
    await syncGeneratedBindings(destination, source);
    assert.equal(
      await readFile(join(source, "_generated/api.d.ts"), "utf8"),
      "export type NewQuery = string;"
    );
    await assert.rejects(readFile(join(source, "deployment.env")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
