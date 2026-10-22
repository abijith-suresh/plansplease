import { createSignal, Show } from "solid-js";
import { getErrorMessage } from "~/lib/documents";

export default function DocumentUpload(props: {
  onUploaded(title: string): void;
  onUnauthorized(): void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const [file, setFile] = createSignal<File>();
  const [title, setTitle] = createSignal("");
  const chooseFile = (value: File | undefined) => {
    setError("");
    if (value && (!/\.(html|planview)$/i.test(value.name) || value.size > 8 * 1024 * 1024)) {
      setFile(undefined);
      setError("Choose an HTML file or .planview bundle up to 8 MiB.");
      return;
    }
    setFile(value);
    if (value) setTitle(value.name.replace(/\.(html|planview)$/i, "").slice(0, 200));
  };
  const upload = async (event: SubmitEvent) => {
    event.preventDefault();
    const selected = file();
    if (!selected || pending()) return;
    setPending(true);
    setError("");
    try {
      const data = new FormData();
      data.set("title", title().trim());
      const contentType = selected.name.toLowerCase().endsWith(".planview")
        ? "application/vnd.planview.bundle"
        : "text/html";
      data.set("file", new File([selected], selected.name, { type: contentType }));
      const response = await fetch("/api/documents/upload", { method: "POST", body: data });
      if (response.status === 401) {
        props.onUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(await getErrorMessage(response));
      props.onUploaded(title().trim());
      setExpanded(false);
      setFile(undefined);
      setTitle("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The document could not be uploaded.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section class="document-upload" aria-label="Upload a document">
      <button
        class="button-secondary"
        type="button"
        aria-expanded={expanded()}
        aria-controls="document-upload-form"
        disabled={pending()}
        onClick={() => setExpanded(!expanded())}
      >
        {expanded() ? "Close upload" : "Upload document"}
      </button>
      <Show when={expanded()}>
        <form
          id="document-upload-form"
          class="upload-form"
          onSubmit={(event) => void upload(event)}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: The native file input provides the keyboard equivalent for drag and drop. */}
          <div
            class="upload-drop-area"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!pending())
                chooseFile(
                  event.dataTransfer?.files.length === 1 ? event.dataTransfer.files[0] : undefined
                );
            }}
          >
            <label for="document-file">
              Drop an HTML file or artifact bundle here, or choose a file
            </label>
            <input
              id="document-file"
              type="file"
              accept=".html,.planview"
              disabled={pending()}
              onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
            />
            <p class="page-note">
              {file() ? file()!.name : "Up to 8 MiB. Use the CLI to upload an artifact folder."}
            </p>
          </div>
          <label for="document-upload-title">Title</label>
          <input
            id="document-upload-title"
            class="search-input"
            value={title()}
            required
            maxlength={200}
            disabled={pending()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
          <button
            class="button-primary"
            type="submit"
            disabled={pending() || !file() || !title().trim()}
          >
            {pending() ? "Uploading…" : "Save document"}
          </button>
          <Show when={error()}>
            <p class="error-message" role="alert">
              {error()}
            </p>
          </Show>
        </form>
      </Show>
    </section>
  );
}
