import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("scripted client handles local theme command without command.run", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id: string; method: string; params?: Record<string, unknown> }> = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      messages.push(message);
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
    await runScriptedClient('["/theme mono","/quit"]');
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
  }

  const commandRuns = messages.filter((message) => message.method === "command.run");
  assert.equal(commandRuns.length, 1);
  assert.equal(commandRuns[0]?.params?.command, "/quit");
});

test("scripted client can resume a session before follow-up actions", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const originalDump = process.env.MYCLI_NODE_TUI_STATE_DUMP;
  const tempDir = await mkdtemp(join(tmpdir(), "mycli-scripted-resume-"));
  const dumpPath = join(tempDir, "state.json");
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id: string; method: string; params?: Record<string, unknown> }> = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      messages.push(message);
      if (message.method === "session.bootstrap") {
        input.write(
          [
            `{"jsonrpc":"2.0","id":"${message.id}","result":`,
            '{"session_id":"root","workspace":"/tmp/work","model":"test",',
            '"provider":"test/chat","status":{"session_id":"root"},',
            '"welcome":{"workspace":"/tmp/work","startup_mark":{"text":"mycli"}}}}\n',
          ].join(""),
        );
      }
      if (message.method === "session.resume") {
        input.write(`{"jsonrpc":"2.0","method":"session.changed","params":{"session_id":"branch"}}\n`);
        input.write(
          [
            '{"jsonrpc":"2.0","method":"status.changed","params":',
            '{"session_id":"branch","pending_decision":false,"suspended_turn":false}}\n',
          ].join(""),
        );
        input.write(
          `{"jsonrpc":"2.0","id":"${message.id}","result":{"session_id":"branch","lines":["[session] resumed branch"]}}\n`,
        );
      }
      if (message.method === "shutdown") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
    }
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  process.env.MYCLI_NODE_TUI_STATE_DUMP = dumpPath;
  try {
    await runScriptedClient(JSON.stringify([{ type: "session.resume", session_id: "root" }]));
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    if (originalDump === undefined) {
      delete process.env.MYCLI_NODE_TUI_STATE_DUMP;
    } else {
      process.env.MYCLI_NODE_TUI_STATE_DUMP = originalDump;
    }
  }

  try {
    const resume = messages.find((message) => message.method === "session.resume");
    assert.deepEqual(resume?.params, { session_id: "root" });
    const state = JSON.parse(await readFile(dumpPath, "utf8")) as {
      sessionId: string;
      status: Record<string, unknown>;
    };
    assert.equal(state.sessionId, "branch");
    assert.equal(state.status.session_id, "branch");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scripted client routes session commands through typed RPCs", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id: string; method: string; params?: Record<string, unknown> }> = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      messages.push(message);
      if (message.method === "session.bootstrap") {
        input.write(
          [
            `{"jsonrpc":"2.0","id":"${message.id}","result":`,
            '{"session_id":"root","workspace":"/tmp/work","model":"test",',
            '"provider":"test/chat","status":{"session_id":"root"},',
            '"welcome":{"workspace":"/tmp/work","startup_mark":{"text":"mycli"}}}}\n',
          ].join(""),
        );
      }
      if (message.method === "session.list") {
        input.write(
          [
            `{"jsonrpc":"2.0","id":"${message.id}","result":`,
            '{"sessions":[{"id":"root","last_active":"2026-06-07T01:00:00Z",',
            '"message_count":4,"current":true}]}}\n',
          ].join(""),
        );
      }
      if (message.method === "session.resume") {
        input.write(`{"jsonrpc":"2.0","method":"session.changed","params":{"session_id":"branch"}}\n`);
        input.write(
          `{"jsonrpc":"2.0","id":"${message.id}","result":{"session_id":"branch","lines":["[session] resumed branch"]}}\n`,
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
    await runScriptedClient('["/sessions","/resume branch"]');
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
  }

  assert.ok(messages.some((message) => message.method === "session.list"));
  assert.deepEqual(
    messages.find((message) => message.method === "session.resume")?.params,
    { session_id: "branch" },
  );
  assert.equal(messages.some((message) => message.method === "command.run"), false);
});

