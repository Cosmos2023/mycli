import React from "react";
import { Box, Text } from "ink";
import type { OverlayState } from "../state/types.ts";

export function Overlay({ overlay }: { overlay: OverlayState }) {
  if (!overlay.visible) {
    return null;
  }
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold>{overlay.title}</Text>
      {overlay.lines.map((line, index) => (
        <Text key={`${index}:${line}`}>{line}</Text>
      ))}
    </Box>
  );
}
