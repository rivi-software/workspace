import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANDROID_GLYPH_SCALE,
  WEB_ICONS,
  androidForeground,
  glyphOnly,
  monochrome,
  roundedTile,
  tileOnly,
} from "../scripts/icons";

const svg = readFileSync(new URL("../icon/icon.svg", import.meta.url), "utf-8");

const favicon = readFileSync(
  new URL("../../public/favicon.svg", import.meta.url),
  "utf-8"
);

const RECT =
  /<rect x="(?<x>[\d.]+)" y="(?<y>[\d.]+)" width="(?<width>[\d.]+)" height="(?<height>[\d.]+)" rx="(?<rx>[\d.]+)"/gu;

/** Each `<rect>`'s box in `markup`, in the order drawn. */
const rects = (markup: string) =>
  [...markup.matchAll(RECT)].map(({ groups }) => ({
    x: Number(groups?.x),
    y: Number(groups?.y),
    width: Number(groups?.width),
    height: Number(groups?.height),
    rx: Number(groups?.rx),
  }));

/** How far a rounded rectangle reaches from (`centre`, `centre`): its farthest corner's arc. */
const reach = (
  centre: number,
  { x, y, width, height, rx }: ReturnType<typeof rects>[number]
) => {
  const dx = Math.max(
    Math.abs(x + rx - centre),
    Math.abs(x + width - rx - centre)
  );

  const dy = Math.max(
    Math.abs(y + rx - centre),
    Math.abs(y + height - rx - centre)
  );

  return Math.hypot(dx, dy) + rx;
};

describe("the app icon", () => {
  it("is the glyph on a 1024 px canvas of the 40 grid, the tile edge to edge", () => {
    expect(svg).toContain('width="1024" height="1024" viewBox="0 0 40 40"');
    expect(svg).toContain(
      '<rect id="tile" width="40" height="40" fill="#15171a" />'
    );
  });

  it("draws four module tiles, the first lit in the signal green", () => {
    expect(rects(svg)).toHaveLength(4);
    expect(svg.match(/fill="#3be08a"/gu)).toHaveLength(1);
    expect(svg).toMatch(/<rect x="9" y="9" [^>]*fill="#3be08a"/u);
  });

  it("draws the web icons on the mark's rounded tile", () => {
    expect(roundedTile(svg)).toContain('rx="9"');
    expect(roundedTile(svg)).not.toContain(
      '<rect id="tile" width="40" height="40" fill'
    );
  });

  it("splits the Android adaptive icon into its tile and its glyph", () => {
    expect(tileOnly(svg)).not.toContain("<g");
    expect(tileOnly(svg)).toContain('<rect id="tile"');
    expect(glyphOnly(svg)).not.toContain('<rect id="tile"');
    expect(androidForeground(svg)).not.toContain('<rect id="tile"');
    expect(androidForeground(svg)).toContain('<g id="glyph"');
  });

  it("keeps the Android glyph inside the 66 dp circle every launcher mask keeps", () => {
    const safeRadius = (33 / 108) * 40;
    const farthest = Math.max(...rects(svg).map((box) => reach(20, box)));

    expect(farthest).toBeGreaterThan(safeRadius);
    expect(farthest * ANDROID_GLYPH_SCALE).toBeLessThanOrEqual(safeRadius);
    expect(androidForeground(svg)).toContain(`scale(${ANDROID_GLYPH_SCALE})`);
  });

  it("keeps the maskable web icon's glyph inside the mask's 80% circle", () => {
    const farthest = Math.max(...rects(svg).map((box) => reach(20, box)));

    expect(farthest).toBeLessThanOrEqual(0.4 * 40);
  });

  it("draws the themed icon in one colour", () => {
    expect(monochrome(svg)).not.toContain("#3be08a");
    expect(monochrome(svg)).not.toContain("#15171a");
    expect(monochrome(svg)).toContain('fill="#ffffff"');
  });

  it("refuses a drawing without the tile and glyph it takes apart", () => {
    expect(() => roundedTile("<svg></svg>")).toThrow("no longer an ink tile");
    expect(() => tileOnly("<svg></svg>")).toThrow("glyph");
  });

  it("writes the Home Screen icons the manifest and Safari read, opaque where iOS shows them", () => {
    expect(WEB_ICONS.map((icon) => [icon.file, icon.opaque])).toStrictEqual([
      ["apple-touch-icon.png", true],
      ["icons/icon-192.png", false],
      ["icons/icon-512.png", false],
      ["icons/icon-maskable-512.png", false],
    ]);
  });

  it("has a favicon cut from the same drawing: four tiles on the 32 grid, the first lit", () => {
    expect(favicon).toContain('viewBox="0 0 32 32"');
    expect(rects(favicon)).toHaveLength(4);
    expect(favicon).toMatch(/<rect x="[\d.]+" y="[\d.]+" [^>]*fill="#3be08a"/u);
    expect(favicon.indexOf("#3be08a")).toBeLessThan(favicon.indexOf("</g>"));
  });
});
