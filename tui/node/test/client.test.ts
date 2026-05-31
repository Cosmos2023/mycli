import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { resolve } from "node:path";
import { GatewayClient, GatewayRequestError } from "../src/protocol/client.ts";
import {
  GATEWAY_EVENT_PAYLOAD_CONTRACTS,
  KNOWN_GATEWAY_EVENT_METHODS,
} from "../src/protocol/types.ts";

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

  const completePromise = client.waitForEvent(
    "tool.complete",
    (event) => event.params.summary_chars === 19,
  );
  input.write(
    [
      '{"jsonrpc":"2.0","method":"tool.complete","params":',
      '{"client_turn_id":"c1","tool_id":"call_1","call_id":"call_1",',
      '"name":"Read","duration_s":0.125,"summary":"Read pyproject.toml",',
      '"summary_chars":19,"summary_truncated":false,"success":true}}\n',
    ].join(""),
  );
  const completeEvent = await completePromise;
  assert.equal(completeEvent.method, "tool.complete");
  assert.equal(completeEvent.params.summary_chars, 19);
  assert.equal(completeEvent.params.summary_truncated, false);

  const failedPromise = client.waitForEvent(
    "tool.failed",
    (event) => event.params.error_truncated === true,
  );
  input.write(
    [
      '{"jsonrpc":"2.0","method":"tool.failed","params":',
      '{"client_turn_id":"c1","tool_id":"call_2","call_id":"call_2",',
      '"name":"Bash","duration_s":0.2,"summary":"stdout preview...",',
      '"summary_chars":920,"summary_truncated":true,"success":false,',
      '"error":"stderr preview...","error_chars":480,"error_truncated":true}}\n',
    ].join(""),
  );
  const failedEvent = await failedPromise;
  assert.equal(failedEvent.method, "tool.failed");
  assert.equal(failedEvent.params.summary_chars, 920);
  assert.equal(failedEvent.params.summary_truncated, true);
  assert.equal(failedEvent.params.error_chars, 480);
  assert.equal(failedEvent.params.error_truncated, true);

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

  const turnEventPromise = client.waitForEvent(
    "turn.event",
    (event) => event.params.phase === "assistant_delta",
  );
  input.write(
    [
      '{"jsonrpc":"2.0","method":"turn.event","params":',
      '{"client_turn_id":"c1","phase":"assistant_delta","kind":"text_delta",',
      '"text":"legacy","tool_name":null,"metadata":{}}}\n',
    ].join(""),
  );
  const turnEvent = await turnEventPromise;
  assert.equal(turnEvent.method, "turn.event");
  assert.equal(turnEvent.params.phase, "assistant_delta");
  assert.equal(turnEvent.params.text, "legacy");

  const unknownPromise = client.waitForEvent("custom.event");
  input.write('{"jsonrpc":"2.0","method":"custom.event","params":{"ok":true}}\n');
  const unknownEvent = await unknownPromise;
  assert.equal(unknownEvent.method, "custom.event");
  assert.equal(unknownEvent.params.ok, true);
  client.stop();
});

test("known TypeScript event methods match Python advertised gateway streams", async () => {
  const { spawn } = await import("node:child_process");
  const python = spawn("python3", [
    "-c",
    [
      "import json",
      "from mycli.domain.runtime.gateway_contract import SUPPORTED_GATEWAY_EVENT_STREAMS",
      "print(json.dumps(sorted(SUPPORTED_GATEWAY_EVENT_STREAMS)))",
    ].join("; "),
  ], {
    env: {
      ...process.env,
      PYTHONPATH: [resolve(process.cwd(), "../../src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(":"),
    },
  });
  let stdout = "";
  let stderr = "";
  python.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  python.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => python.on("close", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.deepEqual(KNOWN_GATEWAY_EVENT_METHODS.slice().sort(), JSON.parse(stdout));
});

test("TypeScript payload contracts match Python manifest required fields", async () => {
  const pythonManifest = await pythonGatewayManifest();
  const pythonRequiredFields = Object.fromEntries(
    (pythonManifest.event_streams as Array<Record<string, unknown>>).map((entry) => {
      const schema = entry.payload_schema as Record<string, unknown>;
      return [String(entry.name), schema.required ?? []];
    }),
  );
  const tsRequiredFields = Object.fromEntries(
    Object.entries(GATEWAY_EVENT_PAYLOAD_CONTRACTS).map(([name, contract]) => [
      name,
      contract.required,
    ]),
  );

  assert.deepEqual(tsRequiredFields, pythonRequiredFields);
});

async function pythonGatewayManifest(): Promise<Record<string, unknown>> {
  const { spawn } = await import("node:child_process");
  const python = spawn("python3", [
    "-c",
    [
      "import json",
      "from mycli.services.extensions.manifest import ExtensionManifestService",
      "print(json.dumps(ExtensionManifestService().manifest()))",
    ].join("; "),
  ], {
    env: {
      ...process.env,
      PYTHONPATH: [resolve(process.cwd(), "../../src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(":"),
    },
  });
  let stdout = "";
  let stderr = "";
  python.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  python.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => python.on("close", resolve));
  assert.equal(exitCode, 0, stderr);
  return JSON.parse(stdout) as Record<string, unknown>;
}
