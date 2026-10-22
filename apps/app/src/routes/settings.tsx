import { Meta, Title } from "@solidjs/meta";
import { Show, createSignal } from "solid-js";

import AppShell from "~/components/AppShell";
import Icon from "~/components/Icon";
import { useWorkspaceAuth } from "~/lib/workspace-auth";

export default function Settings() {
  const { session, signOut, user, userInitial, userName } = useWorkspaceAuth();
  const [signOutError, setSignOutError] = createSignal("");
  const [isSigningOut, setIsSigningOut] = createSignal(false);

  const handleSignOut = async () => {
    setSignOutError("");
    setIsSigningOut(true);

    try {
      await signOut();
    } catch {
      setSignOutError("Sign out failed. Try again.");
      setIsSigningOut(false);
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
      <Title>Settings | plansplease</Title>
      <Meta name="description" content="Your plansplease account settings." />
      <AppShell active="settings" userName={userName}>
        <div class="page-content settings-content">
          <header class="page-header">
            <div>
              <h1>Settings</h1>
              <p class="page-lede">Manage your account.</p>
            </div>
          </header>

          <section class="card onboarding-card" aria-labelledby="settings-account-title">
            <h2 id="settings-account-title">Account</h2>
            <div class="settings-account">
              <span class="profile-avatar">
                {user()?.image ? (
                  <img src={user()?.image ?? ""} alt="" width="56" height="56" />
                ) : (
                  <span>{userInitial()}</span>
                )}
              </span>
              <div>
                <strong>{userName()}</strong>
                <span class="stat-meta">{user()?.email}</span>
                <span class="stat-meta">Workspace account</span>
              </div>
            </div>
          </section>

          <section class="card onboarding-card" aria-labelledby="settings-session-title">
            <h2 id="settings-session-title">Session</h2>
            <div class="settings-actions">
              <button
                class="button-secondary"
                type="button"
                disabled={isSigningOut()}
                onClick={() => void handleSignOut()}
              >
                <Icon name="log-out" />
                <span>{isSigningOut() ? "Signing out…" : "Sign out"}</span>
              </button>
              <Show when={signOutError()}>
                <p class="error-message" role="alert">
                  {signOutError()}
                </p>
              </Show>
            </div>
          </section>
        </div>
      </AppShell>
    </Show>
  );
}
