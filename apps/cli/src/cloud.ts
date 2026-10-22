import { parseCloudBundle } from "@planview/core/cloud-bundle";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { basename, join } from "node:path";
import { preparePublishSource, resolveAppDataPaths } from "@planview/local";
import { MAX_HTML_SIZE_BYTES, readBoundedCloudFile } from "./cloud-file.js";

const DEFAULT_CLOUD_URL = "https://plansplease-app-staging.up.railway.app";
const LEGACY_STAGING_CLOUD_URL = "https://app-staging-a39a.up.railway.app";
const CLI_CREDENTIAL_PREFIX = "planview_cli_";
const CREDENTIALS_NAME = "cloud-credentials.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CLOUD_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

type Credentials = Readonly<{
  version: 1;
  cloudUrl: string;
  token: string;
}>;

type CloudDocument = Readonly<{
  id: string;
  url: string;
}>;

type BrowserCallback = (url: string) => Promise<void>;
type CloudObject = Record<string, unknown> & {
  cloudUrl?: unknown;
  error?: unknown;
  id?: unknown;
  state?: unknown;
  token?: unknown;
  version?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isCloudObject = (value: unknown): value is CloudObject => isObject(value);

const credentialPath = (profile?: string) =>
  join(resolveAppDataPaths(profile === undefined ? {} : { profile }).appDataDir, CREDENTIALS_NAME);

const normalizedCloudUrl = (value: string) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("The cloud URL must be an absolute HTTPS URL.");
  }

  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("The cloud URL must be an HTTPS origin without a path or credentials.");
  }

  // This is the same staging backend after its Railway hostname cutover.
  // Only migrate this known origin; never send saved tokens to an env override.
  return url.origin === LEGACY_STAGING_CLOUD_URL ? DEFAULT_CLOUD_URL : url.origin;
};

const assertCurrentUserFile = (stats: Awaited<ReturnType<typeof lstat>>, label: string) => {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Refusing to use ${label} because it is not a regular file.`);
  }

  if (
    process.platform !== "win32" &&
    ((process.getuid?.() !== undefined && stats.uid !== process.getuid()) ||
      (Number(stats.mode) & 0o077) !== 0)
  ) {
    throw new Error(`Refusing to use ${label} because it is not private to the current user.`);
  }
};

const prepareCredentialsDirectory = async (profile?: string) => {
  const directory = resolveAppDataPaths(profile === undefined ? {} : { profile }).appDataDir;
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stats = await lstat(directory);

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Refusing to save cloud credentials in an unsafe Planview data directory.");
  }

  if (process.platform !== "win32") {
    if (process.getuid?.() !== undefined && stats.uid !== process.getuid()) {
      throw new Error("The Planview data directory must be owned by the current user.");
    }
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }

  return directory;
};

const saveCredentials = async (profile: string | undefined, credentials: Credentials) => {
  const directory = await prepareCredentialsDirectory(profile);
  const targetPath = join(directory, CREDENTIALS_NAME);
  const temporaryPath = join(
    directory,
    `.${CREDENTIALS_NAME}.${randomBytes(12).toString("hex")}.tmp`
  );
  const targetStats = await lstat(targetPath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });

  if (targetStats) assertCurrentUserFile(targetStats, "the existing cloud credentials file");

  const file = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NO_FOLLOW,
    PRIVATE_FILE_MODE
  );

  try {
    await file.writeFile(JSON.stringify(credentials), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    if (process.platform !== "win32") await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, targetPath);
    if (process.platform !== "win32") await chmod(targetPath, PRIVATE_FILE_MODE);
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
};

const loadCredentials = async (
  profile?: string,
  options: { allowInvalid?: boolean } = {}
): Promise<Credentials | undefined> => {
  const path = credentialPath(profile);
  let file: FileHandle;

  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }

  try {
    const stats = await file.stat();
    assertCurrentUserFile(stats, "the cloud credentials file");
    const invalidCredentials = () => {
      if (options.allowInvalid) return undefined;
      throw new Error("The saved cloud credentials are invalid. Run `plansplease login` again.");
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.readFile({ encoding: "utf8" }));
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      return invalidCredentials();
    }

    if (
      !isCloudObject(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.cloudUrl !== "string" ||
      typeof parsed.token !== "string" ||
      !parsed.token.startsWith(CLI_CREDENTIAL_PREFIX) ||
      parsed.token.length === CLI_CREDENTIAL_PREFIX.length
    ) {
      return invalidCredentials();
    }

    let cloudUrl: string;
    try {
      cloudUrl = normalizedCloudUrl(parsed.cloudUrl);
    } catch {
      return invalidCredentials();
    }

    return {
      version: 1,
      cloudUrl,
      token: parsed.token,
    };
  } finally {
    await file.close();
  }
};

const revokeCloudCredential = async (credentials: Credentials) => {
  const response = await fetch(`${credentials.cloudUrl}/api/cli/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${credentials.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error("The cloud could not revoke this computer's credential. Try again.");
  }
};

