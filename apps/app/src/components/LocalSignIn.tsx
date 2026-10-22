import { createSignal, Show } from "solid-js";
import { authClient } from "~/lib/auth";
import { localSignInReturnTo } from "~/lib/local-sign-in";

export default function LocalSignIn() {
  const [creating, setCreating] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      const result = creating()
        ? await authClient.signUp.email({
            email,
            password,
            name: String(data.get("name") ?? "Local developer"),
          })
        : await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message ?? "Sign-in failed");
      window.location.assign(localSignInReturnTo(window.location.search));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
      setPending(false);
    }
  };
  return (
    <form class="local-sign-in" onSubmit={(event) => void submit(event)}>
      <p class="eyebrow">Local workspace</p>
      <p class="local-sign-in-note">
        Accounts and documents stay on this computer. Use a test password.
      </p>
      <Show when={creating()}>
        <label for="local-name">Name</label>
        <input id="local-name" name="name" autocomplete="name" required maxlength={100} />
      </Show>
      <label for="local-email">Email</label>
      <input id="local-email" name="email" type="email" autocomplete="username" required />
      <label for="local-password">Password</label>
      <input
        id="local-password"
        name="password"
        type="password"
        autocomplete={creating() ? "new-password" : "current-password"}
        minlength={12}
        required
      />
      <Show when={error()}>
        <p class="error-message" role="alert">
          {error()}
        </p>
      </Show>
      <button class="button-primary" type="submit" disabled={pending()}>
        {pending() ? "Opening workspace…" : creating() ? "Create local account" : "Sign in locally"}
      </button>
      <button
        class="text-link"
        type="button"
        disabled={pending()}
        onClick={() => {
          setCreating(!creating());
          setError("");
        }}
      >
        {creating() ? "Use an existing local account" : "Create a local test account"}
      </button>
    </form>
  );
}
