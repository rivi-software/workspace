import { useEffect, useState } from "react";

/**
 * The token a mailed link carries in its fragment (`/reset-password#<token>`). No request carries a fragment, so
 * the token stays out of Workers Logs; the page reads it once on the client and drops it from the address bar and
 * the history. Null until the page has looked, then the token, or "" for a page opened without one.
 */
export const useLinkToken = (): string | null => {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const fromLink = window.location.hash.replace(/^#/u, "").trim();

    // A second run (React's development double effect) finds the fragment already gone: keep what the first read.
    if (!fromLink) {
      // oxlint-disable-next-line react/set-state-in-effect -- the fragment exists only in the browser, so the page can read it only once it has hydrated
      return setToken((t) => t ?? "");
    }

    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search
    );
    setToken(fromLink);
  }, []);

  return token;
};
