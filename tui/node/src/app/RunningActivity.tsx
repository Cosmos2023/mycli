import React from "react";
import { Box, Text } from "ink";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ShellState, TranscriptItem, TurnLiveState } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

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
  const liveState = state.liveStatus?.state ?? "running";
  const label = state.liveStatus?.text || "Thinking";
  const style = activityStyle(liveState, state.theme);
  return (
    <Box marginLeft={0}>
      <Text color={style.color}>
        {style.glyph} {label} {elapsedSeconds}s{path ? ` · ${path}` : ""}
      </Text>
    </Box>
  );
}

export function activityStyle(
  state: TurnLiveState,
  theme: ThemeTokens,
): { color: string; glyph: string } {
  if (state === "waiting_approval") {
    return { color: theme.warning, glyph: "!" };
  }
  if (state === "failed" || state === "interrupted") {
    return { color: theme.error, glyph: "x" };
  }
  if (state === "completed") {
    return { color: theme.success, glyph: "✓" };
  }
  return { color: theme.accent, glyph: "●" };
}
