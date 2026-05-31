export type JsonObject = Record<string, unknown>;

export type TurnState =
  | "running"
  | "waiting_approval"
  | "waiting_clarification"
  | "completed"
  | "failed"
  | "interrupted"
  | "rejected";

export type Notification<Method extends string, Params extends JsonObject> = {
  jsonrpc: "2.0";
  method: Method;
  params: Params;
};

export type ApprovalDecisionChoice = "approve_once" | "reject" | "allow_session";

export type ApprovalOptionPayload = {
  choice: ApprovalDecisionChoice;
  label: string;
};

export type ApprovalRequestPayload = {
  client_turn_id?: string;
  decision_id: string;
  preview: string;
  reason?: string;
  tool_name?: string;
  options: ApprovalOptionPayload[];
};

export type ApprovalRespondPayload = {
  client_turn_id?: string;
  decision_id: string;
  choice: ApprovalDecisionChoice;
};

export type ClarifyRespondPayload = {
  client_turn_id?: string;
  request_id: string;
  response: string;
};

export type ClarifyOptionPayload = {
  label: string;
  description?: string;
};

export type ClarifyRequestPayload = {
  client_turn_id?: string;
  request_id: string;
  tool_id: string;
  call_id: string;
  tool_name: string;
  question: string;
  options: ClarifyOptionPayload[];
  header?: string;
  multi_select: boolean;
};

export type StatusUpdatePayload = {
  client_turn_id?: string;
  state: TurnState;
  kind: string;
  text: string;
  message?: string;
  severity?: string;
};

export type TurnStatusPayload = {
  client_turn_id?: string;
  state: Exclude<TurnState, "running">;
  kind: string;
  text: string;
  terminal: boolean;
  message?: string;
};

export type ToolLifecycleBasePayload = {
  client_turn_id?: string;
  tool_id: string;
  call_id: string;
  name: string;
};

export type ToolStartPayload = ToolLifecycleBasePayload & {
  context: string;
  args_preview?: string;
};

export type ToolProgressPayload = ToolLifecycleBasePayload & {
  stage: string;
  message: string;
  args_preview?: string;
};

export type ToolCompletePayload = ToolLifecycleBasePayload & {
  duration_s: number;
  summary: string;
  summary_chars: number;
  summary_truncated: boolean;
  success: true;
};

export type ToolFailedPayload = ToolLifecycleBasePayload & {
  duration_s: number;
  summary: string;
  summary_chars: number;
  summary_truncated: boolean;
  success: false;
  error?: string;
  error_chars?: number;
  error_truncated?: boolean;
};

export type TextDeltaPayload = {
  client_turn_id?: string;
  text: string;
};

export type MessageCompletePayload = {
  client_turn_id?: string;
  [key: string]: unknown;
};

export type TurnEventPayload = {
  client_turn_id?: string;
  phase: string;
  kind: string;
  text?: string;
  tool_name?: string | null;
  metadata?: JsonObject;
};

export type TurnStartedPayload = {
  client_turn_id: string;
};

export type TurnCompletedPayload = {
  client_turn_id?: string;
  assistant_message?: string;
  turn_state?: TurnState;
  pending_decision?: boolean;
  activity_events?: unknown[];
  progress_updates?: unknown[];
  plan_steps?: unknown[];
  usage?: JsonObject;
};

export type TurnFailedPayload = {
  client_turn_id?: string;
  message?: string;
};

export type TurnInterruptedPayload = {
  client_turn_id?: string;
  requested?: boolean;
};

export type StatusChangedPayload = JsonObject;

export type SessionChangedPayload = {
  session_id: string;
};

export type GatewayErrorCode =
  | "internal_error"
  | "invalid_params"
  | "method_not_found"
  | "turn_in_progress"
  | "decision_not_pending"
  | "clarification_not_pending"
  | "incompatible_protocol";

export const GATEWAY_ERROR_CODES = [
  "internal_error",
  "invalid_params",
  "method_not_found",
  "turn_in_progress",
  "decision_not_pending",
  "clarification_not_pending",
  "incompatible_protocol",
] as const satisfies readonly GatewayErrorCode[];

export type GatewayErrorPayload = {
  code: GatewayErrorCode;
  message: string;
  detail?: string;
  method?: string;
};

export type RuntimeEventEnvelopePayload = {
  version: 1;
  sequence: number;
  type: string;
  payload: JsonObject;
  timestamp: number;
};

export type RpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: JsonObject;
};

export type RpcResponse = {
  jsonrpc: "2.0";
  id: string;
  result?: JsonObject;
  error?: { code: string; message: string };
};

