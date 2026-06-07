import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, modelLabel, truncateMiddle } from "./layout.ts";
import { trustLabel } from "./trust.ts";
import { StatusPill } from "./ui/StatusPill.tsx";
import type { LiveStatus, ShellState } from "../state/types.ts";

const STATUS_MESSAGE_MAX_WIDTH = 48;

export function statusMetadata(state: ShellState): string {
  const session = state.sessionId ? truncateMiddle(state.sessionId, 18) : "pending";
  const model = modelLabel(state.model, 24);
  const parts = [
    `sess: ${session}`,
    ...(state.sessionTitle ? [`title: ${truncateMiddle(state.sessionTitle, 24)}`] : []),
    `model: ${model}`,
    `trust: ${trustLabel(state)}`,
    `theme: ${state.themeName}`,
    `ctx: ${formatContextUsage(state.status)}`,
  ];
  if (state.liveStatus && state.liveStatus.state !== "completed") {
    parts.push(statusLabel(state.liveStatus));
  }
  if (state.pendingApproval) {
    parts.push("approval pending");
  }
  if (state.pendingClarification) {
    parts.push("clarification pending");
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
  const session = state.sessionId ? truncateMiddle(state.sessionId, 18) : "pending";
  const model = modelLabel(state.model, 24);
  const title = state.sessionTitle ? truncateMiddle(state.sessionTitle, 24) : null;
  const live =
    state.liveStatus && state.liveStatus.state !== "completed"
      ? statusLabel(state.liveStatus)
      : null;
  return (
    <Box flexDirection="row" flexWrap="wrap">
      <StatusPill label="session" value={session} theme={state.theme} maxWidth={18} />
      {title ? (
        <>
          <Text color={state.theme.subtle}> · </Text>
          <StatusPill label="title" value={title} theme={state.theme} maxWidth={24} />
        </>
      ) : null}
      <Text color={state.theme.subtle}> · </Text>
      <StatusPill label="model" value={model} theme={state.theme} maxWidth={24} />
      <Text color={state.theme.subtle}> · </Text>
      <StatusPill label="trust" value={trustLabel(state)} theme={state.theme} maxWidth={18} />
      <Text color={state.theme.subtle}> · </Text>
      <StatusPill label="theme" value={state.themeName} theme={state.theme} maxWidth={16} />
      <Text color={state.theme.subtle}> · </Text>
      <StatusPill
        label="ctx"
        value={formatContextUsage(state.status)}
        theme={state.theme}
        maxWidth={18}
      />
      {live ? (
        <>
          <Text color={state.theme.subtle}> · </Text>
          <StatusPill label="turn" value={live} theme={state.theme} maxWidth={54} />
        </>
      ) : null}
      {state.pendingApproval ? (
        <>
          <Text color={state.theme.subtle}> · </Text>
          <Text color={state.theme.warning}>approval pending</Text>
        </>
      ) : null}
      {state.pendingClarification ? (
        <>
          <Text color={state.theme.subtle}> · </Text>
          <Text color={state.theme.warning}>clarification pending</Text>
        </>
      ) : null}
    </Box>
  );
}
