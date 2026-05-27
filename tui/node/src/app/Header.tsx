import React from "react";
import { Box, Text } from "ink";
import {
  DEFAULT_TERMINAL_WIDTH,
  formatContextUsage,
  modelLabel,
  truncateMiddle,
  workspaceLabel,
} from "./layout.ts";
import type { ShellState } from "../state/types.ts";

function fitRightSegment(state: ShellState, width: number): string {
  const model = modelLabel(state.model, width < 90 ? 18 : 28);
  const context = formatContextUsage(state.status);
  const full = `${model} · ${context} · ${state.themeName}`;
  if (full.length <= Math.max(18, Math.floor(width * 0.42))) {
    return full;
  }
  const withoutTheme = `${model} · ${context}`;
  if (withoutTheme.length <= Math.max(18, Math.floor(width * 0.42))) {
    return withoutTheme;
  }
  return truncateMiddle(withoutTheme, Math.max(18, Math.floor(width * 0.42)));
}

export function Header({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const workspace = workspaceLabel(state.workspace, width < 90 ? 22 : 34);
  const session = state.sessionId ? truncateMiddle(state.sessionId, width < 90 ? 14 : 22) : "pending";
  const center = width < 90 ? session : `session ${session} · ${state.viewMode}`;
  const right = fitRightSegment(state, width);
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between" width={dividerWidth}>
        <Text>
          <Text color={state.theme.accent} bold>
            mycli
          </Text>
          <Text color={state.theme.muted}>  {workspace}</Text>
        </Text>
        <Text color={state.theme.subtle}>{center}</Text>
        <Text color={state.theme.muted}>{right}</Text>
      </Box>
      <Text color={state.theme.border}>{"─".repeat(dividerWidth)}</Text>
    </Box>
  );
}