export type RpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params: JsonObject;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const KNOWN_GATEWAY_EVENT_METHODS = [
  "approval.request",
  "approval.respond",
  "clarify.request",
  "clarify.respond",
  "gateway.error",
  "message.complete",
  "message.delta",
  "reasoning.delta",
  "runtime.event",
  "session.changed",
  "status.changed",
  "status.update",
  "thinking.delta",
  "tool.complete",
  "tool.failed",
  "tool.progress",
  "tool.start",
  "turn.completed",
  "turn.event",
  "turn.failed",
  "turn.interrupted",
  "turn.started",
  "turn.status",
] as const;

type ListedKnownGatewayEventMethod = (typeof KNOWN_GATEWAY_EVENT_METHODS)[number];

type GatewayEventPayloadContract = {
  required: readonly string[];
  properties: readonly string[];
  enums?: Readonly<Record<string, readonly string[]>>;
  itemEnums?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
};

export const GATEWAY_EVENT_PAYLOAD_CONTRACTS: Record<
  ListedKnownGatewayEventMethod,
  GatewayEventPayloadContract
> = {
  "approval.request": {
    required: ["decision_id", "preview", "options"],
    properties: ["client_turn_id", "decision_id", "options", "preview", "reason", "tool_name"],
    itemEnums: {
      options: {
        choice: ["approve_once", "reject", "allow_session"],
      },
    },
  },
  "approval.respond": {
    required: ["decision_id", "choice"],
    properties: ["choice", "client_turn_id", "decision_id"],
    enums: {
      choice: ["approve_once", "reject", "allow_session"],
    },
  },
  "clarify.request": {
    required: [
      "request_id",
      "tool_id",
      "call_id",
      "tool_name",
      "question",
      "options",
      "multi_select",
    ],
    properties: [
      "call_id",
      "client_turn_id",
      "header",
      "multi_select",
      "options",
      "question",
      "request_id",
      "tool_id",
      "tool_name",
    ],
  },
  "clarify.respond": {
    required: ["request_id", "response"],
    properties: ["client_turn_id", "request_id", "response"],
  },
  "gateway.error": {
    required: ["code", "message"],
    properties: ["code", "detail", "message", "method"],
    enums: {
      code: GATEWAY_ERROR_CODES,
    },
  },
  "message.complete": {
    required: [],
    properties: ["client_turn_id", "final", "source", "text"],
  },
  "message.delta": {
    required: ["text"],
    properties: ["client_turn_id", "text"],
  },
  "reasoning.delta": {
    required: ["text"],
    properties: ["client_turn_id", "text"],
  },
  "runtime.event": {
    required: ["version", "sequence", "type", "payload", "timestamp"],
    properties: ["payload", "sequence", "timestamp", "type", "version"],
  },
  "session.changed": {
    required: ["session_id"],
    properties: ["session_id"],
  },
  "status.changed": {
    required: [
      "session_id",
      "workspace",
      "model",
      "provider",
      "context_window",
      "pending_decision",
      "suspended_turn",
    ],
    properties: [
      "context_window",
      "model",
      "pending_decision",
      "provider",
      "session_id",
      "suspended_turn",
      "workspace",
    ],
  },
  "status.update": {
    required: ["state", "kind", "text"],
    properties: ["client_turn_id", "kind", "message", "severity", "state", "text"],
    enums: {
      state: [
        "running",
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
      ],
    },
  },
  "thinking.delta": {
    required: ["text"],
    properties: ["client_turn_id", "text"],
  },
  "tool.complete": {
    required: [
      "client_turn_id",
      "tool_id",
      "call_id",
      "name",
      "duration_s",
      "summary",
      "summary_chars",
      "summary_truncated",
      "success",
    ],
    properties: [
      "call_id",
      "client_turn_id",
      "duration_s",
      "name",
      "success",
      "summary",
      "summary_chars",
      "summary_truncated",
      "tool_id",
    ],
  },
  "tool.failed": {
    required: [
      "client_turn_id",
      "tool_id",
      "call_id",
      "name",
      "duration_s",
      "summary",
      "summary_chars",
      "summary_truncated",
      "success",
    ],
    properties: [
      "call_id",
      "client_turn_id",
      "duration_s",
      "error",
      "error_chars",
      "error_truncated",
      "name",
      "success",
      "summary",
      "summary_chars",
      "summary_truncated",
      "tool_id",
    ],
  },
  "tool.progress": {
    required: ["client_turn_id", "tool_id", "call_id", "name", "stage", "message"],
    properties: ["args_preview", "call_id", "client_turn_id", "message", "name", "stage", "tool_id"],
  },
  "tool.start": {
    required: ["client_turn_id", "tool_id", "call_id", "name", "context"],
    properties: ["args_preview", "call_id", "client_turn_id", "context", "name", "tool_id"],
  },
  "turn.completed": {
    required: [
      "client_turn_id",
      "assistant_message",
      "activity_events",
      "progress_updates",
      "plan_steps",
      "pending_decision",
      "turn_state",
      "usage",
    ],
    properties: [
      "activity_events",
      "assistant_message",
      "client_turn_id",
      "pending_decision",
      "plan_steps",
      "progress_updates",
      "turn_state",
      "usage",
    ],
    enums: {
      turn_state: [
        "running",
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
      ],
    },
  },
  "turn.event": {
    required: ["phase", "kind"],
    properties: ["client_turn_id", "kind", "metadata", "phase", "text", "tool_name"],
  },
  "turn.failed": {
    required: [],
    properties: ["client_turn_id", "message"],
  },
  "turn.interrupted": {
    required: [],
    properties: ["client_turn_id", "requested"],
  },
  "turn.started": {
    required: ["client_turn_id"],
    properties: ["client_turn_id"],
  },
  "turn.status": {
    required: ["state", "kind", "text", "terminal"],
    properties: ["client_turn_id", "kind", "message", "state", "terminal", "text"],
    enums: {
      state: [
        "waiting_approval",
        "waiting_clarification",
        "completed",
        "failed",
        "interrupted",
        "rejected",
      ],
    },
  },
};

