import React from "react";
import { Box, Text } from "ink";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolRow({ summary, theme }: { summary: ToolSummary; theme: ThemeTokens }) {
  const statusColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : summary.status === "done"
          ? theme.success
          : theme.muted;
  return (
    <Box marginLeft={2}>
      <Text color={statusColor}>{summary.verb}</Text>
      <Text color={theme.subtle}> - </Text>
      <Text color={theme.muted}>{summary.target}</Text>
      {summary.detail ? (
        <>
          <Text color={theme.subtle}> - </Text>
          <Text color={theme.subtle}>{summary.detail}</Text>
        </>
      ) : null}
    </Box>
  );
}
