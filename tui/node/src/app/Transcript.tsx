import React, { memo } from "react";
import { Box, Text } from "ink";
import { CommandOutput } from "./CommandOutput.tsx";
import { MarkdownText } from "./MarkdownText.tsx";
import { SystemNotice } from "./SystemNotice.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

const TranscriptRow = memo(function TranscriptRow({
  item,
  viewMode,
  theme,
}: {
  item: TranscriptItem;
  viewMode: ShellState["viewMode"];
  theme: ThemeTokens;
}) {
  if (item.type === "tool_detail" && viewMode !== "verbose") {
    return null;
  }
  if (item.type === "system_notice" && typeof item.metadata.startup_mark === "object") {
    return null;
  }
  if (item.type === "tool_summary") {
    return (
      <ToolRow
        summary={formatToolSummary({
          tool_name:
            item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
          text: item.text,
          metadata: item.metadata,
        })}
        theme={theme}
      />
    );
  }
  if (item.type === "command_output") {
    return <CommandOutput text={item.text} theme={theme} />;
  }
  if (item.type === "system_notice" || item.type === "warning" || item.type === "error") {
    return <SystemNotice text={item.text} type={item.type} theme={theme} />;
  }
  if (item.type === "assistant_final") {
    return <MarkdownText text={item.text} theme={theme} />;
  }
  const marker = item.type === "user" ? ">" : " ";
  const text = item.folded && viewMode === "default" ? `${item.text}` : item.text;
  return (
    <Box>
      <Text dimColor={item.type === "execution_status"}>{marker} {text}</Text>
    </Box>
  );
});

export function Transcript({ state }: { state: ShellState }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.transcript.map((item) => (
        <TranscriptRow key={item.id} item={item} viewMode={state.viewMode} theme={state.theme} />
      ))}
      {state.turnRunning ? <Text dimColor>Thinking...</Text> : null}
    </Box>
  );
}
