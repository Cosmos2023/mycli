import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ThemeTokens } from "../../theme/types.ts";

export function List({
  items,
  theme,
  marker = "›",
}: {
  items: ReactNode[];
  theme: ThemeTokens;
  marker?: string;
}) {
  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Box key={index}>
          <Text color={theme.subtle}>{marker} </Text>
          {item}
        </Box>
      ))}
    </Box>
  );
}
