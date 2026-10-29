import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import "./style.css";

type Snapshot = {
  id: string;
  generation: string;
  size: number;
  createdAt: number;
  pinned: boolean;
  expiresAt: number | null;
  unpinnedExpiresAt: number;
};
type Page = { snapshots: Snapshot[]; nextAfter?: string };
type Usage = {
  pinnedBytes: number;
  pinnedCount: number;
  bytes: number;
  documentBytes: number;
  metadataBytes: number;
  documentCount: number;
  quotaBytes: number;
  retentionMilliseconds: number;
};
type Status = {
  profile: string;
  appDataDir: string;
  previewOrigin: string;
  managerOrigin: string;
  pid: number;
  state: "running";
};
type ProfileCatalog = {
  current: { name: string; appDataDir: string };
  scope: "managed" | "isolated_override";
  profiles: { name: string; selected: boolean; present: boolean; daemon: "not_checked" }[];
  limited: boolean;
  skippedEntries: number;
};
type ProfilePlan = {
  target: { name: string; present: boolean };
  launchCommand: string;
  openCommand: string;
  createCommand: string;
  message: string;
};
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
  const [profiles, setProfiles] = createSignal<ProfileCatalog>();
  const [profilesError, setProfilesError] = createSignal("");
  const [profileName, setProfileName] = createSignal("");
  const [profilePlan, setProfilePlan] = createSignal<ProfilePlan>();
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
  const loadProfiles = async () => {
    try {
      setProfiles(await request<ProfileCatalog>("profiles", { limit: 50 }));
      setProfilesError("");
    } catch (cause) {
      setProfilesError(describe(cause));
    }
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
          `${describe(cause)} The import response was not confirmed. Refresh the snapshot list before selecting the file again.`
        );
      }
      setFile(undefined);
      fileInput.value = "";
      setNotice(`Saved ${result.id}. Open it from the snapshot list.`);
      await load(undefined);
    });
  const changePin = (snapshot: Snapshot) => {
    if (
      snapshot.pinned &&
      !window.confirm(
        `Unpin ${snapshot.id}? Original access-based expiry: ${date(snapshot.unpinnedExpiresAt)}. ${snapshot.unpinnedExpiresAt < Date.now() ? "It is already expired and may be cleaned promptly." : "Cleanup can remove it after that date."} This does not renew retention.`
      )
    )
      return;
    void work(async () => {
      const result = await request<{ status: string }>(snapshot.pinned ? "unpin" : "pin", {
        id: snapshot.id,
        generation: snapshot.generation,
      });
      await load(cursor());
      if (result.status !== "updated")
        throw new Error(`${result.status}: Refresh and select an available generation.`);
      setNotice(
        snapshot.pinned
          ? "Unpinned. Original access-based expiry restored; expired copies may be cleaned promptly."
          : "Pinned for offline use within your 1 GiB quota. Manual deletion is still allowed. Keep a separate backup."
      );
    });
  };
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
          `${result.status}: ${result.message ?? "The selected snapshot changed or is still being read."} Recovery: ${result.recovery}. ${result.recovery === "clean" ? `Run plansplease --profile ${status()?.profile ?? "default"} clean for bounded recovery.` : "Refresh the snapshot list before retrying."}`
        );
    });
  return (
    <div class="workspace">
      <header class="masthead">
        <a
          class="brand"
          href="/"
          onClick={(event) => event.preventDefault()}
          aria-label="plansplease local manager"
        >
          plansplease
        </a>
        <span class="local-label">
          <span class="dot" /> Local manager
        </span>
      </header>
      <main>
        <div class="intro">
          <div>
            <h1>Local snapshots</h1>
          </div>
          <div class="profile-label">
            <span>Profile</span>
            <strong>{status()?.profile ?? (busy() ? "Connecting…" : "Unavailable")}</strong>
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
                <h2>{busy() ? "Connecting…" : "Connect to the local manager"}</h2>
                <Show when={!busy()}>
                  <p>
                    Run <code>plansplease --profile {status()?.profile ?? "NAME"} ui</code> in your
                    terminal. Add <code>--open</code> to open it yourself.
                  </p>
                  <p class="muted">
                    Browser access lasts up to 8 hours. Reloading requires a new link.
                  </p>
                </Show>
              </section>
            </Show>
          }
        >
          <section class="runtime">
            <div>
              <h2>Profile and session</h2>

              <details
                class="profile-controls"
                onToggle={(event) => {
                  if (event.currentTarget.open && !profiles()) void work(loadProfiles);
                }}
              >
                <summary>Profiles &amp; storage</summary>
                <p>
                  Each profile has separate storage, a process and a browser session. Preparing a
                  command does not switch profiles or stop existing preview links.
                </p>
                <details class="advanced">
                  <summary>Advanced details</summary>
                  <p>
                    Current process: {status()?.pid}. This manager can stop only {status()?.profile}
                    .
                  </p>
                  <dl class="profile-facts">
                    <div>
                      <dt>Storage</dt>
                      <dd>
                        <code>{status()?.appDataDir}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Preview origin</dt>
                      <dd>
                        <code>{status()?.previewOrigin}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Manager origin</dt>
                      <dd>
                        <code>{status()?.managerOrigin}</code>
                      </dd>
                    </div>
                  </dl>
                  <p>
                    Run commands without PLANVIEW_APP_DATA_DIR, PLANVIEW_DATA_DIR or
                    PLANVIEW_RUNTIME_DIR overrides. Omit --open to print a link instead of opening a
                    browser.
                  </p>
                </details>
                <button
                  type="button"
                  class="quiet"
                  disabled={busy()}
                  onClick={() => void work(loadProfiles)}
                >
                  Refresh profiles
                </button>
                <Show when={profilesError()}>
                  <p role="alert">{profilesError()}</p>
                </Show>
                <Show when={profiles()?.scope === "isolated_override"}>
                  <p class="fine-print">
                    Custom storage/runtime override: only this location is shown. Use a terminal
                    with the intended environment to discover or launch other profiles.
                  </p>
                </Show>
                <Show when={profiles()?.scope === "managed"}>
                  <label class="profile-picker">
                    Choose a profile
                    <select
                      aria-label="Choose a profile"
                      value={
                        profiles()?.profiles.some((profile) => profile.name === profileName())
                          ? profileName()
                          : ""
                      }
                      onChange={(event) => {
                        setProfileName(event.currentTarget.value);
                        setProfilePlan(undefined);
                      }}
                      disabled={busy()}
                    >
                      <option value="">Select a profile</option>
                      <For each={profiles()?.profiles ?? []}>
                        {(profile) => (
                          <option value={profile.name}>
                            {profile.name}
                            {profile.selected ? " · current" : ""}
                            {profile.present ? "" : " · not created"}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <label class="profile-picker">
                    Or use a new name
                    <input
                      aria-label="New profile name"
                      maxlength="32"
                      value={profileName()}
                      onInput={(event) => {
                        setProfileName(event.currentTarget.value);
                        setProfilePlan(undefined);
                      }}
                      placeholder="research"
                      disabled={busy()}
                    />
                  </label>
                  <button
                    type="button"
                    class="quiet"
                    disabled={busy() || !profileName()}
                    onClick={() =>
                      void work(async () => {
                        setProfilePlan(
                          await request<ProfilePlan>("profile-plan", { name: profileName() })
                        );
                      })
                    }
                  >
                    Prepare launch command
                  </button>
                  <p class="fine-print">
                    Offline directory metadata only. Other daemon states are not checked.{" "}
                    {profiles()?.limited
                      ? "Partial list: directory/count bound reached. Enter a known name directly."
                      : ""}{" "}
                    {profiles()?.skippedEntries ?? 0} unsupported entries excluded.
                  </p>
                </Show>
                <Show when={profilePlan()}>
                  {(plan) => (
                    <section class="profile-plan" aria-label="Selected profile launch">
                      <h3>Launch {plan().target.name}</h3>

                      <p>
                        {plan().target.present
                          ? "Existing profile."
                          : "Created when the command runs."}{" "}
                        Run this command in a terminal.
                      </p>
                      <code>{plan().openCommand}</code>
                      <button
                        type="button"
                        class="quiet"
                        onClick={() =>
                          void work(async () => {
                            await navigator.clipboard.writeText(plan().openCommand);
                            setNotice(
                              "Profile launch command copied. Run it deliberately in your terminal. This profile remains running."
                            );
                          })
                        }
                      >
                        Copy profile launch command
                      </button>
                    </section>
                  )}
                </Show>
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
          <div class="desk">
            <section class="collection" aria-labelledby="snapshots-heading">
              <div class="section-heading">
                <div>
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
                Pin a copy for offline use. Unpinned copies expire 30 days after last access.
              </p>
              <Show
                when={page().snapshots.length > 0}
                fallback={
                  <div class="empty shelf-empty">
                    <h3>No snapshots yet.</h3>
                    <p>Import an HTML file or publish from your terminal.</p>
                    <code>plansplease publish ./report.html</code>
                  </div>
                }
              >
                <ol class="snapshot-list">
                  <For each={page().snapshots}>
                    {(snapshot) => (
                      <li>
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
                            <span>·</span>{" "}
                            <span class={snapshot.pinned ? "pin-label" : ""}>
                              {snapshot.pinned
                                ? "Pinned · no automatic expiry"
                                : `Expires ${date(snapshot.expiresAt!)}`}
                            </span>
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
                            class="quiet"
                            disabled={busy()}
                            aria-label={`${snapshot.pinned ? "Unpin" : "Pin"} ${snapshot.id}`}
                            onClick={() => changePin(snapshot)}
                          >
                            {snapshot.pinned ? "Unpin" : "Pin"}
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
              <Show when={cursor() !== undefined || page().nextAfter}>
                <div class="pagination">
                  <Show when={cursor() !== undefined}>
                    <button
                      type="button"
                      class="quiet"
                      disabled={busy()}
                      onClick={() => void work(() => load(undefined))}
                    >
                      Back to first page
                    </button>
                  </Show>
                  <span>Up to 50 per page</span>
                  <Show when={page().nextAfter}>
                    <button
                      type="button"
                      class="quiet"
                      disabled={busy()}
                      onClick={() => void work(() => load(page().nextAfter))}
                    >
                      Next page →
                    </button>
                  </Show>
                </div>
              </Show>
            </section>
            <aside>
              <section class="import-panel" aria-labelledby="import-heading">
                <h2 id="import-heading">Import HTML</h2>
                <p>Save a standalone HTML file as a local snapshot.</p>
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
                  {busy() ? "Working…" : "Import snapshot"}
                </button>
                <p class="fine-print">
                  Standalone HTML · up to 10 MiB
                  <br />
                  No cloud upload. Folders use the CLI.
                </p>
              </section>
              <section class="storage-panel" aria-labelledby="storage-heading">
                <h2 id="storage-heading">Storage</h2>
                <p class="storage-total">
                  {size(usage()?.bytes ?? 0)} <span>of 1 GiB</span>
                </p>
                <progress
                  aria-label="Logical storage used"
                  max={usage()?.quotaBytes ?? 1}
                  value={usage()?.bytes ?? 0}
                />
                <p>
                  Unpinned: 30 days since last access.
                  <br />
                  Pinned copies survive automatic cleanup and count toward this limit.
                </p>
                <dl>
                  <div>
                    <dt>Pinned ({usage()?.pinnedCount ?? 0})</dt>
                    <dd>{size(usage()?.pinnedBytes ?? 0)}</dd>
                  </div>
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
                  Full quota can refuse new saves. Pins are never silently evicted. Pinning is not a
                  backup. Temporary files and disk allocation are excluded.
                </p>
              </section>
            </aside>
          </div>
        </Show>
      </main>
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
      <h2 id="delete-heading">Delete local snapshot?</h2>
      <code>{props.snapshot.id}</code>
      <p>
        This removes one immutable local snapshot, including a pinned copy. Its preview link stops
        working. Any cloud copy is kept separately.
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
