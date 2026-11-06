import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";

import { useShortcuts } from "~/components/keyboard";
import { MailLeavingProvider } from "~/components/mail-leaving";
import { MailList } from "~/components/mail-list";
import type { MailListData } from "~/components/mail-list";
import { MailSelectionProvider } from "~/components/mail-selection";
import { SectionError } from "~/components/section-error";
import { cx } from "~/components/ui";
import { isJsonObject, numberOr } from "~/lib/guards";
import { keepShown } from "~/lib/keep-shown";
import { parseJsonAddresses } from "~/lib/mail/addresses";
import { FOLDER_LABEL, isFolder } from "~/lib/mail/folders";
import type { Folder } from "~/lib/mail/folders";
import { listLabels } from "~/lib/mail/labels.server";
import {
  countThreads,
  labelsForThreads,
  listThreads,
  pruneExpired,
} from "~/lib/mail/mailbox.server";
import { parsePreferences } from "~/lib/mail/preferences";
import { listScheduled } from "~/lib/mail/schedule.server";
import { listDrafts } from "~/lib/mail/send.server";
import { pruneSpamTokens } from "~/lib/mail/spam.server";
import { participantLabel } from "~/lib/mail/threading";
import { wakeSnoozed } from "~/lib/mail/threads.server";
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

/** The folder a list shows: a label lists the archive, a folder the person typed that does not exist the inbox. */
const listFolder = (
  labelled: boolean,
  requested: string | undefined
): Folder => {
  if (labelled) {
    return "archive";
  }

  return isFolder(requested) ? requested : "inbox";
};

const getMail = createServerFn()
  .validator((d: ListDeps) => d)
  .handler(
    async ({ data }): Promise<MailListData & { layout: "split" | "full" }> => {
      const { db, env, user } = await appContext();
      const prefs = parsePreferences(user.preferencesJson);
      const labels = await listLabels(db, user.id);

      const label = data.label
        ? (labels.find((l) => l.id === data.label) ?? null)
        : null;

      const folder = listFolder(Boolean(label), data.folder);

      const q = data.q ?? "";

      const page = Math.max(
        1,
        Math.min(10_000, Math.floor(Number(data.page) || 1))
      );

      const { pageSize } = prefs;
      // Snoozed threads whose time has come return now (the cron wakes every mailbox's each minute; this makes the
      // page exact); the trash and spam folders shed what is older than 30 days, a batch every few hours, after the
      // response, and the spam filter the words that say nothing.
      await wakeSnoozed(db, new Date(), user.id);
      const pruneKey = `prune:${user.id}`;

      if (!(await env.KV.get(pruneKey))) {
        await env.KV.put(pruneKey, "1", { expirationTtl: 6 * 3600 });
        waitUntil(
          Promise.all([
            pruneExpired(db, env, user.id),
            pruneSpamTokens(db, user.id),
          ])
        );
      }

      const base = {
        folder,
        q,
        page,
        pageSize,
        label,
        labels,
        layout: prefs.layout,
      };

      if ((folder === "drafts" || folder === "scheduled") && !label) {
        const rows =
          folder === "drafts"
            ? await listDrafts(db, user.id)
            : await listScheduled(db, user.id);

        return {
          ...base,
          total: rows.length,
          threads: [],
          drafts: rows.map((d) => ({
            id: d.id,
            to: participantLabel(parseJsonAddresses(d.toJson)),
            subject: d.subject,
            snippet: d.text.replaceAll(/\s+/gu, " ").trim().slice(0, 120),
            updatedAt: d.updatedAt,
            scheduledAt: d.scheduledAt,
            sendError: d.sendError,
          })),
        };
      }

      const options = { folder, q, label: label?.id ?? null };

      const [rows, total] = await Promise.all([
        listThreads(db, user.id, {
          ...options,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        countThreads(db, user.id, options),
      ]);

      const threadLabels = await labelsForThreads(
        db,
        user.id,
        rows.map((t) => t.id)
      );

      return {
        ...base,
        total,
        drafts: [],
        threads: rows.map((t) => ({
          id: t.id,
          subject: t.subject,
          snippet: t.snippet,
          people:
            participantLabel(parseJsonAddresses(t.participantsJson)) || "me",
          count: t.messageCount,
          unread: t.unreadCount > 0,
          starred: t.starred,
          hasAttachments: t.hasAttachments,
          lastMessageAt: t.lastMessageAt,
          folder: t.folder,
          snoozedUntil: t.snoozedUntil,
          muted: t.muted,
          sent: t.sentCount > 0,
          labels: threadLabels.get(t.id) ?? [],
        })),
      };
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
