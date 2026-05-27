import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

export function hasConversationContent(items: TranscriptItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "user" ||
      item.type === "assistant_stream" ||
      item.type === "assistant_final" ||
      item.type === "tool_summary" ||
      item.type === "tool_detail",
  );
}

function welcomeItem(state: ShellState): TranscriptItem | undefined {
  return state.transcript.find(
    (item) => item.type === "system_notice" && typeof item.metadata.startup_mark === "object",
  );
}

export function WelcomePanel({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  if (hasConversationContent(state.transcript)) {
    return null;
  }
  const item = welcomeItem(state);
  if (!item) {
    return null;
  }
  const workspace = truncateMiddle(state.workspace || "workspace pending", Math.max(24, width - 32));
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color={state.theme.accent}>{item.text}</Text>
      <Text color={state.theme.subtle}>ready · {workspace} · /help for commands</Text>
    </Box>
  );
}
