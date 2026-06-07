import React, { memo } from "react";
import { Box, Text } from "ink";
import { CommandOutput } from "./CommandOutput.tsx";
import {
  groupTranscriptIntoTurns,
  isStartupNotice,
  visibleTurnsForMode,
} from "./displayModel.ts";
import { SystemNotice } from "./SystemNotice.tsx";
import { TurnSeparator } from "./TurnSeparator.tsx";
import { TranscriptTurn } from "./TranscriptTurn.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

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
    return (
      <SystemNotice text={item.text} type={item.type} theme={theme} metadata={item.metadata} />
    );
  }
  return (
    <Box>
      <Text dimColor>{item.text}</Text>
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
          <TranscriptTurn turn={turn} theme={state.theme} viewMode={state.viewMode} width={width} />
        </Box>
      ))}
    </Box>
  );
}
