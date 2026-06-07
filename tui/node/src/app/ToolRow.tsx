import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function statusLabel(status: ToolSummary["status"]): string {
  switch (status) {
    case "failed":
      return "x";
    case "running":
      return "●";
    default:
      return "✓";
  }
}

function statusColor(status: ToolSummary["status"], theme: ThemeTokens): string {
  switch (status) {
    case "failed":
      return theme.error;
    case "running":
      return theme.warning;
    default:
      return theme.success;
  }
}

export function ToolRow({
  summary,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  summary: ToolSummary;
  theme: ThemeTokens;
  width?: number;
}) {
  const targetWidth = width < 90 ? 42 : 64;
  const target = truncateMiddle(summary.target, targetWidth);
  const detailParts = [summary.reason, summary.detail, summary.changes, summary.hint].filter(
    (part): part is string => Boolean(part),
  );
  const detail = detailParts.length > 0 ? ` · ${detailParts.join(" · ")}` : "";
  const label = statusLabel(summary.status);
  const color = statusColor(summary.status, theme);

  return (
    <Box marginLeft={0}>
      <Text color={color}>{label}</Text>
      <Text color={theme.muted}> </Text>
      <Text color={theme.accent}>{titleCase(summary.verb)}</Text>
      <Text color={theme.muted}>
        {" "}
        {target}
        {detail}
      </Text>
    </Box>
  );
}
