import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolRow({
  summary,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  summary: ToolSummary;
  theme: ThemeTokens;
  width?: number;
}) {
  const statusColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : summary.status === "done"
          ? theme.success
          : theme.muted;
  const targetWidth = width < 90 ? 28 : 44;
  const target = truncateMiddle(summary.target, targetWidth);
  const status = summary.detail ? `${summary.status} ${summary.detail}` : summary.status;

  return (
    <Box marginLeft={2}>
      <Box width={8}>
        <Text color={statusColor}>{truncateMiddle(summary.verb, 7)}</Text>
      </Box>
      <Box width={targetWidth + 2}>
        <Text color={theme.muted}>{target}</Text>
      </Box>
      <Text color={statusColor}>{status}</Text>
    </Box>
  );
}
