import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

export function InputBox({
  draft,
  turnRunning,
  completionVisible,
  onDraftChange,
  onSubmit,
  onInterrupt,
}: {
  draft: string;
  turnRunning: boolean;
  completionVisible: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
}) {
  const [value, setValue] = useState(draft);
  const valueRef = useRef(draft);
  const updateValue = (next: string): void => {
    valueRef.current = next;
    setValue(next);
    onDraftChange(next);
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.return) {
      const submitted = valueRef.current.trim();
      if (submitted && !completionVisible) {
        onSubmit(submitted);
        updateValue("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      const next = valueRef.current.slice(0, -1);
      updateValue(next);
      return;
    }
    if (!key.ctrl && input) {
      const next = `${valueRef.current}${input}`;
      updateValue(next);
    }
  });
  return (
    <Box>
      <Text color={turnRunning ? "yellow" : "green"}>{"> "}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
