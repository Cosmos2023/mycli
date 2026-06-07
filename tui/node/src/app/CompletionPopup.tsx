import React from "react";
import { Box, Text } from "ink";
import { completionWindow, type CompletionItem } from "../state/completion.ts";
import { truncateMiddle } from "./layout.ts";

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
        const marker = absolute === selectedIndex ? "> " : "  ";
        const flags = [
          item.category,
          item.mutating === true ? "mutating" : item.mutating === false ? "read" : "",
        ].filter(Boolean);
        const suffix = [flags.length ? `[${flags.join(" · ")}]` : "", item.description]
          .filter(Boolean)
          .join(" ");
        return (
          <Text key={item.value} dimColor={absolute !== selectedIndex}>
            {marker}
            {item.value}
            {suffix ? ` ${truncateMiddle(suffix, 72)}` : ""}
          </Text>
        );
      })}
    </Box>
  );
}
