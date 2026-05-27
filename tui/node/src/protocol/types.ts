export type JsonObject = Record<string, unknown>;

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