export const removeCloudCredentials = async (profile?: string) => {
  const path = credentialPath(profile);
  const stats = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });

  if (stats) {
    assertCurrentUserFile(stats, "the cloud credentials file");
    const credentials = await loadCredentials(profile, { allowInvalid: true });
    if (credentials) await revokeCloudCredential(credentials);
    await unlink(path);
  }
};

const sendText = (response: import("node:http").ServerResponse, status: number, text: string) => {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
};

const callbackDocument = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Return to plansplease CLI</title>
<body><p id="message">Finishing plansplease sign-in…</p><script>
const message = document.getElementById("message");
const params = new URLSearchParams(location.hash.slice(1));
const state = params.get("state");
const token = params.get("token");
history.replaceState(null, "", location.pathname);
if (!state || !token) {
  message.textContent = "Sign-in did not return an authorization token. You can close this tab.";
} else {
  fetch("/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, token }),
  }).then((response) => {
    if (!response.ok) throw new Error("The CLI did not accept this sign-in response.");
    message.textContent = "You are signed in. Return to the terminal.";
  }).catch(() => {
    message.textContent = "Sign-in could not be completed. Return to the terminal and try again.";
  });
}
</script></body></html>`;

const readSmallJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 16 * 1024) throw new Error("The sign-in response is too large.");
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const closeServer = async (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

export const loginToCloud = async (options: {
  profile?: string;
  cloudUrl?: string;
  openBrowser: BrowserCallback;
  writeStatus: (message: string) => void | Promise<void>;
}) => {
  const cloudUrl = normalizedCloudUrl(
    options.cloudUrl ?? process.env["PLANVIEW_CLOUD_URL"] ?? DEFAULT_CLOUD_URL
  );
  const state = randomBytes(32).toString("base64url");
  let tokenResolve: (token: string) => void = () => undefined;
  let tokenReject: (cause: Error) => void = () => undefined;
  const tokenPromise = new Promise<string>((resolve, reject) => {
    tokenResolve = resolve;
    tokenReject = reject;
  });
  let callbackOrigin = "";
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/callback") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(callbackDocument);
      return;
    }

    if (request.method !== "POST" || request.url !== "/callback") {
      sendText(response, 404, "Not found");
      return;
    }

    if (
      request.headers.origin !== callbackOrigin ||
      !request.headers["content-type"]?.startsWith("application/json")
    ) {
      sendText(response, 403, "This sign-in response was not sent by the local callback page.");
      return;
    }

    void readSmallJson(request)
      .then((body) => {
        if (
          !isCloudObject(body) ||
          typeof body.state !== "string" ||
          typeof body.token !== "string"
        ) {
          sendText(response, 400, "The sign-in response is invalid.");
          return;
        }

        const expectedState = Buffer.from(state);
        const receivedState = Buffer.from(body.state);
        if (
          expectedState.byteLength !== receivedState.byteLength ||
          !timingSafeEqual(expectedState, receivedState)
        ) {
          sendText(response, 403, "The sign-in state did not match this CLI request.");
          return;
        }

        if (body.token.length > 16 * 1024) {
          sendText(response, 400, "The sign-in token is invalid.");
          return;
        }

        sendText(response, 200, "Signed in. You can return to the terminal.");
        tokenResolve(body.token);
      })
      .catch(() => sendText(response, 400, "The sign-in response could not be read."));
  });

  const address = await new Promise<ReturnType<Server["address"]>>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("The local sign-in callback could not bind to a port.");
  }

  callbackOrigin = `http://127.0.0.1:${address.port}`;
  const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
  const returnTo = new URL("/cli/authorize", cloudUrl);
  returnTo.searchParams.set("redirect_uri", callbackUrl);
  returnTo.searchParams.set("state", state);
  const signInUrl = new URL("/auth/login", cloudUrl);
  signInUrl.searchParams.set("returnTo", `${returnTo.pathname}${returnTo.search}`);
  const timer = setTimeout(
    () => tokenReject(new Error("Sign-in timed out. Run `plansplease login` to try again.")),
    LOGIN_TIMEOUT_MS
  );
  timer.unref();

  try {
    await options.writeStatus(`Continue in your browser: ${signInUrl.toString()}\n`);
    await options.openBrowser(signInUrl.toString());
    await options.writeStatus("Waiting for you to authorize the local CLI…\n");
    const token = await tokenPromise;
    const credentials: Credentials = {
      version: 1,
      cloudUrl,
      token: `${CLI_CREDENTIAL_PREFIX}${token}`,
    };
    try {
      const previous = await loadCredentials(options.profile, { allowInvalid: true });
      if (previous?.cloudUrl === credentials.cloudUrl && previous.token === credentials.token) {
        return { cloudUrl };
      }
      if (previous) await revokeCloudCredential(previous);
      await saveCredentials(options.profile, credentials);
    } catch (cause) {
      await revokeCloudCredential(credentials).catch(() => undefined);
      throw cause;
    }
    return { cloudUrl };
  } finally {
    clearTimeout(timer);
    await closeServer(server).catch(() => undefined);
  }
};

