import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { ChevronRight, Download, FolderOpen, Link2Off } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";

import { AuthShell, authCardClass } from "~/components/auth-shell";
import { RiviMark } from "~/components/brand";
import { KindIcon } from "~/components/drive/icons";
import { FilePreview } from "~/components/drive/preview";
import {
  Button,
  Empty,
  Field,
  Notice,
  Timestamp,
  buttonClass,
  inputClass,
} from "~/components/ui";
import { createDb } from "~/db";
import { formatSize, sharedFileHref, sharedHref } from "~/lib/drive/drive";
import type { SharedRow } from "~/lib/drive/drive";
import { sharedPage, sharedPagePost } from "~/lib/drive/links.server";
import type { SharedPage } from "~/lib/drive/links.server";
import { stringOrNull } from "~/lib/guards";

// What a form post sends back (`sharedPagePost`): the step to show and what went wrong. A node id could look like a
// number to the router's decoder, so every value is coerced back to a string.
const searchSchema = z.object({
  n: z.coerce.string().optional(),
  step: z.coerce.string().optional(),
  error: z.coerce.string().optional(),
});

// Anyone can call this without a session: whatever arrives is read as strings, or not at all.
const getShared = createServerFn()
  .validator((d: { token: string; n?: string }) => ({
    token: stringOrNull(d?.token) ?? "",
    n: stringOrNull(d?.n) || undefined,
  }))
  .handler(async ({ data }): Promise<{ appName: string; page: SharedPage }> => {
    const page = await sharedPage(
      env,
      createDb(env.DB),
      getRequest(),
      data.token,
      data.n ?? null
    );

    if (!page) {
      throw notFound();
    }

    return { appName: env.APP_NAME, page };
  });

const Locked = ({
  appName,
  subtitle,
  children,
}: {
  appName: string;
  subtitle: string;
  children: ReactNode;
}) => (
  <AuthShell appName={appName} subtitle={subtitle}>
    {children}
  </AuthShell>
);

