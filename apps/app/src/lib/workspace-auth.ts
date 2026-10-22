import { createEffect } from "solid-js";

import { createDocumentAccountBoundary } from "~/lib/document-account-boundary";
import { authClient } from "~/lib/auth";
import { resetDocumentsSubscription } from "~/lib/documents-live";
import { clearAuthAttemptCookie, hasAuthAttemptCookie } from "~/lib/auth-attempt";
import { completeSignOut, signOutDestination } from "~/lib/sign-out-navigation";

const updateDocumentAccount = createDocumentAccountBoundary(resetDocumentsSubscription);

export function useWorkspaceAuth() {
  const session = authClient.useSession();
  let authRedirectStarted = false;
  let isSigningOut = false;

  const redirectToSignIn = () => {
    if (typeof window === "undefined") return;
    window.location.assign(hasAuthAttemptCookie(document.cookie) ? "/auth/problem" : "/auth/login");
  };

  createEffect(() => {
    const currentSession = session();

    if (currentSession.isPending) return;
    updateDocumentAccount(currentSession.data?.user.id ?? null);

    if (currentSession.data) {
      document.cookie = clearAuthAttemptCookie;
      return;
    }

    if (currentSession.error) return;

    if (!isSigningOut && !authRedirectStarted) {
      authRedirectStarted = true;
      redirectToSignIn();
    }
  });

  const signOut = async () => {
    isSigningOut = true;

    try {
      await completeSignOut({
        signOut: () => authClient.signOut(),
        clearAuthAttempt: () => {
          resetDocumentsSubscription();
          document.cookie = clearAuthAttemptCookie;
        },
        redirect: (destination) => window.location.assign(destination),
        destination: signOutDestination(
          window.location.origin,
          import.meta.env["VITE_PUBLIC_SITE_URL"]
        ),
      });
    } catch (error) {
      isSigningOut = false;
      throw error;
    }
  };

  const user = () => session().data?.user;
  const userName = () => session().data?.user.name || session().data?.user.email || "Workspace";
  const userInitial = () => userName().slice(0, 1).toUpperCase();

  return { session, redirectToSignIn, signOut, userName, userInitial, user };
}
