import { useEffect, useState, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const KEY = "workspace.theme";

/** Runs before paint so the first frame already has the right theme (no flash). */
export const themeInitScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)})||"system";var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

/** The canvas colour of each reading (`--bg` in app.css), for the browser's chrome and a phone's status bar. */
export const THEME_COLORS = { light: "#fcfcfc", dark: "#191a1b" } as const;

/**
 * Points the `theme-color` metas (routes/__root.tsx) at the theme's canvas: with `system` each
 * keeps its own reading, which its media query picks; a chosen theme sets both to its colour, as
 * the page no longer follows the system.
 */
export const syncThemeColor = (theme: Theme) => {
  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[name="theme-color"]'
  )) {
    const own: Theme = meta.media.includes("dark") ? "dark" : "light";
    const reading = theme === "system" ? own : theme;

    meta.content = THEME_COLORS[reading];
  }
};

export const applyTheme = (theme: Theme) => {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.classList.toggle("dark", dark);
  syncThemeColor(theme);
};

const getThemeSnapshot = (): Theme => {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const stored = localStorage.getItem(KEY);

    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Ignore storage access errors
  }

  return "system";
};

const getServerThemeSnapshot = (): Theme => "system";

const themeListeners = new Set<() => void>();

const subscribeTheme = (onChange: () => void) => {
  themeListeners.add(onChange);
  const mq = matchMedia("(prefers-color-scheme: dark)");

  const handleMq = () => {
    if (getThemeSnapshot() === "system") {
      applyTheme("system");
      onChange();
    }
  };

  const handleStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      onChange();
    }
  };

  mq.addEventListener("change", handleMq);
  window.addEventListener("storage", handleStorage);

  return () => {
    themeListeners.delete(onChange);
    mq.removeEventListener("change", handleMq);
    window.removeEventListener("storage", handleStorage);
  };
};

export const useTheme = (): [Theme, (t: Theme) => void] => {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot
  );

  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // Ignore storage access errors
    }

    applyTheme(t);

    for (const listener of themeListeners) {
      listener();
    }
  };

  return [theme, setTheme];
};

/**
 * Whether the document is dark right now, for the parts that cannot read the CSS variables (the mail iframe); null
 * until the client has looked, so nothing renders in the wrong theme first (the server cannot know the theme).
 */
export const useIsDark = (): boolean | null => {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => {
      setDark(document.documentElement.classList.contains("dark"));
    };

    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  return dark;
};
