import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolResultRow({ text, theme }: { text: string; theme: ThemeTokens }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" marginLeft={0}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.subtle}>
          {index === 0 ? "⎿ " : "  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
