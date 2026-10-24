import { cloudBundleContentType, parseCloudBundle } from "./cloud-bundle.ts";
import {
  cloudDocumentMaxBytes,
  cloudDocumentTitleMaxLength,
  cloudDocumentTitleMinLength,
} from "@planview/core/cloud-policy";
import { isConvexConfigurationError } from "./convex-configuration-error.ts";

import {
  uploadReservedDocument,
  storageQuotaErrorResponse,
  type DocumentUploadMetadata,
} from "./reserved-document-upload.ts";
import type { DocumentStorageUpload, StoredDocument } from "./document-storage.ts";
import type { DocumentUploadCompensationReporter } from "./document-upload-compensation.ts";

export type { DocumentUploadMetadata } from "./reserved-document-upload.ts";

export type DocumentUploadHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{ client: Client; token: string | null | undefined }>;
  getCurrentUser(client: Client, request: Request): Promise<{ subject: string } | null | undefined>;
  isStorageConfigured(): boolean;
  getUploadLocator(objectId: string): StoredDocument;
  uploadFile(input: DocumentStorageUpload): Promise<StoredDocument>;
  reserveMetadata(
    client: Client,
    input: DocumentUploadMetadata,
    ownerId: string,
    request: Request
  ): Promise<{ id: string | null; uploadDeadlineAt: number }>;
  abandonMetadata(
    client: Client,
    input: DocumentUploadMetadata,
    ownerId: string,
    request: Request,
    uploadConfirmed: boolean
  ): Promise<string | null>;
  createMetadata(
    client: Client,
    input: DocumentUploadMetadata,
    ownerId: string,
    request: Request
  ): Promise<string>;
  reportCompensationFailure?: DocumentUploadCompensationReporter;
  createUploadId(): string;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

const MAX_FILE_SIZE_BYTES = cloudDocumentMaxBytes;
const MAX_REQUEST_SIZE_BYTES = MAX_FILE_SIZE_BYTES + 64 * 1024;

async function readBoundedFormData(request: Request): Promise<FormData | null> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("The upload form has no body");

  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_REQUEST_SIZE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = request.headers.get("content-type");
  if (!contentType) throw new Error("The upload form has no content type");
  return new Request(request.url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Blob([bytes]),
  }).formData();
}

export function createDocumentUploadHandler<Client>(
  dependencies: DocumentUploadHandlerDependencies<Client>
) {
  return async ({ request }: { request: Request }) => {
    const contentLengthHeader = request.headers.get("content-length");
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);

    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength <= 0)) {
      return Response.json({ error: "Content-Length must be a positive integer" }, { status: 400 });
    }
    if (contentLength !== null && contentLength > MAX_REQUEST_SIZE_BYTES) {
      return Response.json(
        { error: "The upload request exceeds the 8 MiB limit" },
        { status: 413 }
      );
    }

    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      const identity = await dependencies.getCurrentUser(client, request);
      if (!identity) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }
      if (!dependencies.isStorageConfigured()) {
        return Response.json(
          { error: "File storage is not configured yet.", code: "STORAGE_NOT_CONFIGURED" },
          { status: 503 }
        );
      }

      let formData: FormData | null;
      try {
        formData = await readBoundedFormData(request);
      } catch {
        return Response.json({ error: "The upload form could not be read" }, { status: 400 });
      }
      if (!formData) {
        return Response.json(
          { error: "The upload request exceeds the 8 MiB limit" },
          { status: 413 }
        );
      }

      const files = formData.getAll("file");
      const file = files[0];
      const titleField = formData.get("title");
      const title = typeof titleField === "string" ? titleField.trim() : "";

      const bundle =
        file instanceof File &&
        file.type === cloudBundleContentType &&
        file.name.toLowerCase().endsWith(".planview");
      if (
        files.length !== 1 ||
        typeof File === "undefined" ||
        !(file instanceof File) ||
        (!bundle && (!file.name.toLowerCase().endsWith(".html") || file.type !== "text/html")) ||
        file.size > MAX_FILE_SIZE_BYTES ||
        title.length < cloudDocumentTitleMinLength ||
        title.length > cloudDocumentTitleMaxLength
      ) {
        return Response.json(
          {
            error:
              "Upload one HTML file or artifact bundle up to 8 MiB with a title of 1 to 200 characters",
          },
          { status: 400 }
        );
      }

      if (bundle) {
        try {
          parseCloudBundle(new Uint8Array(await file.arrayBuffer()));
        } catch {
          return Response.json({ error: "Invalid HTML/CSS/JS bundle" }, { status: 400 });
        }
      }
      const objectId = `${identity.subject}:${dependencies.createUploadId()}`;
      const locator = dependencies.getUploadLocator(objectId);
      const metadata: DocumentUploadMetadata = {
        title,
        ...locator,
        contentType: bundle ? cloudBundleContentType : "text/html",
        sizeBytes: file.size,
      };
      const id = await uploadReservedDocument({
        metadata,
        file,
        objectId,
        reserve: () => dependencies.reserveMetadata(client, metadata, identity.subject, request),
        upload: dependencies.uploadFile,
        commit: () => dependencies.createMetadata(client, metadata, identity.subject, request),
        abandon: (uploadConfirmed) =>
          dependencies.abandonMetadata(
            client,
            metadata,
            identity.subject,
            request,
            uploadConfirmed
          ),
        ...(dependencies.reportCompensationFailure
          ? { reportCompensationFailure: dependencies.reportCompensationFailure }
          : {}),
      });

      return Response.json({ id }, { status: 201 });
    } catch (error) {
      if (isConvexConfigurationError(error)) {
        return dependencies.missingServerConfigurationResponse();
      }

      return storageQuotaErrorResponse(error) ?? dependencies.errorResponse(error);
    }
  };
}
