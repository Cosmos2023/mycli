import React from "react";
import { Box, Text } from "ink";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

export function activityPath(items: TranscriptItem[]): string {
  const verbs = items
    .filter((item) => item.type === "tool_summary")
    .slice(-3)
    .map(
      (item) =>
        formatToolSummary({
          tool_name:
            item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
          text: item.text,
          metadata: item.metadata,
        }).verb,
    );
  return verbs.join(" → ");
}

export function RunningActivity({
  state,
  elapsedSeconds = 0,
}: {
  state: ShellState;
  elapsedSeconds?: number;
}) {
  if (!state.turnRunning) {
    return null;
  }
  const path = activityPath(state.transcript);
  return (
    <Box marginLeft={2}>
      <Text color={state.theme.warning}>
        thinking {elapsedSeconds}s{path ? ` · ${path}` : ""}
      </Text>
    </Box>
  );
}
