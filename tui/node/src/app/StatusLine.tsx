import React from "react";
import { Box, Text } from "ink";
import type { ShellState } from "../state/types.ts";

function formatNumber(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "0";
}

function workspaceLabel(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

export function StatusLine({ state }: { state: ShellState }) {
  const context = state.status.context_window as
    | { used_tokens?: number; max_tokens?: number }
    | undefined;
  return (
    <Box justifyContent="space-between">
      <Text color={state.theme.muted}>
        {workspaceLabel(state.workspace)} · {state.viewMode} · {state.themeName}
      </Text>
      <Text color={state.theme.muted}>
        {state.model} · context {formatNumber(context?.used_tokens)} /{" "}
        {formatNumber(context?.max_tokens)}
        {state.pendingApproval ? " · approval pending" : ""}
      </Text>
    </Box>
  );
}
