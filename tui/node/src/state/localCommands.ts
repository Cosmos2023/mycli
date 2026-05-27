import { THEMES } from "../theme/themes.ts";
import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ShellAction } from "./reducer.ts";
import type { ShellState } from "./types.ts";

const LOCAL_COMMANDS = new Set(["/theme", "/clear"]);

export function commandName(raw: string): string {
  return raw.trim().split(/\s+/, 1)[0] ?? "";
}

export function isLocalCommand(raw: string): boolean {
  return LOCAL_COMMANDS.has(commandName(raw));
}

export function handleLocalCommand(raw: string, state: ShellState): ShellAction {
  const trimmed = raw.trim();
  const name = commandName(trimmed);
  if (name === "/clear") {
    return { type: "transcript.cleared", message: "Visible transcript cleared." };
  }
  if (name === "/theme") {
    const requested = trimmed.split(/\s+/, 2)[1];
    if (!requested) {
      return {
        type: "local.command_output",
        command: "/theme",
        lines: [
          `current=${state.themeName}`,
          `available=${Object.keys(THEMES).join(", ")}`,
          "usage=/theme <name>",
        ],
      };
    }
    const resolved = resolveTheme(requested);
    if (!resolved.ok) {
      return {
        type: "theme.failed",
        message: `Unknown theme: ${requested}. Keeping ${state.themeName}.`,
      };
    }
    return {
      type: "theme.changed",
      themeName: resolved.name,
      theme: resolved.theme,
      message: `Theme changed to ${resolved.name}.`,
    };
  }
  return {
    type: "local.command_output",
    command: trimmed,
    lines: [`Unknown local command: ${trimmed}`],
  };
}
