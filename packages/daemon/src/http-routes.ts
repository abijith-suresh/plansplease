import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { DEFAULT_PROFILE_NAME, validateDocumentId, type DocumentId } from "@planview/core";
import {
  validateSnapshotListOptions,
  validateSnapshotSelection,
  createSnapshotManagement,
  DocumentPublicationNotFoundError,
  DocumentPublicationReadError,
  type DocumentCleanupResult,
  type DocumentPublicationCoordinator,
  type MetadataStore,
} from "@planview/storage";
import { Effect } from "effect";
import {
  DAEMON_HOST,
  TEST_PUBLISH_PAUSE_ENV,
  TEST_PUBLISH_PAUSE_ONCE_ENV,
  TEST_UNCOOPERATIVE_PUBLISH_ENV,
} from "./configuration.js";
import { DocumentReadAdmissionError, type DocumentReadPermit } from "./document-read-admission.js";
import type { DaemonHttpRequestHandler } from "./http-server.js";
import type { OperationGate } from "./operation-gate.js";

export const DAEMON_SECRET_HEADER = "x-planview-secret";
export const DAEMON_READY_PATH = "/__planview/ready";
export const DAEMON_STARTUP_ACK_PATH = "/__planview/startup-ack";
export const DAEMON_STATUS_PATH = "/__planview/status";
export const DAEMON_SHUTDOWN_PATH = "/__planview/shutdown";
export const DAEMON_PUBLISH_PATH = "/__planview/publish";
export const DAEMON_INVENTORY_PATH = "/__planview/snapshots";
export const DAEMON_USAGE_PATH = "/__planview/usage";
export const DAEMON_DELETE_PATH = "/__planview/delete";
export const DAEMON_CLEAN_PATH = "/__planview/clean";
/** Slow consumers are allowed to backpressure, but not to remain completely idle forever. */
export const DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS = 30_000;
/** An absolute bound prevents a peer from retaining a read lease indefinitely. */
export const DAEMON_DOCUMENT_READ_MAX_DURATION_MS = 10 * 60_000;
export const DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS = 30_000;
/** Read admission is bounded so stalled clients cannot grow an unbounded queue. */
export const DAEMON_MAX_ACTIVE_DOCUMENT_READS = 64;
export const DAEMON_MAX_QUEUED_DOCUMENT_READS = 128;
const MAX_PUBLISH_REQUEST_BYTES = 16 * 1024;

type DaemonRouteDescriptor = Readonly<{
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly profile?: string;
  readonly secret: string;
  readonly startedAt: number;
}>;

export type DaemonStatusPayload = Readonly<{
  readonly state: "running";
  readonly profile: string;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}>;

type DocumentReadAdmission = Readonly<{
  readonly acquire: (signal?: AbortSignal) => Promise<DocumentReadPermit>;
}>;

