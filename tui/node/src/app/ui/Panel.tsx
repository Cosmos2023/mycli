import React from "react";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ThemeTokens } from "../../theme/types.ts";

export function Panel({
  title,
  subtitle,
  children,
  footer,
  theme,
  width,
  borderColor,
  compact = false,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  theme: ThemeTokens;
  width?: number;
  borderColor?: string;
  compact?: boolean;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor ?? theme.border}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      {title || subtitle ? (
        <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
          {title ? (
            <Text color={theme.accent} bold>
              {title}
            </Text>
          ) : null}
          {subtitle ? <Text color={theme.subtle}>{subtitle}</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="column">{children}</Box>
      {footer ? (
        <Box marginTop={1}>
          <Text color={theme.subtle}>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
