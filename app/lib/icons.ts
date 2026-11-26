/**
 * The addresses the page links its icons at. A browser keeps a tab's icon under the icon's
 * address in a store of its own, apart from its HTTP cache, and Safari never asks again, so a new
 * drawing under the old `/favicon.svg` stays unseen by every browser that showed the old one. The
 * links carry `ICON_VERSION`: bump it whenever `favicon.svg` or `apple-touch-icon.png` changes.
 * The files keep their names; a query reaches the same file.
 */
const ICON_VERSION = "1";

/** The tab's icon, and a mail notification's. */
export const FAVICON_HREF = `/favicon.svg?v=${ICON_VERSION}`;

/** The icon Safari puts on the Home Screen. */
export const APPLE_TOUCH_ICON_HREF = `/apple-touch-icon.png?v=${ICON_VERSION}`;
