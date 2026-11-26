import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

/**
 * Writes the app's icons from `icon/icon.svg`, Workspace's own symbol on a 40 grid: four module
 * tiles, the first lit in the signal green, on an ink tile edge to edge, which iPhone and Android
 * round themselves.
 *
 * - The Tauri shell's sets: `tauri icon` turns a 1024 px PNG of the SVG into the iPhone set in the
 *   Xcode project (`gen/apple/Assets.xcassets/AppIcon.appiconset/`), the Android launcher icon in
 *   its adaptive layers in the Android project (`gen/android/app/src/main/res/`: the tile, the
 *   glyph, and the glyph alone for a themed icon) and the PNG sizes tauri.conf.json lists for the
 *   desktop window `tauri dev` opens on a Mac (`src-tauri/icons/`).
 * - `public/`: the Home Screen icons of the workspace as a web app:
 *   `apple-touch-icon.png` edge to edge, `icons/icon-192.png` and `icons/icon-512.png` on the
 *   mark's rounded tile, and `icons/icon-maskable-512.png` edge to edge for Android's own mask.
 *   The tab's icon, `favicon.svg`, is the same drawing cut by hand on the 32 grid for 16 px.
 *   A new drawing bumps `ICON_VERSION` in `app/lib/icons.ts`, or browsers that
 *   saw the old one keep showing it.
 *
 * Every iPhone icon is opaque: App Store Connect refuses an app icon with an alpha channel.
 *
 * Run it after changing the SVG and commit what it writes (`pnpm run icons`).
 */
const SOURCE = "icon/icon.svg";
const OUTPUT = "src-tauri/icons";
const IOS_SET = "src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset";

const WEB_OUTPUT = "../public";

/** The ink the tile is drawn in, the colour iOS fills behind the icon's transparent pixels. */
export const TILE_COLOR = "#15171a";

const TILE = '<rect id="tile" width="40" height="40" fill="#15171a" />';
const GLYPH = '<g id="glyph" fill="#f5f6f7">';

/**
 * How far the glyph shrinks in Android's adaptive layers. The launcher shows a 108 dp layer's inner
 * 72 dp and keeps only a 66 dp circle on every mask, a radius of 12.2 on the 40 grid, where the
 * tiles' outer corners reach 14.3 from the centre. At this scale they reach 10.3, and the glyph
 * takes the share of the visible icon it takes of the iPhone's tile.
 */
export const ANDROID_GLYPH_SCALE = 0.72;

/** `svg` with its tile replaced by `tile`. Throws when the SVG no longer has the tile, so a changed SVG is looked at again. */
const withTile = (svg: string, tile: string): string => {
  if (!svg.includes(TILE)) {
    throw new Error(
      `${SOURCE}: no longer an ink tile edge to edge on the 40 grid`
    );
  }

  return svg.replace(TILE, tile);
};

/** Where the glyph group starts and ends in `svg`. Throws when the SVG no longer holds it. */
const glyphSpan = (svg: string) => {
  const start = svg.indexOf(GLYPH);
  const close = svg.indexOf("</g>", start);

  if (start === -1 || close === -1) {
    throw new Error(
      `${SOURCE}: no longer holds the glyph in a group named glyph`
    );
  }

  return { start, end: close + "</g>".length };
};

/** What stays in `src-tauri/icons/`: the PNGs tauri.conf.json lists for the desktop window. */
export const KEPT_ICONS = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
] as const;

const kept = (entry: string): boolean =>
  KEPT_ICONS.some((name) => name === entry);

/** The mark's own corners, 9 on the 40 grid, for the web icons drawn on transparency. */
export const roundedTile = (svg: string): string =>
  withTile(
    svg,
    '<rect id="tile" width="40" height="40" rx="9" fill="#15171a" />'
  );

/** The glyph alone on transparency, at full size. */
export const glyphOnly = (svg: string): string => withTile(svg, "");

/** `svg` with its glyph drawn at `ANDROID_GLYPH_SCALE` around the centre, inside Android's safe zone. */
export const inSafeZone = (svg: string): string => {
  const { start, end } = glyphSpan(svg);
  const scale = `translate(20 20) scale(${ANDROID_GLYPH_SCALE}) translate(-20 -20)`;

  return `${svg.slice(0, start)}<g transform="${scale}">${svg.slice(start, end)}</g>${svg.slice(end)}`;
};

