export type JsonObject = Record<string, unknown>;

export type TurnState =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted";

export type Notification<Method extends string, Params extends JsonObject> = {
  jsonrpc: "2.0";
  method: Method;
  params: Params;
};

export type ApprovalOptionPayload = {
  choice: "approve_once" | "reject" | "allow_session" | string;
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
  choice: string;
};

export type StatusUpdatePayload = {
  client_turn_id?: string;
  state: TurnState;
  kind: string;
  text: string;
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
  success: true;
};

export type ToolFailedPayload = ToolLifecycleBasePayload & {
  duration_s: number;
  summary: string;
  success: false;
  error?: string;
};

export type TextDeltaPayload = {
  client_turn_id?: string;
  text: string;
};

export type MessageCompletePayload = {
  client_turn_id?: string;
  [key: string]: unknown;
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

export type KnownGatewayEvent =
  | Notification<"runtime.event", RuntimeEventEnvelopePayload>
  | Notification<"turn.started", TurnStartedPayload>
  | Notification<"status.update", StatusUpdatePayload>
  | Notification<"approval.request", ApprovalRequestPayload>
  | Notification<"approval.respond", ApprovalRespondPayload>
  | Notification<"tool.start", ToolStartPayload>
  | Notification<"tool.progress", ToolProgressPayload>
  | Notification<"tool.complete", ToolCompletePayload>
  | Notification<"tool.failed", ToolFailedPayload>
  | Notification<"message.delta", TextDeltaPayload>
  | Notification<"message.complete", MessageCompletePayload>
  | Notification<"reasoning.delta", TextDeltaPayload>
  | Notification<"thinking.delta", TextDeltaPayload>
  | Notification<"turn.completed", TurnCompletedPayload>
  | Notification<"turn.failed", TurnFailedPayload>
  | Notification<"turn.interrupted", TurnInterruptedPayload>
  | Notification<"turn.status", TurnStatusPayload>
  | Notification<"status.changed", StatusChangedPayload>;

export type KnownGatewayEventMethod = KnownGatewayEvent["method"];

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
