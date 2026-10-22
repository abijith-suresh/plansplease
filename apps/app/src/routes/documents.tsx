import { Meta, Title } from "@solidjs/meta";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import AppShell from "~/components/AppShell";
import DocumentUpload from "~/components/DocumentUpload";
import DocumentActions from "~/components/DocumentActions";
import { docsUrl } from "~/lib/docs-url";
import Icon from "~/components/Icon";
import {
  formatBytes,
  formatRelativeDate,
  type DocumentRecord,
  getErrorMessage,
} from "~/lib/documents";
import {
  documentsStore,
  ensureDocumentsSubscription,
  loadMoreDocuments,
} from "~/lib/documents-live";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Documents() {
  const { session, redirectToSignIn, userName } = useWorkspaceAuth();
  const documents = () => documentsStore.documents;
  const status = () => documentsStore.status;
  const [deletingId, setDeletingId] = createSignal("");
  const [pendingDeleteId, setPendingDeleteId] = createSignal("");
  const [deleteError, setDeleteError] = createSignal("");
  const [actionMessage, setActionMessage] = createSignal("");
  const [query, setQuery] = createSignal("");
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  createEffect(() => {
    const currentSession = session();

    if (!currentSession.isPending && currentSession.data) ensureDocumentsSubscription();
  });

  const isReady = () => status() === "ready";

  const normalizedQuery = () => query().trim().toLowerCase();
  const filteredDocuments = createMemo(() => {
    const needle = normalizedQuery();
    if (!needle) return documents();
    return documents().filter((document) => document.title.toLowerCase().includes(needle));
  });

  onCleanup(() => {
    disposed = true;
    if (feedbackTimer) clearTimeout(feedbackTimer);
  });

  const pageCountLabel = (count: number) =>
    documentsStore.hasMore
      ? `${count} documents loaded`
      : `${count} ${count === 1 ? "document" : "documents"}`;

  const pageLede = () => {
    if (status() === "error") return "";
    if (!isReady()) return "Checking workspace…";
    return pageCountLabel(documents().length);
  };

  const isFiltering = () => normalizedQuery().length > 0;
  const listCount = () => {
    if (isFiltering()) return `${filteredDocuments().length} of ${documents().length}`;
    return !isReady() && documents().length === 0
      ? "…"
      : `${documents().length}${documentsStore.hasMore ? "+" : ""}`;
  };

  const showActionMessage = (message: string) => {
    setActionMessage(message);
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => setActionMessage(""), 2600);
  };

  const cancelDelete = (id: string) => {
    if (deletingId()) return;
    setPendingDeleteId("");
    queueMicrotask(() => window.document.getElementById(`document-actions-${id}`)?.focus());
  };

  const documentHref = (id: string) => `/api/documents/${encodeURIComponent(id)}`;

  const copyDocumentLink = async (document: DocumentRecord) => {
    if (typeof window === "undefined" || !navigator.clipboard) {
      showActionMessage("Copying links is not available in this browser.");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        new URL(documentHref(document._id), window.location.origin).href
      );
      showActionMessage(`Link copied for ${document.title}.`);
    } catch {
      showActionMessage("The link could not be copied.");
    }
  };

  const removeDocument = async (document: DocumentRecord) => {
    const focusedControl = window.document.activeElement;
    const focusedRow = focusedControl?.closest(".document-row");
    let deleted = false;
    setDeleteError("");
    setDeletingId(document._id);

    try {
      const response = await fetch(documentHref(document._id), { method: "DELETE" });

      if (response.status === 401) {
        redirectToSignIn();
        return;
      }

      if (!response.ok) throw new Error(await getErrorMessage(response));

      deleted = true;
      showActionMessage(`${document.title} deleted.`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "The document could not be deleted.");
    } finally {
      setDeletingId("");
      setPendingDeleteId("");
      queueMicrotask(() => {
        if (disposed || !focusedRow) return;
        const currentFocus = window.document.activeElement;
        // A removed confirmation control falls back to the body. Preserve any
        // other control the user focused while the deletion request was pending.
        if (
          !focusedRow.contains(currentFocus) &&
          !(currentFocus === window.document.body && !focusedControl?.isConnected)
        )
          return;
        window.document
          .getElementById(deleted ? "main-content" : `document-actions-${document._id}`)
          ?.focus();
      });
    }
  };

  return (
    <Show
      when={!session().isPending && session().data}
      fallback={
        <main class="auth-loading" aria-live="polite">
          <Show
            when={!session().error}
            fallback={<p role="alert">Could not check your session. Refresh to try again.</p>}
          >
            <span class="signal-dot" aria-hidden="true" />
            Opening your workspace…
          </Show>
        </main>
      }
    >
      <Title>Documents | plansplease</Title>
      <Meta
        name="description"
        content="Open, copy a link, or delete the HTML pages saved in your plansplease workspace."
      />
      <AppShell active="documents" userName={userName}>
        <div class="page-content">
          <header class="page-header">
            <div>
              <h1>Documents</h1>
              <p class="page-lede">{pageLede()}</p>
            </div>
            <input
              class="search-input"
              type="search"
              placeholder="Filter by title…"
              aria-label={
                documentsStore.hasMore
                  ? "Filter loaded documents by title"
                  : "Filter documents by title"
              }
              name="title"
              autocomplete="off"
              spellcheck={false}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
            />
          </header>

          <DocumentUpload
            onUploaded={(title) => showActionMessage(`${title} uploaded.`)}
            onUnauthorized={redirectToSignIn}
          />

          <section class="documents-list" aria-labelledby="documents-list-title">
            <div class="list-header">
              <h2 id="documents-list-title">All documents</h2>
              <span class="list-count">{listCount()}</span>
            </div>
            <Show
              when={status() !== "error" || documents().length > 0}
              fallback={
                <p class="error-message" role="alert">
                  {documentsStore.error}
                </p>
              }
            >
              <Show
                when={documents().length > 0}
                fallback={
                  <div class="empty-state">
                    <Show when={isReady()} fallback={<p>Loading documents…</p>}>
                      <span class="empty-icon" aria-hidden="true">
                        <Icon name="file" size={24} />
                      </span>
                      <h2>No documents yet</h2>
                      <p>Upload an HTML page or connect your agent to save one.</p>
                      <div class="empty-actions">
                        <a class="button-primary" href={docsUrl("getting-started/")}>
                          Connect your agent
                        </a>
                      </div>
                    </Show>
                  </div>
                }
              >
                <Show
                  when={filteredDocuments().length > 0}
                  fallback={
                    <div class="empty-state">
                      <p>
                        No pages match "{normalizedQuery()}". Try a different word or clear the
                        filter.
                      </p>
                    </div>
                  }
                >
                  <For each={filteredDocuments()}>
                    {(document) => (
                      <article
                        class="document-row"
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && pendingDeleteId() === document._id)
                            cancelDelete(document._id);
                        }}
                      >
                        <div class="document-details">
                          <a
                            class="document-title"
                            href={documentHref(document._id)}
                            target="_blank"
                            rel="noreferrer"
                            title={document.title}
                          >
                            {document.title}
                          </a>
                          <small>
                            {formatRelativeDate(document.createdAt)} ·{" "}
                            {formatBytes(document.sizeBytes)}
                          </small>
                        </div>
                        <div class="document-actions">
                          <Show
                            when={pendingDeleteId() === document._id}
                            fallback={
                              <DocumentActions
                                id={document._id}
                                title={document.title}
                                onCopy={() => void copyDocumentLink(document)}
                                onDelete={() => setPendingDeleteId(document._id)}
                                disabled={deletingId() === document._id}
                              />
                            }
                          >
                            <span class="delete-confirm" role="alert">
                              <span class="confirm-label">Delete?</span>
                              <button
                                class="button-danger"
                                type="button"
                                aria-label={`Confirm deletion of ${document.title}`}
                                disabled={deletingId() === document._id}
                                onClick={() => void removeDocument(document)}
                              >
                                {deletingId() === document._id ? "Deleting…" : "Delete"}
                              </button>
                              <button
                                class="icon-button"
                                type="button"
                                aria-label={`Cancel deleting ${document.title}`}
                                title="Cancel"
                                ref={(element) => queueMicrotask(() => element.focus())}
                                disabled={deletingId() === document._id}
                                onClick={() => cancelDelete(document._id)}
                              >
                                <svg
                                  aria-hidden="true"
                                  fill="none"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  width="16"
                                  xmlns="http://www.w3.org/2000/svg"
                                >
                                  <path
                                    d="M18 6 6 18M6 6l12 12"
                                    stroke="currentColor"
                                    stroke-linecap="round"
                                    stroke-width="1.7"
                                  />
                                </svg>
                              </button>
                            </span>
                          </Show>
                        </div>
                      </article>
                    )}
                  </For>
                </Show>
              </Show>
            </Show>
          </section>

          <Show when={documents().length > 0 && documentsStore.hasMore}>
            <div class="list-footer">
              <span class="page-note">
                {isFiltering() ? "Filtering loaded documents" : "More documents available"}
              </span>
              <button
                class="button-secondary"
                type="button"
                disabled={documentsStore.loadingMore}
                onClick={loadMoreDocuments}
              >
                {documentsStore.loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          </Show>
          <Show when={status() === "error" && documents().length > 0}>
            <p class="error-message" role="alert">
              {documentsStore.error}
            </p>
          </Show>

          <Show when={deleteError()}>
            <p class="error-message" role="alert">
              {deleteError()} Try refreshing the page.
            </p>
          </Show>

          <div class="action-message" role="status" aria-live="polite">
            {actionMessage()}
          </div>
        </div>
      </AppShell>
    </Show>
  );
}
