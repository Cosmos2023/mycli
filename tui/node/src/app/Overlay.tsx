import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function Overlay({
  overlay,
  theme,
  maxLines = 12,
}: {
  overlay: OverlayState;
  theme: ThemeTokens;
  maxLines?: number;
}) {
  if (!overlay.visible) {
    return null;
  }
  const visibleLines = overlay.lines.slice(0, maxLines);
  const hidden = Math.max(overlay.lines.length - visibleLines.length, 0);
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold>
          {overlay.title}
        </Text>
        <Text color={theme.subtle}>overlay</Text>
      </Box>
      {visibleLines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text}>
          {line}
        </Text>
      ))}
      {hidden > 0 ? <Text color={theme.warning}>{hidden} more lines truncated</Text> : null}
      <Text color={theme.subtle}>Esc close</Text>
    </Box>
  );
}
