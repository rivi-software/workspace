import { THEME_COLORS } from "~/components/theme";
import { BRAND_PATHS } from "~/lib/icons";
import {
  contrast,
  formatColor,
  lightness,
  parseColor,
  withLightness,
} from "~/lib/mail/colors";
import type { Rgba } from "~/lib/mail/colors";

/**
 * A deployment's own brand, from two vars, so a workspace deployed without a fork (the Deploy to Cloudflare button)
 * can look like its owner's: `BRAND_COLOR`, the accent, and `BRAND_ICON_URL`, the icon. The Worker serves everything
 * that depends on them under `/brand/`, and the pages link there whatever the vars hold, so no loader reads them and a
 * page renders the same on the server and in the browser. Empty vars answer the drawing in `public/` and the
 * stylesheet of app.css alone.
 */

const BRAND_PREFIX = "/brand/";

/** The default drawing, in `public/`. A query carries the page's `ICON_VERSION` on to it. */
const DEFAULT_ICON = "/favicon.svg";
const DEFAULT_TOUCH_ICON = "/apple-touch-icon.png";

/** The canvases of app.css (`--bg`), which the accent is held against. */
const { light: LIGHT_BG, dark: DARK_BG } = THEME_COLORS;

/** Ink for text on the accent (`--accent-fg`), whichever reads better. */
const ON_ACCENT = ["#ffffff", "#08090a"] as const;

/** A var change lands with a deploy; a tab picks it up within five minutes. */
const CACHE = "public, max-age=300";

/** What the brand reads of the Worker's `Env`, as strings: the vars are typed as wrangler.jsonc's literals. */
export interface BrandVars {
  APP_NAME: string;
  BRAND_COLOR: string;
  BRAND_ICON_URL: string;
}

export const isBrandPath = (pathname: string): boolean =>
  pathname.startsWith(BRAND_PREFIX);

const solid = (hex: string): Rgba => {
  const c = parseColor(hex);

  if (!c) {
    throw new Error(`not a colour: ${hex}`);
  }

  return c;
};

/** `BRAND_COLOR` as an opaque colour, or null when it is empty or no colour CSS reads. */
export const brandColor = (
  env: Pick<BrandVars, "BRAND_COLOR">
): Rgba | null => {
  const c = parseColor(env.BRAND_COLOR);

  return c && c.a >= 1 ? c : null;
};

