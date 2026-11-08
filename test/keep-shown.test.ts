import { notFound, redirect } from "@tanstack/react-router";
import type { NotFoundError } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { keepShown } from "~/lib/keep-shown";
import type { KeepShownOptions, LoaderRun, ShownMatch } from "~/lib/keep-shown";

interface Deps {
  folder: string;
}

interface List {
  folder: string;
  threads: string[];
}

const inboxList: List = { folder: "inbox", threads: ["th_1", "th_2"] };
const offline = new TypeError("Failed to fetch");

/** The /mail layout as the page shows it: the inbox, loaded on the server and hydrated. */
const shownInbox: ShownMatch = {
  routeId: "/_app/mail",
  params: {},
  loaderDeps: { folder: "inbox" },
  loaderData: inboxList,
};

/** The router's run of the /mail loader. */
const run = (
  cause: LoaderRun<Deps>["cause"],
  folder = "inbox"
): LoaderRun<Deps> => ({
  cause,
  deps: { folder },
  params: {},
  route: { id: "/_app/mail" },
});

/** What a loader's call can fail with: an error, or the router's own redirect and notFound. */
type Failure = Error | Response | NotFoundError;

// A call that fails at once: the keeper awaits it inside its `try`, as it does Start's.
const failing = (failure: Failure) => (): Promise<List> => {
  // oxlint-disable-next-line typescript/only-throw-error -- each kind of Failure may be thrown on its own (oxlint.config.ts allows Response and TanStack's NotFoundError); the rule does not read a union of them
  throw failure;
};

/** A page that shows `matches`, with the reports it would send to PostHog. */
const page = (...matches: ShownMatch[]) => {
  const reported: unknown[] = [];

  const options: KeepShownOptions = {
    matches: () => Promise.resolve(matches),
    report: (error) => {
      reported.push(error);
    },
  };

  return { reported, options };
};

describe("a /mail loader whose reload fails (#3547)", () => {
  it("answers with the list the page shows when the minute's refresh of it fails, and reports why", async () => {
    const { options, reported } = page(shownInbox);

    await expect(
      keepShown(run("stay"), failing(offline), options)
    ).resolves.toBe(inboxList);
    expect(reported).toStrictEqual([offline]);
  });

  it("answers with what loaded when the call works, without reading the page", async () => {
    const fresh: List = { folder: "inbox", threads: ["th_3"] };

    await expect(
      keepShown(run("stay"), () => Promise.resolve(fresh), {
        matches: () => Promise.reject(new Error("not read")),
      })
    ).resolves.toBe(fresh);
  });

  it("fails a move to another folder, so the address and the list never disagree", async () => {
    const { options, reported } = page(shownInbox);

    await expect(
      keepShown(run("stay", "sent"), failing(offline), options)
    ).rejects.toBe(offline);
    expect(reported).toStrictEqual([]);
  });

  it("fails a move to another conversation, whose params differ", async () => {
    const { options } = page({
      routeId: "/_app/mail/t/$threadId",
      params: { threadId: "th_1" },
      loaderDeps: {},
      loaderData: { thread: "th_1" },
    });

    await expect(
      keepShown(
        {
          cause: "stay",
          deps: {},
          params: { threadId: "th_2" },
          route: { id: "/_app/mail/t/$threadId" },
        },
        failing(offline),
        options
      )
    ).rejects.toBe(offline);
  });

  it("fails a page it enters, which shows nothing of that route yet", async () => {
    const { options } = page(shownInbox);

    await expect(
      keepShown(run("enter"), failing(offline), options)
    ).rejects.toBe(offline);
    await expect(
      keepShown(run("preload"), failing(offline), options)
    ).rejects.toBe(offline);
  });

  it("fails when the page shows no data of that route", async () => {
    const { options } = page({ ...shownInbox, loaderData: undefined });

    await expect(
      keepShown(run("stay"), failing(offline), options)
    ).rejects.toBe(offline);
  });

  it("lets a sign-in redirect and a notFound through", async () => {
    const { options, reported } = page(shownInbox);
    const signedOut = redirect({ to: "/login" });
    const gone = notFound();

    await expect(
      keepShown(run("stay"), failing(signedOut), options)
    ).rejects.toBe(signedOut);
    await expect(keepShown(run("stay"), failing(gone), options)).rejects.toBe(
      gone
    );
    expect(reported).toStrictEqual([]);
  });
});
