import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export type InputPreview = {
  text: string;
  diagnostic?: string;
};

const COLLAPSE_INPUT_CHARS = 240;

export function inputPreview(value: string, width = DEFAULT_TERMINAL_WIDTH): InputPreview {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const multiline = lines.length > 1;
  const shouldCollapse = multiline || normalized.length > COLLAPSE_INPUT_CHARS;
  if (!shouldCollapse) {
    return { text: normalized };
  }
  const firstLine = lines.find((line) => line.trim()) ?? lines[0] ?? "";
  const lineLabel = multiline ? `${lines.length} lines` : "1 line";
  return {
    text: truncateMiddle(firstLine.replace(/\s+/g, " ").trim() || "(blank paste)", Math.max(16, width - 16)),
    diagnostic: `paste: ${lineLabel}, ${normalized.length} chars collapsed`,
  };
}

export function InputBox({
  draft,
  turnRunning,
  completionVisible,
  overlayVisible = false,
  theme,
  metadata = "",
  hint = "",
  width = DEFAULT_TERMINAL_WIDTH,
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
  overlayVisible?: boolean;
  theme: ThemeTokens;
  metadata?: string;
  hint?: string;
  width?: number;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
  onCompletionMove?: (delta: number) => void;
  onCompletionAccept?: () => void;
  onCompletionClose?: () => void;
}) {
  const [value, setValue] = useState(draft);
  const valueRef = useRef(draft);
  useEffect(() => {
    if (draft === valueRef.current) {
      return;
    }
    valueRef.current = draft;
    setValue(draft);
  }, [draft]);
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
    if (overlayVisible && (key.escape || input === "\u001b")) {
      onInterrupt();
      return;
    }
    const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (normalized.length > 1 && normalized.endsWith("\n")) {
      const withoutFinalNewline = normalized.slice(0, -1);
      if (!withoutFinalNewline.includes("\n")) {
        updateValue(`${valueRef.current}${withoutFinalNewline}`);
        submitCurrentValue();
        return;
      }
    }
    if (normalized.includes("\n") && normalized.length > 1) {
      updateValue(`${valueRef.current}${normalized}`);
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      submitCurrentValue();
      return;
    }
    if (key.backspace || key.delete) {
      updateValue(valueRef.current.slice(0, -1));
      return;
    }
    if (!key.ctrl && input) {
      updateValue(`${valueRef.current}${normalized}`);
    }
  });

  const contentWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));
  const visibleHint = truncateMiddle(hint, contentWidth);
  const preview = inputPreview(value, contentWidth);
  const metadataParts = metadata
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={turnRunning ? theme.warning : theme.accent}>{">"}</Text>
        {preview.text ? <Text color={theme.text}> {preview.text}</Text> : null}
      </Text>
      {preview.diagnostic ? <Text color={theme.warning}>{preview.diagnostic}</Text> : null}
      {visibleHint ? <Text color={theme.subtle}>{visibleHint}</Text> : null}
      {metadataParts.length > 0 ? (
        <Box flexDirection="row" flexWrap="wrap">
          {metadataParts.map((part, index) => (
            <Text key={`${index}:${part}`} color={theme.subtle}>
              {index > 0 ? " · " : ""}
              {truncateMiddle(part, contentWidth < 90 ? 28 : 40)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