export type KnownGatewayEvent =
  | Notification<"runtime.event", RuntimeEventEnvelopePayload>
  | Notification<"turn.started", TurnStartedPayload>
  | Notification<"status.update", StatusUpdatePayload>
  | Notification<"approval.request", ApprovalRequestPayload>
  | Notification<"approval.respond", ApprovalRespondPayload>
  | Notification<"clarify.request", ClarifyRequestPayload>
  | Notification<"clarify.respond", ClarifyRespondPayload>
  | Notification<"tool.start", ToolStartPayload>
  | Notification<"tool.progress", ToolProgressPayload>
  | Notification<"tool.complete", ToolCompletePayload>
  | Notification<"tool.failed", ToolFailedPayload>
  | Notification<"message.delta", TextDeltaPayload>
  | Notification<"message.complete", MessageCompletePayload>
  | Notification<"reasoning.delta", TextDeltaPayload>
  | Notification<"thinking.delta", TextDeltaPayload>
  | Notification<"turn.completed", TurnCompletedPayload>
  | Notification<"turn.event", TurnEventPayload>
  | Notification<"turn.failed", TurnFailedPayload>
  | Notification<"turn.interrupted", TurnInterruptedPayload>
  | Notification<"turn.status", TurnStatusPayload>
  | Notification<"gateway.error", GatewayErrorPayload>
  | Notification<"session.changed", SessionChangedPayload>
  | Notification<"status.changed", StatusChangedPayload>;

export type KnownGatewayEventMethod = KnownGatewayEvent["method"];

type AssertNever<T extends never> = T;
type _KnownGatewayEventMethodMissingFromList = AssertNever<
  Exclude<KnownGatewayEventMethod, ListedKnownGatewayEventMethod>
>;
type _KnownGatewayEventMethodExtraInList = AssertNever<
  Exclude<ListedKnownGatewayEventMethod, KnownGatewayEventMethod>
>;
type _KnownGatewayEventMethodMissingFromContract = AssertNever<
  Exclude<KnownGatewayEventMethod, keyof typeof GATEWAY_EVENT_PAYLOAD_CONTRACTS>
>;
type _ContractMethodMissingFromKnownGatewayEvent = AssertNever<
  Exclude<keyof typeof GATEWAY_EVENT_PAYLOAD_CONTRACTS, KnownGatewayEventMethod>
>;

export type GatewayEventFor<Method extends KnownGatewayEventMethod> = Extract<
  KnownGatewayEvent,
  { method: Method }
>;

export type GatewayEventForMethod<Method extends string> =
  Method extends KnownGatewayEventMethod ? GatewayEventFor<Method> : UnknownGatewayEvent;

export type UnknownGatewayEvent = Notification<
  Exclude<string, KnownGatewayEvent["method"]>,
  JsonObject
>;

export type GatewayEvent = KnownGatewayEvent | UnknownGatewayEvent;

export type GatewayClientOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (event: GatewayEvent) => void;
};
