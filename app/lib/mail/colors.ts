import { defined } from "~/lib/guards";
/**
 * The colours of a message's CSS, read and rewritten for the dark reading (`mailDocument`). The work happens in OKLab,
 * where lightness is perceptual: dark text becomes light text of the same hue and a light background a dark one, so a
 * message keeps its accents and its hierarchy (body text brighter than the grey footnote) on the dark surface.
 */

/** A colour as sRGB channels and alpha, each 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

// SAFETY: every entry of the literal is `name:hex`, so a split on the colon gives two strings.
const NAMED = new Map(
  "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32"
    .split(",")
    .map((pair) => pair.split(":") as [string, string])
);

// Outlook writes the Windows system colours, black text in a white window.
for (const name of ["windowtext", "buttontext", "canvastext"]) {
  NAMED.set(name, "000000");
}

for (const name of ["window", "canvas"]) {
  NAMED.set(name, "ffffff");
}

const parseHex = (hex: string): Rgba | null => {
  if (!/^[0-9a-f]+$/u.test(hex) || ![3, 4, 6, 8].includes(hex.length)) {
    return null;
  }

  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
  const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;

  return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) : 1 };
};

const channel = (part: string, scale: number): number => {
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- `parseFloat` reads the number in front of the unit ("50%"), where `Number` gives NaN
  const n = Number.parseFloat(part);

  return Math.min(1, Math.max(0, part.endsWith("%") ? n / 100 : n / scale));
};

/** A CSS colour (hex, rgb(), hsl(), a named or Windows system colour), or null for anything else. */
export const parseColor = (value: string): Rgba | null => {
  const v = value.trim().toLowerCase();

  if (v === "transparent") {
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  const hex = v.startsWith("#") ? v.slice(1) : NAMED.get(v);

  if (hex !== undefined) {
    return parseHex(hex);
  }

  const fn = v.match(/^(?<fn>rgba?|hsla?)\((?<args>[^()]*)\)$/u);

  if (!fn) {
    return null;
  }

  const parts = fn[2].split(/[\s,/]+/u).filter(Boolean);

  if (parts.length < 3 || parts.length > 4) {
    return null;
  }

  const a = parts[3] === undefined ? 1 : channel(parts[3], 1);

  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => channel(p, 255));

    return [r, g, b, a].some(Number.isNaN) ? null : { r, g, b, a };
  }

  // oxlint-disable-next-line unicorn/prefer-number-coercion -- `parseFloat` reads the number in front of the unit ("0.5turn", "90deg"), where `Number` gives NaN
  const h = Number.parseFloat(parts[0]) * (parts[0].endsWith("turn") ? 360 : 1);
  const s = channel(parts[1], 100);
  const l = channel(parts[2], 100);

  if ([h, s, l, a].some(Number.isNaN)) {
    return null;
  }

  const k = (n: number) => (n + ((h % 360) + 360) / 30) % 12;

  const f = (n: number) =>
    l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));

  return { r: f(0), g: f(8), b: f(4), a };
};

/** The colour as CSS: `#rrggbb`, `rgba()` when it is see-through, `transparent` when it is not there at all. */
export const formatColor = (c: Rgba): string => {
  if (c.a <= 0) {
    return "transparent";
  }

  const [r, g, b] = [c.r, c.g, c.b].map((v) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
  );

  if (c.a >= 1) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  return `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 1000) / 1000})`;
};

interface Lab {
  L: number;
  a: number;
  b: number;
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const fromLinear = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;

const toOklab = ({ r, g, b }: Rgba): Lab => {
  const [lr, lg, lb] = [r, g, b].map(toLinear);

  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );

  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );

  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};

const fromOklab = ({ L, a, b }: Lab): [number, number, number] => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const [red, green, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLinear);

  return [red, green, blue];
};

/** Perceptual lightness, 0 (black) to 1 (white). */
export const lightness = (c: Rgba): number => toOklab(c).L;

const chroma = (lab: Lab): number => Math.hypot(lab.a, lab.b);

