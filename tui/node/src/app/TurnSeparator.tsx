import React from "react";
import { Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function TurnSeparator({
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  theme: ThemeTokens;
  width?: number;
}) {
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));
  return <Text color={theme.border}>{"─".repeat(dividerWidth)}</Text>;
}
