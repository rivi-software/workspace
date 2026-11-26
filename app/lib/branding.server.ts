/**
 * The workspace's own brand, which an admin sets under Settings → Branding: an accent colour and an icon, so a
 * workspace deployed without a fork can look like its owner's. The colour is a `workspace_settings` row, the icon a
 * file in the `DRIVE` bucket with a row that names its type. The Worker serves everything that depends on them under
 * `/brand/`, and the pages link there whatever is set, so no loader reads them and a page renders the same on the
 * server and in the browser. Nothing set answers the drawing in `public/` and the stylesheet of app.css alone.
 */
import { desc, eq, inArray } from "drizzle-orm";

import { THEME_COLORS } from "~/components/theme";
import type { Database } from "~/db";
import { users, workspaceSettings } from "~/db/schema";
import { BRAND_PATHS } from "~/lib/icons";
import { nowIso } from "~/lib/ids";
import {
  contrast,
  formatColor,
  lightness,
  parseColor,
  withLightness,
} from "~/lib/mail/colors";
import type { Rgba } from "~/lib/mail/colors";

const BRAND_PREFIX = "/brand/";

/** The `workspace_settings` keys: the accent as `#rrggbb`, and the icon's content type (its bytes are in R2). */
const COLOR_KEY = "brand.color";
const ICON_KEY = "brand.icon";

/** Where the icon's bytes are, in the `DRIVE` bucket beside Drive's files and signing's copies. */
const ICON_OBJECT = "branding/icon";

/** What an icon may be: what a tab, a Home Screen and a manifest read. SVG is served sandboxed (`iconResponse`). */
export const ICON_TYPES = [
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/jpeg",
] as const;

type IconType = (typeof ICON_TYPES)[number];

/** An icon is small: a favicon, a Home Screen tile. */
export const MAX_ICON_BYTES = 1024 * 1024;

/** The default drawing, in `public/`. A query carries the page's `ICON_VERSION` on to it. */
const DEFAULT_ICON = "/favicon.svg";
const DEFAULT_TOUCH_ICON = "/apple-touch-icon.png";

/** The canvases of app.css (`--bg`), which the accent is held against. */
const { light: LIGHT_BG, dark: DARK_BG } = THEME_COLORS;

/** Ink for text on the accent (`--accent-fg`), whichever reads better. */
const ON_ACCENT = ["#ffffff", "#08090a"] as const;

/**
 * Every page load asks again, and a brand that has not changed answers 304 (`ETag`), so an admin's change shows on
 * the next page anyone opens; the page that made it swaps its own links at once (`refreshBrandLinks`).
 */
const REVALIDATE = "no-cache";

export const isBrandPath = (pathname: string): boolean =>
  pathname.startsWith(BRAND_PREFIX);

const isIconType = (type: string): type is IconType =>
  ICON_TYPES.some((t) => t === type);

/** The brand as stored: the accent, the icon's type, and when either last changed, which versions what is served. */
export interface Brand {
  color: string | null;
  icon: { type: IconType; version: string } | null;
  version: string;
}

export const readBrand = async (db: Database): Promise<Brand> => {
  const rows = await db
    .select({
      key: workspaceSettings.key,
      value: workspaceSettings.value,
      at: workspaceSettings.updatedAt,
    })
    .from(workspaceSettings)
    .where(inArray(workspaceSettings.key, [COLOR_KEY, ICON_KEY]));

  const color = rows.find((r) => r.key === COLOR_KEY);
  const icon = rows.find((r) => r.key === ICON_KEY);
  const parsed = color ? parseColor(color.value) : null;

  return {
    color: parsed && parsed.a >= 1 ? formatColor(parsed) : null,
    icon:
      icon && isIconType(icon.value)
        ? { type: icon.value, version: icon.at }
        : null,
    version: rows
      .map((r) => `${r.key}@${r.at}`)
      .toSorted()
      .join(","),
  };
};

/** The brand as Settings → Branding shows it, with who changed it last, and when. */
export const brandSetting = async (db: Database) => {
  const [brand, [last]] = await Promise.all([
    readBrand(db),
    db
      .select({ at: workspaceSettings.updatedAt, by: users.name })
      .from(workspaceSettings)
      .leftJoin(users, eq(users.id, workspaceSettings.updatedBy))
      .where(inArray(workspaceSettings.key, [COLOR_KEY, ICON_KEY]))
      .orderBy(desc(workspaceSettings.updatedAt))
      .limit(1),
  ]);

  return {
    color: brand.color,
    icon: brand.icon,
    updatedBy: last?.by ?? null,
    updatedAt: last?.at ?? null,
  };
};

const writeSetting = async (
  db: Database,
  adminId: string,
  key: string,
  value: string
) => {
  await db
    .insert(workspaceSettings)
    .values({ key, value, updatedBy: adminId, updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: workspaceSettings.key,
      set: { value, updatedBy: adminId, updatedAt: nowIso() },
    });
};

/** A refusal an admin can act on: Settings shows its message. */
export class BrandError extends Error {
  override name = "BrandError";
}

/** Set the accent to a CSS colour, kept as `#rrggbb`; an empty value goes back to app.css's green. */
export const setBrandColor = async (
  db: Database,
  adminId: string,
  value: string
) => {
  if (!value.trim()) {
    await db
      .delete(workspaceSettings)
      .where(eq(workspaceSettings.key, COLOR_KEY));

    return null;
  }

  const c = parseColor(value);

  if (!c || c.a < 1) {
    throw new BrandError(
      "That is not a colour. Enter one such as #e11d48, or pick one."
    );
  }

  const hex = formatColor(c);
  await writeSetting(db, adminId, COLOR_KEY, hex);

  return hex;
};

