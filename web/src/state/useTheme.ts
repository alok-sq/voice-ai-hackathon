import { useEffect, useState } from "react";
import { THEME_KEY, parseTheme, resolveTheme, type Theme } from "./theme";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

function readSaved(): Theme | null {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return null; // Storage blocked: follow the system.
  }
}

const systemPrefersDark = () => typeof matchMedia === "function" && matchMedia(SYSTEM_DARK).matches;

/**
 * The console's theme, applied as <html data-theme>. Follows the system until
 * someone picks one; their pick is remembered in this browser.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [saved, setSaved] = useState<Theme | null>(readSaved);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme = resolveTheme(saved, systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Track the OS setting live, but only while no choice has been saved.
  useEffect(() => {
    if (saved || typeof matchMedia !== "function") return;
    const query = matchMedia(SYSTEM_DARK);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [saved]);

  const set = (next: Theme) => {
    setSaved(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be blocked; the choice still holds for this visit.
    }
  };
  return [theme, set];
}
