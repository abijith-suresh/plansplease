import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isBundleHeader,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "@planview/core";
import {
  type DocumentPublicationCoordinator,
  type createSnapshotManagement,
} from "@planview/storage";
import { Effect } from "effect";
import type { OperationGate } from "./operation-gate.js";

/** Shared daemon operations for native CLI requests and the browser adapter. */
export const createDaemonApplication = ({
  publication,
  snapshots,
  operationGate,
}: {
  publication: DocumentPublicationCoordinator;
  snapshots: ReturnType<typeof createSnapshotManagement>;
  operationGate: OperationGate;
}) => {
  const publishSource = (path: string, signal?: AbortSignal) =>
    operationGate(
      (activeSignal) => Effect.runPromise(publication.publish(path, activeSignal)),
      signal
    );
  const importHtml = async (filename: string, bytes: Uint8Array, signal?: AbortSignal) => {
    if (filename.length > 255 || /[/\\\0]/.test(filename))
      throw new Error("Choose one standalone HTML file.");
    validateSourceFileExtension(filename);
    validateSourceFileSize(bytes.byteLength);
    if (isBundleHeader(bytes))
      throw new Error("Folder bundles cannot be imported as standalone HTML.");
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "planview-import-"));
    try {
      const source = join(directory, "import.html");
      await writeFile(source, bytes, {
        mode: 0o600,
        flag: "wx",
        ...(signal === undefined ? {} : { signal }),
      });
      return await publishSource(source, signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  return {
    list: (options: Parameters<typeof snapshots.list>[0]) =>
      Effect.runPromise(snapshots.list(options)),
    usage: () => Effect.runPromise(snapshots.usage()),
    deleteSnapshot: (
      selection: Parameters<typeof snapshots.deleteSnapshot>[0],
      signal?: AbortSignal
    ) =>
      operationGate(
        (activeSignal) => Effect.runPromise(snapshots.deleteSnapshot(selection, activeSignal)),
        signal
      ),
    publishSource,
    importHtml,
  };
};
export type DaemonApplication = ReturnType<typeof createDaemonApplication>;
