import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function InputBox({
  draft,
  turnRunning,
  completionVisible,
  theme,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onCompletionMove,
  onCompletionAccept,
  onCompletionClose,
}: {
  draft: string;
  turnRunning: boolean;
  completionVisible: boolean;
  theme: ThemeTokens;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
  onCompletionMove?: (delta: number) => void;
  onCompletionAccept?: () => void;
  onCompletionClose?: () => void;
}) {
  const [value, setValue] = useState(draft);
  const valueRef = useRef(draft);
  const updateValue = (next: string): void => {
    valueRef.current = next;
    setValue(next);
    onDraftChange(next);
  };
  const submitCurrentValue = (): void => {
    const submitted = valueRef.current.trim();
    if (submitted && !completionVisible) {
      onSubmit(submitted);
      updateValue("");
    }
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (completionVisible && key.downArrow) {
      onCompletionMove?.(1);
      return;
    }
    if (completionVisible && key.upArrow) {
      onCompletionMove?.(-1);
      return;
    }
    if (completionVisible && key.tab) {
      onCompletionAccept?.();
      return;
    }
    if (completionVisible && key.escape) {
      onCompletionClose?.();
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      submitCurrentValue();
      return;
    }
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1);
      updateValue(next);
      return;
    }
    if (!key.ctrl && input) {
      const normalized = input.replaceAll("\r", "\n");
      const newlineIndex = normalized.indexOf("\n");
      const text = newlineIndex >= 0 ? normalized.slice(0, newlineIndex) : normalized;
      const next = `${valueRef.current}${text}`;
      updateValue(next);
      if (newlineIndex >= 0) {
        submitCurrentValue();
      }
    }
  });
  const isCommand = value.startsWith("/");
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={turnRunning ? theme.warning : theme.accent}>{"> "}</Text>
        <Text>{value || "Type a message or /command"}</Text>
      </Box>
      {isCommand ? <Text color={theme.subtle}>local UI command or Python slash command</Text> : null}
    </Box>
  );
}
