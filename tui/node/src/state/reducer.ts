import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ThemeName, ThemeTokens } from "../theme/types.ts";
import type { ApprovalRequestPayload, ClarifyRequestPayload } from "../protocol/types.ts";
import { acceptSelected, moveSelection, shouldComplete } from "./completion.ts";
import { slashCommandCompletions } from "./slashCatalog.ts";
import {
  applyMessageComplete,
  applyTextDelta,
  applyToolEvent,
  applyToolLifecycleEvent,
  itemId,
  reconcileFinalAnswer,
} from "./transcript.ts";
import type {
  LiveReasoning,
  LiveStatus,
  ShellState,
  TranscriptItem,
  TurnLiveState,
  ViewMode,
} from "./types.ts";

export type ShellAction =
  | { type: "bootstrap.result"; payload: Record<string, unknown> }
  | { type: "transcript.loaded"; payload: Record<string, unknown> }
  | { type: "user.submit"; message: string }
  | { type: "request.failed"; method: string; code: string; message: string; detail?: string }
  | { type: "input.changed"; value: string }
  | { type: "input.cleared"; message?: string }
  | { type: "completion.move"; delta: number }
  | { type: "completion.accept" }
  | { type: "completion.closed" }
  | { type: "overlay.closed"; message?: string }
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
    sessionTitle: null,
    workspace: "",
    model: "",
    provider: "",
    trust: { state: "unknown", workspace: "", source: "initial", enforced: false },
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
    liveReasoning: null,
    typedMessageTurnId: null,
    viewMode: "default",
    completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
    overlay: { visible: false, title: "", lines: [] },
    pendingApproval: null,
    pendingClarification: null,
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
      sessionTitle: sessionTitleFromPayload(action.payload),
      workspace: String(action.payload.workspace ?? ""),
      model: String(action.payload.model ?? ""),
      provider: String(action.payload.provider ?? ""),
      trust: trustFromPayload(action.payload.trust ?? recordOrNull(action.payload.status)?.trust, {
        workspace: String(action.payload.workspace ?? ""),
      }),
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
  if (action.type === "input.changed") {
    return { ...state, inputDraft: action.value, completion: completionFromInput(state, action.value) };
  }
  if (action.type === "input.cleared") {
    return {
      ...state,
      inputDraft: "",
      restoredDraft: action.message ?? state.restoredDraft,
      completion: { ...state.completion, visible: false, items: [], selectedIndex: 0, prefix: "" },
    };
  }
  if (action.type === "completion.move") {
    return {
      ...state,
      completion: {
        ...state.completion,
        selectedIndex: moveSelection(
          state.completion.selectedIndex,
          action.delta,
          state.completion.items.length,
        ),
      },
    };
  }
  if (action.type === "completion.accept") {
    const accepted = acceptSelected(state.completion.items, state.completion.selectedIndex);
    if (!accepted) {
      return { ...state, completion: { ...state.completion, visible: false } };
    }
    return {
      ...state,
      inputDraft: accepted,
      completion: { ...state.completion, visible: false },
    };
  }
  if (action.type === "completion.closed") {
    return { ...state, completion: { ...state.completion, visible: false } };
  }
  if (action.type === "overlay.closed") {
    return {
      ...state,
      completion: { ...state.completion, visible: false },
      overlay: { visible: false, title: "", lines: [] },
      ...(action.message
        ? {
            transcript: [
              ...state.transcript,
              {
                id: itemId("system"),
                type: "system_notice" as const,
                text: action.message,
                folded: false,
                metadata: { local: true },
              },
            ],
          }
        : {}),
    };
  }
  if (action.type === "request.failed") {
    return appendErrorItem(state, {
      code: action.code,
      message: action.message,
      method: action.method,
      ...(action.detail ? { detail: truncatePreview(action.detail) } : {}),
      source: "request",
    });
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
    if (action.method === "runtime.event") {
      const unwrapped = runtimeEventFromParams(action.params);
      if (!unwrapped) {
        return state;
      }
      return reduceShellState(state, {
        type: "gateway.event",
        method: unwrapped.method,
        params: unwrapped.params,
      });
    }
    if (action.method === "turn.started") {
      return {
        ...state,
        turnRunning: true,
        currentTurnId: String(action.params.client_turn_id ?? ""),
        liveReasoning: null,
        typedMessageTurnId: null,
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
      if (
        liveStatus.state === "completed" &&
        isInterruptedTerminalForClient(state, liveStatus.client_turn_id)
      ) {
        return state;
      }
      return applyLiveStatus(state, liveStatus);
    }
    if (action.method === "turn.status") {
      const liveStatus = liveStatusFromParams(action.params);
      if (!liveStatus) {
        return state;
      }
      return applyTurnStatus(state, liveStatus, action.params);
    }
    if (action.method === "gateway.error") {
      return appendErrorItem(state, action.params, "Gateway error");
    }
    if (action.method === "session.changed") {
      const sessionId = String(action.params.session_id ?? "").trim();
      if (!sessionId) {
        return state;
      }
      return { ...state, sessionId, sessionTitle: sessionTitleFromPayload(action.params) ?? state.sessionTitle };
    }
    if (action.method === "message.delta") {
      const clientTurnId = clientTurnIdFromParams(action.params) ?? state.currentTurnId;
      return {
        ...state,
        typedMessageTurnId: clientTurnId,
        transcript: applyTextDelta(state.transcript, String(action.params.text ?? "")),
      };
    }
    if (action.method === "message.complete") {
      const clientTurnId = clientTurnIdFromParams(action.params);
      if (action.params.final === true) {
        if (isInterruptedTerminalForClient(state, clientTurnId)) {
          return state;
        }
        return {
          ...state,
          turnRunning: false,
          currentTurnId:
            clientTurnId && state.currentTurnId === clientTurnId ? null : state.currentTurnId,
          liveReasoning:
            clientTurnId && state.liveReasoning?.client_turn_id === clientTurnId
              ? null
              : state.liveReasoning,
          typedMessageTurnId:
            clientTurnId && state.typedMessageTurnId === clientTurnId
              ? null
              : state.typedMessageTurnId,
          transcript: reconcileFinalAnswer(state.transcript, String(action.params.text ?? "")),
        };
      }
      return {
        ...state,
        liveReasoning:
          clientTurnId && state.liveReasoning?.client_turn_id === clientTurnId
            ? null
            : state.liveReasoning,
        transcript: applyMessageComplete(
          state.transcript,
          boundedMessageCompleteMetadata(action.params),
        ),
      };
    }
    if (action.method === "reasoning.delta" || action.method === "thinking.delta") {
      const clientTurnId = clientTurnIdFromParams(action.params) ?? state.currentTurnId;
      const kind = action.method === "thinking.delta" ? "thinking" : "reasoning";
      const liveStatus: LiveStatus = {
        state: "running",
        kind,
        text: reasoningStatusText(action.params.text),
      };
      if (clientTurnId) {
        liveStatus.client_turn_id = clientTurnId;
      }
      return {
        ...state,
        turnRunning: true,
        currentTurnId: clientTurnId,
        liveStatus,
        liveReasoning: liveReasoningFromParams(kind, action.params),
      };
    }
    if (action.method === "turn.event" && action.params.phase === "assistant_delta") {
      const clientTurnId = clientTurnIdFromParams(action.params);
      if (
        state.typedMessageTurnId &&
        clientTurnId &&
        clientTurnId === state.typedMessageTurnId
      ) {
        return state;
      }
      return {
        ...state,
        transcript: applyTextDelta(state.transcript, String(action.params.text ?? "")),
      };
    }
    if (action.method === "turn.event" && action.params.phase === "tool_call") {
      return { ...state, transcript: applyToolEvent(state.transcript, action.params) };
    }
    if (
      action.method === "tool.start" ||
      action.method === "tool.progress" ||
      action.method === "tool.complete" ||
      action.method === "tool.failed"
    ) {
      return {
        ...state,
        transcript: applyToolLifecycleEvent(state.transcript, action.method, action.params),
      };
    }
    if (action.method === "turn.completed") {
      const clientTurnId = clientTurnIdFromParams(action.params);
      if (isInterruptedTerminalForClient(state, clientTurnId)) {
        return state;
      }
      return {
        ...state,
        turnRunning: false,
        currentTurnId: null,
        liveReasoning: null,
        typedMessageTurnId: null,
        liveStatus: stateFromTurnCompleted(action.params),
        pendingApproval:
          action.params.pending_decision === true || action.params.turn_state === "waiting_approval"
            ? state.pendingApproval
            : null,
        pendingClarification:
          action.params.turn_state === "waiting_clarification"
            ? state.pendingClarification
            : null,
      };
    }
    if (action.method === "approval.request" || action.method === "approval.pending") {
      const pendingApproval = action.params as ApprovalRequestPayload;
      return {
        ...state,
        pendingApproval,
        transcript: [
          ...state.transcript,
          {
            id: itemId("approval"),
            type: "approval",
            text: String(pendingApproval.preview ?? "Approval required"),
            folded: false,
            metadata: pendingApproval,
          },
        ],
      };
    }
    if (action.method === "approval.respond") {
      return { ...state, pendingApproval: null };
    }
    if (action.method === "turn.completion_suppressed") {
      return state;
    }
    if (action.method === "clarify.request") {
      const pendingClarification = action.params as ClarifyRequestPayload;
      return {
        ...state,
        pendingClarification,
        transcript: [
          ...state.transcript,
          {
            id: itemId("clarification"),
            type: "clarification",
            text: clarifyTextFromParams(pendingClarification),
            folded: false,
            metadata: pendingClarification,
          },
        ],
      };
    }
    if (action.method === "clarify.respond") {
      return { ...state, pendingClarification: null };
    }
    if (action.method === "status.changed") {
      return {
        ...state,
        status: action.params,
        sessionTitle: sessionTitleFromPayload(action.params) ?? state.sessionTitle,
        trust: trustFromPayload(action.params.trust, {
          fallback: state.trust,
          workspace: String(action.params.workspace ?? state.workspace),
        }),
        pendingApproval: action.params.pending_decision === false ? null : state.pendingApproval,
        pendingClarification:
          action.params.suspended_turn === false ? null : state.pendingClarification,
      };
    }
    if (action.method === "workspace.trust.changed") {
      return {
        ...state,
        trust: trustFromPayload(action.params, {
          fallback: state.trust,
          workspace: state.workspace,
        }),
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
        liveReasoning: null,
        typedMessageTurnId: null,
        liveStatus: failedStatus,
        pendingApproval: null,
        pendingClarification: null,
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
    const presentationHint = stringValue(action.result.presentation_hint) ?? undefined;
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
          ? {
              visible: true,
              title: action.command,
              lines,
              ...(presentationHint === undefined ? {} : { presentationHint }),
            }
          : action.result.presentation === "transcript"
            ? { visible: false, title: "", lines: [] }
            : state.overlay,
    };
  }
  return state;
}

function appendErrorItem(
  state: ShellState,
  metadata: Record<string, unknown>,
  fallbackMessage = "Request failed",
): ShellState {
  if (matchesRecentError(state.transcript, metadata)) {
    return state;
  }
  return {
    ...state,
    transcript: [
      ...state.transcript,
      {
        id: itemId("error"),
        type: "error",
        text: String(metadata.message ?? fallbackMessage),
        folded: false,
        metadata,
      },
    ],
  };
}

function completionFromInput(state: ShellState, value: string): ShellState["completion"] {
  if (shouldComplete(value) !== "slash") {
    return { ...state.completion, visible: false, prefix: "", items: [], selectedIndex: 0 };
  }
  const token = currentInputToken(value);
  const items = slashCommandCompletions(token).map((command) => ({
    value: command.name,
    description: command.description,
    category: command.category,
    mutating: command.mutating,
    aliases: command.aliases,
  }));
  return {
    visible: items.length > 0,
    requestId: state.completion.requestId + 1,
    prefix: token,
    items,
    selectedIndex: 0,
  };
}

function currentInputToken(value: string): string {
  const stripped = value.trimStart();
  if (!stripped) {
    return "";
  }
  return stripped.split(/\s+/, 1)[0] ?? "";
}

function sessionTitleFromPayload(payload: Record<string, unknown>): string | null {
  const direct = payload.session_title ?? payload.title;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  const status = recordOrNull(payload.status);
  const nested = status?.session_title ?? status?.title;
  if (typeof nested === "string" && nested.trim()) {
    return nested.trim();
  }
  const welcome = recordOrNull(payload.welcome);
  const welcomeTitle = welcome?.session_title ?? welcome?.title;
  if (typeof welcomeTitle === "string" && welcomeTitle.trim()) {
    return welcomeTitle.trim();
  }
  return null;
}

function matchesRecentError(
  transcript: TranscriptItem[],
  metadata: Record<string, unknown>,
): boolean {
  const recent = transcript.slice(-3);
  return recent.some(
    (item) =>
      item.type === "error" &&
      item.metadata.code === metadata.code &&
      item.metadata.method === metadata.method &&
      item.metadata.message === metadata.message,
  );
}

function clientTurnIdFromParams(params: Record<string, unknown>): string | null {
  return typeof params.client_turn_id === "string" && params.client_turn_id
    ? params.client_turn_id
    : null;
}

function liveReasoningFromParams(
  kind: LiveReasoning["kind"],
  params: Record<string, unknown>,
): LiveReasoning {
  const reasoning: LiveReasoning = {
    kind,
    text: truncatePreview(String(params.text ?? "")),
  };
  const clientTurnId = clientTurnIdFromParams(params);
  if (clientTurnId) {
    reasoning.client_turn_id = clientTurnId;
  }
  return reasoning;
}

function truncatePreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedMessageCompleteMetadata(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      metadata[key] = truncatePreview(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function isTerminalTurnState(state: TurnLiveState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "interrupted" ||
    state === "rejected"
  );
}

function applyLiveStatus(state: ShellState, liveStatus: LiveStatus): ShellState {
  return {
    ...state,
    liveStatus,
    turnRunning:
      liveStatus.state === "running" ||
      liveStatus.state === "waiting_approval" ||
      liveStatus.state === "waiting_clarification"
        ? true
        : liveStatus.state === "completed" ||
            liveStatus.state === "failed" ||
            liveStatus.state === "interrupted" ||
            liveStatus.state === "rejected"
          ? false
          : state.turnRunning,
    currentTurnId: isTerminalTurnState(liveStatus.state)
      ? null
      : liveStatus.client_turn_id ?? state.currentTurnId,
    liveReasoning: isTerminalTurnState(liveStatus.state) ? null : state.liveReasoning,
    typedMessageTurnId: isTerminalTurnState(liveStatus.state) ? null : state.typedMessageTurnId,
    pendingApproval: isTerminalTurnState(liveStatus.state) ? null : state.pendingApproval,
    pendingClarification: isTerminalTurnState(liveStatus.state) ? null : state.pendingClarification,
  };
}

function applyTurnStatus(
  state: ShellState,
  liveStatus: LiveStatus,
  params: Record<string, unknown>,
): ShellState {
  const next = applyLiveStatus(state, liveStatus);
  if (liveStatus.state !== "failed" || params.terminal !== true) {
    return next;
  }
  return appendErrorItem(next, params, "Turn failed");
}

function isInterruptedTerminalForClient(
  state: ShellState,
  clientTurnId: string | null | undefined,
): boolean {
  if (state.liveStatus?.state !== "interrupted") {
    return false;
  }
  const interruptedTurnId = state.liveStatus.client_turn_id;
  return Boolean(clientTurnId && interruptedTurnId && clientTurnId === interruptedTurnId);
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
  if (typeof params.message === "string") {
    status.message = params.message;
  }
  return status;
}

function stateFromTurnCompleted(params: Record<string, unknown>): LiveStatus {
  const state = isTurnLiveState(params.turn_state) ? params.turn_state : "completed";
  const liveStatus: LiveStatus = {
    state,
    kind: state,
    text:
      state === "waiting_approval"
        ? "Waiting approval"
        : state === "waiting_clarification"
          ? "Waiting clarification"
          : state === "rejected"
            ? "Rejected"
          : "Completed",
  };
  if (typeof params.client_turn_id === "string") {
    liveStatus.client_turn_id = params.client_turn_id;
  }
  return liveStatus;
}

function clarifyTextFromParams(params: Record<string, unknown>): string {
  const question = String(params.question ?? "Clarification requested").trim();
  return question || "Clarification requested";
}

function reasoningStatusText(value: unknown): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "Thinking";
  }
  const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `Thinking: ${preview}`;
}

