import type { TranscriptItem } from "./types.ts";

let nextItemId = 1;

export function itemId(prefix: string): string {
  return `${prefix}_${nextItemId++}`;
}

export function applyTextDelta(items: TranscriptItem[], text: string): TranscriptItem[] {
  const last = items.at(-1);
  if (last?.type === "assistant_stream") {
    return [...items.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }
  return [
    ...items,
    { id: itemId("assistant"), type: "assistant_stream", text, folded: false, metadata: {} },
  ];
}

export function reconcileFinalAnswer(items: TranscriptItem[], answer: string): TranscriptItem[] {
  const last = items.at(-1);
  const finalItem: TranscriptItem = {
    id: last?.type === "assistant_stream" ? last.id : itemId("assistant"),
    type: "assistant_final",
    text: answer,
    folded: false,
    metadata: {},
  };
  if (last?.type === "assistant_stream") {
    return [...items.slice(0, -1), finalItem];
  }
  return [...items, finalItem];
}

export function applyToolEvent(
  items: TranscriptItem[],
  event: Record<string, unknown>,
): TranscriptItem[] {
  const name = typeof event.tool_name === "string" ? event.tool_name : "Tool";
  const metadata =
    typeof event.metadata === "object" && event.metadata !== null
      ? (event.metadata as Record<string, unknown>)
      : {};
  const path = typeof metadata.path === "string" ? ` ${metadata.path}` : "";
  const summaryMetadata = { ...metadata, tool_name: name };
  return [
    ...items,
    {
      id: itemId("tool"),
      type: "tool_summary",
      text: `${name}${path}`,
      folded: true,
      metadata: summaryMetadata,
    },
  ];
}
