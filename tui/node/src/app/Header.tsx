import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, formatContextUsage, modelLabel, workspaceLabel } from "./layout.ts";
import { trustLabel } from "./trust.ts";
import { Badge } from "./ui/Badge.tsx";
import { StatusPill } from "./ui/StatusPill.tsx";
import type { ShellState } from "../state/types.ts";

export function Header({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const workspace = workspaceLabel(state.workspace, width < 90 ? 30 : 44);
  const model = modelLabel(state.model, width < 90 ? 20 : 28);
  const provider = state.provider ? state.provider : "provider pending";
  const title = state.sessionTitle?.trim();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" flexWrap="wrap">
        <Badge variant="default" theme={state.theme} bold>
          mycli
        </Badge>
        <Text color={state.theme.subtle}>  </Text>
        <StatusPill label="workspace" value={workspace} theme={state.theme} maxWidth={44} />
        <Text color={state.theme.subtle}> · </Text>
        <StatusPill label="trust" value={trustLabel(state)} theme={state.theme} maxWidth={18} />
        <Text color={state.theme.subtle}> · </Text>
        <StatusPill label="model" value={model} theme={state.theme} maxWidth={28} />
        {title ? (
          <>
            <Text color={state.theme.subtle}> · </Text>
            <StatusPill label="title" value={title} theme={state.theme} maxWidth={32} />
          </>
        ) : null}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" marginTop={0}>
        <StatusPill label="provider" value={provider} theme={state.theme} maxWidth={32} />
        <Text color={state.theme.subtle}> · </Text>
        <StatusPill
          label="ctx"
          value={formatContextUsage(state.status)}
          theme={state.theme}
          maxWidth={18}
        />
        <Text color={state.theme.subtle}> · </Text>
        <StatusPill label="theme" value={state.themeName} theme={state.theme} maxWidth={16} />
      </Box>
    </Box>
  );
}
