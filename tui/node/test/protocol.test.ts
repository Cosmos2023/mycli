import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessage, encodeMessage, request } from "../src/protocol/client.ts";

test("encodes one JSON-RPC request line", () => {
  const line = encodeMessage(request("1", "status.inspect", {}));
  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    jsonrpc: "2.0",
    id: "1",
    method: "status.inspect",
    params: {},
  });
});

test("decodes notifications and responses", () => {
  assert.deepEqual(
    decodeMessage('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}'),
    { jsonrpc: "2.0", method: "runtime.ready", params: { ok: true } },
  );
  assert.deepEqual(
    decodeMessage('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}'),
    { jsonrpc: "2.0", id: "1", result: { ok: true } },
  );
});