/** The glyph alone on transparency, inside the safe zone: the foreground of Android's adaptive icon. */
export const androidForeground = (svg: string): string =>
  inSafeZone(glyphOnly(svg));

/** The foreground in one colour: Android's themed (monochrome) icon, which the launcher tints. */
export const monochrome = (svg: string): string =>
  androidForeground(svg)
    .replace(GLYPH, '<g id="glyph" fill="#ffffff">')
    .replace(' fill="#3be08a"', "");

/** The tile alone: the background of Android's adaptive icon. */
export const tileOnly = (svg: string): string => {
  const { start, end } = glyphSpan(svg);

  return `${svg.slice(0, start)}${svg.slice(end)}`;
};

/** The web icons, each from one drawing at one size; `opaque` for the ones iOS shows. */
export const WEB_ICONS: readonly {
  file: string;
  size: number;
  drawing: (svg: string) => string;
  opaque: boolean;
}[] = [
  {
    file: "apple-touch-icon.png",
    size: 180,
    drawing: (svg) => svg,
    opaque: true,
  },
  {
    file: "icons/icon-192.png",
    size: 192,
    drawing: roundedTile,
    opaque: false,
  },
  {
    file: "icons/icon-512.png",
    size: 512,
    drawing: roundedTile,
    opaque: false,
  },
  {
    file: "icons/icon-maskable-512.png",
    size: 512,
    drawing: (svg) => svg,
    opaque: false,
  },
];

const png = async (svg: string, size: number, file: string) => {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
};

/** A PNG of an edge-to-edge drawing without an alpha channel, as App Store Connect wants it. */
const opaquePng = async (svg: string, size: number, file: string) => {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .flatten({ background: TILE_COLOR })
    .png()
    .toFile(file);
};

/** Takes the alpha channel out of every PNG `tauri icon` wrote into the Xcode project. */
const flattenIosSet = async () => {
  const files = readdirSync(IOS_SET).filter((file) => file.endsWith(".png"));

  await Promise.all(
    files.map(async (file) => {
      const target = path.join(IOS_SET, file);

      const flat = await sharp(target)
        .flatten({ background: TILE_COLOR })
        .png()
        .toBuffer();

      writeFileSync(target, flat);
    })
  );
};

const tauriIcon = (manifest: string, output: string) => {
  execFileSync(
    "pnpm",
    ["exec", "tauri", "icon", manifest, "--output", output],
    {
      stdio: "inherit",
    }
  );
};

const main = async () => {
  const svg = readFileSync(SOURCE, "utf-8");
  const work = mkdtempSync(path.join(tmpdir(), "workspace-icon-"));

  try {
    await png(svg, 1024, path.join(work, "icon.png"));
    await png(tileOnly(svg), 1024, path.join(work, "android-bg.png"));
    await png(androidForeground(svg), 1024, path.join(work, "android-fg.png"));
    await png(monochrome(svg), 1024, path.join(work, "android-mono.png"));
    const manifest = path.join(work, "icon.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        default: "icon.png",
        bg_color: TILE_COLOR,
        android_bg: "android-bg.png",
        android_fg: "android-fg.png",
        android_monochrome: "android-mono.png",
      })
    );
    tauriIcon(manifest, OUTPUT);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // The Mac, Windows and Microsoft Store icons the app never ships; the window `tauri dev` opens
  // on a Mac reads the PNGs tauri.conf.json lists.
  for (const entry of readdirSync(OUTPUT)) {
    if (!kept(entry)) {
      rmSync(path.join(OUTPUT, entry), { recursive: true, force: true });
    }
  }

  await flattenIosSet();

  mkdirSync(path.join(WEB_OUTPUT, "icons"), { recursive: true });

  // Each image goes to a file of its own, so the renders do not depend on one another.
  await Promise.all(
    WEB_ICONS.map((icon) => {
      const write = icon.opaque ? opaquePng : png;

      return write(
        icon.drawing(svg),
        icon.size,
        path.join(WEB_OUTPUT, icon.file)
      );
    })
  );

  console.log(
    `Wrote the iPhone and Android sets into the Xcode and Android projects, the desktop icons to ${OUTPUT}, and ${WEB_ICONS.length} web icons to ${WEB_OUTPUT}.`
  );
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
