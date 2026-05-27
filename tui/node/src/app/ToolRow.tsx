import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
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
  const markerColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : theme.accent;
  const targetWidth = width < 90 ? 42 : 64;
  const target = truncateMiddle(summary.target, targetWidth);
  const detail = summary.detail ? ` · ${summary.detail}` : "";

  return (
    <Box marginLeft={0}>
      <Text color={markerColor}>● </Text>
      <Text color={markerColor}>{titleCase(summary.verb)}</Text>
      <Text color={theme.muted}>
        {" "}
        {target}
        {detail}
      </Text>
    </Box>
  );
}
