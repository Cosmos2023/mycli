export function encodeMessage(message) {
  return `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;
}

export function decodeMessage(line) {
  const payload = JSON.parse(line);
  if (!payload || payload.jsonrpc !== "2.0") {
    throw new Error("Invalid JSON-RPC message");
  }
  return payload;
}

export function request(id, method, params = {}) {
  return { id, method, params };
}
