import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { runScriptedClient } from "../src/smoke/scriptedClient.ts";

test("scripted client still shuts down after commands", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: string[] = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    writes.push(text);
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as { id: string; method: string };
      if (message.method === "session.bootstrap") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
      if (message.method === "command.run") {
        input.write(
          `{"jsonrpc":"2.0","id":"${message.id}","result":{"lines":["Bye."],"exit_requested":true}}\n`,
        );
      }
      if (message.method === "shutdown") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
    }
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    await runScriptedClient('["/quit"]');
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
  }
  assert.match(writes.join(""), /session\.bootstrap/);
  assert.match(writes.join(""), /shutdown/);
});
