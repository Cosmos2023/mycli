import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

type Segment = { kind: "plain" | "code" | "bold"; text: string };

function inlineSegments(line: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > lastIndex) {
      segments.push({ kind: "plain", text: line.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      segments.push({ kind: "code", text: raw.slice(1, -1) });
    } else {
      segments.push({ kind: "bold", text: raw.slice(2, -2) });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < line.length) {
    segments.push({ kind: "plain", text: line.slice(lastIndex) });
  }
  return segments.length ? segments : [{ kind: "plain", text: line }];
}

function renderLine(line: string): { codeBlock: boolean; text: string; segments: Segment[] } {
  if (line.startsWith("- ")) {
    return { codeBlock: false, text: "", segments: inlineSegments(`• ${line.slice(2)}`) };
  }
  if (/^\d+\.\s+/.test(line)) {
    return { codeBlock: false, text: "", segments: inlineSegments(line) };
  }
  return { codeBlock: false, text: "", segments: inlineSegments(line) };
}

export function MarkdownText({ text, theme }: { text: string; theme: ThemeTokens }) {
  const lines = text.split("\n");
  let inCode = false;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, index) => {
        if (line.startsWith("```")) {
          inCode = !inCode;
          return null;
        }
        if (inCode) {
          return (
            <Text key={index} color={theme.code}>
              {line}
            </Text>
          );
        }
        const rendered = renderLine(line);
        return (
          <Text key={index} color={theme.text}>
            {rendered.segments.map((segment, segmentIndex) => (
              <Text
                key={`${index}:${segmentIndex}`}
                color={segment.kind === "code" ? theme.code : theme.text}
                bold={segment.kind === "bold"}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}
