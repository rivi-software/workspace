import { captureClientException } from "@rivi-software/posthog-tanstack-start/browser";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { getRouterInstance } from "@tanstack/react-start";

/** What the router tells a loader of why it runs and for which view (part of its `LoaderFnContext`). */
export interface LoaderRun<Deps> {
  /** A link's preload, a route the page enters, or one it already shows ("stay"). */
  cause: "preload" | "enter" | "stay";
  deps: Deps;
  params: object;
  route: { id: string };
}

/** What the keeper reads of a route's match on the page. */
export interface ShownMatch {
  routeId: string;
  params: object;
  loaderDeps: object;
  loaderData?: unknown;
}

export interface KeepShownOptions {
  /** The matches the page shows: the router's, in the browser. */
  matches?: () => Promise<readonly ShownMatch[]>;
  report?: typeof captureClientException;
}

const routerMatches = async (): Promise<readonly ShownMatch[]> => {
  const router = await getRouterInstance();

  return router.state.matches;
};

/** Whether a match on the page is the view a run loads: the same route, params and deps. */
const showsView = <Deps extends object>(
  match: ShownMatch,
  run: LoaderRun<Deps>
): boolean =>
  match.routeId === run.route.id &&
  JSON.stringify(match.params) === JSON.stringify(run.params) &&
  JSON.stringify(match.loaderDeps) === JSON.stringify(run.deps);

/**
 * A loader's call that answers with what the page shows of its route when loading that view again fails (#3547).
 * The console reloads every loader once a minute and when the tab comes back (`useRefresh` in `_app/route.tsx`), and a
 * route's loader runs again on each move within it. A call that failed then (the network still down after a laptop
 * woke, an answer Start could not read) put the route in its error state and an error page in place of what the
 * person was reading, even though the router still held it.
 *
 * Only a run for a view the page shows (`cause` "stay", the same params and deps) is answered from it, whether the
 * server rendered that view or the browser loaded it, and its failure goes to PostHog. A route the page enters,
 * another folder, page, search or conversation, a redirect (signed out) and a notFound fail as before.
 */
export const keepShown = async <Data, Deps extends object>(
  run: LoaderRun<Deps>,
  load: () => Promise<Data>,
  {
    matches = routerMatches,
    report = captureClientException,
  }: KeepShownOptions = {}
): Promise<Data> => {
  try {
    return await load();
  } catch (error) {
    if (run.cause !== "stay" || isRedirect(error) || isNotFound(error)) {
      throw error;
    }

    const onPage = await matches();
    const shown = onPage.find((match) => showsView(match, run));

    if (shown?.loaderData === undefined) {
      throw error;
    }

    report(error);

    // SAFETY: the match of this route with the same params and deps holds what this loader answered for them.
    return shown.loaderData as Data;
  }
};
