export type OperationGate = {
  <Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    requestSignal?: AbortSignal
  ): Promise<Value>;
  readonly close: (cause?: unknown) => void;
  readonly abortActive: (cause?: unknown) => void;
  readonly isIdle: () => boolean;
  readonly waitForIdle: () => Promise<void>;
};

type OperationEntry = {
  readonly controller: AbortController;
  readonly start: () => void;
  readonly reject: (cause: unknown) => void;
  readonly requestSignal?: AbortSignal;
  readonly onRequestAbort?: () => void;
};

// Serialize publication and cleanup across the file-to-metadata commit.
// Reads use separate leases. Shutdown rejects queued mutations and can abort
// the active mutation after its drain deadline.
export const createOperationGate = () => {
  const queued: OperationEntry[] = [];
  const idleWaiters = new Set<() => void>();
  let running: OperationEntry | undefined;
  let closed = false;

  const notifyIdle = () => {
    if (running !== undefined || queued.length > 0) {
      return;
    }
    for (const resolvePromise of idleWaiters) {
      resolvePromise();
    }
    idleWaiters.clear();
  };

  const pump = () => {
    if (closed || running !== undefined) {
      return;
    }
    const next = queued.shift();
    if (next === undefined) {
      notifyIdle();
      return;
    }
    running = next;
    next.start();
  };

  const run = <Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    requestSignal?: AbortSignal
  ) => {
    if (closed) {
      return Promise.reject(new Error("The daemon is shutting down."));
    }
    if (requestSignal?.aborted) {
      return Promise.reject(requestSignal.reason);
    }

    return new Promise<Value>((resolvePromise, rejectPromise) => {
      const controller = new AbortController();
      let entry: OperationEntry;
      const onRequestAbort = () => {
        controller.abort(requestSignal?.reason ?? new Error("The operation request was aborted."));
        const index = queued.indexOf(entry);
        if (index >= 0) {
          queued.splice(index, 1);
          rejectPromise(controller.signal.reason);
          notifyIdle();
        }
      };
      const start = () => {
        void Promise.resolve()
          .then(() => operation(controller.signal))
          .then(resolvePromise, rejectPromise)
          .finally(() => {
            if (requestSignal !== undefined) {
              requestSignal.removeEventListener("abort", onRequestAbort);
            }
            if (running === entry) {
              running = undefined;
            }
            pump();
            notifyIdle();
          });
      };
      entry = {
        controller,
        start,
        reject: rejectPromise,
        ...(requestSignal === undefined ? {} : { requestSignal, onRequestAbort }),
      };
      queued.push(entry);
      requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
      pump();
    });
  };

  const close = (cause: unknown = new Error("The daemon is shutting down.")) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const entry of queued.splice(0)) {
      entry.controller.abort(cause);
      if (entry.requestSignal !== undefined && entry.onRequestAbort !== undefined) {
        entry.requestSignal.removeEventListener("abort", entry.onRequestAbort);
      }
      entry.reject(cause);
    }
    notifyIdle();
  };

  const abortActive = (cause: unknown = new Error("The daemon shutdown deadline elapsed.")) => {
    running?.controller.abort(cause);
  };

  const isIdle = () => running === undefined && queued.length === 0;
  const waitForIdle = () =>
    isIdle()
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => idleWaiters.add(resolvePromise));

  return Object.assign(run, { close, abortActive, isIdle, waitForIdle }) satisfies OperationGate;
};
