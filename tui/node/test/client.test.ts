import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { GatewayClient } from "../src/protocol/client.ts";

test("typed client sends requests and receives matching responses", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.send("status.inspect", {});
  input.write('{"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n');

  assert.match(writes.join(""), /"method":"status.inspect"/);
  assert.deepEqual(await promise, { ok: true });
  client.stop();
});

test("typed client waits for matching events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === "c1",
  );
  input.write('{"jsonrpc":"2.0","method":"turn.completed","params":{"client_turn_id":"c1"}}\n');

  assert.equal((await promise).method, "turn.completed");
  client.stop();
});

test("typed client narrows known event payloads and keeps unknown events", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const progressPromise = client.waitForEvent(
    "tool.progress",
    (event) => event.params.stage === "executing",
  );
  input.write(
    [
      '{"jsonrpc":"2.0","method":"tool.progress","params":',
      '{"client_turn_id":"c1","tool_id":"call_1","call_id":"call_1",',
      '"name":"Read","stage":"executing","message":"Executing Read"}}\n',
    ].join(""),
  );

  const progressEvent = await progressPromise;
  assert.equal(progressEvent.method, "tool.progress");
  assert.equal(progressEvent.params.tool_id, "call_1");
  assert.equal(progressEvent.params.stage, "executing");

  const unknownPromise = client.waitForEvent("custom.event");
  input.write('{"jsonrpc":"2.0","method":"custom.event","params":{"ok":true}}\n');
  const unknownEvent = await unknownPromise;
  assert.equal(unknownEvent.method, "custom.event");
  assert.equal(unknownEvent.params.ok, true);
  client.stop();
});
