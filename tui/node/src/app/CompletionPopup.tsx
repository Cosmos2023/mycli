import React from "react";
import { Box, Text } from "ink";
import { completionWindow, type CompletionItem } from "../state/completion.ts";

export function CompletionPopup({
  visible,
  items,
  selectedIndex,
}: {
  visible: boolean;
  items: CompletionItem[];
  selectedIndex: number;
}) {
  if (!visible) {
    return null;
  }
  const windowItems = completionWindow(items, selectedIndex, 6);
  const firstVisible = windowItems[0];
  const offset = firstVisible ? items.indexOf(firstVisible) : 0;
  return (
    <Box flexDirection="column">
      {windowItems.map((item, index) => {
        const absolute = offset + index;
        return (
          <Text key={item.value} dimColor={absolute !== selectedIndex}>
            {absolute === selectedIndex ? "> " : "  "}
            {item.value}
          </Text>
        );
      })}
    </Box>
  );
}
