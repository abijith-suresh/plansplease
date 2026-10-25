export class DocumentReadAdmissionError extends Error {
  readonly code: "capacity" | "closed" | "timeout";

  constructor(code: "capacity" | "closed" | "timeout") {
    super(
      code === "capacity"
        ? "The daemon has reached its bounded document-read capacity."
        : code === "timeout"
          ? "The daemon document-read queue deadline elapsed."
          : "The daemon is shutting down."
    );
    this.name = "DocumentReadAdmissionError";
    this.code = code;
  }
}

export type DocumentReadAdmissionOptions = Readonly<{
  readonly maxActiveReads: number;
  readonly maxQueuedReads: number;
  readonly queueTimeoutMs: number;
}>;

export const createDocumentReadAdmission = ({
  maxActiveReads,
  maxQueuedReads,
  queueTimeoutMs,
}: DocumentReadAdmissionOptions) => {
  const active = new Set<AbortController>();
  const queued: Array<{
    readonly resolve: (permit: DocumentReadPermit) => void;
    readonly reject: (cause: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly timer: NodeJS.Timeout;
  }> = [];
  let closing = false;

  const removeQueued = (entry: (typeof queued)[number]) => {
    const index = queued.indexOf(entry);
    if (index < 0) {
      return false;
    }
    queued.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    return true;
  };

  const makePermit = () => {
    const controller = new AbortController();
    active.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        if (active.delete(controller)) {
          drain();
        }
      },
    } satisfies DocumentReadPermit;
  };

  const drain = () => {
    while (!closing && active.size < maxActiveReads) {
      const next = queued.shift();
      if (next === undefined) {
        return;
      }
      clearTimeout(next.timer);
      if (next.signal !== undefined && next.onAbort !== undefined) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve(makePermit());
    }
  };

  const acquire = (signal?: AbortSignal) => {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (closing) {
      return Promise.reject(new DocumentReadAdmissionError("closed"));
    }
    if (active.size < maxActiveReads) {
      return Promise.resolve(makePermit());
    }
    if (queued.length >= maxQueuedReads) {
      return Promise.reject(new DocumentReadAdmissionError("capacity"));
    }
    return new Promise<DocumentReadPermit>((resolvePromise, rejectPromise) => {
      let entry: (typeof queued)[number];
      const onAbort = () => {
        if (removeQueued(entry)) {
          rejectPromise(signal?.reason);
        }
      };
      const timer = setTimeout(() => {
        if (removeQueued(entry)) {
          rejectPromise(new DocumentReadAdmissionError("timeout"));
        }
      }, queueTimeoutMs);
      entry = {
        resolve: resolvePromise,
        reject: rejectPromise,
        ...(signal === undefined ? {} : { signal, onAbort }),
        timer,
      };
      queued.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    for (const queuedRead of queued.splice(0)) {
      clearTimeout(queuedRead.timer);
      if (queuedRead.signal !== undefined && queuedRead.onAbort !== undefined) {
        queuedRead.signal.removeEventListener("abort", queuedRead.onAbort);
      }
      queuedRead.reject(new DocumentReadAdmissionError("closed"));
    }
    for (const controller of active) {
      controller.abort(new Error("The daemon is shutting down."));
    }
  };

  return { acquire, close };
};

export type DocumentReadPermit = Readonly<{
  readonly signal: AbortSignal;
  readonly release: () => void;
}>;
