import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function CommandOutput({ text, theme }: { text: string; theme: ThemeTokens }) {
  return (
    <Box marginLeft={2}>
      <Text color={theme.muted}>{text}</Text>
    </Box>
  );
}
