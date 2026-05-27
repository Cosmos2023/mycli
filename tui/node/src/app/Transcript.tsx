import React, { memo } from "react";
import { Box, Text } from "ink";
import type { ShellState, TranscriptItem } from "../state/types.ts";

const TranscriptRow = memo(function TranscriptRow({
  item,
  viewMode,
}: {
  item: TranscriptItem;
  viewMode: ShellState["viewMode"];
}) {
  if (item.type === "tool_detail" && viewMode !== "verbose") {
    return null;
  }
  const marker = item.type === "user" ? ">" : item.type === "tool_summary" ? "." : " ";
  const text = item.folded && viewMode === "default" ? `${item.text}` : item.text;
  return (
    <Box>
      <Text dimColor={item.type === "tool_summary"}>
        {marker} {text}
      </Text>
    </Box>
  );
});

export function Transcript({ state }: { state: ShellState }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.transcript.map((item) => (
        <TranscriptRow key={item.id} item={item} viewMode={state.viewMode} />
      ))}
      {state.turnRunning ? <Text dimColor>Thinking...</Text> : null}
    </Box>
  );
}