export type DaemonHttpRouteOptions = Readonly<{
  readonly descriptor: DaemonRouteDescriptor;
  readonly requestShutdown: () => void;
  readonly publicationCoordinator: DocumentPublicationCoordinator;
  readonly metadataStore: MetadataStore;
  readonly snapshotManagement: ReturnType<typeof createSnapshotManagement>;
  readonly runCleanup: (signal?: AbortSignal) => Promise<DocumentCleanupResult>;
  readonly isReady: () => boolean;
  readonly documentReadAdmission: DocumentReadAdmission;
  readonly operationGate: OperationGate;
  readonly acknowledgeStartup: () => void;
  readonly isTestProcess: () => boolean;
  readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const response = (res: ServerResponse, status: number, body: string, type = "application/json") => {
  res.statusCode = status;
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

export const writeDaemonHttpResponse = response;

const htmlError = (_status: number, title: string, message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;

const statusPayload = (descriptor: DaemonRouteDescriptor) =>
  ({
    state: "running",
    profile: descriptor.profile ?? DEFAULT_PROFILE_NAME,
    pid: descriptor.pid,
    host: descriptor.host,
    port: descriptor.port,
    startedAt: descriptor.startedAt,
  }) satisfies DaemonStatusPayload;

const secretFrom = (request: IncomingMessage) => {
  const header = request.headers[DAEMON_SECRET_HEADER];
  if (typeof header === "string") {
    return header;
  }
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
};

const sameSecret = (left: string | undefined, right: string) => {
  if (left === undefined) {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const parseJson = (contents: string) => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordValue = (record: Record<string, unknown>, key: string) => record[key];

const readJsonBody = async (request: IncomingMessage, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const chunks: Buffer[] = [];
  let size = 0;
  const onAbort = () => {
    request.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of request) {
      signal?.throwIfAborted();
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_PUBLISH_REQUEST_BYTES) {
        throw new Error("The publish request body is too large.");
      }
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
    return parseJson(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

const PRIVATE_MANAGEMENT_PATHS = new Set([
  DAEMON_READY_PATH,
  DAEMON_STARTUP_ACK_PATH,
  DAEMON_STATUS_PATH,
  DAEMON_SHUTDOWN_PATH,
  DAEMON_PUBLISH_PATH,
  DAEMON_CLEAN_PATH,
  DAEMON_INVENTORY_PATH,
  DAEMON_USAGE_PATH,
  DAEMON_DELETE_PATH,
  "/internal/clean",
  "/internal/ready",
  "/internal/status",
  "/internal/shutdown",
]);

type PublishedDocumentRoute = Readonly<{
  readonly id: string;
  readonly entryPath?: string;
}>;

const documentRouteFromPath = (url: string): PublishedDocumentRoute | undefined => {
  if (!url.startsWith("/") || url.length < 2) {
    return undefined;
  }
  const segments = url.slice(1).split("/");
  const id = segments.shift();
  if (id === undefined || id.length === 0) {
    return undefined;
  }
  if (segments.length === 0) {
    return { id };
  }
  const decoded = [];
  for (const segment of segments) {
    try {
      const value = decodeURIComponent(segment);
      if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
        return undefined;
      }
      decoded.push(value);
    } catch {
      return undefined;
    }
  }
  return {
    id,
    entryPath: decoded.length === 1 && decoded[0] === "" ? "index.html" : decoded.join("/"),
  };
};

const contentTypeForPath = (path: string) => {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return (
    {
      ".html": "text/html",
      ".htm": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".otf": "font/otf",
      ".wasm": "application/wasm",
    }[extension] ?? "application/octet-stream"
  );
};

const handlePublishedDocument = async (
  documentId: string,
  res: ServerResponse,
  publicationCoordinator: DocumentPublicationCoordinator,
  metadataStore: MetadataStore,
  permit: DocumentReadPermit,
  entryPath?: string,
  requestSignal?: AbortSignal
) => {
  const id = (() => {
    try {
      return validateDocumentId(documentId);
    } catch {
      return undefined;
    }
  })();
  if (id === undefined) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    permit.release();
    return;
  }

  const documentEffect =
    entryPath === undefined
      ? publicationCoordinator.readPublishedDocumentLease(id)
      : publicationCoordinator.readPublishedDocumentEntryLease(id, entryPath);
  const document = await Effect.runPromise(documentEffect, { signal: requestSignal }).catch(
    (cause) => {
      if (
        cause instanceof DocumentPublicationNotFoundError ||
        cause instanceof DocumentPublicationReadError
      ) {
        return undefined;
      }
      throw cause;
    }
  );
  if (document === undefined) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    permit.release();
    return;
  }

  res.statusCode = 200;
  const contentType = entryPath === undefined ? "text/html" : contentTypeForPath(entryPath);
  res.setHeader(
    "Content-Type",
    contentType.startsWith("text/") ||
      contentType === "application/json" ||
      contentType === "image/svg+xml"
      ? `${contentType}; charset=utf-8`
      : contentType
  );
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const controller = new AbortController();
  const resettableSignal = AbortSignal.any(
    requestSignal === undefined
      ? [controller.signal, permit.signal]
      : [controller.signal, permit.signal, requestSignal]
  );
  const abort = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!controller.signal.aborted) {
      controller.abort(error);
    }
    document.stream.destroy(error);
    if (!res.destroyed && !res.writableFinished) {
      res.destroy(error);
    }
  };
  let idleTimer: NodeJS.Timeout | undefined;
  let absoluteTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(
      () => abort(new Error("The document download became idle.")),
      DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS
    );
    idleTimer.unref();
  };
  const onResponseClose = () => {
    if (!res.writableFinished) {
      abort(new Error("The document download client disconnected."));
    }
  };
  const onPermitAbort = () =>
    abort(permit.signal.reason ?? new Error("The daemon is shutting down."));
  let completed = false;
  document.stream.on("data", resetIdleTimer);
  res.on("drain", resetIdleTimer);
  res.once("close", onResponseClose);
  permit.signal.addEventListener("abort", onPermitAbort, { once: true });
  resetIdleTimer();
  absoluteTimer = setTimeout(
    () => abort(new Error("The document download deadline elapsed.")),
    DAEMON_DOCUMENT_READ_MAX_DURATION_MS
  );
  absoluteTimer.unref();
  try {
    await pipeline(document.stream, res, { signal: resettableSignal });
    completed = true;
    // The access timestamp is deliberately recorded only once the immutable file
    // stream and the HTTP response have completed successfully.
    try {
      metadataStore.recordDocumentAccess(id);
    } catch {
      // The document was already delivered. There is no safe second response once
      // the body has finished, so leave the daemon available for the next request.
    }
  } finally {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    if (absoluteTimer !== undefined) {
      clearTimeout(absoluteTimer);
    }
    document.stream.off("data", resetIdleTimer);
    res.off("drain", resetIdleTimer);
    res.off("close", onResponseClose);
    permit.signal.removeEventListener("abort", onPermitAbort);
    document.release();
    permit.release();
    if (!completed) {
      abort(new Error("The document download did not complete."));
    }
  }
};

const handleRequest = async (
  request: IncomingMessage,
  res: ServerResponse,
  requestSignal: AbortSignal | undefined,
  isAccepting: () => boolean,
  {
    descriptor,
    requestShutdown,
    publicationCoordinator,
    metadataStore,
    runCleanup,
    snapshotManagement,
    isReady,
    documentReadAdmission,
    operationGate,
    acknowledgeStartup,
    isTestProcess,
    wait,
  }: DaemonHttpRouteOptions
) => {
  let url: string;
  try {
    url = request.url === undefined ? "/" : new URL(request.url, `http://${DAEMON_HOST}`).pathname;
  } catch {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    return;
  }

  if (!isAccepting() && url !== DAEMON_SHUTDOWN_PATH && url !== "/internal/shutdown") {
    response(res, 503, JSON.stringify({ error: "shutting_down" }));
    return;
  }

  // Management routes are an exact set. Do this check before the public
  // single-segment route so a valid document id such as __planview_________x
  // remains public without weakening authentication on management endpoints.
  const privatePath = PRIVATE_MANAGEMENT_PATHS.has(url);
  if (!privatePath) {
    const documentRoute = documentRouteFromPath(url);
    if (documentRoute !== undefined) {
      if (request.method === "GET") {
        if (!isReady()) {
          response(res, 503, JSON.stringify({ error: "not_ready" }));
          return;
        }
        let documentId: DocumentId;
        try {
          documentId = validateDocumentId(documentRoute.id);
        } catch {
          response(
            res,
            404,
            htmlError(404, "Not found", "That Planview document does not exist."),
            "text/html"
          );
          return;
        }
        if (documentRoute.entryPath === undefined) {
          try {
            const format = await Effect.runPromise(
              publicationCoordinator.inspectPublishedDocument(documentId),
              { signal: requestSignal }
            );
            if (format.kind === "bundle") {
              res.statusCode = 308;
              res.setHeader("Location", `/${documentId}/`);
              res.setHeader("Content-Length", "0");
              res.end();
              return;
            }
          } catch (cause) {
            if (
              cause instanceof DocumentPublicationNotFoundError ||
              cause instanceof DocumentPublicationReadError
            ) {
              response(
                res,
                404,
                htmlError(404, "Not found", "That Planview document does not exist."),
                "text/html"
              );
              return;
            }
            throw cause;
          }
        }
        let permit: DocumentReadPermit | undefined;
        try {
          const requestAbort = new AbortController();
          const abortRequest = () => requestAbort.abort(new Error("The client disconnected."));
          const admissionSignal =
            requestSignal === undefined
              ? requestAbort.signal
              : AbortSignal.any([requestAbort.signal, requestSignal]);
          request.once("aborted", abortRequest);
          try {
            permit = await documentReadAdmission.acquire(admissionSignal);
          } finally {
            request.off("aborted", abortRequest);
          }
          await handlePublishedDocument(
            documentId,
            res,
            publicationCoordinator,
            metadataStore,
            permit,
            documentRoute.entryPath,
            requestSignal
          );
        } catch (cause) {
          permit?.release();
          if (!res.destroyed && !res.headersSent) {
            const status =
              cause instanceof DocumentReadAdmissionError
                ? 503
                : request.aborted || request.destroyed
                  ? 499
                  : undefined;
            if (status !== undefined) {
              response(
                res,
                status,
                JSON.stringify({
                  error: status === 503 ? "read_capacity" : "read_aborted",
                  message: describe(cause),
                })
              );
            } else {
              throw cause;
            }
          }
        }
      } else {
        response(
          res,
          405,
          htmlError(405, "Method not allowed", "Planview documents are retrieved with GET."),
          "text/html"
        );
      }
      return;
    }
  }

  if (url === "/" && request.method === "GET") {
    response(
      res,
      isReady() ? 200 : 503,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Planview daemon</title></head><body><h1>Planview daemon running</h1><p>Listening on ${descriptor.host}:${descriptor.port}.</p></body></html>`,
      "text/html"
    );
    return;
  }

  if (!privatePath) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    return;
  }
  if (!sameSecret(secretFrom(request), descriptor.secret)) {
    response(res, 401, JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if ((url === DAEMON_READY_PATH || url === "/internal/ready") && request.method === "GET") {
    if (!isReady()) {
      response(res, 503, JSON.stringify({ ready: false, ...statusPayload(descriptor) }));
      return;
    }
    response(res, 200, JSON.stringify({ ready: true, ...statusPayload(descriptor) }));
    return;
  }
  if (url === DAEMON_STARTUP_ACK_PATH && request.method === "POST") {
    response(res, 202, JSON.stringify({ acknowledged: true }));
    acknowledgeStartup();
    return;
  }
  if ((url === DAEMON_STATUS_PATH || url === "/internal/status") && request.method === "GET") {
    response(res, 200, JSON.stringify(statusPayload(descriptor)));
    return;
  }
  if (!isReady() && !(url === DAEMON_SHUTDOWN_PATH || url === "/internal/shutdown")) {
    response(res, 503, JSON.stringify({ error: "not_ready" }));
    return;
  }
  if ((url === DAEMON_SHUTDOWN_PATH || url === "/internal/shutdown") && request.method === "POST") {
    response(res, 202, JSON.stringify({ shuttingDown: true }));
    requestShutdown();
    return;
  }
  if (url === DAEMON_INVENTORY_PATH && request.method === "GET") {
    let options: ReturnType<typeof validateSnapshotListOptions>;
    try {
      const query = new URL(request.url ?? "", `http://${DAEMON_HOST}`).searchParams;
      if (
        [...query.keys()].some((key) => key !== "limit" && key !== "after") ||
        query.getAll("limit").length > 1 ||
        query.getAll("after").length > 1
      ) {
        throw new Error("Expected only limit and after query parameters.");
      }
      options = validateSnapshotListOptions({
        ...(query.has("limit") ? { limit: Number(query.get("limit")) } : {}),
        ...(query.has("after") ? { after: query.get("after") ?? "" } : {}),
      });
    } catch (cause) {
      response(res, 400, JSON.stringify({ error: "invalid_request", message: describe(cause) }));
      return;
    }
    response(res, 200, JSON.stringify(await Effect.runPromise(snapshotManagement.list(options))));
    return;
  }
  if (url === DAEMON_USAGE_PATH && request.method === "GET") {
    response(res, 200, JSON.stringify(await Effect.runPromise(snapshotManagement.usage())));
    return;
  }
  if (url === DAEMON_DELETE_PATH && request.method === "POST") {
    let selection: ReturnType<typeof validateSnapshotSelection>;
    try {
      const payload = await readJsonBody(request, requestSignal);
      if (
        !isRecord(payload) ||
        typeof payload["id"] !== "string" ||
        typeof payload["generation"] !== "string" ||
        Object.keys(payload).some((key) => key !== "id" && key !== "generation")
      ) {
        throw new Error("Expected a snapshot id and generation from list.");
      }
      selection = validateSnapshotSelection({
        id: payload["id"],
        generation: payload["generation"],
      });
    } catch (cause) {
      if (!res.destroyed)
        response(res, 400, JSON.stringify({ error: "invalid_request", message: describe(cause) }));
      return;
    }
    const result = await operationGate(
      (signal) => Effect.runPromise(snapshotManagement.deleteSnapshot(selection, signal)),
      requestSignal
    );
    response(res, 200, JSON.stringify(result));
    return;
  }
  if ((url === DAEMON_CLEAN_PATH || url === "/internal/clean") && request.method === "POST") {
    try {
      const result = await runCleanup(requestSignal);
      response(
        res,
        200,
        JSON.stringify({
          ...result,
          failures: result.failures.map(({ cause, ...failure }) => ({
            ...failure,
            cause: describe(cause),
          })),
        })
      );
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 500, JSON.stringify({ error: "cleanup_failed", message: describe(cause) }));
    }
    return;
  }
  if (url === DAEMON_PUBLISH_PATH && request.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(request, requestSignal);
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 400, JSON.stringify({ error: "invalid_request", message: describe(cause) }));
      return;
    }
    const sourcePath = isRecord(payload) ? recordValue(payload, "sourcePath") : undefined;
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      response(
        res,
        400,
        JSON.stringify({ error: "invalid_request", message: "sourcePath is required." })
      );
      return;
    }
    try {
      if (isTestProcess()) {
        const pauseMilliseconds = Number(process.env[TEST_PUBLISH_PAUSE_ENV]);
        const pauseOnce = process.env[TEST_PUBLISH_PAUSE_ONCE_ENV] === "1";
        if (
          Number.isFinite(pauseMilliseconds) &&
          pauseMilliseconds > 0 &&
          (!pauseOnce || !testPublishPauseConsumed)
        ) {
          testPublishPauseConsumed = true;
          await wait(
            pauseMilliseconds,
            process.env[TEST_UNCOOPERATIVE_PUBLISH_ENV] === "1" ? undefined : requestSignal
          );
        }
      }
      const published = await operationGate(
        (signal) =>
          Effect.runPromise(publicationCoordinator.publish(sourcePath, signal), {
            signal: requestSignal,
          }),
        requestSignal
      );
      // Keep this response synchronous: 201 means the publication is committed
      // and can be retrieved immediately by its immutable id.
      response(res, 201, JSON.stringify({ id: published.id }));
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 422, JSON.stringify({ error: "publish_failed", message: describe(cause) }));
    }
    return;
  }
  response(res, 405, JSON.stringify({ error: "method_not_allowed" }));
};

export const createDaemonHttpRequestHandler =
  (options: DaemonHttpRouteOptions): DaemonHttpRequestHandler =>
  (request, res, requestSignal, isAccepting) =>
    handleRequest(request, res, requestSignal, isAccepting, options);

let testPublishPauseConsumed = false;
