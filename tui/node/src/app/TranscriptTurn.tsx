import React from "react";
import { Box, Text } from "ink";
import { AssistantBlock } from "./AssistantBlock.tsx";
import { ClarificationRow } from "./ClarificationRow.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { SystemNotice } from "./SystemNotice.tsx";
import { ToolResultRow } from "./ToolResultRow.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { UserPromptRow } from "./UserPromptRow.tsx";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { DisplayTurn } from "./displayModel.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

function toolSummaryFor(item: TranscriptItem) {
  return formatToolSummary({
    tool_name: item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
    text: item.text,
    metadata: item.metadata,
  });
}

export function TranscriptTurn({
  turn,
  theme,
  viewMode,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  turn: DisplayTurn;
  theme: ThemeTokens;
  viewMode: ShellState["viewMode"];
  width?: number;
}) {
  const assistant = turn.assistantFinal ?? turn.assistantStream;

  return (
    <Box flexDirection="column">
      {turn.user ? <UserPromptRow text={turn.user.text} theme={theme} width={width} /> : null}
      {turn.approvals.map((item) => (
        <SystemNotice key={item.id} text={item.text} type="system_notice" theme={theme} />
      ))}
      {turn.clarifications.map((item) => (
        <ClarificationRow key={item.id} item={item} theme={theme} />
      ))}
      {turn.tools.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {turn.tools.map((item) => (
            <ToolRow key={item.id} summary={toolSummaryFor(item)} theme={theme} width={width} />
          ))}
        </Box>
      ) : null}
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
        <SystemNotice
          key={item.id}
          text={item.text}
          type={item.type}
          theme={theme}
          metadata={item.metadata}
        />
      ))}
    </Box>
  );
}