const readResponseBody = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  try {
    return await response.json();
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    throw cause;
  }
};

const readResponseMessage = async (response: Response, signal: AbortSignal) => {
  try {
    const body = await readResponseBody(response, signal);
    if (isCloudObject(body) && typeof body.error === "string") return body.error;
  } catch {
    if (signal.aborted) throw signal.reason;
    // Use the status code below when the response does not contain JSON.
  }
  return `Cloud request failed (${response.status}).`;
};

const requireCloudCredentials = async (profile?: string) => {
  const credentials = await loadCredentials(profile);
  if (!credentials) throw new Error("Not signed in to the cloud. Run `plansplease login` first.");
  return credentials;
};

export const uploadCloudDocument = async (
  sourcePath: string,
  profile?: string,
  options: { timeoutMs?: number; bundle?: boolean; title?: string } = {}
): Promise<CloudDocument> => {
  const credentials = await requireCloudCredentials(profile);
  const fileStats = await lstat(sourcePath);

  if (fileStats.isDirectory() && !fileStats.isSymbolicLink()) {
    const prepared = await preparePublishSource(sourcePath, { maxBytes: MAX_HTML_SIZE_BYTES });
    try {
      return await uploadCloudDocument(prepared.sourcePath, profile, {
        ...options,
        bundle: true,
        title: basename(sourcePath) || "Artifact",
      });
    } finally {
      await prepared.cleanup();
    }
  }

  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error("Choose a regular .html file to upload.");
  }
  if (!sourcePath.toLowerCase().endsWith(".html")) {
    throw new Error("The cloud uploader accepts standalone .html files only.");
  }
  if (fileStats.size > MAX_HTML_SIZE_BYTES) {
    throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
  }

  // O_NONBLOCK prevents a replacement FIFO from stalling between lstat and
  // open. Descriptor and path checks then reject a replacement file.
  const source = await open(
    sourcePath,
    constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0)
  );
  let bytes: Uint8Array;
  let openedStats: Awaited<ReturnType<FileHandle["stat"]>>;
  try {
    openedStats = await source.stat();
    if (!openedStats.isFile()) {
      throw new Error("Choose a regular .html file to upload.");
    }
    if (openedStats.dev !== fileStats.dev || openedStats.ino !== fileStats.ino) {
      throw new Error("The HTML file changed while it was being opened for upload.");
    }
    if (openedStats.size > MAX_HTML_SIZE_BYTES) {
      throw new Error("The cloud uploader accepts HTML files up to 8 MiB.");
    }

    bytes = await readBoundedCloudFile(source);

    const currentPathStats = await lstat(sourcePath);
    if (currentPathStats.isSymbolicLink() || !currentPathStats.isFile()) {
      throw new Error("Choose a regular .html file to upload.");
    }
    if (currentPathStats.dev !== openedStats.dev || currentPathStats.ino !== openedStats.ino) {
      throw new Error("The HTML file changed while it was being read.");
    }
  } finally {
    await source.close();
  }

  if (options.bundle) parseCloudBundle(bytes);
  const file = new File([bytes], options.bundle ? "artifact.planview" : basename(sourcePath), {
    type: options.bundle ? "application/vnd.planview.bundle" : "text/html",
    lastModified: openedStats.mtimeMs,
  });
  const title =
    (options.title ?? basename(sourcePath).replace(/\.html$/i, "")).trim().slice(0, 200) ||
    "Untitled HTML";
  const formData = new FormData();
  formData.set("file", file);
  formData.set("title", title);

  const timeoutMs = options.timeoutMs ?? CLOUD_UPLOAD_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("The cloud upload timeout must be a positive finite number.");
  }

  const controller = new AbortController();
  const timeoutReason = new DOMException("The cloud upload deadline elapsed.", "TimeoutError");
  const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);

  try {
    const response = await fetch(`${credentials.cloudUrl}/api/documents/upload`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.token}`,
      },
      body: formData,
      signal: controller.signal,
    });

    if (response.status === 401) {
      throw new Error(
        "Your cloud credential was rejected. Run `plansplease login` and retry the upload."
      );
    }
    if (!response.ok) {
      throw new Error(await readResponseMessage(response, controller.signal));
    }

    const body = await readResponseBody(response, controller.signal);
    if (!isCloudObject(body) || typeof body.id !== "string") {
      throw new Error("The cloud did not return a document link.");
    }

    return {
      id: body.id,
      url: `${credentials.cloudUrl}/api/documents/${encodeURIComponent(body.id)}`,
    } satisfies CloudDocument;
  } catch (cause) {
    if (controller.signal.aborted && cause === timeoutReason) {
      throw new Error("The cloud upload timed out. Check your connection and retry.", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};
