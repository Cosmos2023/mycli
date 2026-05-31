import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { GatewayClient, GatewayRequestError } from "../src/protocol/client.ts";

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

test("typed client rejects JSON-RPC errors with request code and method", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const client = new GatewayClient({ input, output });
  client.start();

  const promise = client.send("approval.respond", { decision_id: "bad", choice: "reject" });
  input.write(
    [
      '{"jsonrpc":"2.0","id":"1","error":',
      '{"code":"decision_not_pending","message":"No pending decision."}}\n',
    ].join(""),
  );

  await assert.rejects(
    promise,
    (error) =>
      error instanceof GatewayRequestError &&
      error.code === "decision_not_pending" &&
      error.method === "approval.respond" &&
      error.message === "No pending decision.",
  );
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

  const clarifyPromise = client.waitForEvent(
    "clarify.request",
    (event) => event.params.request_id === "question_1",
  );
  input.write(
    [
      '{"jsonrpc":"2.0","method":"clarify.request","params":',
      '{"client_turn_id":"c1","request_id":"question_1","tool_id":"question_1",',
      '"call_id":"question_1","tool_name":"AskUserQuestion",',
      '"question":"Pick one","options":[{"label":"A","description":"First"}],',
      '"header":"Choice","multi_select":false}}\n',
    ].join(""),
  );
  const clarifyEvent = await clarifyPromise;
  assert.equal(clarifyEvent.method, "clarify.request");
  assert.equal(clarifyEvent.params.question, "Pick one");
  assert.equal(clarifyEvent.params.options[0]?.label, "A");
  assert.equal(clarifyEvent.params.multi_select, false);

  const sessionChangedPromise = client.waitForEvent(
    "session.changed",
    (event) => event.params.session_id === "resumed",
  );
  input.write(
    '{"jsonrpc":"2.0","method":"session.changed","params":{"session_id":"resumed"}}\n',
  );
  const sessionChangedEvent = await sessionChangedPromise;
  assert.equal(sessionChangedEvent.method, "session.changed");
  assert.equal(sessionChangedEvent.params.session_id, "resumed");

  const unknownPromise = client.waitForEvent("custom.event");
  input.write('{"jsonrpc":"2.0","method":"custom.event","params":{"ok":true}}\n');
  const unknownEvent = await unknownPromise;
  assert.equal(unknownEvent.method, "custom.event");
  assert.equal(unknownEvent.params.ok, true);
  client.stop();
});
