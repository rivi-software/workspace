import {
  BuildMeta,
  useChunkErrorRecovery,
} from "@rivi-software/deploy-watch/react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { RiviMark } from "~/components/brand";

import { THEME_COLORS, themeInitScript } from "../components/theme";

import appCss from "../app.css?url";

const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="en" className="h-full" suppressHydrationWarning>
    <head>
      {/* Runs before paint so the first frame already has the right theme. */}
      <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      <HeadContent />
      <BuildMeta />
    </head>
    <body className="bg-bg text-fg h-full antialiased">
      {children}
      <Scripts />
    </body>
  </html>
);

const ErrorShell = ({
  message,
  details,
  stack,
}: {
  message: string;
  details: string;
  stack?: string;
}) => (
  <main className="mx-auto max-w-2xl p-10">
    <RiviMark className="mb-6 text-[28px]" />
    <h1 className="text-xl font-semibold">{message}</h1>
    <p className="text-muted mt-2 text-base">{details}</p>
    <a
      href="/mail"
      className="text-accent mt-4 inline-block text-base underline underline-offset-2"
    >
      Back to Mail
    </a>
    {stack && (
      <pre className="border-line bg-sidebar mt-6 overflow-x-auto rounded-lg border p-4 text-xs">
        <code>{stack}</code>
      </pre>
    )}
  </main>
);

const NotFoundPage = () => (
  <ErrorShell
    message="Not found"
    details="The page you asked for does not exist or was removed."
  />
);

const ErrorPage = ({ error }: ErrorComponentProps) => {
  const dev = import.meta.env.DEV && error instanceof Error;

  // A chunk a deploy removed: nothing while the page reloads onto the new build (CORE-1169).
  if (useChunkErrorRecovery(error)) {
    return null;
  }

  return (
    <ErrorShell
      message="Something went wrong"
      details={dev ? error.message : "An unexpected error occurred."}
      stack={dev ? error.stack : undefined}
    />
  );
};

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // `viewport-fit=cover`: on a phone the page runs under the status bar and the home
      // indicator, and keeps clear of them itself (`safe-area-inset-*` in app.css).
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: "Workspace" },
      // The browser's chrome and the status bar in the canvas colour of the system's reading;
      // `syncThemeColor` (theme.tsx) sets both to the chosen theme's once the client knows it.
      {
        name: "theme-color",
        media: "(prefers-color-scheme: light)",
        content: THEME_COLORS.light,
      },
      {
        name: "theme-color",
        media: "(prefers-color-scheme: dark)",
        content: THEME_COLORS.dark,
      },
      // Added to the Home Screen from Safari or Chrome, the workspace opens as an app of its own,
      // without the browser's bars (#3529); Workspace for iPhone and Android is the same page
      // in a web view (apps/workspace-mobile). The status bar stays the system's, in the
      // `theme-color` above with text that reads on it: `black-translucent` would put white text
      // over the light canvas.
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Workspace" },
      { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
  errorComponent: ErrorPage,
  notFoundComponent: NotFoundPage,
});
