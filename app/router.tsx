import {
  followNewBuild,
  recoverFromChunkError,
  startDeployWatch,
} from "@rivi-software/deploy-watch";
import {
  captureClientException,
  initPostHog,
} from "@rivi-software/posthog-tanstack-start/browser";
import { getPostHogBrowserConfig } from "@rivi-software/posthog-tanstack-start/start";
import {
  createRouter,
  parseSearchWith,
  stringifySearchWith,
} from "@tanstack/react-router";

import { isSharedPath } from "./lib/drive/drive";
import { posthogOptions } from "./lib/posthog-config";
import { routeTree } from "./routeTree.gen";

/** Reports a route error, unless it was a chunk a deploy removed and the page is reloading onto the new build. */
const reportUnlessReloading = async (cause: unknown) => {
  // A check that fails reports the error all the same, rather than losing it to an unhandled rejection.
  const reloading = await recoverFromChunkError(cause).catch(() => false);

  if (!reloading) {
    captureClientException(cause);
  }
};

export const getRouter = () => {
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    // Every search param here is a string (a folder, a search term, an id). The default parser reads JSON, which
    // turns a search for "2026" into a number and sends the browser through a redirect; keep what was typed.
    parseSearch: parseSearchWith((value) => value),
    stringifySearch: stringifySearchWith(String),
    // The PostHog browser settings come from the Worker vars once per document, before the client hydrates. The SDK
    // tracks errors only (`posthogOptions`), and never on a link's public page (`/s/`): that visitor is not one of
    // the workforce, and gets no PostHog cookie or storage.
    dehydrate: () => ({ posthog: getPostHogBrowserConfig() }),
    hydrate: ({ posthog }) => {
      if (!isSharedPath(window.location.pathname)) {
        initPostHog(posthog, posthogOptions);
      }
    },
    // Render and loader errors caught by a route's error boundary (the root ErrorPage). A chunk a deploy
    // removed is no fault: the page reloads onto the new build instead (CORE-1169).
    defaultOnCatch: (error) => {
      void reportUnlessReloading(error);
    },
  });

  // A tab open across a deploy learns of the new build; its next move to another page loads it whole
  // (CORE-1169, `@rivi-software/deploy-watch`), and the console's notice offers the reload.
  if (typeof window !== "undefined") {
    startDeployWatch();
    followNewBuild(router);
  }

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
