import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, workspaceLabel } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function statusMetadata(state: ShellState): string {
  const parts = [
    workspaceLabel(state.workspace, 20),
    state.viewMode,
    state.themeName,
    formatContextUsage(state.status),
  ];
  if (state.pendingApproval) {
    parts.push("approval pending");
  }
  return parts.join(" · ");
}

export function StatusLine({ state }: { state: ShellState }) {
  return (
    <Box>
      <Text color={state.theme.muted}>{statusMetadata(state)}</Text>
    </Box>
  );
}
