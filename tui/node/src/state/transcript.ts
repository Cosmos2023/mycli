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

export function applyMessageComplete(
  items: TranscriptItem[],
  metadata: Record<string, unknown>,
): TranscriptItem[] {
  const last = items.at(-1);
  if (last?.type !== "assistant_stream") {
    return items;
  }
  return [
    ...items.slice(0, -1),
    {
      ...last,
      metadata: {
        ...last.metadata,
        message_complete: metadata,
      },
    },
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

export function applyToolLifecycleEvent(
  items: TranscriptItem[],
  method: "tool.start" | "tool.progress" | "tool.complete" | "tool.failed",
  params: Record<string, unknown>,
): TranscriptItem[] {
  const metadata = lifecycleMetadata(method, params);
  const matchIndex = findMatchingToolIndex(items, metadata);
  const item: TranscriptItem = {
    id: matchIndex >= 0 ? items[matchIndex]!.id : itemId("tool"),
    type: "tool_summary",
    text: lifecycleToolText(metadata),
    folded: true,
    metadata:
      matchIndex >= 0
        ? { ...items[matchIndex]!.metadata, ...metadata }
        : metadata,
  };
  if (matchIndex < 0) {
    return [...items, item];
  }
  return [...items.slice(0, matchIndex), item, ...items.slice(matchIndex + 1)];
}

function lifecycleMetadata(
  method: "tool.start" | "tool.progress" | "tool.complete" | "tool.failed",
  params: Record<string, unknown>,
): Record<string, unknown> {
  const name = stringParam(params.name) ?? stringParam(params.tool_name) ?? "Tool";
  const status =
    method === "tool.start" || method === "tool.progress"
      ? "running"
      : method === "tool.failed"
        ? "failed"
        : "done";
  return {
    ...params,
    tool_name: name,
    status,
  };
}

function findMatchingToolIndex(
  items: TranscriptItem[],
  metadata: Record<string, unknown>,
): number {
  const toolId = stringParam(metadata.tool_id);
  const callId = stringParam(metadata.call_id);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type !== "tool_summary") {
      continue;
    }
    const itemToolId = stringParam(item.metadata.tool_id);
    const itemCallId = stringParam(item.metadata.call_id);
    if (toolId && itemToolId === toolId) {
      return index;
    }
    if (callId && itemCallId === callId) {
      return index;
    }
  }
  return -1;
}

function lifecycleToolText(metadata: Record<string, unknown>): string {
  const name = stringParam(metadata.tool_name) ?? "Tool";
  const target =
    stringParam(metadata.path) ??
    stringParam(metadata.query) ??
    stringParam(metadata.command) ??
    stringParam(metadata.context) ??
    stringParam(metadata.summary) ??
    stringParam(metadata.args_preview) ??
    "";
  return target ? `${name} ${target}` : name;
}

function stringParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
