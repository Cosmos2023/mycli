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
