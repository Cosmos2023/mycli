import React from "react";
import { Box, Text } from "ink";
import { contentWidth, DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import type { ThemeTokens } from "../theme/types.ts";

export function AssistantBlock({
  text,
  final,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  text: string;
  final: boolean;
  theme: ThemeTokens;
  width?: number;
}) {
  const columnWidth = contentWidth(width);
  return (
    <Box marginLeft={1}>
      <Text color={theme.border}>│ </Text>
      <Box width={columnWidth} flexDirection="column">
        {final ? (
          <MarkdownText text={text} theme={theme} width={columnWidth} />
        ) : (
          <Text color={theme.text}>{text}</Text>
        )}
      </Box>
    </Box>
  );
}
