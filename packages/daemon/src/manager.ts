import { randomBytes, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { V1_MAX_HTML_SIZE_BYTES } from "@planview/core";
import { validateSnapshotListOptions, validateSnapshotSelection } from "@planview/storage";
import type { DaemonApplication } from "./application.js";
import { createDaemonHttpServer, type DaemonHttpServer } from "./http-server.js";

export type ManagerLaunch = Readonly<{ url: string; origin: string; expiresAt: number }>;
export const MANAGER_CODE_TTL_MS = 60_000;
export const MANAGER_SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_CREDENTIALS = 8;
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
};
const equals = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const response = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const body = async (request: IncomingMessage, max: number, signal: AbortSignal) => {
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > max))
    throw new Error("Request exceeds its byte limit.");
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(
    () => request.destroy(new Error("Request body deadline elapsed.")),
    15_000
  );
  timer.unref();
  const abort = () => request.destroy(new Error("Request cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of request) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > max) throw new Error("Request exceeds its byte limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
};
const jsonBody = async (req: IncomingMessage, signal: AbortSignal) => {
  if (req.headers["content-type"] !== "application/json")
    throw new Error("Expected application/json.");
  return record(JSON.parse((await body(req, 4096, signal)).toString("utf8")));
};
const only = (value: Record<string, unknown>, names: string[]) => {
  if (Object.keys(value).some((key) => !names.includes(key)))
    throw new Error("Unexpected request fields.");
};

/** Loads only compiled, owned application assets. Artifact paths never enter this map. */
const loadAssets = async (root: URL) => {
  const assets = new Map<string, { bytes: Buffer; type: string }>();
  for (const dir of ["", "assets/"]) {
    const entries = await readdir(new URL(dir, root), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const path = `${dir}${entry.name}`;
      const type = path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : path.endsWith(".css")
            ? "text/css; charset=utf-8"
            : undefined;
      if (type !== undefined)
        assets.set(`/${path === "index.html" ? "" : path}`, {
          bytes: await readFile(new URL(path, root)),
          type,
        });
    }
  }
  if (!assets.has("/"))
    throw new Error(
      "Manager assets are missing. Rebuild or reinstall the CLI, then restart its daemon."
    );
  return assets;
};

export type ManagerOptions = {
  application: DaemonApplication;
  profile: string;
  appDataDir: string;
  previewOrigin: string;
  requestShutdown: () => void;
  isShuttingDown: () => boolean;
  assetsRoot?: URL;
  now?: () => number;
};

export const openManager = async (options: ManagerOptions) => {
  const assets = await loadAssets(options.assetsRoot ?? new URL("./manager/", import.meta.url));
  const now = options.now ?? Date.now;
  const codes = new Map<string, number>();
  const sessions = new Map<string, number>();
  let origin = "";
  let authority = "";
  let active = 0;
  let imports = 0;
  const prune = (entries: Map<string, number>) => {
    for (const [key, expiresAt] of entries) if (expiresAt <= now()) entries.delete(key);
  };
  const consume = (entries: Map<string, number>, token: string, remove: boolean) => {
    prune(entries);
    for (const [key, expiry] of entries)
      if (equals(token, key)) {
        if (remove) entries.delete(key);
        return expiry;
      }
    return undefined;
  };
  const authenticate = (req: IncomingMessage) => {
    const authorization = req.headers.authorization;
    return (
      authorization?.startsWith("Bearer ") === true &&
      consume(sessions, authorization.slice(7), false) !== undefined
    );
  };
  const server: DaemonHttpServer = createDaemonHttpServer(
    async (req, res, signal, accepting) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", CSP);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Frame-Options", "DENY");
      let target: URL;
      try {
        const hosts = req.rawHeaders
          .filter((_, index) => index % 2 === 0)
          .filter((key) => key.toLowerCase() === "host");
        if (hosts.length !== 1 || req.headers.host !== authority) throw new Error("Invalid Host.");
        target = new URL(req.url ?? "/", origin);
        if (
          target.origin !== origin ||
          target.search !== "" ||
          target.hash !== "" ||
          !req.url?.startsWith("/")
        )
          throw new Error("Invalid request target.");
        if (req.headers.origin !== undefined && req.headers.origin !== origin)
          throw new Error("Invalid Origin.");
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new Error("Cross-site request refused.");
      } catch {
        response(res, 403, { error: "untrusted_request" });
        return;
      }
      if (!accepting() || options.isShuttingDown()) {
        response(res, 503, { error: "stopping" });
        return;
      }
      if (active >= 16) {
        response(res, 503, { error: "capacity" });
        return;
      }
      active += 1;
      try {
        if (!target.pathname.startsWith("/api/")) {
          if (req.method !== "GET") {
            response(res, 405, { error: "method_not_allowed" });
            return;
          }
          const asset = assets.get(target.pathname);
          if (!asset) {
            response(res, 404, { error: "not_found" });
            return;
          }
          res.writeHead(200, { "Content-Type": asset.type, "Content-Length": asset.bytes.length });
          res.end(asset.bytes);
          return;
        }
        if (req.method !== "POST") {
          response(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (req.headers.origin !== origin) {
          response(res, 403, { error: "origin_required" });
          return;
        }
        if (target.pathname === "/api/session") {
          const payload = await jsonBody(req, signal);
          only(payload, ["code"]);
          const code = payload["code"];
          if (typeof code !== "string" || consume(codes, code, true) === undefined) {
            response(res, 401, {
              error: "invalid_launch",
              message: "Run ui again with the same selected profile for a new one-use launch link.",
            });
            return;
          }
          prune(sessions);
          if (sessions.size >= MAX_CREDENTIALS) {
            response(res, 429, {
              error: "session_limit",
              message: "Sign out of another manager session or restart the daemon.",
            });
            return;
          }
          const token = randomBytes(32).toString("base64url");
          const expiresAt = now() + MANAGER_SESSION_TTL_MS;
          sessions.set(token, expiresAt);
          response(res, 200, { token, expiresAt });
          return;
        }
        if (!authenticate(req)) {
          response(res, 401, {
            error: "unauthorized",
            message: "Run ui again with the same selected profile for a fresh launch link.",
          });
          return;
        }
        if (target.pathname === "/api/import") {
          if (imports >= 2) {
            response(res, 429, { error: "import_capacity" });
            return;
          }
          imports += 1;
          try {
            if (req.headers["content-type"] !== "application/octet-stream")
              throw new Error("Expected raw HTML bytes.");
            const encoded = req.headers["x-planview-filename"];
            if (typeof encoded !== "string") throw new Error("An HTML filename is required.");
            const filename = decodeURIComponent(encoded);
            const bytes = await body(req, V1_MAX_HTML_SIZE_BYTES, signal);
            const result = await options.application.importHtml(filename, bytes, signal);
            response(res, 201, { id: result.id, url: `${options.previewOrigin}/${result.id}` });
          } finally {
            imports -= 1;
          }
          return;
        }
        const payload = await jsonBody(req, signal);
        switch (target.pathname) {
          case "/api/list": {
            only(payload, ["limit", "after"]);
            const args = validateSnapshotListOptions({
              ...(payload["limit"] === undefined ? {} : { limit: payload["limit"] as number }),
              ...(payload["after"] === undefined ? {} : { after: payload["after"] as string }),
            });
            response(res, 200, await options.application.list(args));
            return;
          }
          case "/api/usage":
            only(payload, []);
            response(res, 200, await options.application.usage());
            return;
          case "/api/status":
            only(payload, []);
            response(res, 200, {
              profile: options.profile,
              appDataDir: options.appDataDir,
              previewOrigin: options.previewOrigin,
              pid: process.pid,
            });
            return;
          case "/api/delete": {
            only(payload, ["id", "generation"]);
            if (typeof payload["id"] !== "string" || typeof payload["generation"] !== "string")
              throw new Error("Select a listed snapshot generation.");
            const selected = validateSnapshotSelection({
              id: payload["id"],
              generation: payload["generation"],
            });
            response(res, 200, await options.application.deleteSnapshot(selected, signal));
            return;
          }
          case "/api/logout": {
            only(payload, []);
            const token = req.headers.authorization?.slice(7) ?? "";
            consume(sessions, token, true);
            response(res, 200, { signedOut: true });
            return;
          }
          case "/api/stop":
            only(payload, []);
            response(res, 202, { stopping: true });
            options.requestShutdown();
            return;
          default:
            response(res, 404, { error: "not_found" });
        }
      } catch (cause) {
        if (!res.destroyed && !res.headersSent)
          response(res, 400, {
            error: "operation_failed",
            message: cause instanceof Error ? cause.message : "Manager operation failed.",
          });
      } finally {
        active -= 1;
      }
    },
    (res) => {
      if (!res.destroyed && !res.headersSent) response(res, 500, { error: "manager_failed" });
    }
  );
  server.server.requestTimeout = 30_000;
  server.server.headersTimeout = 10_000;
  const port = await server.listen("127.0.0.1", 0, true, 0);
  authority = `127.0.0.1:${port}`;
  origin = `http://${authority}`;
  return {
    ...server,
    launch: (): ManagerLaunch => {
      prune(codes);
      if (codes.size >= MAX_CREDENTIALS)
        throw new Error("Too many unused launch links. Wait one minute and retry.");
      const code = randomBytes(32).toString("base64url");
      const expiresAt = now() + MANAGER_CODE_TTL_MS;
      codes.set(code, expiresAt);
      return { url: `${origin}/#${code}`, origin, expiresAt };
    },
    revoke: () => {
      codes.clear();
      sessions.clear();
    },
  };
};
export type ManagerServer = Awaited<ReturnType<typeof openManager>>;
