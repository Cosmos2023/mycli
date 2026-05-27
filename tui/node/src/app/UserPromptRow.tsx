import React from "react";
import { Box, Text } from "ink";
import { contentWidth, DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function UserPromptRow({
  text,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  text: string;
  theme: ThemeTokens;
  width?: number;
}) {
  return (
    <Box width={contentWidth(width) + 4}>
      <Text color={theme.accent} bold>
        ❯{" "}
      </Text>
      <Box width={contentWidth(width)}>
        <Text color={theme.text} bold>
          {text}
        </Text>
      </Box>
    </Box>
  );
}
