import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, modelLabel, truncateMiddle } from "./layout.ts";
import type { LiveStatus, ShellState } from "../state/types.ts";

const STATUS_MESSAGE_MAX_WIDTH = 48;

export function statusMetadata(state: ShellState): string {
  const session = state.sessionId ? truncateMiddle(state.sessionId, 18) : "pending";
  const model = modelLabel(state.model, 24);
  const parts = [session, model, state.themeName, formatContextUsage(state.status)];
  if (state.liveStatus && state.liveStatus.state !== "completed") {
    parts.push(statusLabel(state.liveStatus));
  }
  if (state.pendingApproval) {
    parts.push("approval pending");
  }
  return parts.join(" · ");
}

function statusLabel(status: LiveStatus): string {
  if (!status.message) {
    return status.text;
  }
  return `${status.text}: ${truncateMiddle(status.message, STATUS_MESSAGE_MAX_WIDTH)}`;
}

export function StatusLine({ state }: { state: ShellState }) {
  return (
    <Box>
      <Text color={state.theme.muted}>{statusMetadata(state)}</Text>
    </Box>
  );
}
