import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, modelLabel, truncateMiddle } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function statusMetadata(state: ShellState): string {
  const session = state.sessionId ? truncateMiddle(state.sessionId, 18) : "pending";
  const model = modelLabel(state.model, 24);
  const parts = [session, model, state.themeName, formatContextUsage(state.status)];
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
