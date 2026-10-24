import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { cloudDocumentMaxBytes } from "@planview/core/cloud-policy";

import { isFilesystemKey, isLocalDevelopment } from "../../convex/localMode.ts";
import type { DocumentStorageAdapter } from "./document-storage.ts";

export function localStorageConfiguration() {
  if (!isLocalDevelopment(process.env))
    throw new Error("Local storage requires local development mode");
  const root = process.env["PLANVIEW_LOCAL_STORAGE_DIR"];
  const secret = process.env["LOCAL_STORAGE_SECRET"];
  if (!root || !isAbsolute(root) || !secret || secret.length < 32)
    throw new Error("Local storage is not configured");
  return { root, secret, siteUrl: process.env["SITE_URL"]! };
}

export function signLocalStorage(secret: string, action: string, key: string, expires: number) {
  return createHmac("sha256", secret)
    .update(JSON.stringify([action, key, expires]))
    .digest("hex");
}

export function verifyLocalStorage(
  secret: string,
  action: string,
  key: string,
  expires: number,
  signature: string
) {
  if (
    !isFilesystemKey(key) ||
    !Number.isSafeInteger(expires) ||
    expires < Date.now() ||
    expires > Date.now() + 5 * 60_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(signLocalStorage(secret, action, key, expires), "hex")
  );
}

export function createFilesystemStorage(
  root: string,
  readUrl: (key: string) => string
): DocumentStorageAdapter & { read(key: string): Promise<Uint8Array<ArrayBuffer>> } {
  if (!isAbsolute(root)) throw new Error("Local storage requires an absolute directory");
  const pathFor = (key: string) => {
    if (!isFilesystemKey(key)) throw new Error("Invalid local storage locator");
    return join(root, `${createHash("sha256").update(key).digest("hex")}.blob`);
  };
  const prepare = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe local storage directory");
  };
  return {
    provider: "filesystem",
    getUploadLocator(objectId) {
      const storageKey = `filesystem:${objectId}`;
      pathFor(storageKey);
      return { storageProvider: "filesystem", storageKey };
    },
    async upload({ file, objectId, deadlineAt }) {
      const locator = this.getUploadLocator(objectId);
      const destination = pathFor(locator.storageKey);
      const checkDeadline = () => {
        if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now())
          throw new Error("The upload reservation expired. Try uploading again.");
      };
      checkDeadline();
      if (file.size > cloudDocumentMaxBytes) throw new Error("Document exceeds 8 MiB");
      await prepare();
      const temporary = join(root, `${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(new Uint8Array(await file.arrayBuffer()));
        await handle.sync();
        checkDeadline();
        // Hard-link publication is atomic and refuses to replace an existing object.
        await link(temporary, destination);
      } finally {
        await handle.close();
        await unlink(temporary).catch(() => undefined);
      }
      return locator;
    },
    async getReadUrl(key) {
      pathFor(key);
      return readUrl(key);
    },
    async read(key) {
      const path = pathFor(key);
      await prepare();
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe local storage object");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > cloudDocumentMaxBytes)
          throw new Error("Invalid local storage object");
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
    async delete(key) {
      const path = pathFor(key);
      await prepare();
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

export function getFilesystemStorage() {
  const { root, secret, siteUrl } = localStorageConfiguration();
  return createFilesystemStorage(root, (key) => {
    const expires = Date.now() + 60_000;
    const query = new URLSearchParams({
      key,
      expires: String(expires),
      signature: signLocalStorage(secret, "read", key, expires),
    });
    return `${siteUrl}/api/local-storage?${query}`;
  });
}

export async function localStorageRequest(request: Request) {
  try {
    const { secret, siteUrl } = localStorageConfiguration();
    if (new URL(request.url).origin !== siteUrl) return new Response("Not found", { status: 404 });
    const query = new URL(request.url).searchParams;
    const key = query.get("key") ?? "";
    const action = request.method === "DELETE" ? "delete" : "read";
    if (
      !verifyLocalStorage(
        secret,
        action,
        key,
        Number(query.get("expires")),
        query.get("signature") ?? ""
      )
    )
      return new Response("Not found", { status: 404 });
    const storage = getFilesystemStorage();
    if (action === "delete") {
      await storage.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(await storage.read(key), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Access-Control-Allow-Origin": "*",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
