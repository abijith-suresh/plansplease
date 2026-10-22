import { Meta, Title } from "@solidjs/meta";
import { createEffect, createSignal, onMount } from "solid-js";

import { authClient } from "~/lib/auth";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";

type SessionTokenResponse = { token?: unknown; error?: unknown };

const isLoopbackCallback = (value: string) => {
  try {
    const callback = new URL(value);
    return (
      callback.protocol === "http:" &&
      callback.hostname === "127.0.0.1" &&
      callback.port.length > 0 &&
      callback.username === "" &&
      callback.password === "" &&
      callback.pathname === "/callback" &&
      callback.search === "" &&
      callback.hash === ""
    );
  } catch {
    return false;
  }
};

export default function AuthorizeCli() {
  const session = authClient.useSession();
  const [callbackUrl, setCallbackUrl] = createSignal("");
  const [state, setState] = createSignal("");
  const [isValidRequest, setIsValidRequest] = createSignal(false);
  const [isAuthorizing, setIsAuthorizing] = createSignal(false);
  const [error, setError] = createSignal("");

  onMount(() => {
    const query = new URLSearchParams(window.location.search);
    const callback = query.get("redirect_uri") ?? "";
    const stateValue = query.get("state") ?? "";
    const valid = isLoopbackCallback(callback) && /^[A-Za-z0-9_-]{43}$/.test(stateValue);

    setCallbackUrl(callback);
    setState(stateValue);
    setIsValidRequest(valid);
  });

  createEffect(() => {
    const currentSession = session();

    if (typeof window === "undefined" || !isValidRequest() || currentSession.isPending) return;
    if (currentSession.error) return;

    if (currentSession.data) {
      document.cookie = clearAuthAttemptCookie;
      return;
    }

    if (hasAuthAttemptCookie(document.cookie)) {
      window.location.replace("/auth/problem");
      return;
    }
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.replace(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  });

  const authorize = async () => {
    setError("");
    setIsAuthorizing(true);

    try {
      const response = await fetch("/api/cli/session", {
        method: "POST",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json()) as SessionTokenResponse;

      if (!response.ok || typeof body.token !== "string" || body.token.length === 0) {
        throw new Error(
          typeof body.error === "string" ? body.error : "CLI sign-in could not be completed."
        );
      }

      const callback = new URL(callbackUrl());
      callback.hash = new URLSearchParams({ state: state(), token: body.token }).toString();
      window.location.replace(callback.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "CLI sign-in could not be completed.");
      setIsAuthorizing(false);
    }
  };

  const userName = () => {
    const user = session().data?.user;
    return user?.name || user?.email || "your account";
  };

  return (
    <>
      <Title>Authorize CLI | plansplease</Title>
      <Meta name="referrer" content="no-referrer" />
      <main class="panel-page">
        <p class="eyebrow">plansplease · local CLI</p>
        <h1>Authorize this computer</h1>
        {session().error && (
          <p role="alert">Could not check your session. Refresh this page to try again.</p>
        )}
        <p class="panel-lede">
          The plansplease CLI on this computer is requesting permission to upload HTML pages to your
          workspace as {userName()}.
        </p>
        {isValidRequest() ? (
          <div class="panel-actions">
            <button
              class="button-primary"
              type="button"
              disabled={isAuthorizing() || session().isPending || !session().data}
              onClick={() => void authorize()}
            >
              {isAuthorizing() ? "Authorizing…" : "Authorize local CLI"}
            </button>
            <a class="text-link" href="/documents">
              Cancel
            </a>
          </div>
        ) : (
          <p class="error-message" role="alert">
            This sign-in request is invalid. Return to the CLI and try again.
          </p>
        )}
        {error() ? (
          <p class="error-message" role="alert">
            {error()}
          </p>
        ) : null}
      </main>
    </>
  );
}
