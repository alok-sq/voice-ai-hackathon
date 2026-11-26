/**
 * Light or dark. A saved choice wins; with none, the console follows the system.
 * index.html repeats this logic inline so the right theme is set before first paint.
 */
export type Theme = "light" | "dark";

export const THEME_KEY = "console.theme";

/** Only the exact stored strings count; anything else means "no choice saved". */
export function parseTheme(raw: string | null): Theme | null {
  return raw === "light" || raw === "dark" ? raw : null;
}

export function resolveTheme(saved: Theme | null, systemDark: boolean): Theme {
  return saved ?? (systemDark ? "dark" : "light");
}
