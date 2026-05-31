import React from "react";
import { Box, Text } from "ink";
import type { TranscriptItem } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

type ClarificationOption = {
  label: string;
  description?: string;
};

function clarificationOptions(metadata: TranscriptItem["metadata"]): ClarificationOption[] {
  const options = metadata.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const record = option as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    if (!label) {
      return [];
    }
    const normalized: ClarificationOption = { label };
    if (typeof record.description === "string" && record.description.trim()) {
      normalized.description = record.description.trim();
    }
    return [normalized];
  });
}

export function ClarificationRow({
  item,
  theme,
}: {
  item: TranscriptItem;
  theme: ThemeTokens;
}) {
  const header =
    typeof item.metadata.header === "string" && item.metadata.header.trim()
      ? item.metadata.header.trim()
      : "Clarification requested";
  const options = clarificationOptions(item.metadata);
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={theme.warning} bold>
        ? {header}
      </Text>
      <Text>{item.text}</Text>
      {options.map((option, index) => (
        <Text key={`${option.label}-${index}`}>
          <Text color={theme.accent}>{index + 1}</Text>
          <Text color={theme.muted}>. </Text>
          {option.label}
          {option.description ? <Text color={theme.muted}> · {option.description}</Text> : null}
        </Text>
      ))}
      {options.length > 0 ? (
        <Text color={theme.subtle}>
          Type 1-{options.length}, an option label, or a custom answer.
        </Text>
      ) : null}
    </Box>
  );
}
