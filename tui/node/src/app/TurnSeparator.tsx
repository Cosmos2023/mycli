import React from "react";
import { Box } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function TurnSeparator({
  theme: _theme,
  width: _width,
}: {
  theme: ThemeTokens;
  width?: number;
}) {
  return <Box height={1} />;
}
