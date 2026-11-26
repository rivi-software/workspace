import { afterEach, describe, expect, it, vi } from "vitest";

import { THEME_COLORS, syncThemeColor } from "~/components/theme";
import { opensInTab } from "~/lib/drive/drive";
import {
  MOBILE_APP_AGENT,
  inAndroidApp,
  inMobileApp,
  mobileAppStartPage,
} from "~/lib/mobile-app";

/** Safari on an iPhone, as it names itself. */
const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1";

/** The same WebKit inside Workspace for iPhone (mobile/), which adds its name. */
const APP = `Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 ${MOBILE_APP_AGENT}1.2.3`;

/** Chrome on an Android phone, as it names itself. */
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

/** The Android System WebView inside Workspace for Android (mobile/), which adds its name. */
const ANDROID_APP = `Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP4A.250105.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36 ${MOBILE_APP_AGENT}1.2.3`;

describe("the phone app's contract with the console", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("knows the app by its token in the user agent, and a browser by its absence", () => {
    vi.stubGlobal("navigator", { userAgent: APP });
    expect(inMobileApp()).toBeTruthy();

    vi.stubGlobal("navigator", { userAgent: SAFARI });
    expect(inMobileApp()).toBeFalsy();
  });

  it("knows the app on Android apart from the app on an iPhone and from Chrome on Android", () => {
    vi.stubGlobal("navigator", { userAgent: ANDROID_APP });
    expect([inMobileApp(), inAndroidApp()]).toStrictEqual([true, true]);

    vi.stubGlobal("navigator", { userAgent: APP });
    expect(inAndroidApp()).toBeFalsy();

    vi.stubGlobal("navigator", { userAgent: CHROME_ANDROID });
    expect(inAndroidApp()).toBeFalsy();
  });

  it("links the app's start page where each web view serves it, to name another workspace", () => {
    vi.stubGlobal("navigator", { userAgent: APP });
    expect(mobileAppStartPage()).toBe("tauri://localhost/index.html?change");

    vi.stubGlobal("navigator", { userAgent: ANDROID_APP });
    expect(mobileAppStartPage()).toBe(
      "http://tauri.localhost/index.html?change"
    );
  });

  it("offers a PDF in a tab of its own only where the web view has a PDF viewer", () => {
    expect({
      pdf: opensInTab("application/pdf", true),
      pdfInAndroidApp: opensInTab("application/pdf", false),
      imageInAndroidApp: opensInTab("image/png", false),
      textInAndroidApp: opensInTab("text/plain", false),
      zip: opensInTab("application/zip", true),
    }).toStrictEqual({
      pdf: true,
      pdfInAndroidApp: false,
      imageInAndroidApp: true,
      textInAndroidApp: true,
      zip: false,
    });
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
