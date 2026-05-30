import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ThemeName, ThemeTokens } from "../theme/types.ts";
import { applyTextDelta, applyToolEvent, itemId, reconcileFinalAnswer } from "./transcript.ts";
import type { LiveStatus, ShellState, TranscriptItem, TurnLiveState, ViewMode } from "./types.ts";

export type ShellAction =
  | { type: "bootstrap.result"; payload: Record<string, unknown> }
  | { type: "transcript.loaded"; payload: Record<string, unknown> }
  | { type: "user.submit"; message: string }
  | { type: "theme.changed"; themeName: ThemeName; theme: ThemeTokens; message: string }
  | { type: "theme.failed"; message: string }
  | { type: "local.command_output"; command: string; lines: string[] }
  | { type: "transcript.cleared"; message: string }
  | { type: "gateway.event"; method: string; params: Record<string, unknown> }
  | { type: "command.result"; command: string; result: Record<string, unknown> };

export function initialState({
  rawThemeName,
}: { rawThemeName?: string } = {}): ShellState {
  const resolved = resolveTheme(rawThemeName);
  const themeName = resolved.ok ? resolved.name : resolved.fallbackName;
  return {
    sessionId: null,
    workspace: "",
    model: "",
    provider: "",
    status: {},
    transcript: resolved.ok
      ? []
      : [
          {
            id: itemId("theme"),
            type: "system_notice",
            text: resolved.message,
            folded: false,
            metadata: {},
          },
        ],
    themeName,
    theme: resolved.theme,
    themeNotice: resolved.ok ? null : resolved.message,
    inputDraft: "",
    restoredDraft: "",
    turnRunning: false,
    currentTurnId: null,
    liveStatus: null,
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
  if (action.type === "transcript.loaded") {
    const items = Array.isArray(action.payload.items)
      ? (action.payload.items as TranscriptItem[])
      : [];
    return { ...state, transcript: [...state.transcript, ...items] };
  }
  if (action.type === "theme.changed") {
    return {
      ...state,
      themeName: action.themeName,
      theme: action.theme,
      themeNotice: action.message,
      transcript: [
        ...state.transcript,
        {
          id: itemId("command"),
          type: "command_output",
          text: action.message,
          folded: false,
          metadata: { command: "/theme", theme: action.themeName },
        },
      ],
    };
  }
  if (action.type === "theme.failed") {
    return {
      ...state,
      themeNotice: action.message,
      transcript: [
        ...state.transcript,
        {
          id: itemId("warning"),
          type: "warning",
          text: action.message,
          folded: false,
          metadata: { command: "/theme" },
        },
      ],
    };
  }
  if (action.type === "local.command_output") {
    return {
      ...state,
      transcript: [
        ...state.transcript,
        {
          id: itemId("command"),
          type: "command_output",
          text: action.lines.join("\n"),
          folded: false,
          metadata: { command: action.command },
        },
      ],
    };
  }
  if (action.type === "transcript.cleared") {
    return {
      ...state,
      transcript: [
        {
          id: itemId("system"),
          type: "system_notice",
          text: action.message,
          folded: false,
          metadata: { local: true },
        },
      ],
      overlay: { visible: false, title: "", lines: [] },
    };
  }
  if (action.type === "gateway.event") {
    if (action.method === "turn.started") {
      return {
        ...state,
        turnRunning: true,
        currentTurnId: String(action.params.client_turn_id ?? ""),
        liveStatus: {
          client_turn_id: String(action.params.client_turn_id ?? ""),
          state: "running",
          kind: "running",
          text: "Running",
        },
      };
    }
    if (action.method === "status.update") {
      const liveStatus = liveStatusFromParams(action.params);
      if (!liveStatus) {
        return state;
      }
      return {
        ...state,
        liveStatus,
        turnRunning:
          liveStatus.state === "running" || liveStatus.state === "waiting_approval"
            ? true
            : liveStatus.state === "completed" ||
                liveStatus.state === "failed" ||
                liveStatus.state === "interrupted"
              ? false
              : state.turnRunning,
        currentTurnId: liveStatus.client_turn_id ?? state.currentTurnId,
        pendingApproval:
          liveStatus.state === "completed" ||
          liveStatus.state === "failed" ||
          liveStatus.state === "interrupted"
            ? null
            : state.pendingApproval,
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
    if (action.method === "message.complete") {
      if (action.params.final !== true) {
        return state;
      }
      return {
        ...state,
        transcript: reconcileFinalAnswer(state.transcript, String(action.params.text ?? "")),
      };
    }
    if (action.method === "turn.completed") {
      return {
        ...state,
        turnRunning: false,
        currentTurnId: null,
        liveStatus: stateFromTurnCompleted(action.params),
        pendingApproval:
          action.params.pending_decision === true || action.params.turn_state === "waiting_approval"
            ? state.pendingApproval
            : null,
      };
    }
    if (action.method === "approval.request" || action.method === "approval.pending") {
      return {
        ...state,
        pendingApproval: action.params,
        transcript: [
          ...state.transcript,
          {
            id: itemId("approval"),
            type: "approval",
            text: String(action.params.preview ?? "Approval required"),
            folded: false,
            metadata: action.params,
          },
        ],
      };
    }
    if (action.method === "approval.respond") {
      return { ...state, pendingApproval: null };
    }
    if (action.method === "status.changed") {
      return {
        ...state,
        status: action.params,
        pendingApproval: action.params.pending_decision === false ? null : state.pendingApproval,
      };
    }
    if (action.method === "turn.failed") {
      const failedStatus: LiveStatus = {
        state: "failed",
        kind: "failed",
        text: String(action.params.message ?? "Turn failed"),
      };
      if (typeof action.params.client_turn_id === "string") {
        failedStatus.client_turn_id = action.params.client_turn_id;
      }
      return {
        ...state,
        turnRunning: false,
        currentTurnId: null,
        liveStatus: failedStatus,
        pendingApproval: null,
        transcript: [
          ...state.transcript,
          {
            id: itemId("error"),
            type: "error",
            text: String(action.params.message ?? "Turn failed"),
            folded: false,
            metadata: action.params,
          },
        ],
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

function liveStatusFromParams(params: Record<string, unknown>): LiveStatus | null {
  if (!isTurnLiveState(params.state)) {
    return null;
  }
  const status: LiveStatus = {
    state: params.state,
    kind: String(params.kind ?? params.state),
    text: String(params.text ?? params.state),
  };
  if (typeof params.client_turn_id === "string") {
    status.client_turn_id = params.client_turn_id;
  }
  if (typeof params.severity === "string") {
    status.severity = params.severity;
  }
  return status;
}

function stateFromTurnCompleted(params: Record<string, unknown>): LiveStatus {
  const state = isTurnLiveState(params.turn_state) ? params.turn_state : "completed";
  const liveStatus: LiveStatus = {
    state,
    kind: state,
    text: state === "waiting_approval" ? "Waiting approval" : "Completed",
  };
  if (typeof params.client_turn_id === "string") {
    liveStatus.client_turn_id = params.client_turn_id;
  }
  return liveStatus;
}

function isTurnLiveState(value: unknown): value is TurnLiveState {
  return (
    value === "running" ||
    value === "waiting_approval" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  );
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
