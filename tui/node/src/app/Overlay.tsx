import React from "react";
import { Box, Text } from "ink";
import { Badge } from "./ui/Badge.tsx";
import { Panel } from "./ui/Panel.tsx";
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
    <Panel
      title={overlay.title}
      subtitle={overlay.presentationHint ?? "command output"}
      theme={theme}
      footer="Esc close"
      borderColor={theme.border}
    >
      <Box>
        <Badge variant="info" theme={theme}>
          overlay
        </Badge>
      </Box>
      {visibleLines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text}>
          {line}
        </Text>
      ))}
      {hidden > 0 ? <Text color={theme.warning}>{hidden} more lines truncated</Text> : null}
    </Panel>
  );
}
