import { Meta, Title } from "@solidjs/meta";
import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";

import LocalSignIn from "~/components/LocalSignIn";
import { localSignInReturnTo } from "~/lib/local-sign-in";
import Icon from "~/components/Icon";
import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";

export default function Home() {
  const session = authClient.useSession();
  const [localMode, setLocalMode] = createSignal(false);
  const [githubEnabled, setGithubEnabled] = createSignal(true);
  onMount(() => {
    void fetch("/api/local-mode")
      .then((response) => response.json())
      .then((data) => {
        setLocalMode(data.enabled === true);
        setGithubEnabled(data.enabled !== true || data.github === true);
      })
      .catch(() => undefined);
  });

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || currentSession.isPending || currentSession.error) return;
    if (!currentSession.data) {
      if (hasAuthAttemptCookie(document.cookie)) window.location.replace("/auth/problem");
      return;
    }

    document.cookie = clearAuthAttemptCookie;
    window.location.replace(localSignInReturnTo(window.location.search));
  });

  const isSignedOut = createMemo(() => {
    const currentSession = session();
    return !currentSession.isPending && !currentSession.data && !currentSession.error;
  });

  return (
    <>
      <Title>plansplease | Keep the pages your agent makes</Title>
      <Meta name="description" content="Sign in to your plansplease workspace." />
      <Show
        when={isSignedOut()}
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
        <main class="sign-in-panel">
          <div class="sign-in-shell">
            <A class="wordmark" href="/">
              <span class="brand-name">
                <span class="brand-plans">plans</span>
                <span class="brand-please">please</span>
              </span>
            </A>
            <h1>Pages from your agent, in one place.</h1>
            <div class="sign-in-actions">
              <Show when={localMode()}>
                <LocalSignIn />
              </Show>
              <Show when={githubEnabled()}>
                <a class="button-primary" href="/auth/github">
                  <Icon name="github" size={18} />
                  <span>Continue with GitHub</span>
                </a>
              </Show>
            </div>
          </div>
        </main>
      </Show>
    </>
  );
}
