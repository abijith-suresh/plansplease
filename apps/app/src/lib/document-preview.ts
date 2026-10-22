import { isLocalDevelopment } from "../../convex/localMode.ts";
import { initializeDocumentPreview, readPreviewDocument } from "./document-preview-client.ts";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

const previewContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // Blob documents inherit this policy. Preserve generated inline scripts while
  // the wrapper and its child both have an opaque, sandboxed origin.
  "sandbox allow-scripts allow-modals allow-popups",
  "script-src 'unsafe-inline' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "worker-src blob: https:",
  "frame-src blob: https:",
].join("; ");

export function documentPreviewResponse(readUrl: string, title = "Document") {
  return renderDocumentPreview(readUrl, title);
}

export function localDocumentPreviewResponse(readUrl: string, title = "Document") {
  const url = new URL(readUrl);
  if (
    !isLocalDevelopment(process.env) ||
    url.origin !== process.env["SITE_URL"] ||
    url.pathname !== "/api/local-storage"
  )
    throw new Error("Invalid local preview URL");
  return renderDocumentPreview(readUrl, title, url.origin);
}

function renderDocumentPreview(readUrl: string, title: string, localOrigin?: string) {
  const url = new URL(readUrl);
  if ((!localOrigin && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Document storage returned an invalid preview URL.");
  }
  const serializedUrl = JSON.stringify(url.href).replace(/</g, "\\u003c");
  const safeTitle = escapeHtml(title);
  const script = `(${initializeDocumentPreview.toString()})(${serializedUrl},8388608,${readPreviewDocument.toString()});`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${safeTitle} | plansplease</title>
<style>html,body{height:100%;margin:0;color-scheme:dark}body{background:#0c0c0e;color:#d9d9dc;font-family:ui-sans-serif,sans-serif}iframe{background:#fff;width:100%;height:100%;height:100dvh;border:0;display:block}#preview-state{height:100%;display:grid;place-content:center;justify-items:center;gap:1rem;padding:1.5rem;box-sizing:border-box;text-align:center}p{margin:0;max-width:30rem;font-size:.95rem;line-height:1.5}button{font:inherit;color:inherit;background:transparent;border:1px solid #343439;border-radius:.35rem;padding:.6rem 1rem;min-height:44px;cursor:pointer;touch-action:manipulation}button:hover{border-color:#e5795a}button:focus-visible{outline:2px solid #e5795a;outline-offset:4px}[hidden]{display:none!important}</style></head>
<body><main id="preview-state" role="status" aria-live="polite"><p id="preview-message">Opening document…</p><button id="preview-retry" type="button" hidden>Retry</button><noscript>Enable JavaScript to open this document.</noscript></main>
<iframe id="document-preview" title="Preview of ${safeTitle}" sandbox="allow-scripts allow-modals allow-popups" referrerpolicy="no-referrer" hidden></iframe><script>${script}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Security-Policy": localOrigin
        ? previewContentSecurityPolicy.replace(
            "connect-src https:",
            `connect-src https: ${localOrigin}`
          )
        : previewContentSecurityPolicy,
      "Content-Type": "text/html; charset=utf-8",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
