import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { Composer } from "~/components/composer";
import { ViewHeader } from "~/components/ui";
import { keepShown } from "~/lib/keep-shown";
import { composeData, ComposeNotFound } from "~/lib/mail/compose.server";
import type { ComposeData } from "~/lib/mail/compose.server";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

const searchSchema = z.object({
  draft: z.string().optional(),
  reply: z.string().optional(),
  mode: z.enum(["reply", "all", "forward"]).optional(),
  to: z.coerce.string().optional(),
});

const getCompose = createServerFn()
  .validator((d: z.infer<typeof searchSchema>) => d)
  .handler(async ({ data }): Promise<ComposeData> => {
    const { db, user } = await appContext();

    try {
      return await composeData(db, user, data);
    } catch (error) {
      if (error instanceof ComposeNotFound) {
        throw notFound();
      }

      throw error;
    }
  });

/** The page's title from what the composer starts: a reply, a forward, or a new message. */
const composeTitle = (mode: ComposeData["prefill"]["mode"] | undefined) => {
  if (mode === "reply") {
    return "Reply";
  }

  return mode === "forward" ? "Forward" : "New message";
};

const Compose = () => {
  const data = Route.useLoaderData();
  const { prefill } = data;

  // A new draft, reply or forward gets a composer of its own: the key resets what the last one held.
  const key =
    prefill.draftId ??
    `${prefill.mode}:${prefill.inReplyToId ?? "new"}:${prefill.to}`;

  return (
    <>
      <ViewHeader title={composeTitle(prefill.mode)} />
      <div className="flex-1 overflow-y-auto">
        <Composer
          key={key}
          data={data}
          variant="page"
          className="mx-auto max-w-3xl px-4 py-4"
        />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_app/mail/compose")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    draft: search.draft,
    reply: search.reply,
    mode: search.mode,
    to: search.to,
  }),
  // What the composer started from stays when the minute's refresh cannot load it again (#3547): an error state in
  // its place would take the message being written with it.
  loader: (run) =>
    keepShown(run, () => getCompose({ data: run.deps, fetch: serverFnFetch })),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${composeTitle(loaderData?.prefill.mode)} · Workspace`,
      },
    ],
  }),
  component: Compose,
});
