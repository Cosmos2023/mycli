import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme } from "../src/theme/resolveTheme.ts";
import { THEMES } from "../src/theme/themes.ts";

test("resolves the default deep-teal theme when no name is provided", () => {
  const resolved = resolveTheme(undefined);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.name, "deep-teal");
  assert.equal(resolved.theme.accent, THEMES["deep-teal"].accent);
});

test("resolves every built-in theme with the required semantic tokens", () => {
  const required = [
    "background",
    "surface",
    "surfaceRaised",
    "border",
    "text",
    "muted",
    "subtle",
    "accent",
    "success",
    "warning",
    "error",
    "code",
  ] as const;

  for (const name of ["deep-teal", "graphite", "mono", "amber"] as const) {
    const theme = THEMES[name];
    for (const token of required) {
      assert.equal(typeof theme[token], "string", `${name}.${token}`);
      assert.notEqual(theme[token].trim(), "", `${name}.${token}`);
    }
  }
});

test("unknown theme falls back to deep-teal with a message", () => {
  const resolved = resolveTheme("unknown-theme");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.fallbackName, "deep-teal");
  assert.match(resolved.message, /Unknown theme: unknown-theme/);
  assert.equal(resolved.theme.accent, THEMES["deep-teal"].accent);
});
