import React, { memo } from "react";
import { Box, Text } from "ink";
import { AssistantBlock } from "./AssistantBlock.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import {
  groupTranscriptIntoTurns,
  isStartupNotice,
  visibleTurnsForMode,
  type DisplayTurn,
} from "./displayModel.ts";
import { SystemNotice } from "./SystemNotice.tsx";
import { ToolResultRow } from "./ToolResultRow.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { TurnSeparator } from "./TurnSeparator.tsx";
import { UserPromptRow } from "./UserPromptRow.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

function toolSummaryFor(item: TranscriptItem) {
  return formatToolSummary({
    tool_name: item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
    text: item.text,
    metadata: item.metadata,
  });
}

const PreludeRow = memo(function PreludeRow({
  item,
  theme,
}: {
  item: TranscriptItem;
  theme: ThemeTokens;
}) {
  if (isStartupNotice(item)) {
    return null;
  }
  if (item.type === "command_output") {
    return <CommandOutput text={item.text} theme={theme} />;
  }
  if (item.type === "system_notice" || item.type === "warning" || item.type === "error") {
    return <SystemNotice text={item.text} type={item.type} theme={theme} />;
  }
  return (
    <Box>
      <Text dimColor>{item.text}</Text>
    </Box>
  );
});

const TurnView = memo(function TurnView({
  turn,
  theme,
  viewMode,
  width,
}: {
  turn: DisplayTurn;
  theme: ThemeTokens;
  viewMode: ShellState["viewMode"];
  width: number;
}) {
  const assistant = turn.assistantFinal ?? turn.assistantStream;
  return (
    <Box flexDirection="column">
      {turn.user ? <UserPromptRow text={turn.user.text} theme={theme} width={width} /> : null}
      {turn.approvals.map((item) => (
        <SystemNotice key={item.id} text={item.text} type="system_notice" theme={theme} />
      ))}
      {turn.tools.map((item) => (
        <ToolRow key={item.id} summary={toolSummaryFor(item)} theme={theme} width={width} />
      ))}
      {viewMode === "verbose"
        ? turn.toolDetails.map((item) => (
            <ToolResultRow key={item.id} text={item.text} theme={theme} />
          ))
        : null}
      {turn.statuses.map((item) => (
        <Text key={item.id} color={theme.subtle}>
          {item.text}
        </Text>
      ))}
      {assistant ? (
        <AssistantBlock
          text={assistant.text}
          final={assistant.type === "assistant_final"}
          theme={theme}
          width={width}
        />
      ) : null}
      {turn.notices.map((item) =>
        item.type === "command_output" ? (
          <CommandOutput key={item.id} text={item.text} theme={theme} />
        ) : (
          <SystemNotice key={item.id} text={item.text} type={item.type} theme={theme} />
        ),
      )}
      {turn.errors.map((item) => (
        <SystemNotice key={item.id} text={item.text} type={item.type} theme={theme} />
      ))}
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
  const grouped = groupTranscriptIntoTurns(state.transcript);
  const turns = visibleTurnsForMode(grouped.turns, state.viewMode);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {grouped.prelude.map((item) => (
        <PreludeRow key={item.id} item={item} theme={state.theme} />
      ))}
      {turns.map((turn, index) => (
        <Box key={turn.id} flexDirection="column">
          {index > 0 && state.viewMode !== "focus" ? (
            <TurnSeparator theme={state.theme} width={width} />
          ) : null}
          <TurnView turn={turn} theme={state.theme} viewMode={state.viewMode} width={width} />
        </Box>
      ))}
    </Box>
  );
}
