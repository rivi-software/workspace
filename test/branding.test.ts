// The workspace's own brand (`app/lib/branding.server.ts`, Settings → Branding): what an admin may set, the accent
// made from it, and what `/brand/*` answers with and without one.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { THEME_COLORS } from "~/components/theme";
import {
  brandingIntent,
  brandingSettings,
} from "~/lib/branding-settings.server";
import {
  accents,
  brandStylesheet,
  readBrand,
  removeBrandIcon,
  setBrandColor,
} from "~/lib/branding.server";
import { contrast, parseColor } from "~/lib/mail/colors";
import type { Rgba } from "~/lib/mail/colors";
import { loadSettings } from "~/lib/settings.server";

import type { Json } from "./fixtures";
import { adminMailbox, db, formOf, mailbox } from "./fixtures";

const color = (css: string): Rgba => {
  const c = parseColor(css);

  if (!c) {
    throw new Error(`not a colour: ${css}`);
  }

  return c;
};

/** A path of the Worker, as a browser asks for it. */
const brandAt = (path: string, init?: RequestInit) =>
  exports.default.fetch(`${env.APP_URL}${path}`, {
    redirect: "manual",
    ...init,
  });

/** What a path of the Worker answers, as text. */
const textAt = async (path: string) => {
  const res = await brandAt(path);

  return res.text();
};

/** The manifest the Worker answers. */
const manifestNow = async (): Promise<Json> => {
  const res = await brandAt("/brand/manifest.webmanifest");

  return res.json();
};

/** An admin's Branding form, with a file when it names one. */
const brandForm = (fields: Record<string, string>, icon?: File) => {
  const form = formOf(fields);

  if (icon) {
    form.set("icon", icon);
  }

  return form;
};

const SVG = new File(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>',
  ],
  "logo.svg",
  { type: "image/svg+xml" }
);

