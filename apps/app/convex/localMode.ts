// Shared by Convex and the app. Local accounts and storage must never activate
// from a browser-supplied flag or against a hosted Convex deployment.
export function isLoopbackOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function isLocalDevelopment(env: Record<string, string | undefined>): boolean {
  return (
    env["PLANVIEW_LOCAL"] === "true" &&
    env["NODE_ENV"] !== "production" &&
    isLoopbackOrigin(env["SITE_URL"]) &&
    isLoopbackOrigin(env["CONVEX_CLOUD_URL"] ?? env["CONVEX_URL"] ?? env["VITE_CONVEX_URL"])
  );
}

export function isFilesystemKey(key: string, ownerId?: string): boolean {
  const prefix = ownerId === undefined ? "filesystem:" : `filesystem:${ownerId}:`;
  return (
    key.startsWith(prefix) &&
    key.length <= 512 &&
    /^filesystem:[A-Za-z0-9_-]{1,200}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      key
    ) &&
    (ownerId === undefined || /^[a-f0-9-]{36}$/.test(key.slice(prefix.length)))
  );
}
