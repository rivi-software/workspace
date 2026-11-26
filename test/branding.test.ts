// A deployment's own brand (`app/lib/branding.server.ts`): the accent from `BRAND_COLOR`, the icon from
// `BRAND_ICON_URL`, and what `/brand/*` answers with neither.
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { THEME_COLORS } from "../app/components/theme";
import type { BrandVars } from "../app/lib/branding.server";
import {
  accents,
  brandColor,
  brandIcon,
  serveBrand,
} from "../app/lib/branding.server";
import { contrast, parseColor } from "../app/lib/mail/colors";
import type { Rgba } from "../app/lib/mail/colors";
import type { Json } from "./fixtures";

const branded = (vars: Partial<BrandVars>): BrandVars => ({
  APP_NAME: env.APP_NAME,
  BRAND_COLOR: "",
  BRAND_ICON_URL: "",
  ...vars,
});

/** Whether `BRAND_COLOR` set to `value` gives an accent. */
const readsAsColor = (value: string) =>
  brandColor({ BRAND_COLOR: value }) !== null;

const get = (path: string, on: BrandVars) =>
  serveBrand(new Request(new URL(path, env.APP_URL)), on);

const color = (css: string): Rgba => {
  const c = parseColor(css);

  if (!c) {
    throw new Error(`not a colour: ${css}`);
  }

  return c;
};

describe("the brand", () => {
  it("answers the default drawing, an empty stylesheet and the manifest when nothing is set", async () => {
    const icon = await exports.default.fetch(`${env.APP_URL}/brand/icon?v=1`, {
      redirect: "manual",
    });

    const touch = await exports.default.fetch(
      `${env.APP_URL}/brand/apple-touch-icon?v=1`,
      { redirect: "manual" }
    );

    const theme = await exports.default.fetch(`${env.APP_URL}/brand/theme.css`);

    const manifest = await exports.default.fetch(
      `${env.APP_URL}/brand/manifest.webmanifest`
    );

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

  it("points every icon at BRAND_ICON_URL and shows it in place of the mark", async () => {
    const on = branded({
      BRAND_ICON_URL: " https://cdn.example.org/logo.png ",
    });

    const manifest: Json = await get("/brand/manifest.webmanifest", on).json();
    const css = await get("/brand/theme.css", on).text();

    expect({
      icon: get("/brand/icon?v=1", on).headers.get("location"),
      touch: get("/brand/apple-touch-icon", on).headers.get("location"),
      manifest,
      hidesMark: css.includes(".brand-mark-default { display: none; }"),
    }).toMatchObject({
      icon: "https://cdn.example.org/logo.png",
      touch: "https://cdn.example.org/logo.png",
      manifest: { icons: [{ src: "/brand/icon", sizes: "512x512" }] },
      hidesMark: true,
    });
  });

  it("refuses an icon address that is not https", () => {
    expect(
      [
        "http://cdn.example.org/logo.png",
        "data:image/png;base64,AAAA",
        "/logo.png",
        "not a url",
        "http://localhost:5174/logo.svg",
      ].map((url) => brandIcon({ BRAND_ICON_URL: url }))
    ).toStrictEqual([null, null, null, null, "http://localhost:5174/logo.svg"]);
  });

  it("reads BRAND_COLOR as an opaque CSS colour, or not at all, so nothing of it reaches the stylesheet as written", () => {
    expect(
      [
        "#e11d48",
        "rebeccapurple",
        "rgb(10 20 30)",
        "",
        "#e11d4880",
        "red; }",
      ].map(readsAsColor)
    ).toStrictEqual([true, true, true, false, false, false]);
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

  it("lays the accent of both themes over app.css", async () => {
    const css = await get(
      "/brand/theme.css",
      branded({ BRAND_COLOR: "#e11d48" })
    ).text();

    expect(css).toMatch(/^:root \{ --accent: #[0-9a-f]{6};/u);
    expect(css).toMatch(/\n\.dark \{ --accent: #[0-9a-f]{6};/u);
    expect(css).not.toContain("brand-mark");
  });
});
