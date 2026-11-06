import { useHydrated } from "@tanstack/react-router";

/**
 * A phone app that wraps the workspace in a web view names itself in the web view's user agent,
 * `RIVIWorkspaceApp/<version>`, so a page can leave out what the web view cannot do: the browser's
 * own notifications, and passkeys, which WebKit and the Android WebView take from a browser alone.
 * Such an app bundles no copy of the workspace, so what it reads here is a contract with every
 * installed version: add to it, never rename it.
 */
export const MOBILE_APP_AGENT = "RIVIWorkspaceApp/";

/** Whether this page runs in the app, read from the user agent; false on the server. */
export const inMobileApp = (): boolean =>
  typeof navigator !== "undefined" &&
  navigator.userAgent.includes(MOBILE_APP_AGENT);

/** Whether this page runs in the app: false until the client has hydrated, as the server cannot know. */
export const useMobileApp = (): boolean => {
  const hydrated = useHydrated();

  return hydrated && inMobileApp();
};