const SharedList = ({
  token,
  rows,
  allowDownload,
}: {
  token: string;
  rows: SharedRow[];
  allowDownload: boolean;
}) => (
  <div className="@container">
    <div className="border-line text-subtle flex h-8 items-center gap-3 border-b px-4 text-xs font-medium">
      <span className="w-4" />
      <span className="flex-1">Name</span>
      <span className="hidden w-24 @xl:block">Modified</span>
      <span className="w-16 text-right">Size</span>
      <span className="w-6" />
    </div>
    <ul aria-label="Contents">
      {rows.map((row) => (
        <li
          key={row.id}
          className="border-line hover:bg-hover flex h-10 items-center gap-3 border-b px-4 text-base"
        >
          <KindIcon
            kind={row.kind}
            name={row.name}
            contentType={row.contentType}
            className="h-4 w-4"
          />
          <a
            href={sharedHref(token, row.id)}
            className="text-fg min-w-0 flex-1 truncate"
          >
            {row.name}
          </a>
          <Timestamp
            iso={row.updatedAt}
            className="text-subtle hidden w-24 text-sm @xl:block"
          />
          <span className="tnum text-subtle w-16 text-right text-sm">
            {row.kind === "file" ? formatSize(row.size) : "–"}
          </span>
          <span className="flex w-6 justify-end">
            {row.kind === "file" && allowDownload && (
              <a
                href={sharedFileHref(token, row.id, true)}
                className="text-muted hover:bg-hover hover:text-fg inline-flex h-6 w-6 items-center justify-center rounded-md"
                aria-label={`Download ${row.name}`}
                title="Download"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

const SharedView = ({
  token,
  page,
  appName,
}: {
  token: string;
  page: OpenPage;
  appName: string;
}) => {
  const { node, root, crumbs, rows, allowDownload } = page;

  const crumbHref = (id: string) =>
    sharedHref(token, id === root.id ? null : id);

  let content: ReactNode;

  if (node.kind === "file") {
    content = (
      <FilePreview
        src={sharedFileHref(token, node.id)}
        download={allowDownload ? sharedFileHref(token, node.id, true) : null}
        name={node.name}
        contentType={node.contentType}
        size={node.size}
      />
    );
  } else if (rows.length) {
    content = (
      <SharedList token={token} rows={rows} allowDownload={allowDownload} />
    );
  } else {
    content = (
      <Empty
        icon={<FolderOpen className="h-4 w-4" />}
        title="This folder is empty"
      >
        Nothing has been put here yet.
      </Empty>
    );
  }

  return (
    <div className="bg-bg flex min-h-dvh flex-col">
      <header className="border-line flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <RiviMark className="text-[22px]" />
        <span className="text-base font-medium">{appName}</span>
        <span className="text-muted ml-auto truncate text-sm">
          Shared by {page.sharedBy}
          {page.expiresAt && (
            <>
              {" · until "}
              <Timestamp iso={page.expiresAt} relative={false} />
            </>
          )}
        </span>
      </header>
      <div className="border-line flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-1 text-base"
        >
          {crumbs.map((c) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <a
                href={crumbHref(c.id)}
                className="text-muted hover:text-fg max-w-48 truncate"
              >
                {c.name}
              </a>
              <ChevronRight className="text-faint h-3 w-3 shrink-0" />
            </span>
          ))}
          <span
            className="text-fg flex min-w-0 items-center gap-2 font-medium"
            aria-current="page"
          >
            <KindIcon
              kind={node.kind}
              name={node.name}
              contentType={node.contentType}
              className="h-4 w-4 shrink-0"
            />
            <span className="truncate">{node.name}</span>
          </span>
        </nav>
        {node.kind === "file" && (
          <span className="tnum text-subtle shrink-0 text-sm">
            {formatSize(node.size)}
          </span>
        )}
        {node.kind === "file" && allowDownload && (
          <a
            href={sharedFileHref(token, node.id, true)}
            className={buttonClass("primary", "md")}
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        )}
      </div>
      <main className="min-h-0 flex-1">{content}</main>
      {!allowDownload && (
        <footer className="border-line text-subtle border-t px-4 py-2 text-sm">
          Downloads are off for this link: what can be shown here can be viewed,
          nothing more.
        </footer>
      )}
    </div>
  );
};

const SharedPageView = () => {
  const { appName, page } = Route.useLoaderData();
  const { token } = Route.useParams();
  const { step, error } = Route.useSearch();

  if (page.state === "throttled") {
    return (
      <Locked appName={appName} subtitle="A shared link">
        <Notice tone="error">
          Too many attempts from here. Wait 15 minutes, then try again.
        </Notice>
      </Locked>
    );
  }

  if (page.state === "password") {
    return (
      <Locked appName={appName} subtitle="A shared link">
        <form method="post" className={authCardClass}>
          <input type="hidden" name="intent" value="password" />
          <p className="text-muted text-base">
            This link is protected. Enter its password to open it.
          </p>
          {error === "password" && (
            <Notice tone="error">That password is not right.</Notice>
          )}
          {error === "throttled" && (
            <Notice tone="error">
              Too many wrong passwords. Wait 15 minutes, then try again.
            </Notice>
          )}
          <Field label="Password">
            <input
              name="password"
              type="password"
              className={inputClass}
              autoComplete="off"
              autoFocus
              required
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
          >
            Open
          </Button>
        </form>
      </Locked>
    );
  }

  if (page.state === "invite") {
    return (
      <Locked appName={appName} subtitle="Shared with you">
        {step === "code" ? (
          <div className={authCardClass}>
            <form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="code" />
              <p className="text-muted text-base">
                We sent a code to {page.email}. It works for 10 minutes.
              </p>
              {error === "code" && (
                <Notice tone="error">
                  That code is not right, or it has expired.
                </Notice>
              )}
              {error === "codes" && (
                <Notice tone="error">
                  Too many codes in the last hour. Use the last one, or wait a
                  while.
                </Notice>
              )}
              <Field label="Code">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  maxLength={8}
                  className={inputClass}
                  autoFocus
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                className="w-full justify-center"
              >
                Confirm
              </Button>
            </form>
            <form method="post">
              <input type="hidden" name="intent" value="send-code" />
              <button
                type="submit"
                className="text-accent text-sm hover:underline"
              >
                Send a new code
              </button>
            </form>
          </div>
        ) : (
          <form method="post" className={authCardClass}>
            <input type="hidden" name="intent" value="send-code" />
            <p className="text-muted text-base">
              This was shared with {page.email}. To open it, confirm that is
              you: we mail a code to that address.
            </p>
            {error === "throttled" && (
              <Notice tone="error">
                Too many attempts from here. Wait 15 minutes.
              </Notice>
            )}
            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
            >
              Email me a code
            </Button>
          </form>
        )}
      </Locked>
    );
  }

  return <SharedView token={token} page={page} appName={appName} />;
};

/** A link that opens nothing: never there, revoked, expired, or no longer shared. It never says which. */
const LinkGone = () => (
  <AuthShell appName="Workspace" subtitle="A shared link">
    <div className={authCardClass}>
      <div className="text-md flex items-center gap-2 font-medium">
        <Link2Off className="text-subtle h-4 w-4" />
        This link does not work
      </div>
      <p className="text-muted text-base">
        It may have expired or been turned off, or what it shared is no longer
        there. Ask the person who shared it for a new link.
      </p>
    </div>
  </AuthShell>
);

/**
 * A folder or file shared outside the workspace (#2836), for whoever holds the link: no session, no workspace
 * navigation, nothing above the shared node. The gate is `openLink` (`access.server.ts`), through `sharedPage`. The
 * page navigates with plain links and posts plain forms to itself, so nothing here calls a server function from the
 * browser: everything a visitor reaches is under `/s/`.
 */
export const Route = createFileRoute("/s/$token")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ n: search.n }),
  loader: ({ params, deps }) =>
    getShared({ data: { token: params.token, n: deps.n } }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.page.state === "open"
            ? `${loaderData.page.node.name} · ${loaderData.appName}`
            : (loaderData?.appName ?? "Workspace"),
      },
      // The token is the address: no search engine keeps it, and no page on another site learns it. `same-origin`,
      // not `no-referrer`: under that a browser sends `Origin: null` with the page's own posts, and one without
      // `Sec-Fetch-Site` (Safari before 16.4) would be refused by the post check (`sameOriginPost`).
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "same-origin" },
    ],
  }),
  server: {
    handlers: {
      // The password and an invite's code, as classic form posts: they work without JavaScript.
      POST: async ({ request, params }) =>
        sharedPagePost(
          env,
          createDb(env.DB),
          request,
          params.token,
          await request.formData()
        ),
    },
  },
  component: SharedPageView,
  notFoundComponent: LinkGone,
});

type OpenPage = Extract<SharedPage, { state: "open" }>;
