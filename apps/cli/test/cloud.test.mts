import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cloudDocumentTitleMaxLength } from "@planview/core/cloud-policy";
import { resolveAppDataPaths } from "@planview/local";
import { loginToCloud, removeCloudCredentials, uploadCloudDocument } from "../dist/cloud.js";
import { MAX_HTML_SIZE_BYTES, readBoundedCloudFile } from "../dist/cloud-file.js";

const collectRequest = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const waitForTestEvent = async (event: Promise<void>, description: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Did not observe ${description}.`)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const withIsolatedAppData = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "planview-cloud-test-"));
  const envKeys = ["HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_DATA_HOME"] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "local-app-data"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  });

  try {
    await run(root);
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
};

const fakeReader = (options: {
  initialSize: number;
  currentSize?: () => number;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null | undefined
  ) => Promise<number>;
}) => {
  let statCalls = 0;
  const reader = {
    stat: async () => {
      statCalls += 1;
      return {
        size:
          statCalls === 1 ? options.initialSize : (options.currentSize?.() ?? options.initialSize),
      } as Stats;
    },
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null | undefined
    ) => ({
      bytesRead: await options.read(buffer, offset, length, position),
      buffer,
    }),
  };
  return reader as unknown as Pick<FileHandle, "read" | "stat">;
};

const saveTestCredentials = async (
  profile: string,
  cloudUrl = "https://cloud.example.test",
  token = "security-test-token"
) => {
  await loginToCloud({
    profile,
    cloudUrl,
    writeStatus: () => undefined,
    openBrowser: async (signInUrl) => {
      const signIn = new URL(signInUrl);
      const returnToValue = signIn.searchParams.get("returnTo");
      assert.ok(returnToValue);
      const returnTo = new URL(returnToValue, cloudUrl);
      const state = returnTo.searchParams.get("state");
      const callbackUrl = returnTo.searchParams.get("redirect_uri");
      assert.ok(state);
      assert.ok(callbackUrl);

      const callback = new URL(callbackUrl);
      const response = await fetch(callback, {
        method: "POST",
        headers: { Origin: callback.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ state, token }),
      });
      assert.equal(response.status, 200);
      await response.text();
    },
  });
};

const cloudCredentialsPath = (profile: string) =>
  join(resolveAppDataPaths({ profile }).appDataDir, "cloud-credentials.json");

test("cloud login callback and upload preserve the local protocol", async () => {
  await withIsolatedAppData(async (root) => {
    let responseMode: "success" | "expired" | "failure" = "success";
    const uploadRequests: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
    const revokedTokens: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE" && request.url === "/api/cli/session") {
        revokedTokens.push(request.headers.authorization ?? "");
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/api/documents/upload") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const body = await collectRequest(request);
      uploadRequests.push({ headers: request.headers, body });
      if (responseMode === "expired") {
        sendJson(response, 401, { error: "expired" });
      } else if (responseMode === "failure") {
        sendJson(response, 422, { error: "Upload rejected by the test server." });
      } else {
        sendJson(response, 201, { id: "folder/document id" });
      }
    });
    const cloudUrl = await listen(server);

    try {
      const statuses: string[] = [];
      let callbackPageStatus = 0;
      let wrongOriginStatus = 0;
      let wrongStateStatus = 0;
      let acceptedCallbackStatus = 0;

      const login = await loginToCloud({
        profile: "cloud-test",
        cloudUrl,
        writeStatus: (message) => {
          statuses.push(message);
        },
        openBrowser: async (signInUrl) => {
          const signIn = new URL(signInUrl);
          assert.equal(signIn.origin, cloudUrl);
          assert.equal(signIn.pathname, "/auth/login");

          const returnToValue = signIn.searchParams.get("returnTo");
          assert.ok(returnToValue);
          const returnTo = new URL(returnToValue, cloudUrl);
          assert.equal(returnTo.pathname, "/cli/authorize");
          const state = returnTo.searchParams.get("state");
          const callbackUrl = returnTo.searchParams.get("redirect_uri");
          assert.ok(state);
          assert.ok(callbackUrl);

          const callback = new URL(callbackUrl);
          assert.equal(callback.protocol, "http:");
          assert.equal(callback.hostname, "127.0.0.1");
          assert.equal(callback.pathname, "/callback");

          const page = await fetch(callback);
          callbackPageStatus = page.status;
          assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
          await page.text();

          const wrongOrigin = await fetch(callback, {
            method: "POST",
            headers: {
              Origin: "http://127.0.0.1:1",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ state, token: "test-token" }),
          });
          wrongOriginStatus = wrongOrigin.status;
          await wrongOrigin.text();

          const wrongState = await fetch(callback, {
            method: "POST",
            headers: { Origin: callback.origin, "Content-Type": "application/json" },
            body: JSON.stringify({
              state: `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`,
              token: "test-token",
            }),
          });
          wrongStateStatus = wrongState.status;
          await wrongState.text();

          const accepted = await fetch(callback, {
            method: "POST",
            headers: { Origin: callback.origin, "Content-Type": "application/json" },
            body: JSON.stringify({ state, token: "test-token" }),
          });
          acceptedCallbackStatus = accepted.status;
          await accepted.text();
        },
      });

      assert.deepEqual(login, { cloudUrl });
      assert.equal(callbackPageStatus, 200);
      assert.equal(wrongOriginStatus, 403);
      assert.equal(wrongStateStatus, 403);
      assert.equal(acceptedCallbackStatus, 200);
      assert.ok(statuses.some((message) => message.includes("Continue in your browser:")));
      assert.ok(statuses.some((message) => message.includes("Waiting for you to authorize")));

      const sourcePath = join(root, "Project plan.HTML");
      writeFileSync(sourcePath, "<!doctype html><title>Plan</title>");
      const uploaded = await uploadCloudDocument(sourcePath, "cloud-test");
      assert.deepEqual(uploaded, {
        id: "folder/document id",
        url: `${cloudUrl}/api/documents/folder%2Fdocument%20id`,
      });
      assert.equal(uploadRequests.length, 1);
      assert.equal(uploadRequests[0]?.headers.authorization, "Bearer planview_cli_test-token");
      assert.match(
        uploadRequests[0]?.headers["content-type"] ?? "",
        /^multipart\/form-data; boundary=/
      );
      assert.match(uploadRequests[0]?.body ?? "", /name="title"\r\n\r\nProject plan\r\n/);
      assert.match(
        uploadRequests[0]?.body ?? "",
        /filename="Project plan\.HTML"\r\nContent-Type: text\/html\r\n\r\n<!doctype html><title>Plan<\/title>/
      );

      await uploadCloudDocument(sourcePath, "cloud-test", {
        title: "x".repeat(cloudDocumentTitleMaxLength + 5),
      });
      assert.ok(
        uploadRequests[1]?.body?.includes(
          `name="title"\r\n\r\n${"x".repeat(cloudDocumentTitleMaxLength)}\r\n`
        )
      );

      responseMode = "expired";
      await assert.rejects(
        uploadCloudDocument(sourcePath, "cloud-test"),
        /credential was rejected/
      );
      responseMode = "failure";
      await assert.rejects(
        uploadCloudDocument(sourcePath, "cloud-test"),
        /Upload rejected by the test server\./
      );

      const oversizedPath = join(root, "too-large.html");
      writeFileSync(oversizedPath, Buffer.alloc(MAX_HTML_SIZE_BYTES + 1));
      const requestCount = uploadRequests.length;
      await assert.rejects(uploadCloudDocument(oversizedPath, "cloud-test"), /up to 8 MiB/);
      assert.equal(uploadRequests.length, requestCount);

      const credentialsPath = join(
        resolveAppDataPaths({ profile: "cloud-test" }).appDataDir,
        "cloud-credentials.json"
      );
      assert.ok(readFileSync(credentialsPath, "utf8").includes("planview_cli_test-token"));
      await removeCloudCredentials("cloud-test");
      assert.deepEqual(revokedTokens, ["Bearer planview_cli_test-token"]);
      assert.equal(existsSync(credentialsPath), false);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

test("logout retains a credential when server revocation fails", async () => {
  await withIsolatedAppData(async () => {
    const server = createServer((_request, response) => sendJson(response, 503, { error: "down" }));
    const cloudUrl = await listen(server);
    try {
      await saveTestCredentials("logout-retry", cloudUrl);
      await assert.rejects(removeCloudCredentials("logout-retry"), /could not revoke/);
      assert.equal(existsSync(cloudCredentialsPath("logout-retry")), true);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

test("login defaults to the current plansplease staging origin", async () => {
  await withIsolatedAppData(async () => {
    const previousUrl = process.env["PLANVIEW_CLOUD_URL"];
    delete process.env["PLANVIEW_CLOUD_URL"];
    try {
      const result = await loginToCloud({
        profile: "staging-default",
        writeStatus: () => undefined,
        openBrowser: async (value) => {
          const signIn = new URL(value);
          assert.equal(signIn.origin, "https://plansplease-app-staging.up.railway.app");
          const returnTo = new URL(signIn.searchParams.get("returnTo")!, signIn.origin);
          const callback = new URL(returnTo.searchParams.get("redirect_uri")!);
          const response = await fetch(callback, {
            method: "POST",
            headers: { Origin: callback.origin, "Content-Type": "application/json" },
            body: JSON.stringify({
              state: returnTo.searchParams.get("state"),
              token: "staging-default-token",
            }),
          });
          assert.equal(response.status, 200);
          await response.text();
        },
      });
      assert.deepEqual(result, { cloudUrl: "https://plansplease-app-staging.up.railway.app" });
    } finally {
      if (previousUrl === undefined) delete process.env["PLANVIEW_CLOUD_URL"];
      else process.env["PLANVIEW_CLOUD_URL"] = previousUrl;
    }
  });
});

test("saved staging credentials revoke through the confirmed replacement origin", async (t) => {
  await withIsolatedAppData(async () => {
    const profile = "staging-migration";
    await saveTestCredentials(profile);
    const path = cloudCredentialsPath(profile);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify({ ...saved, cloudUrl: "https://app-staging-a39a.up.railway.app" })
    );
    t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
      assert.equal(input, "https://plansplease-app-staging.up.railway.app/api/cli/session");
      assert.equal(init.method, "DELETE");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer planview_cli_security-test-token"
      );
      return Response.json({ success: true });
    });
    await removeCloudCredentials(profile);
    assert.equal(existsSync(path), false);
  });
});

test("failed staging credential migration revocation preserves the saved credential", async (t) => {
  await withIsolatedAppData(async () => {
    const profile = "staging-migration-retry";
    await saveTestCredentials(profile);
    const path = cloudCredentialsPath(profile);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const original = JSON.stringify({
      ...saved,
      cloudUrl: "https://app-staging-a39a.up.railway.app",
    });
    writeFileSync(path, original);
    t.mock.method(globalThis, "fetch", async (input: string) => {
      assert.equal(input, "https://plansplease-app-staging.up.railway.app/api/cli/session");
      return Response.json({ error: "down" }, { status: 503 });
    });
    await assert.rejects(removeCloudCredentials(profile), /could not revoke/);
    assert.equal(readFileSync(path, "utf8"), original);
  });
});

test("a similarly named custom origin never redirects its saved token to staging", async (t) => {
  await withIsolatedAppData(async () => {
    const profile = "custom-origin";
    await saveTestCredentials(profile);
    const path = cloudCredentialsPath(profile);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const customOrigin = "https://app-staging-a39a.up.railway.app.example.test";
    writeFileSync(path, JSON.stringify({ ...saved, cloudUrl: customOrigin }));
    t.mock.method(globalThis, "fetch", async (input: string) => {
      assert.equal(input, `${customOrigin}/api/cli/session`);
      return Response.json({ success: true });
    });
    await removeCloudCredentials(profile);
  });
});

test("login and logout can repair a private but invalid credentials file", async () => {
  await withIsolatedAppData(async () => {
    const profile = "invalid-credentials";
    await saveTestCredentials(profile);
    const path = cloudCredentialsPath(profile);

    writeFileSync(path, "{invalid json");
    await assert.rejects(uploadCloudDocument("unused.html", profile), /credentials are invalid/);
    await saveTestCredentials(profile, "https://cloud.example.test", "replacement-token");
    assert.match(readFileSync(path, "utf8"), /planview_cli_replacement-token/);

    writeFileSync(
      path,
      JSON.stringify({ version: 1, cloudUrl: "not a URL", token: "planview_cli_bad" })
    );
    await removeCloudCredentials(profile);
    assert.equal(existsSync(path), false);
  });
});

test("login refuses to replace a credentials file shared with other users", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async () => {
    const revokedTokens: string[] = [];
    const server = createServer((request, response) => {
      revokedTokens.push(request.headers.authorization ?? "");
      response.writeHead(204);
      response.end();
    });
    const cloudUrl = await listen(server);

    try {
      const profile = "unsafe-credentials";
      await saveTestCredentials(profile, cloudUrl, "previous");
      const path = cloudCredentialsPath(profile);
      chmodSync(path, 0o644);

      await assert.rejects(
        saveTestCredentials(profile, cloudUrl, "replacement"),
        /not private to the current user/
      );
      assert.match(readFileSync(path, "utf8"), /planview_cli_previous/);
      assert.deepEqual(revokedTokens, ["Bearer planview_cli_replacement"]);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

test("signing in again revokes the old credential and retains it when rotation fails", async () => {
  await withIsolatedAppData(async () => {
    const revokedTokens: string[] = [];
    let failSecondRevocation = false;
    const server = createServer((request, response) => {
      if (request.method !== "DELETE" || request.url !== "/api/cli/session") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const authorization = request.headers.authorization ?? "";
      revokedTokens.push(authorization);
      if (failSecondRevocation && authorization === "Bearer planview_cli_second") {
        sendJson(response, 503, { error: "unavailable" });
        return;
      }
      response.writeHead(204);
      response.end();
    });
    const cloudUrl = await listen(server);

    try {
      await saveTestCredentials("rotation", cloudUrl, "first");
      await saveTestCredentials("rotation", cloudUrl, "second");
      assert.deepEqual(revokedTokens, ["Bearer planview_cli_first"]);
      assert.match(readFileSync(cloudCredentialsPath("rotation"), "utf8"), /planview_cli_second/);

      failSecondRevocation = true;
      await assert.rejects(saveTestCredentials("rotation", cloudUrl, "third"), /could not revoke/);
      assert.deepEqual(revokedTokens, [
        "Bearer planview_cli_first",
        "Bearer planview_cli_second",
        "Bearer planview_cli_third",
      ]);
      assert.match(readFileSync(cloudCredentialsPath("rotation"), "utf8"), /planview_cli_second/);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

const assertCloudUploadTimesOut = async (
  responseMode: "no-headers" | "partial-json" | "partial-error-json"
) => {
  await withIsolatedAppData(async (root) => {
    let markRequestReceived: () => void = () => undefined;
    let markPartialResponseSent: () => void = () => undefined;
    const requestReceived = new Promise<void>((resolve) => {
      markRequestReceived = resolve;
    });
    const partialResponseSent = new Promise<void>((resolve) => {
      markPartialResponseSent = resolve;
    });
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/api/documents/upload") {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      markRequestReceived();
      void collectRequest(request).catch(() => undefined);
      if (responseMode !== "no-headers") {
        const isErrorResponse = responseMode === "partial-error-json";
        response.writeHead(isErrorResponse ? 422 : 201, {
          "Content-Type": "application/json",
        });
        response.write(
          isErrorResponse ? '{"error":"partial' : '{"id":"partial',
          markPartialResponseSent
        );
      }
    });

    try {
      const cloudUrl = await listen(server);
      const profile = `cloud-timeout-${responseMode}`;
      await saveTestCredentials(profile, cloudUrl);
      const sourcePath = join(root, "timeout.html");
      writeFileSync(sourcePath, "<!doctype html><title>Timeout</title>");

      const upload = uploadCloudDocument(sourcePath, profile, { timeoutMs: 500 }).then(
        () => ({ kind: "success" as const }),
        (cause: unknown) => ({ kind: "failure" as const, cause })
      );
      await waitForTestEvent(requestReceived, "upload request to reach the local server");
      if (responseMode !== "no-headers") {
        await waitForTestEvent(partialResponseSent, "partial JSON response to be sent");
      }
      const result = await upload;
      assert.equal(result.kind, "failure", "the stalled cloud upload should reject");
      if (result.kind === "failure") {
        assert.match(String(result.cause), /cloud upload timed out/i);
      }
    } finally {
      server.closeAllConnections();
      if (server.listening) await close(server);
    }
  });
};

test("cloud upload times out when the server never sends response headers", async () => {
  await assertCloudUploadTimesOut("no-headers");
});

test("cloud upload timeout covers a successful response with an unfinished JSON body", async () => {
  await assertCloudUploadTimesOut("partial-json");
});

test("cloud upload timeout covers an unfinished JSON error body", async () => {
  await assertCloudUploadTimesOut("partial-error-json");
});

test("bounded cloud reads catch growth at EOF and cap bytes read", async () => {
  let readTotal = 0;
  const growingAtEof = fakeReader({
    initialSize: 2,
    currentSize: () => MAX_HTML_SIZE_BYTES + 1,
    read: async (buffer, offset, length, position) => {
      if (position === 0) {
        buffer.write("ab", offset, "utf8");
        readTotal += 2;
        return Math.min(length, 2);
      }
      return 0;
    },
  });
  await assert.rejects(readBoundedCloudFile(growingAtEof), /up to 8 MiB/);
  assert.equal(readTotal, 2);

  let totalRequested = 0;
  const growingDuringRead = fakeReader({
    initialSize: 1,
    currentSize: () => MAX_HTML_SIZE_BYTES + 1,
    read: async (buffer, offset, length) => {
      totalRequested += length;
      buffer.fill(0x61, offset, offset + length);
      return length;
    },
  });
  await assert.rejects(readBoundedCloudFile(growingDuringRead), /up to 8 MiB/);
  assert.equal(totalRequested, MAX_HTML_SIZE_BYTES + 1);

  let position = 0;
  const exactLimit = fakeReader({
    initialSize: MAX_HTML_SIZE_BYTES,
    read: async (buffer, offset, length) => {
      const bytesRead = Math.min(length, MAX_HTML_SIZE_BYTES - position);
      buffer.fill(0x62, offset, offset + bytesRead);
      position += bytesRead;
      return bytesRead;
    },
  });
  const contents = await readBoundedCloudFile(exactLimit);
  assert.equal(contents.byteLength, MAX_HTML_SIZE_BYTES);
  assert.equal(contents[0], 0x62);
  assert.equal(contents.at(-1), 0x62);
});

test("cloud credentials are saved with private file and profile directory modes on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async () => {
    const profile = "cloud-permissions";
    await saveTestCredentials(profile);

    const credentialsPath = cloudCredentialsPath(profile);
    const directoryStats = lstatSync(resolveAppDataPaths({ profile }).appDataDir);
    const credentialsStats = lstatSync(credentialsPath);

    assert.equal(directoryStats.mode & 0o777, 0o700);
    assert.equal(credentialsStats.mode & 0o777, 0o600);
    assert.equal(directoryStats.uid, process.getuid?.());
    assert.equal(credentialsStats.uid, process.getuid?.());
  });
});

test("cloud upload refuses credentials with permissions shared beyond the current user on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async () => {
    const profile = "cloud-permissive-credentials";
    await saveTestCredentials(profile);
    chmodSync(cloudCredentialsPath(profile), 0o644);

    await assert.rejects(uploadCloudDocument("unused.html", profile), {
      message: /not private to the current user/,
    });
  });
});

test("cloud upload refuses credentials stored through a symbolic link on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  await withIsolatedAppData(async (root) => {
    const profile = "cloud-symlink-credentials";
    await saveTestCredentials(profile);

    const credentialsPath = cloudCredentialsPath(profile);
    const externalCredentialsPath = join(root, "external-cloud-credentials.json");
    writeFileSync(
      externalCredentialsPath,
      JSON.stringify({
        version: 1,
        cloudUrl: "https://cloud.example.test",
        token: "planview_cli_security-test-token",
      })
    );
    rmSync(credentialsPath);
    symlinkSync(externalCredentialsPath, credentialsPath);

    assert.equal(lstatSync(credentialsPath).isSymbolicLink(), true);
    await assert.rejects(uploadCloudDocument("unused.html", profile), { code: "ELOOP" });
  });
});

test("cloud upload packs an artifact folder and rejects unsupported entries before sending bytes", async () => {
  await withIsolatedAppData(async (root) => {
    let uploads = 0;
    const server = createServer(async (request, response) => {
      uploads += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const form = await new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": String(request.headers["content-type"]) },
        body: Buffer.concat(chunks),
      }).formData();
      const file = form.get("file");
      assert.ok(file instanceof File);
      assert.equal(file.type, "application/vnd.planview.bundle");
      assert.equal(form.get("title"), "artifact");
      const { parseCloudBundle, cloudBundleEntry } = await import("@planview/core/cloud-bundle");
      const bundle = parseCloudBundle(new Uint8Array(await file.arrayBuffer()));
      assert.deepEqual(
        Buffer.from(cloudBundleEntry(bundle, "pixel.png").bytes),
        Buffer.from([137, 80, 78, 71, 0, 255])
      );
      assert.equal(
        Buffer.from(await file.arrayBuffer())
          .subarray(0, 8)
          .toString(),
        "PLVWBND1"
      );
      sendJson(response, 201, { id: "artifact-id" });
    });
    try {
      const cloudUrl = await listen(server);
      await saveTestCredentials("artifact-test", cloudUrl);
      const artifact = join(root, "artifact");
      mkdirSync(join(artifact, "scripts"), { recursive: true });
      writeFileSync(join(artifact, "pixel.png"), Buffer.from([137, 80, 78, 71, 0, 255]));
      writeFileSync(join(artifact, "index.html"), '<script src="scripts/main.js"></script>');
      writeFileSync(join(artifact, "scripts", "main.js"), 'document.body.dataset.artifact="yes";');
      assert.equal((await uploadCloudDocument(artifact, "artifact-test")).id, "artifact-id");
      assert.equal(uploads, 1);
      writeFileSync(join(artifact, "unsupported.exe"), "unsupported");
      await assert.rejects(
        uploadCloudDocument(artifact, "artifact-test"),
        /Unsupported bundle file extension/
      );
      assert.equal(uploads, 1);
    } finally {
      await close(server);
    }
  });
});
