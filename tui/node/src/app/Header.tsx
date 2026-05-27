import React from "react";
import { Box, Text } from "ink";
import type { ShellState } from "../state/types.ts";

function workspaceLabel(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

export function Header({ state }: { state: ShellState }) {
  const session = state.sessionId ? `session ${state.sessionId}` : "session pending";
  const workspace = state.workspace ? workspaceLabel(state.workspace) : "workspace pending";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text color={state.theme.accent} bold>
          mycli
        </Text>
        <Text color={state.theme.muted}>
          {state.model || "model pending"} · {state.themeName}
        </Text>
      </Box>
      <Text color={state.theme.muted}>
        {session} · {workspace}
      </Text>
    </Box>
  );
}