/** `BRAND_ICON_URL` when it is an https address (http on localhost, for local development), else null. */
export const brandIcon = (
  env: Pick<BrandVars, "BRAND_ICON_URL">
): string | null => {
  const raw = env.BRAND_ICON_URL.trim();

  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";

    return url.protocol === "https:" || (url.protocol === "http:" && local)
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** The colour moved in lightness, one step at a time, until it reads on `ground` at `ratio` or cannot move further. */
const readableOn = (
  c: Rgba,
  ground: Rgba,
  ratio: number,
  direction: 1 | -1,
  from = lightness(c)
): Rgba => {
  let target = from;
  let out = target === lightness(c) ? c : withLightness(c, target);

  while (contrast(out, ground) < ratio && target > 0 && target < 1) {
    target = Math.min(1, Math.max(0, target + 0.02 * direction));
    out = withLightness(c, target);
  }

  return out;
};

const onAccent = (accent: Rgba): string => {
  const [white, ink] = ON_ACCENT;

  return contrast(accent, solid(white)) >= contrast(accent, solid(ink))
    ? white
    : ink;
};

interface Accent {
  accent: string;
  hover: string;
  fg: string;
}

/**
 * The accent of each theme from one colour, as app.css's own green is: on the light canvas the colour itself, darkened
 * until links read at 4.5:1; on the dark canvas a bright reading of the same hue (at least the lightness of app.css's
 * signal green), raised until it reads at 6:1.
 */
export const accents = (c: Rgba): Record<"light" | "dark", Accent> => {
  const light = readableOn(c, solid(LIGHT_BG), 4.5, -1);

  const dark = readableOn(
    c,
    solid(DARK_BG),
    6,
    1,
    Math.max(lightness(c), 0.78)
  );

  return {
    light: {
      accent: formatColor(light),
      hover: formatColor(withLightness(light, lightness(light) - 0.03)),
      fg: onAccent(light),
    },
    dark: {
      accent: formatColor(dark),
      hover: formatColor(withLightness(dark, lightness(dark) + 0.04)),
      fg: onAccent(dark),
    },
  };
};

/** The tokens of one theme that carry the accent (app.css), the tints mixed from it as app.css's green ones are. */
const themeTokens = (
  { accent, hover, fg }: Accent,
  ground: string,
  soft: number,
  selected: number,
  peak: string
) =>
  [
    `--accent: ${accent};`,
    `--accent-hover: ${hover};`,
    `--accent-fg: ${fg};`,
    `--accent-soft: color-mix(in oklab, ${accent} ${soft}%, ${ground});`,
    `--bg-selected: color-mix(in oklab, ${accent} ${selected}%, ${ground});`,
    // The default mark's lit bar sits on the ink tile in the light theme and on the paper tile in the dark one.
    `--rivi-mark-peak: ${peak};`,
  ].join(" ");

/**
 * The stylesheet the pages link after app.css: the accent tokens of both themes when `BRAND_COLOR` is set, and the
 * icon in place of the default mark (`BrandMark`) when `BRAND_ICON_URL` is. Empty when neither is.
 */
export const brandStylesheet = (env: BrandVars): string => {
  const rules: string[] = [];
  const color = brandColor(env);

  if (color) {
    const { light, dark } = accents(color);

    rules.push(
      `:root { ${themeTokens(light, "#ffffff", 10, 8, dark.accent)} }`,
      `.dark { ${themeTokens(dark, DARK_BG, 16, 10, light.accent)} }`
    );
  }

  if (brandIcon(env)) {
    rules.push(
      `.brand-mark-default { display: none; }`,
      `.brand-mark-icon { display: inline-block; background-image: url("${BRAND_PATHS.icon}"); }`
    );
  }

  return rules.join("\n");
};

/** The web app's manifest: the workspace's name, and its icon (or the default drawings in `public/icons/`). */
export const brandManifest = (env: BrandVars) => {
  const icon = brandIcon(env);
  const svg = icon !== null && new URL(icon).pathname.endsWith(".svg");

  return {
    name: env.APP_NAME,
    short_name: env.APP_NAME,
    description:
      "Mail, Drive, Calendar, Tasks and an Assistant, on Cloudflare.",
    id: "/",
    start_url: "/mail",
    scope: "/",
    display: "standalone",
    background_color: LIGHT_BG,
    theme_color: LIGHT_BG,
    icons: icon
      ? [{ src: BRAND_PATHS.icon, sizes: svg ? "any" : "512x512" }]
      : [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
    shortcuts: [
      { name: "Mail", url: "/mail" },
      { name: "Drive", url: "/drive" },
      { name: "Calendar", url: "/calendar" },
      { name: "Tasks", url: "/tasks" },
      { name: "Assistant", url: "/assistant" },
    ],
  };
};

/**
 * A redirect, not a copy: the icon stays where its owner keeps it, and the Worker never fetches an address a var
 * names. A browser follows it for a tab's icon, a manifest's and a notification's alike.
 */
const redirect = (location: string) =>
  new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": CACHE },
  });

/** Everything under `/brand/`. */
export const serveBrand = (request: Request, env: BrandVars): Response => {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  switch (url.pathname) {
    case BRAND_PATHS.theme: {
      return new Response(brandStylesheet(env), {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": CACHE,
        },
      });
    }

    case BRAND_PATHS.icon: {
      return redirect(brandIcon(env) ?? `${DEFAULT_ICON}${url.search}`);
    }

    case BRAND_PATHS.touchIcon: {
      return redirect(brandIcon(env) ?? `${DEFAULT_TOUCH_ICON}${url.search}`);
    }

    case BRAND_PATHS.manifest: {
      return Response.json(brandManifest(env), {
        headers: {
          "Content-Type": "application/manifest+json",
          "Cache-Control": CACHE,
        },
      });
    }

    default: {
      return new Response("Not found", { status: 404 });
    }
  }
};