/** Keep an uploaded icon: a PNG, SVG, WebP or JPEG of at most 1 MB. */
export const setBrandIcon = async (
  db: Database,
  env: Pick<Env, "DRIVE">,
  adminId: string,
  file: File
) => {
  if (!isIconType(file.type)) {
    throw new BrandError("The icon must be a PNG, SVG, WebP or JPEG image.");
  }

  if (!file.size) {
    throw new BrandError("That file is empty.");
  }

  if (file.size > MAX_ICON_BYTES) {
    throw new BrandError("The icon must be 1 MB or smaller.");
  }

  await env.DRIVE.put(ICON_OBJECT, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  await writeSetting(db, adminId, ICON_KEY, file.type);
};

/** Go back to the default mark. */
export const removeBrandIcon = async (
  db: Database,
  env: Pick<Env, "DRIVE">
) => {
  await db.delete(workspaceSettings).where(eq(workspaceSettings.key, ICON_KEY));
  await env.DRIVE.delete(ICON_OBJECT);
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

const solid = (hex: string): Rgba => {
  const c = parseColor(hex);

  if (!c) {
    throw new Error(`not a colour: ${hex}`);
  }

  return c;
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

/** The address of the icon as it is now, so a new one is a new address for every cache. */
const iconHref = (icon: NonNullable<Brand["icon"]>) =>
  `${BRAND_PATHS.icon}?v=${encodeURIComponent(icon.version)}`;

/**
 * The stylesheet the pages link after app.css: the accent tokens of both themes when a colour is set, and the icon in
 * place of the default mark (`BrandMark`) when one is. Empty when neither is. The colour went through `parseColor` and
 * out as a hex on its way in, and is read back the same way, so nothing typed reaches the stylesheet as written.
 */
export const brandStylesheet = (brand: Brand): string => {
  const rules: string[] = [];
  const color = brand.color ? parseColor(brand.color) : null;

  if (color) {
    const { light, dark } = accents(color);

    rules.push(
      `:root { ${themeTokens(light, "#ffffff", 10, 8, dark.accent)} }`,
      `.dark { ${themeTokens(dark, DARK_BG, 16, 10, light.accent)} }`
    );
  }

  if (brand.icon) {
    rules.push(
      `.brand-mark-default { display: none; }`,
      `.brand-mark-icon { display: inline-block; background-image: url("${iconHref(brand.icon)}"); }`
    );
  }

  return rules.join("\n");
};

/** The web app's manifest: the workspace's name, and its icon (or the default drawings in `public/icons/`). */
export const brandManifest = (appName: string, brand: Brand) => ({
  name: appName,
  short_name: appName,
  description: "Mail, Drive, Calendar, Tasks and an Assistant, on Cloudflare.",
  id: "/",
  start_url: "/mail",
  scope: "/",
  display: "standalone",
  background_color: LIGHT_BG,
  theme_color: LIGHT_BG,
  icons: brand.icon
    ? [
        {
          src: iconHref(brand.icon),
          type: brand.icon.type,
          sizes: brand.icon.type === "image/svg+xml" ? "any" : "512x512",
        },
      ]
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
});

const redirect = (location: string) =>
  new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": REVALIDATE },
  });

/** An ETag the brand's version makes; ISO times and keys hold no quote. */
const etagOf = (version: string) => `"${version || "default"}"`;

/** A body under the brand's version, or 304 when the browser already holds that version. */
const versioned = (
  request: Request,
  version: string,
  body: () => BodyInit,
  headers: Record<string, string>
) => {
  const etag = etagOf(version);
  const common = { ETag: etag, "Cache-Control": REVALIDATE, ...headers };

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers: common });
  }

  return new Response(body(), { headers: common });
};

/**
 * The uploaded icon, as it is kept. An SVG is a document that can hold script, so it is served as a file a person
 * uploaded is (`fileResponse`): no script, no frame, sandboxed, so opening `/brand/icon` itself runs nothing.
 */
const iconResponse = async (
  request: Request,
  env: Pick<Env, "DRIVE">,
  icon: NonNullable<Brand["icon"]>
) => {
  const etag = etagOf(icon.version);

  const headers = {
    ETag: etag,
    "Cache-Control": REVALIDATE,
    "Content-Type": icon.type,
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };

  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const object = await env.DRIVE.get(ICON_OBJECT);

  if (!object) {
    return null;
  }

  return new Response(object.body, { headers });
};

/** Everything under `/brand/`. */
export const serveBrand = async (
  request: Request,
  env: Pick<Env, "APP_NAME" | "DRIVE">,
  db: Database
): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const brand = await readBrand(db);

  switch (url.pathname) {
    case BRAND_PATHS.theme: {
      return versioned(request, brand.version, () => brandStylesheet(brand), {
        "Content-Type": "text/css; charset=utf-8",
      });
    }

    case BRAND_PATHS.icon: {
      const icon = brand.icon && (await iconResponse(request, env, brand.icon));

      return icon ?? redirect(`${DEFAULT_ICON}${url.search}`);
    }

    case BRAND_PATHS.touchIcon: {
      // Safari's Home Screen reads no SVG: an SVG icon leaves the default tile there.
      const raster = brand.icon?.type === "image/svg+xml" ? null : brand.icon;
      const icon = raster && (await iconResponse(request, env, raster));

      return icon ?? redirect(`${DEFAULT_TOUCH_ICON}${url.search}`);
    }

    case BRAND_PATHS.manifest: {
      return versioned(
        request,
        brand.version,
        () => JSON.stringify(brandManifest(env.APP_NAME, brand)),
        { "Content-Type": "application/manifest+json" }
      );
    }

    default: {
      return new Response("Not found", { status: 404 });
    }
  }
};
