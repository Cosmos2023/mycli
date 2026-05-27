import type { ShellState, TranscriptItem } from "../state/types.ts";

export type DisplayTurn = {
  id: string;
  user: TranscriptItem | null;
  tools: TranscriptItem[];
  toolDetails: TranscriptItem[];
  statuses: TranscriptItem[];
  approvals: TranscriptItem[];
  assistantStream: TranscriptItem | null;
  assistantFinal: TranscriptItem | null;
  notices: TranscriptItem[];
  errors: TranscriptItem[];
};

export type GroupedTranscript = {
  prelude: TranscriptItem[];
  turns: DisplayTurn[];
};

function emptyTurn(user: TranscriptItem): DisplayTurn {
  return {
    id: `turn_${user.id}`,
    user,
    tools: [],
    toolDetails: [],
    statuses: [],
    approvals: [],
    assistantStream: null,
    assistantFinal: null,
    notices: [],
    errors: [],
  };
}

function appendToTurn(turn: DisplayTurn, item: TranscriptItem): DisplayTurn {
  if (item.type === "tool_summary") {
    return { ...turn, tools: [...turn.tools, item] };
  }
  if (item.type === "tool_detail") {
    return { ...turn, toolDetails: [...turn.toolDetails, item] };
  }
  if (item.type === "execution_status") {
    return { ...turn, statuses: [...turn.statuses, item] };
  }
  if (item.type === "approval") {
    return { ...turn, approvals: [...turn.approvals, item] };
  }
  if (item.type === "assistant_stream") {
    return { ...turn, assistantStream: item };
  }
  if (item.type === "assistant_final") {
    return { ...turn, assistantFinal: item, assistantStream: null };
  }
  if (item.type === "warning" || item.type === "error") {
    return { ...turn, errors: [...turn.errors, item] };
  }
  return { ...turn, notices: [...turn.notices, item] };
}

export function groupTranscriptIntoTurns(items: TranscriptItem[]): GroupedTranscript {
  const prelude: TranscriptItem[] = [];
  const turns: DisplayTurn[] = [];

  for (const item of items) {
    if (item.type === "user") {
      turns.push(emptyTurn(item));
      continue;
    }

    const last = turns.at(-1);
    if (!last) {
      prelude.push(item);
      continue;
    }

    turns[turns.length - 1] = appendToTurn(last, item);
  }

  return { prelude, turns };
}

export function currentTurn(turns: DisplayTurn[]): DisplayTurn | null {
  return turns.at(-1) ?? null;
}

export function visibleTurnsForMode(
  turns: DisplayTurn[],
  viewMode: ShellState["viewMode"],
): DisplayTurn[] {
  if (viewMode === "focus") {
    const current = currentTurn(turns);
    return current ? [current] : [];
  }
  return turns;
}

export function isStartupNotice(item: TranscriptItem): boolean {
  return item.type === "system_notice" && typeof item.metadata.startup_mark === "object";
}
