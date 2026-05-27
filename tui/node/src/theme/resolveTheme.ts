import { DEFAULT_THEME_NAME, THEMES } from "./themes.ts";
import type { ThemeName, ThemeResolution } from "./types.ts";

export function isThemeName(value: string): value is ThemeName {
  return Object.hasOwn(THEMES, value);
}

export function resolveTheme(rawName: string | undefined): ThemeResolution {
  const requested = rawName?.trim();
  if (!requested) {
    return { ok: true, name: DEFAULT_THEME_NAME, theme: THEMES[DEFAULT_THEME_NAME] };
  }
  if (isThemeName(requested)) {
    return { ok: true, name: requested, theme: THEMES[requested] };
  }
  return {
    ok: false,
    fallbackName: DEFAULT_THEME_NAME,
    theme: THEMES[DEFAULT_THEME_NAME],
    message: `Unknown theme: ${requested}. Using ${DEFAULT_THEME_NAME}.`,
  };
}
