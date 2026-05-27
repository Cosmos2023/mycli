import React from "react";
import { Box, Text } from "ink";
import type { TranscriptItemType } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function SystemNotice({
  text,
  type = "system_notice",
  theme,
}: {
  text: string;
  type?: TranscriptItemType;
  theme: ThemeTokens;
}) {
  const color = type === "error" ? theme.error : type === "warning" ? theme.warning : theme.subtle;
  return (
    <Box marginLeft={2}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}
