import React from "react";
import { Text } from "ink";
import type { ReactNode } from "react";
import type { ThemeTokens } from "../../theme/types.ts";

export type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "secondary";

export function badgeColor(variant: BadgeVariant, theme: ThemeTokens): string {
  switch (variant) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "info":
      return theme.accent;
    case "secondary":
      return theme.muted;
    default:
      return theme.accent;
  }
}

export function Badge({
  children,
  variant = "default",
  theme,
  bold = false,
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  theme: ThemeTokens;
  bold?: boolean;
}) {
  return (
    <Text color={badgeColor(variant, theme)} bold={bold}>
      [{children}]
    </Text>
  );
}
