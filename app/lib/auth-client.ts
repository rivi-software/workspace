/**
 * Better Auth in the browser, for what only the browser can do: a passkey's prompt (`navigator.credentials`,
 * through the passkey plugin) and the authenticator app's enrolment in Settings → Account. Everything else about a
 * sign-in is a form post the server handles (`/login`, `/two-factor`). A plain module: the pages import it.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient(), twoFactorClient()],
});

/** Whether this browser can make and use a passkey at all. */
export const passkeysSupported = (): boolean =>
  typeof PublicKeyCredential !== "undefined" &&
  typeof navigator !== "undefined" &&
  "credentials" in navigator;

/** The words for a passkey prompt that did not end in a credential, by the error the browser threw. */
export const passkeyProblem = (name: string): string => {
  switch (name) {
    case "NotAllowedError": {
      return "The passkey prompt was cancelled or took too long. Try again.";
    }

    case "InvalidStateError": {
      return "This passkey is already registered here.";
    }

    case "SecurityError": {
      return "This address cannot use passkeys: open the workspace at its own address.";
    }

    default: {
      return "The passkey did not go through. Try again, or use your password.";
    }
  }
};
