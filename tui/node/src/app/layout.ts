export const DEFAULT_TERMINAL_WIDTH = 100;
export const MIN_CONTENT_WIDTH = 56;
export const MAX_CONTENT_WIDTH = 100;

export function truncateMiddle(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 1) {
    return "…".slice(0, maxWidth);
  }
  const left = maxWidth <= 5 ? 2 : maxWidth <= 12 ? 4 : Math.min(6, maxWidth - 9);
  const right = maxWidth <= 5 ? 2 : maxWidth <= 12 ? 5 : Math.min(8, maxWidth - left - 1);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

export function workspaceLabel(value: string, maxWidth = 28): string {
  const parts = value.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? value;
  return truncateMiddle(basename || "workspace", maxWidth);
}

export function modelLabel(value: string, maxWidth = 28): string {
  const parts = value.split("/").filter(Boolean);
  const label = parts.at(-1) ?? value;
  return truncateMiddle(label || "model", maxWidth);
}

function compactTokenCount(value: number): string {
  if (value >= 1000) {
    const rounded = value % 1000 === 0 ? String(value / 1000) : (value / 1000).toFixed(1);
    return `${rounded.replace(/\.0$/, "")}k`;
  }
  return value.toLocaleString("en-US");
}

export function formatContextUsage(status: Record<string, unknown>): string {
  const context = status.context_window as
    | { used_tokens?: unknown; max_tokens?: unknown }
    | undefined;
  const used = typeof context?.used_tokens === "number" ? context.used_tokens : null;
  const max = typeof context?.max_tokens === "number" ? context.max_tokens : null;
  if (used === null || max === null || max <= 0) {
    return "context --";
  }
  const percent = Math.round((used / max) * 100);
  return `${percent}% ${used.toLocaleString("en-US")}/${compactTokenCount(max)}`;
}

export function contentWidth(terminalWidth = DEFAULT_TERMINAL_WIDTH): number {
  const edgeAllowance = terminalWidth <= 80 ? 8 : 12;
  const available = Math.max(terminalWidth - edgeAllowance, MIN_CONTENT_WIDTH);
  return Math.min(Math.max(available, MIN_CONTENT_WIDTH), MAX_CONTENT_WIDTH);
}