/** The colour at another lightness, hue kept; the chroma shrinks until it fits in sRGB. */
const withLightness = (c: Rgba, L: number, chromaScale = 1): Rgba => {
  const lab = toOklab(c);

  const fits = (k: number) =>
    fromOklab({ L, a: lab.a * k, b: lab.b * k }).every(
      (v) => v >= -1e-4 && v <= 1 + 1e-4
    );

  let k = chromaScale;

  if (!fits(k)) {
    let lo = 0;

    for (let i = 0; i < 20; i += 1) {
      const mid = (lo + k) / 2;

      if (fits(mid)) {
        lo = mid;
      } else {
        k = mid;
      }
    }

    k = lo;
  }

  const [r, g, b] = fromOklab({ L, a: lab.a * k, b: lab.b * k });

  return { r, g, b, a: c.a };
};

/** The dark reading's surface: the message card (`--bg-elevated` of the dark theme). */
export const DARK_SURFACE: Rgba = defined(
  parseColor("#222326"),
  "the result of parse color"
);

const luminance = (c: Rgba): number => {
  const [r, g, b] = [c.r, c.g, c.b].map(toLinear);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two opaque colours. */
export const contrast = (x: Rgba, y: Rgba): number => {
  const [hi, lo] = [luminance(x), luminance(y)].toSorted((p, q) => q - p);

  return (hi + 0.05) / (lo + 0.05);
};

/** A background that reads as the page itself: none, or white and near-white greys (`#fff`, `#f6f9fc`). */
export const isPageColor = (c: Rgba): boolean => {
  if (c.a < 0.1) {
    return true;
  }

  const lab = toOklab(c);

  return lab.L >= 0.95 && chroma(lab) <= 0.02;
};

/**
 * A background pale enough to be a tint of the page, not a design: a shaded table header, a grey card, a pastel note.
 * `darkBackground` turns it into a dark tint of the same hue, so nothing of the message is lost.
 */
export const isPaleColor = (c: Rgba): boolean =>
  c.a < 0.1 || toOklab(c).L >= 0.85;

/**
 * Text for the dark surface. Dark text turns light in reverse order (black brightest, a mid grey dimmer), so the
 * message's own hierarchy survives; colours already light enough stay as they are, and every result reaches 4.5:1.
 */
export const darkText = (c: Rgba): Rgba => {
  const { L } = toOklab(c);
  let target = Math.max(L, 0.93 - 0.55 * L * L);
  let out = target === L ? c : withLightness(c, target);

  while (contrast({ ...out, a: 1 }, DARK_SURFACE) < 4.5 && target < 1) {
    target = Math.min(1, target + 0.02);
    out = withLightness(c, target);
  }

  return out;
};

/** A background for the dark surface: white goes, light colours turn dark (a highlight stays a highlight), dark ones stay. */
export const darkBackground = (c: Rgba): Rgba => {
  if (isPageColor(c)) {
    return { ...c, a: 0 };
  }

  const { L } = toOklab(c);

  return L <= 0.5 ? c : withLightness(c, 0.32 + (1 - L) * 0.36, 0.85);
};

/** A rule or border for the dark surface: a light grey line turns a dark grey line, a black one a mid grey. */
export const darkBorder = (c: Rgba): Rgba => {
  const { L } = toOklab(c);

  if (L > 0.5) {
    return withLightness(c, 0.32 + (1 - L) * 0.36, 0.85);
  }

  return withLightness(c, Math.max(L, 0.62 - 0.3 * L));
};

// url() and other functions are skipped whole, so a colour word inside an address or var(--red) stays as written.
const VALUE_TOKEN =
  /url\([^)]*\)|"[^"]*"|'[^']*'|(?:rgb|hsl)a?\([^()]*\)|-?[a-z][\w-]*\([^()]*\)|#[0-9a-f]{3,8}\b|-?[a-z][\w-]*/giu;

/** Every colour in a CSS value, one by one; the rest of the value is left exactly as it was. */
export const mapColors = (value: string, fn: (c: Rgba) => Rgba): string =>
  value.replaceAll(VALUE_TOKEN, (token) => {
    if (
      /^(?:url\(|["'])/iu.test(token) ||
      (/\(/u.test(token) && !/^(?:rgb|hsl)a?\(/iu.test(token))
    ) {
      return token;
    }

    const c = parseColor(token);

    return c ? formatColor(fn(c)) : token;
  });

/** The colours in a CSS value, for reading a message's palette. */
export const colorsIn = (value: string): Rgba[] => {
  const found: Rgba[] = [];
  mapColors(value, (c) => {
    found.push(c);

    return c;
  });

  return found;
};
