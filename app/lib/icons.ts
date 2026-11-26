/**
 * The addresses the page links its icons at. The Worker answers them (`app/lib/branding.server.ts`): the deployment's
 * own icon when `BRAND_ICON_URL` names one, else the drawing in `public/` (`favicon.svg`, `apple-touch-icon.png`).
 * A browser keeps a tab's icon under the icon's address in a store of its own, apart from its HTTP cache, and Safari
 * never asks again, so a new drawing under the old address stays unseen by every browser that showed the old one. The
 * links carry `ICON_VERSION`: bump it whenever the drawing in `public/` changes.
 */
const ICON_VERSION = "1";

/** What the Worker serves under `/brand/` (`serveBrand`). */
export const BRAND_PATHS = {
  theme: "/brand/theme.css",
  icon: "/brand/icon",
  touchIcon: "/brand/apple-touch-icon",
  manifest: "/brand/manifest.webmanifest",
} as const;

/** The tab's icon, and a mail notification's. */
export const FAVICON_HREF = `${BRAND_PATHS.icon}?v=${ICON_VERSION}`;

/** The icon Safari puts on the Home Screen. */
export const APPLE_TOUCH_ICON_HREF = `${BRAND_PATHS.touchIcon}?v=${ICON_VERSION}`;

/** The web app's manifest: the workspace's name and icon. */
export const MANIFEST_HREF = BRAND_PATHS.manifest;

/** The deployment's accent and icon, laid over app.css. */
export const BRAND_STYLESHEET_HREF = BRAND_PATHS.theme;
