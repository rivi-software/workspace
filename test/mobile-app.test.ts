import { afterEach, describe, expect, it, vi } from "vitest";

import { THEME_COLORS, syncThemeColor } from "~/components/theme";
import { MOBILE_APP_AGENT, inMobileApp } from "~/lib/mobile-app";

/** Safari on an iPhone, as it names itself. */
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";

/** The same WebKit inside RIVI Workspace for iPhone (apps/workspace-mobile), which adds its name. */
const APP = `Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${MOBILE_APP_AGENT}1.2.3`;

describe("the phone app's contract with the console (#3529)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows the app by its token in the user agent, and a browser by its absence", () => {
    vi.stubGlobal("navigator", { userAgent: APP });
    expect(inMobileApp()).toBeTruthy();

    vi.stubGlobal("navigator", { userAgent: SAFARI });
    expect(inMobileApp()).toBeFalsy();
  });

  it("points the theme-color metas at the chosen theme's canvas, and at each reading's own for system", () => {
    const metas = [
      { media: "(prefers-color-scheme: light)", content: "" },
      { media: "(prefers-color-scheme: dark)", content: "" },
    ];

    vi.stubGlobal("document", { querySelectorAll: () => metas });

    syncThemeColor("dark");
    expect(metas.map((meta) => meta.content)).toStrictEqual([
      THEME_COLORS.dark,
      THEME_COLORS.dark,
    ]);

    syncThemeColor("light");
    expect(metas.map((meta) => meta.content)).toStrictEqual([
      THEME_COLORS.light,
      THEME_COLORS.light,
    ]);

    syncThemeColor("system");
    expect(metas.map((meta) => meta.content)).toStrictEqual([
      THEME_COLORS.light,
      THEME_COLORS.dark,
    ]);
  });
});
