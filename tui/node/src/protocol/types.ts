export type JsonObject = Record<string, unknown>;

export type TurnState =
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "interrupted";

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

export type GatewayEvent = RpcNotification;

export type GatewayClientOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?: (event: GatewayEvent) => void;
};
