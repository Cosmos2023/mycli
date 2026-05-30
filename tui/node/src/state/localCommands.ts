import { THEMES } from "../theme/themes.ts";
import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ShellAction } from "./reducer.ts";
import type { ShellState } from "./types.ts";

const LOCAL_COMMANDS = new Set(["/help", "/theme", "/clear"]);

const HELP_LINES = [
  "Input",
  "  Enter send message or clarification reply",
  "  / starts commands",
  "  Ctrl-C requests interrupt",
  "",
  "Completion popup",
  "  Up/Down move",
  "  Tab accept",
  "  Esc cancel",
  "",
  "Approval and clarification",
  "  Approval: press 1-9 to choose",
  "  Clarification: type a reply; single-select accepts number or label",
  "",
  "Local commands",
  "  /help show this help",
  "  /theme [name] list or change theme",
  "  /clear clear visible transcript",
  "  /view default|verbose|focus changes transcript view",
];

export function commandName(raw: string): string {
  return raw.trim().split(/\s+/, 1)[0] ?? "";
}

export function isLocalCommand(raw: string): boolean {
  return LOCAL_COMMANDS.has(commandName(raw));
}

export function handleLocalCommand(raw: string, state: ShellState): ShellAction {
  const trimmed = raw.trim();
  const name = commandName(trimmed);
  if (name === "/help") {
    return {
      type: "command.result",
      command: "/help",
      result: { lines: HELP_LINES, presentation: "overlay" },
    };
  }
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
