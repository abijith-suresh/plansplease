import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import "./style.css";

type Snapshot = {
  id: string;
  generation: string;
  size: number;
  createdAt: number;
  expiresAt: number;
};
type Page = { snapshots: Snapshot[]; nextAfter?: string };
type Usage = {
  bytes: number;
  documentBytes: number;
  metadataBytes: number;
  documentCount: number;
  quotaBytes: number;
  retentionMilliseconds: number;
};
type Status = { profile: string; appDataDir: string; previewOrigin: string; pid: number };
type Deletion = { status: string; recovery: string; message?: string };
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
const date = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The operation could not finish.";

function Shelf() {
  let fileInput!: HTMLInputElement;
  let token: string | undefined;
  let launchCode = location.hash.slice(1);
  // Remove the one-use code before any requests or navigation. Session authority
  // stays in this closure, never in cookies, storage, DOM, or the URL.
  history.replaceState(null, "", "/");
  const [connected, setConnected] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal<Status>();
  const [usage, setUsage] = createSignal<Usage>();
  const [page, setPage] = createSignal<Page>({ snapshots: [] });
  const [cursor, setCursor] = createSignal<string>();
  const [file, setFile] = createSignal<File>();
  const [selected, setSelected] = createSignal<Snapshot>();
  const preview = (id: string) => `${status()?.previewOrigin}/${id}`;
  const request = async <T,>(path: string, payload: unknown = {}, upload?: File): Promise<T> => {
    const res = await fetch(`/api/${path}`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": upload ? "application/octet-stream" : "application/json",
        ...(upload ? { "x-planview-filename": encodeURIComponent(upload.name) } : {}),
      },
      body: upload ?? JSON.stringify(payload),
    });
    const value = await res.json();
    if (!res.ok) {
      if (res.status === 401) {
        token = undefined;
        setConnected(false);
      }
      throw new Error(
        typeof value.message === "string" ? value.message : "The local operation was refused."
      );
    }
    return value as T;
  };
  const load = async (after?: string) => {
    const [info, space, snapshots] = await Promise.all([
      request<Status>("status"),
      request<Usage>("usage"),
      request<Page>("list", { limit: 50, ...(after ? { after } : {}) }),
    ]);
    setStatus(info);
    setUsage(space);
    setPage(snapshots);
    setCursor(after);
  };
  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  onMount(() => {
    const connect = () =>
      void work(async () => {
        const code = launchCode || location.hash.slice(1);
        launchCode = "";
        history.replaceState(null, "", "/");
        if (!code)
          throw new Error(
            "Run ui again with the same selected profile for a new one-use launch link. Reloading this page requires a fresh link."
          );
        const session = await request<{ token: string }>("session", { code });
        token = session.token;
        setConnected(true);
        await load();
      });
    window.addEventListener("hashchange", connect);
    onCleanup(() => window.removeEventListener("hashchange", connect));
    connect();
  });
  const importFile = () =>
    work(async () => {
      const source = file();
      if (!source || !/\.html?$/i.test(source.name))
        throw new Error("Choose one .html or .htm file.");
      if (source.size > 10 * 1024 ** 2) throw new Error("The local limit is 10 MiB per HTML file.");
      let result: { id: string };
      try {
        result = await request<{ id: string }>("import", {}, source);
      } catch (cause) {
        setFile(undefined);
        fileInput.value = "";
        throw new Error(
          `${describe(cause)} The import response was not confirmed. Refresh the shelf before selecting the file again.`
        );
      }
      setFile(undefined);
      fileInput.value = "";
      setNotice(`Saved ${result.id}. Open it from the shelf below.`);
      await load(undefined);
    });
  const remove = () =>
    work(async () => {
      const snapshot = selected();
      if (!snapshot) return;
      const result = await request<Deletion>("delete", {
        id: snapshot.id,
        generation: snapshot.generation,
      });
      setSelected(undefined);
      await load();
      if (result.status === "deleted" || result.status === "not_found")
        setNotice("Local snapshot deleted. Cloud copies are independent.");
      else
        setError(
          `${result.status}: ${result.message ?? "The selected snapshot changed or is still being read."} Recovery: ${result.recovery}. ${result.recovery === "clean" ? `Run plansplease --profile ${status()?.profile ?? "default"} clean for bounded recovery.` : "Refresh the shelf before retrying."}`
        );
    });
  return (
    <div class="workspace">
      <header class="masthead">
        <a
          class="brand"
          href="/"
          onClick={(event) => event.preventDefault()}
          aria-label="plansplease local shelf"
        >
          <span class="brand-mark">p.</span> plansplease
        </a>
        <span class="local-label">
          <span class="dot" /> ON THIS COMPUTER
        </span>
      </header>
      <main>
        <div class="intro">
          <div>
            <p class="eyebrow">A PLACE FOR YOUR WORK</p>
            <h1>
              Your local shelf<span>.</span>
            </h1>
            <p class="lede">Keep a moment. Open it again.</p>
          </div>
          <div class="profile-label">
            <span>SELECTED PROFILE</span>
            <strong>{status()?.profile ?? "Connecting…"}</strong>
          </div>
        </div>
        <Show when={error()}>
          <p class="message error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={notice()}>
          <p class="message" role="status">
            {notice()}
          </p>
        </Show>
        <Show when={stopped()}>
          <section class="empty">
            <h2>Manager and previews stopped.</h2>
            <p>
              Your snapshots remain on disk. Run{" "}
              <code>plansplease --profile {status()?.profile ?? "NAME"} ui</code> to return.
            </p>
          </section>
        </Show>
        <Show
          when={connected() && !stopped()}
          fallback={
            <Show when={!stopped()}>
              <section class="empty">
                <span class="section-number">LOCAL ACCESS</span>
                <h2>{busy() ? "Opening your shelf…" : "A fresh link opens the door."}</h2>
                <p>
                  Run <code>plansplease --profile {status()?.profile ?? "NAME"} ui</code> in your
                  terminal. Add <code>--open</code> to open it yourself.
                </p>
                <p class="muted">
                  Browser access lasts up to 8 hours. Reloading requires a new link.
                </p>
              </section>
            </Show>
          }
        >
          <div class="desk">
            <section class="collection" aria-labelledby="snapshots-heading">
              <div class="section-heading">
                <div>
                  <p class="eyebrow">01 / COLLECTION</p>
                  <h2 id="snapshots-heading">
                    Snapshots <span class="count">{usage()?.documentCount ?? 0}</span>
                  </h2>
                </div>
                <button
                  type="button"
                  class="quiet"
                  disabled={busy()}
                  onClick={() => void work(() => load())}
                >
                  Refresh
                </button>
              </div>
              <p class="caption">
                Immutable copies. Opening a preview renews its 30-day retention.
              </p>
              <Show
                when={page().snapshots.length > 0}
                fallback={
                  <div class="empty shelf-empty">
                    <div class="file-outline" aria-hidden="true">
                      +
                    </div>
                    <h3>Nothing on the shelf yet.</h3>
                    <p>Bring in an HTML file, or publish from your terminal.</p>
                    <code>plansplease publish ./report.html</code>
                  </div>
                }
              >
                <ol class="snapshot-list">
                  <For each={page().snapshots}>
                    {(snapshot) => (
                      <li>
                        <div class="snapshot-icon" aria-hidden="true">
                          HTML
                        </div>
                        <div class="snapshot-details">
                          <a
                            class="snapshot-title"
                            href={preview(snapshot.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Snapshot {snapshot.id.slice(0, 7)}
                          </a>
                          <code class="snapshot-id">{snapshot.id}</code>
                          <p>
                            {size(snapshot.size)} <span>·</span> Saved {date(snapshot.createdAt)}{" "}
                            <span>·</span> Expires {date(snapshot.expiresAt)}
                          </p>
                        </div>
                        <div class="row-actions">
                          <a
                            class="button quiet"
                            href={preview(snapshot.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${snapshot.id}`}
                          >
                            Open ↗
                          </a>
                          <button
                            type="button"
                            class="quiet"
                            disabled={busy()}
                            aria-label={`Copy link ${snapshot.id}`}
                            onClick={() =>
                              void work(async () => {
                                await navigator.clipboard.writeText(preview(snapshot.id));
                                setNotice("Preview link copied.");
                              })
                            }
                          >
                            Copy link
                          </button>
                          <button
                            type="button"
                            class="delete quiet"
                            disabled={busy()}
                            aria-label={`Delete ${snapshot.id}`}
                            onClick={() => setSelected(snapshot)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
              <div class="pagination">
                <button
                  type="button"
                  class="quiet"
                  disabled={busy() || cursor() === undefined}
                  onClick={() => void work(() => load(undefined))}
                >
                  Back to first page
                </button>
                <span>Up to 50 per page</span>
                <button
                  type="button"
                  class="quiet"
                  disabled={busy() || !page().nextAfter}
                  onClick={() => void work(() => load(page().nextAfter))}
                >
                  Next page →
                </button>
              </div>
            </section>
            <aside>
              <section class="import-panel" aria-labelledby="import-heading">
                <p class="eyebrow">02 / BRING SOMETHING IN</p>
                <h2 id="import-heading">Save an HTML file.</h2>
                <p>
                  A report, a diagram, a small idea.
                  <br />
                  We keep the exact bytes here.
                </p>
                <label class="file-picker">
                  <span>
                    Choose HTML file <span aria-hidden="true">↗</span>
                  </span>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".html,.htm,text/html"
                    disabled={busy()}
                    aria-label="Choose HTML file"
                    onChange={(event) => setFile(event.currentTarget.files?.[0])}
                  />
                </label>
                <Show when={file()}>
                  <p class="chosen-file">
                    {file()?.name} · {size(file()?.size ?? 0)}
                  </p>
                </Show>
                <button
                  type="button"
                  class="primary"
                  disabled={busy() || !file()}
                  onClick={() => void importFile()}
                >
                  {busy() ? "Working…" : "Save to local shelf"}
                </button>
                <p class="fine-print">
                  Standalone HTML · up to 10 MiB
                  <br />
                  No cloud upload. Folders use the CLI.
                </p>
              </section>
              <section class="storage-panel" aria-labelledby="storage-heading">
                <p class="eyebrow">03 / ROOM TO KEEP</p>
                <h2 id="storage-heading">
                  {size(usage()?.bytes ?? 0)} <span>of 1 GiB</span>
                </h2>
                <progress
                  aria-label="Logical storage used"
                  max={usage()?.quotaBytes ?? 1}
                  value={usage()?.bytes ?? 0}
                />
                <p>
                  30 days since last access.
                  <br />
                  Expired copies are removed during cleanup.
                </p>
                <dl>
                  <div>
                    <dt>Snapshot bytes</dt>
                    <dd>{size(usage()?.documentBytes ?? 0)}</dd>
                  </div>
                  <div>
                    <dt>Metadata charge</dt>
                    <dd>{size(usage()?.metadataBytes ?? 0)}</dd>
                  </div>
                </dl>
                <p class="fine-print">
                  Logical committed storage. Temporary files and disk allocation are excluded.
                </p>
              </section>
            </aside>
          </div>
          <section class="runtime">
            <div>
              <p class="eyebrow">LOCAL PREVIEWS, UNDER YOUR CONTROL</p>
              <p>Preview links stay available after your terminal command exits.</p>
              <details>
                <summary>Profile &amp; storage location</summary>
                <code>{status()?.appDataDir}</code>
                <p>
                  Use <code>plansplease --profile NAME ui</code> for another profile. Profile
                  controls will follow separately.
                </p>
              </details>
            </div>
            <div class="runtime-actions">
              <button
                type="button"
                class="quiet"
                disabled={busy()}
                onClick={() =>
                  void work(async () => {
                    await request("logout");
                    token = undefined;
                    setConnected(false);
                    setNotice("Signed out of this browser session. Previews are still running.");
                  })
                }
              >
                Sign out
              </button>
              <button
                type="button"
                class="stop"
                disabled={busy()}
                onClick={() => {
                  if (
                    window.confirm(
                      "Stop this profile's daemon? Both the manager and all local preview links stop until the daemon starts again."
                    )
                  )
                    void work(async () => {
                      await request("stop");
                      token = undefined;
                      setConnected(false);
                      setStopped(true);
                    });
                }}
              >
                Stop daemon &amp; previews
              </button>
            </div>
          </section>
        </Show>
      </main>
      <footer>
        <span>plansplease / LOCAL EDITION</span>
        <span>Your files. On your computer.</span>
      </footer>
      <Show when={selected()}>
        {(snapshot) => (
          <DeleteDialog
            snapshot={snapshot()}
            busy={busy()}
            onCancel={() => setSelected(undefined)}
            onConfirm={() => void remove()}
          />
        )}
      </Show>
    </div>
  );
}
function DeleteDialog(props: {
  snapshot: Snapshot;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  let dialog!: HTMLDialogElement;
  onMount(() => dialog.showModal());
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!props.busy) props.onCancel();
      }}
      aria-labelledby="delete-heading"
    >
      <p class="eyebrow">SELECTED LOCAL COPY</p>
      <h2 id="delete-heading">Take it off the shelf?</h2>
      <code>{props.snapshot.id}</code>
      <p>
        This removes one immutable local snapshot. Its preview link stops working. Any cloud copy is
        kept separately.
      </p>
      <p class="fine-print">
        Active readers may keep it busy. You will see the result before retrying.
      </p>
      <div class="dialog-actions">
        <button type="button" class="quiet" disabled={props.busy} onClick={props.onCancel}>
          Keep snapshot
        </button>
        <button type="button" class="danger" disabled={props.busy} onClick={props.onConfirm}>
          {props.busy ? "Deleting…" : "Delete local snapshot"}
        </button>
      </div>
    </dialog>
  );
}
const root = document.getElementById("root");
if (root) render(() => <Shelf />, root);
