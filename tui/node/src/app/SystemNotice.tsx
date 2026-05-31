import React from "react";
import { Box, Text } from "ink";
import type { TranscriptItemType } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function SystemNotice({
  text,
  type = "system_notice",
  theme,
  metadata,
}: {
  text: string;
  type?: TranscriptItemType;
  theme: ThemeTokens;
  metadata?: Record<string, unknown>;
}) {
  const color = type === "error" ? theme.error : type === "warning" ? theme.warning : theme.subtle;
  const diagnostics = noticeDiagnostics(type, metadata);
  return (
    <Box marginLeft={2} flexDirection="column">
      <Text color={color}>{text}</Text>
      {diagnostics ? (
        <Text color={theme.subtle} dimColor>
          {diagnostics}
        </Text>
      ) : null}
    </Box>
  );
}

export function noticeDiagnostics(
  type: TranscriptItemType,
  metadata?: Record<string, unknown>,
): string {
  if ((type !== "error" && type !== "warning") || !metadata) {
    return "";
  }
  const pairs = [
    diagnosticPair("source", metadata.source),
    diagnosticPair("method", metadata.method),
    diagnosticPair("code", metadata.code),
  ].filter((value): value is string => Boolean(value));
  return pairs.join(" · ");
}

function diagnosticPair(label: string, value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return `${label}=${String(value)}`;
  }
  if (typeof value !== "string") {
    return "";
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const bounded = compact.length > 64 ? `${compact.slice(0, 61)}...` : compact;
  return `${label}=${bounded}`;
}
