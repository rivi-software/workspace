import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { useShortcuts } from "~/components/keyboard";
import { MailLeavingProvider } from "~/components/mail-leaving";
import { MailList } from "~/components/mail-list";
import { MailSelectionProvider } from "~/components/mail-selection";
import { SectionError } from "~/components/section-error";
import { cx } from "~/components/ui";
import { isJsonObject, numberOr } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import { FOLDER_LABEL } from "~/lib/mail/folders";
import { parsePreferences } from "~/lib/mail/preferences";
import type { MailListData } from "~/lib/mail/reads";
import { listPage } from "~/lib/mail/reads.server";
import { appContext } from "~/lib/request.server";
import { serverFnFetch } from "~/lib/server-fn-fetch";

// The router keeps search values as strings; `q` and `page` can look like numbers, so they are coerced back.
const searchSchema = z.object({
  folder: z.string().optional(),
  q: z.coerce.string().optional(),
  page: z.coerce.string().optional(),
  label: z.string().optional(),
});

type ListDeps = z.infer<typeof searchSchema>;

const getMail = createServerFn()
  .validator((d: ListDeps) => d)
  .handler(
    async ({ data }): Promise<MailListData & { layout: "split" | "full" }> => {
      const { db, env, user } = await appContext();

      // The page size is the person's preference: the console never asks for another.
      const list = await listPage(db, env, user, {
        folder: data.folder,
        label: data.label,
        q: data.q,
        page: data.page,
      });

      return { ...list, layout: parsePreferences(user.preferencesJson).layout };
    }
  );

/** The inbox's unread count from the console layout's loader, for the tab title. */
export const inboxUnreadOf = (
  matches: readonly { routeId: string; loaderData?: unknown }[]
): number => {
  const app = matches.find((m) => m.routeId === "/_app")?.loaderData;
  const counts = isJsonObject(app) ? app.counts : null;

  return numberOr(isJsonObject(counts) ? counts.inboxUnread : null, 0);
};

/** The list the mail layout loaded, from the route matches, for a conversation's tab title. */
export const listOf = (
  matches: readonly { routeId: string; loaderData?: unknown }[]
): MailListData | undefined => {
  const match = matches.find((m) => m.routeId === "/_app/mail");

  // SAFETY: the match of the "/_app/mail" route holds that route's loader data, which is what `getMail` returns.
  return match?.loaderData as MailListData | undefined;
};

/** What the tab calls the list: its label, a search, or its folder. */
const listName = (data: MailListData | undefined): string => {
  if (!data) {
    return "Mail";
  }

  if (data.label) {
    return data.label.name;
  }

  return data.q ? "Search" : FOLDER_LABEL[data.folder];
};

/** "(3) Inbox · Workspace": the unread count first, as mail tabs do. */
export const mailTitle = (
  data: MailListData | undefined,
  unread: number,
  page?: string
): string => {
  const name = page ?? listName(data);

  return `${unread ? `(${unread}) ` : ""}${name} · Workspace`;
};

const MailLayout = () => {
  const data = Route.useLoaderData();
  const location = useLocation();
  const navigate = useNavigate();
  const isIndex = /^\/mail\/?$/u.test(location.pathname);

  const activeId =
    location.pathname.match(/^\/mail\/t\/(?<id>[^/]+)/u)?.[1] ?? null;

  const split = data.layout === "split";

  // With a conversation open, j and k walk to the next and the previous one in the list.
  const neighbour = (delta: 1 | -1) => {
    if (!activeId) {
      return;
    }

    const i = data.threads.findIndex((t) => t.id === activeId);
    const next = data.threads[i + delta];

    if (i === -1 || !next) {
      return;
    }

    void navigate({
      to: "/mail/t/$threadId",
      params: { threadId: next.id },
      search: (prev) => prev,
    });
  };

  useShortcuts([
    { keys: "j", run: () => neighbour(1) },
    { keys: "k", run: () => neighbour(-1) },
    { keys: "]", run: () => neighbour(1) },
    { keys: "[", run: () => neighbour(-1) },
  ]);

  return (
    <MailLeavingProvider>
      <MailSelectionProvider>
        <div className="flex min-h-0 flex-1 print:block">
          <section
            aria-label="Conversations"
            className={cx(
              "flex min-w-0 flex-col",
              isIndex ? "flex-1" : "hidden",
              split &&
                !isIndex &&
                "xl:flex xl:w-[400px] xl:flex-none xl:border-r xl:border-line 2xl:w-[440px]",
              split &&
                isIndex &&
                "xl:w-[400px] xl:flex-none xl:border-r xl:border-line 2xl:w-[440px]"
            )}
          >
            <MailList data={data} activeId={activeId} navigation={!activeId} />
          </section>
          <section
            aria-label="Conversation"
            className={cx(
              "flex min-w-0 flex-1 flex-col",
              isIndex && (split ? "max-xl:hidden" : "hidden")
            )}
          >
            <Outlet />
          </section>
        </div>
      </MailSelectionProvider>
    </MailLeavingProvider>
  );
};

/** What takes the list's place when it cannot load and there is no list to keep (#3547): another folder, a first load. */
const MailError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="Mail didn't load" />
);

export const Route = createFileRoute("/_app/mail")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({
    folder: search.folder,
    q: search.q,
    page: search.page,
    label: search.label,
  }),
  // The list stays when the minute's refresh cannot load it again (#3547).
  loader: (run) =>
    keepShown(run, () => getMail({ data: run.deps, fetch: serverFnFetch })),
  head: ({ loaderData, matches }) => ({
    meta: [{ title: mailTitle(loaderData, inboxUnreadOf(matches)) }],
  }),
  component: MailLayout,
  errorComponent: MailError,
});
