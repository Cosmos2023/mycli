import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { badgeColor, type BadgeVariant } from "./Badge.tsx";
import type { ThemeTokens } from "../../theme/types.ts";

export function Alert({
  title,
  children,
  variant = "info",
  theme,
}: {
  title?: string;
  children?: ReactNode;
  variant?: BadgeVariant;
  theme: ThemeTokens;
}) {
  const color = badgeColor(variant, theme);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {title ? (
        <Text color={color} bold>
          {title}
        </Text>
      ) : null}
      {children}
    </Box>
  );
}
