import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, workspaceLabel } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function Header({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const workspace = workspaceLabel(state.workspace, width < 90 ? 30 : 44);
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={state.theme.accent} bold>
          mycli
        </Text>
        <Text color={state.theme.muted}>  {workspace}</Text>
      </Text>
      <Text color={state.theme.border}>{"─".repeat(dividerWidth)}</Text>
    </Box>
  );
}
