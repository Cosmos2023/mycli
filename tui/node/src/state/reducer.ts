import { applyTextDelta, applyToolEvent, itemId, reconcileFinalAnswer } from "./transcript.ts";
import type { ShellState, TranscriptItem, ViewMode } from "./types.ts";

export type ShellAction =
  | { type: "bootstrap.result"; payload: Record<string, unknown> }
  | { type: "user.submit"; message: string }
  | { type: "gateway.event"; method: string; params: Record<string, unknown> }
  | { type: "command.result"; command: string; result: Record<string, unknown> };

export function initialState(): ShellState {
  return {
    sessionId: null,
    workspace: "",
    model: "",
    provider: "",
    status: {},
    transcript: [],
    inputDraft: "",
    restoredDraft: "",
    turnRunning: false,
    currentTurnId: null,
    viewMode: "default",
    completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
    overlay: { visible: false, title: "", lines: [] },
    pendingApproval: null,
  };
}

export function reduceShellState(state: ShellState, action: ShellAction): ShellState {
  if (action.type === "bootstrap.result") {
    const welcome = recordOrNull(action.payload.welcome);
    const startupMark = recordOrNull(welcome?.startup_mark);
    const welcomeText = welcome
      ? `${String(startupMark?.text ?? "mycli")}\n${String(welcome.workspace ?? "")}`
      : "mycli";
    return {
      ...state,
      sessionId: String(action.payload.session_id ?? ""),
      workspace: String(action.payload.workspace ?? ""),
      model: String(action.payload.model ?? ""),
      provider: String(action.payload.provider ?? ""),
      status: recordOrNull(action.payload.status) ?? {},
      transcript: [
        ...state.transcript,
        {
          id: itemId("welcome"),
          type: "system_notice",
          text: welcomeText,
          folded: false,
          metadata: welcome ?? {},
        },
      ],
    };
  }
  if (action.type === "user.submit") {
    return {
      ...state,
      restoredDraft: action.message,
      transcript: [
        ...state.transcript,
        { id: itemId("user"), type: "user", text: action.message, folded: false, metadata: {} },
      ],
    };
  }
  if (action.type === "gateway.event") {
    if (action.method === "turn.started") {
      return {
        ...state,
        turnRunning: true,
        currentTurnId: String(action.params.client_turn_id ?? ""),
      };
    }
    if (action.method === "turn.event" && action.params.phase === "assistant_delta") {
      return {
        ...state,
        transcript: applyTextDelta(state.transcript, String(action.params.text ?? "")),
      };
    }
    if (action.method === "turn.event" && action.params.phase === "tool_call") {
      return { ...state, transcript: applyToolEvent(state.transcript, action.params) };
    }
    if (action.method === "turn.completed") {
      return {
        ...state,
        turnRunning: false,
        currentTurnId: null,
        transcript: reconcileFinalAnswer(
          state.transcript,
          String(action.params.assistant_message ?? ""),
        ),
      };
    }
  }
  if (action.type === "command.result") {
    const viewMode = isViewMode(action.result.view_mode) ? action.result.view_mode : undefined;
    const lines = Array.isArray(action.result.lines)
      ? action.result.lines.map((line) => String(line))
      : [];
    return {
      ...state,
      viewMode: viewMode ?? state.viewMode,
      transcript:
        action.result.presentation === "transcript"
          ? [
              ...state.transcript,
              {
                id: itemId("command"),
                type: "command_output",
                text: lines.join("\n"),
                folded: false,
                metadata: {},
              },
            ]
          : state.transcript,
      overlay:
        action.result.presentation === "overlay"
          ? { visible: true, title: action.command, lines }
          : state.overlay,
    };
  }
  return state;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "default" || value === "verbose" || value === "focus";
}
