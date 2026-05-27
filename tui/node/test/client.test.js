import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { GatewayClient } from "../src/client.js";

test("client sends requests and receives responses and events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes = [];
  output.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const events = [];
  const client = new GatewayClient({ input, output, log: (event) => events.push(event) });
  client.start();

  const promise = client.send("status.inspect", {});
  assert.match(writes.join(""), /"method":"status.inspect"/);
  input.write('{"jsonrpc":"2.0","method":"runtime.ready","params":{"ok":true}}\n');
  input.write('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n');

  assert.deepEqual(await promise, { ok: true });
  assert.equal(events[0].method, "runtime.ready");
});

test("client waits for a matching event", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === "script_1",
  );
  input.write('{"jsonrpc":"2.0","method":"turn.event","params":{"client_turn_id":"script_1"}}\n');
  input.write('{"jsonrpc":"2.0","method":"turn.completed","params":{"client_turn_id":"script_1"}}\n');

  assert.equal((await promise).method, "turn.completed");
});

test("client stops reading gateway input", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  assert.ok(input.listenerCount("data") > 0);

  client.stop();

  assert.equal(input.listenerCount("data"), 0);
});
