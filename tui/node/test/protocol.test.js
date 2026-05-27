import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessage, encodeMessage, request } from "../src/protocol.js";

test("encodes one JSON-RPC line", () => {
  const line = encodeMessage(request("1", "session.bootstrap", { protocol_version: 1 }));
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    jsonrpc: "2.0",
    id: "1",
    method: "session.bootstrap",
    params: { protocol_version: 1 },
  });
});

test("decodes JSON-RPC messages", () => {
  assert.deepEqual(decodeMessage('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}'), {
    jsonrpc: "2.0",
    id: "1",
    result: { ok: true },
  });
});
