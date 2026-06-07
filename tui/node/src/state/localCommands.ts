import { THEMES } from "../theme/themes.ts";
import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ShellAction } from "./reducer.ts";
import { catalogHelpLines, commandName, isLocalSlashCommand } from "./slashCatalog.ts";
import type { ShellState, TranscriptItem } from "./types.ts";

const LOCAL_OVERLAY_LIMIT = 40;

export function isLocalCommand(raw: string): boolean {
  return isLocalSlashCommand(raw);
}

export function handleLocalCommand(raw: string, state: ShellState): ShellAction {
  const trimmed = raw.trim();
  const name = commandName(trimmed);
  if (name === "/help" || name === "/?") {
    return {
      type: "command.result",
      command: "/help",
      result: { lines: catalogHelpLines(), presentation: "overlay" },
    };
  }
  if (name === "/clear") {
    return { type: "transcript.cleared", message: "Visible transcript cleared." };
  }
  if (name === "/history") {
    return localOverlay(trimmed, "history", historyLines(state.transcript));
  }
  if (name === "/search") {
    const query = trimmed.split(/\s+/, 2)[1]?.trim() ?? "";
    if (!query) {
      return localOverlay(trimmed, "transcript search", ["usage: /search <query>"]);
    }
    return localOverlay(trimmed, "transcript search", searchLines(state.transcript, query));
  }
  if (name === "/export") {
    return localOverlay(trimmed, "transcript export preview", exportLines(state.transcript));
  }
  if (name === "/copy") {
    return localOverlay(trimmed, "manual copy", copyLines(state.transcript));
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

function localOverlay(command: string, presentationHint: string, lines: string[]): ShellAction {
  return {
    type: "command.result",
    command,
    result: {
      presentation: "overlay",
      presentation_hint: presentationHint,
      lines: boundedLines(lines),
    },
  };
}

function boundedLines(lines: string[]): string[] {
  return lines.slice(0, LOCAL_OVERLAY_LIMIT);
}

function historyLines(items: TranscriptItem[]): string[] {
  const visible = items.filter((item) => !item.folded || item.type !== "tool_detail").slice(-20);
  if (visible.length === 0) {
    return ["No visible transcript yet."];
  }
  return visible.map((item) => `${labelFor(item)} ${compactText(item.text)}`);
}

function searchLines(items: TranscriptItem[], query: string): string[] {
  const lowered = query.toLowerCase();
  const matches = items
    .filter((item) => item.text.toLowerCase().includes(lowered))
    .slice(-20)
    .map((item) => `${labelFor(item)} ${compactText(item.text)}`);
  return matches.length > 0 ? [`${matches.length} matches for "${query}"`, "", ...matches] : [`No matches for "${query}".`];
}

function exportLines(items: TranscriptItem[]): string[] {
  if (items.length === 0) {
    return ["No visible transcript to export."];
  }
  return [
    "Preview only. No file was written.",
    "",
    ...items.slice(-30).map((item) => `${labelFor(item)} ${compactText(item.text, 160)}`),
  ];
}

function copyLines(items: TranscriptItem[]): string[] {
  const assistant = [...items].reverse().find((item) => item.type === "assistant_final" || item.type === "assistant_stream");
  if (!assistant) {
    return ["No assistant message is available for copy preview."];
  }
  return ["Latest assistant message:", "", ...assistant.text.split("\n").slice(0, LOCAL_OVERLAY_LIMIT - 2)];
}

function labelFor(item: TranscriptItem): string {
  switch (item.type) {
    case "user":
      return "user:";
    case "assistant_final":
    case "assistant_stream":
      return "assistant:";
    case "tool_summary":
      return "tool:";
    case "command_output":
      return "command:";
    case "error":
      return "error:";
    case "warning":
      return "warning:";
    default:
      return `${item.type}:`;
  }
}

function compactText(text: string, maxLength = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}
