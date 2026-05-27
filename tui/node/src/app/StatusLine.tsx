import React from "react";
import { Box, Text } from "ink";
import type { ShellState } from "../state/types.ts";

function formatNumber(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "0";
}

export function StatusLine({ state }: { state: ShellState }) {
  const context = state.status.context_window as
    | { used_tokens?: number; max_tokens?: number }
    | undefined;
  return (
    <Box justifyContent="space-between">
      <Text dimColor>{state.workspace}</Text>
      <Text dimColor>
        {state.model} context {formatNumber(context?.used_tokens)} /{" "}
        {formatNumber(context?.max_tokens)}
      </Text>
    </Box>
  );
}