function isTurnLiveState(value: unknown): value is TurnLiveState {
  return (
    value === "running" ||
    value === "waiting_approval" ||
    value === "waiting_clarification" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "rejected"
  );
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function trustFromPayload(
  value: unknown,
  {
    fallback,
    workspace,
  }: { fallback?: ShellState["trust"]; workspace?: string } = {},
): ShellState["trust"] {
  const raw = recordOrNull(value);
  if (!raw) {
    return fallback ?? {
      state: "unknown",
      workspace: workspace ?? "",
      source: "fallback",
      enforced: false,
    };
  }
  const state =
    raw.state === "trusted" || raw.state === "untrusted" || raw.state === "unknown"
      ? raw.state
      : "unknown";
  return {
    state,
    workspace: String(raw.workspace ?? workspace ?? fallback?.workspace ?? ""),
    ...(typeof raw.source === "string" ? { source: raw.source } : {}),
    ...(typeof raw.enforced === "boolean" ? { enforced: raw.enforced } : {}),
    ...(typeof raw.message === "string" ? { message: truncatePreview(raw.message) } : {}),
    ...(typeof raw.requested_state === "string" ? { requested_state: raw.requested_state } : {}),
  };
}

function isViewMode(value: unknown): value is ViewMode {
  return value === "default" || value === "verbose" || value === "focus";
}

function runtimeEventFromParams(
  params: Record<string, unknown>,
): { method: string; params: Record<string, unknown> } | null {
  if (params.version !== 1 || typeof params.type !== "string" || params.type === "runtime.event") {
    return null;
  }
  const payload = recordOrNull(params.payload);
  if (!payload) {
    return null;
  }
  return { method: params.type, params: payload };
}
