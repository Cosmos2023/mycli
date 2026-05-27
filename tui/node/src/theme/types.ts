export type ThemeName = "deep-teal" | "graphite" | "mono" | "amber";

export type ThemeTokens = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  code: string;
};

export type ThemeResolution =
  | { ok: true; name: ThemeName; theme: ThemeTokens }
  | { ok: false; fallbackName: ThemeName; theme: ThemeTokens; message: string };
