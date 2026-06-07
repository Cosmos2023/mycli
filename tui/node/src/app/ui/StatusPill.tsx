import React from "react";
import { Text } from "ink";
import { truncateMiddle } from "../layout.ts";
import type { ThemeTokens } from "../../theme/types.ts";

export function StatusPill({
  label,
  value,
  theme,
  maxWidth = 32,
}: {
  label: string;
  value: string;
  theme: ThemeTokens;
  maxWidth?: number;
}) {
  return (
    <Text>
      <Text color={theme.subtle}>{label}: </Text>
      <Text color={theme.muted}>{truncateMiddle(value, maxWidth)}</Text>
    </Text>
  );
}