test("scripted client records approval request failures in dumped state", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const originalDump = process.env.MYCLI_NODE_TUI_STATE_DUMP;
  const tempDir = await mkdtemp(join(tmpdir(), "mycli-scripted-error-"));
  const dumpPath = join(tempDir, "state.json");
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id: string; method: string }> = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as { id: string; method: string };
      messages.push(message);
      if (message.method === "session.bootstrap") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
      if (message.method === "approval.respond") {
        input.write(
          [
            `{"jsonrpc":"2.0","id":"${message.id}","error":`,
            '{"code":"decision_not_pending","message":"No pending decision."}}\n',
          ].join(""),
        );
      }
      if (message.method === "shutdown") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
    }
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  process.env.MYCLI_NODE_TUI_STATE_DUMP = dumpPath;
  try {
    await runScriptedClient(
      JSON.stringify([
        {
          type: "approval.respond_raw",
          decision_id: "missing_decision",
          choice: "reject",
          expect_error: true,
        },
      ]),
    );
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    if (originalDump === undefined) {
      delete process.env.MYCLI_NODE_TUI_STATE_DUMP;
    } else {
      process.env.MYCLI_NODE_TUI_STATE_DUMP = originalDump;
    }
  }

  try {
    assert.equal(messages.some((message) => message.method === "approval.respond"), true);
    const state = JSON.parse(await readFile(dumpPath, "utf8")) as {
      transcript: Array<{ type: string; text: string; metadata: Record<string, unknown> }>;
    };
    const errors = state.transcript.filter((item) => item.type === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.text, "No pending decision.");
    assert.deepEqual(errors[0]?.metadata, {
      code: "decision_not_pending",
      message: "No pending decision.",
      method: "approval.respond",
      source: "request",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("scripted client submits a turn and waits for an expected failed state", async () => {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  const originalDump = process.env.MYCLI_NODE_TUI_STATE_DUMP;
  const tempDir = await mkdtemp(join(tmpdir(), "mycli-scripted-expect-"));
  const dumpPath = join(tempDir, "state.json");
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Array<{ id: string; method: string; params?: Record<string, unknown> }> = [];
  output.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const rawLine of text.split("\n")) {
      if (!rawLine.trim()) {
        continue;
      }
      const message = JSON.parse(rawLine) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      messages.push(message);
      if (message.method === "session.bootstrap") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
      if (message.method === "turn.submit") {
        const clientTurnId = String(message.params?.client_turn_id);
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"accepted":true,"client_turn_id":"${clientTurnId}"}}\n`);
        input.write(`{"jsonrpc":"2.0","method":"turn.started","params":{"client_turn_id":"${clientTurnId}"}}\n`);
        input.write(
          [
            '{"jsonrpc":"2.0","method":"turn.completed","params":',
            `{"client_turn_id":"${clientTurnId}","assistant_message":"failed",`,
            '"activity_events":[],"progress_updates":[],"plan_steps":[],',
            '"pending_decision":false,"turn_state":"failed","usage":{}}}\n',
          ].join(""),
        );
        input.write(
          `{"jsonrpc":"2.0","method":"status.update","params":{"client_turn_id":"${clientTurnId}","state":"failed","kind":"failed","text":"Failed"}}\n`,
        );
      }
      if (message.method === "shutdown") {
        input.write(`{"jsonrpc":"2.0","id":"${message.id}","result":{"ok":true}}\n`);
      }
    }
  });
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  process.env.MYCLI_NODE_TUI_STATE_DUMP = dumpPath;
  try {
    await runScriptedClient(
      JSON.stringify([
        {
          type: "turn.submit_expect",
          message: "fail once",
          expected_state: "failed",
        },
      ]),
    );
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
    if (originalDump === undefined) {
      delete process.env.MYCLI_NODE_TUI_STATE_DUMP;
    } else {
      process.env.MYCLI_NODE_TUI_STATE_DUMP = originalDump;
    }
  }

  try {
    const submitted = messages.find((message) => message.method === "turn.submit");
    assert.equal(submitted?.params?.message, "fail once");
    const state = JSON.parse(await readFile(dumpPath, "utf8")) as {
      liveStatus: { state: string };
    };
    assert.equal(state.liveStatus.state, "failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