const PNG = new File(
  [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
  "logo.png",
  { type: "image/png" }
);

describe("the brand", () => {
  // Every case starts from a workspace with nothing set, whatever the one before left.
  beforeEach(async () => {
    const admin = await adminMailbox(
      `brand-reset-${crypto.randomUUID().slice(0, 8)}`
    );

    await setBrandColor(db, admin.id, "");
    await removeBrandIcon(db, env);
  });

  it("answers the default drawing, an empty stylesheet and the default manifest when nothing is set", async () => {
    const icon = await brandAt("/brand/icon?v=1");
    const touch = await brandAt("/brand/apple-touch-icon?v=1");
    const theme = await brandAt("/brand/theme.css");
    const manifest = await brandAt("/brand/manifest.webmanifest");
    const body: Json = await manifest.json();

    expect({
      icon: [icon.status, icon.headers.get("location")],
      touch: [touch.status, touch.headers.get("location")],
      theme: [
        theme.status,
        theme.headers.get("content-type"),
        await theme.text(),
      ],
      manifest: [manifest.headers.get("content-type"), body],
    }).toMatchObject({
      icon: [302, "/favicon.svg?v=1"],
      touch: [302, "/apple-touch-icon.png?v=1"],
      theme: [200, "text/css; charset=utf-8", ""],
      manifest: [
        "application/manifest+json",
        {
          name: env.APP_NAME,
          icons: [
            { src: "/icons/icon-192.png" },
            { src: "/icons/icon-512.png" },
            { src: "/icons/icon-maskable-512.png", purpose: "maskable" },
          ],
        },
      ],
    });
  });

  it("lets an admin alone set the accent, and lays it over both themes", async () => {
    const member = await mailbox("brand-member");
    const admin = await adminMailbox("brand-admin");

    const refused = await brandingIntent(
      db,
      env,
      member,
      brandForm({ intent: "color", color: "#e11d48" })
    );

    const notAColour = await brandingIntent(
      db,
      env,
      admin,
      brandForm({ intent: "color", color: "red; } body { x" })
    );

    const set = await brandingIntent(
      db,
      env,
      admin,
      brandForm({ intent: "color", color: "rgb(225 29 72)" })
    );

    const theme = await brandAt("/brand/theme.css");
    const css = await theme.text();

    const again = await brandAt("/brand/theme.css", {
      headers: { "If-None-Match": theme.headers.get("etag") ?? "" },
    });

    const shown = await brandingSettings(db, admin);

    const reset = await brandingIntent(
      db,
      env,
      admin,
      brandForm({ intent: "color-reset" })
    );

    const after = await textAt("/brand/theme.css");

    expect({
      refused,
      notAColour,
      set,
      css: [
        /^:root \{ --accent: #[0-9a-f]{6};/u.test(css),
        /\n\.dark \{ --accent: #[0-9a-f]{6};/u.test(css),
      ],
      cache: [theme.headers.get("cache-control"), again.status],
      shown: [shown.color, shown.updatedBy],
      reset,
      after,
    }).toStrictEqual({
      refused: { error: "Only an admin can change this." },
      notAColour: {
        error: "That is not a colour. Enter one such as #e11d48, or pick one.",
      },
      set: { message: "The accent is #e11d48." },
      css: [true, true],
      cache: ["no-cache", 304],
      shown: ["#e11d48", "brand-admin"],
      reset: { message: "The accent is the default green again." },
      after: "",
    });
  });

  it("serves an uploaded icon from the workspace, sandboxed, and points every icon at it", async () => {
    const admin = await adminMailbox("brand-icon-admin");

    const upload = (file?: File) =>
      brandingIntent(db, env, admin, brandForm({ intent: "icon" }, file));

    const wrongType = await upload(
      new File(["<html>"], "page.html", { type: "text/html" })
    );

    const tooLarge = await upload(
      new File([new Uint8Array(1024 * 1024 + 1)], "big.png", {
        type: "image/png",
      })
    );

    const none = await upload();
    const svg = await upload(SVG);

    const icon = await brandAt("/brand/icon?v=1");
    const iconBody = await icon.text();
    // Safari's Home Screen reads no SVG, so the touch icon stays the default tile.
    const touch = await brandAt("/brand/apple-touch-icon");

    const manifest = await manifestNow();

    const css = await textAt("/brand/theme.css");

    const png = await upload(PNG);
    const touchPng = await brandAt("/brand/apple-touch-icon");
    await touchPng.arrayBuffer();

    const removed = await brandingIntent(
      db,
      env,
      admin,
      brandForm({ intent: "icon-remove" })
    );

    const afterRemove = await brandAt("/brand/icon");

    expect({
      wrongType,
      tooLarge,
      none,
      svg,
      icon: [
        icon.status,
        icon.headers.get("content-type"),
        icon.headers.get("content-security-policy"),
        iconBody.includes("<script>"),
      ],
      touch: [touch.status, touch.headers.get("location")],
      manifest,
      hidesMark: css.includes(".brand-mark-default { display: none; }"),
      png,
      touchPng: [touchPng.status, touchPng.headers.get("content-type")],
      removed,
      afterRemove: afterRemove.headers.get("location"),
    }).toMatchObject({
      wrongType: { error: "The icon must be a PNG, SVG, WebP or JPEG image." },
      tooLarge: { error: "The icon must be 1 MB or smaller." },
      none: { error: "Choose an image to upload." },
      svg: { message: "The workspace's icon is updated." },
      icon: [
        200,
        "image/svg+xml",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
        true,
      ],
      touch: [302, "/apple-touch-icon.png"],
      manifest: { icons: [{ type: "image/svg+xml", sizes: "any" }] },
      hidesMark: true,
      png: { message: "The workspace's icon is updated." },
      touchPng: [200, "image/png"],
      removed: { message: "The workspace shows the default mark again." },
      afterRemove: "/favicon.svg",
    });
  });

  it("shows the Branding tab to an admin alone", async () => {
    const member = await mailbox("brand-tab-member");
    const admin = await adminMailbox("brand-tab-admin");
    const request = new Request(env.APP_URL);

    const memberTab = await loadSettings(db, env, member, request, "branding");
    const adminTab = await loadSettings(db, env, admin, request, "branding");

    expect([memberTab.tab, adminTab.tab]).toStrictEqual([
      "account",
      "branding",
    ]);
    expect(() => brandingSettings(db, member)).toThrow(
      "Only an admin sees the workspace's branding."
    );
  });

  it("makes an accent that reads on both canvases, whatever colour it starts from", () => {
    const light = color(THEME_COLORS.light);
    const dark = color(THEME_COLORS.dark);

    for (const start of [
      "#ffe600",
      "#0b1f4d",
      "#e11d48",
      "#000000",
      "#ffffff",
    ]) {
      const made = accents(color(start));

      expect({
        start,
        light: contrast(color(made.light.accent), light) >= 4.5,
        dark: contrast(color(made.dark.accent), dark) >= 6,
        lightFg:
          contrast(color(made.light.fg), color(made.light.accent)) >= 4.5,
      }).toStrictEqual({ start, light: true, dark: true, lightFg: true });
    }
  });

  it("writes nothing into the stylesheet but a colour it read back", async () => {
    const brand = await readBrand(db);

    expect(
      brandStylesheet({ ...brand, color: "red; } body { display: none" })
    ).toBe("");
  });
});
