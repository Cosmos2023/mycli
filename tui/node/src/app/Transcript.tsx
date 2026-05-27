import React, { memo } from "react";
import { Box, Text } from "ink";
import { AssistantBlock } from "./AssistantBlock.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import { SystemNotice } from "./SystemNotice.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { UserPromptRow } from "./UserPromptRow.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

const TranscriptRow = memo(function TranscriptRow({
  item,
  viewMode,
  theme,
  width,
}: {
  item: TranscriptItem;
  viewMode: ShellState["viewMode"];
  theme: ThemeTokens;
  width: number;
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
        width={width}
      />
    );
  }
  if (item.type === "command_output") {
    return <CommandOutput text={item.text} theme={theme} />;
  }
  if (item.type === "system_notice" || item.type === "warning" || item.type === "error") {
    return <SystemNotice text={item.text} type={item.type} theme={theme} />;
  }
  if (item.type === "user") {
    return <UserPromptRow text={item.text} theme={theme} width={width} />;
  }
  if (item.type === "assistant_stream") {
    return <AssistantBlock text={item.text} final={false} theme={theme} width={width} />;
  }
  if (item.type === "assistant_final") {
    return <AssistantBlock text={item.text} final={true} theme={theme} width={width} />;
  }
  const marker = " ";
  const text = item.folded && viewMode === "default" ? `${item.text}` : item.text;
  return (
    <Box>
      <Text dimColor={item.type === "execution_status"}>{marker} {text}</Text>
    </Box>
  );
});

export function Transcript({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.transcript.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          viewMode={state.viewMode}
          theme={state.theme}
          width={width}
        />
      ))}
    </Box>
  );
}
