import { Meta, Title } from "@solidjs/meta";
import { createEffect, createSignal, onMount } from "solid-js";

import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";
import { consentRedirectUrl } from "~/lib/oauth-consent";

export default function ConsentMcp() {
  const session = authClient.useSession();
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");

  onMount(() => setQuery(window.location.search.slice(1)));

  createEffect(() => {
    if (!query() || session().isPending || typeof window === "undefined") return;
    if (session().error) return;
    if (session().data) {
      document.cookie = clearAuthAttemptCookie;
      return;
    }
    if (hasAuthAttemptCookie(document.cookie)) {
      window.location.replace("/auth/problem?mcp=1");
    } else {
      window.location.replace(`/auth/login?oauth_query=${encodeURIComponent(query())}`);
    }
  });

  const decide = async (accept: boolean) => {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ accept, oauth_query: query() }),
        credentials: "same-origin",
      });
      const data = (await response.json()) as unknown;
      const redirectUrl = consentRedirectUrl(data);
      if (!response.ok || !redirectUrl) {
        const message =
          typeof data === "object" && data !== null && "message" in data ? data.message : undefined;
        throw new Error(typeof message === "string" ? message : "Consent failed");
      }
      window.location.assign(redirectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Consent failed");
      setPending(false);
    }
  };

  const scopes = () => new URLSearchParams(query()).get("scope")?.split(" ") ?? [];
  return (
    <>
      <Title>Authorize cloud agent | plansplease</Title>
      <Meta name="referrer" content="no-referrer" />
      <main class="signed-out-page">
        <p class="eyebrow">plansplease · cloud agents</p>
        <h1>Authorize cloud access</h1>
        {session().error && (
          <p role="alert">Could not check your session. Refresh this page to try again.</p>
        )}
        {query() ? (
          <>
            <p>An agent is requesting access to your account. It may:</p>
            <ul>
              <li>List and read your cloud documents</li>
              <li>Upload HTML documents</li>
              <li>Delete your documents</li>
            </ul>
            <p>Requested permissions: {scopes().join(", ")}</p>
            <p>Uploaded files have public URLs during development.</p>
            <button
              class="button button-primary"
              type="button"
              disabled={pending() || session().isPending || !session().data}
              onClick={() => void decide(true)}
            >
              {pending() ? "Authorizing…" : "Allow access"}
            </button>
            <button
              class="button"
              type="button"
              disabled={pending() || session().isPending || !session().data}
              onClick={() => void decide(false)}
            >
              Deny
            </button>
          </>
        ) : (
          <p role="alert">Invalid authorization request.</p>
        )}
        {error() && <p role="alert">{error()}</p>}
      </main>
    </>
  );
}
