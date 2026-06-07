import { GatewayClient, GatewayRequestError } from "../protocol/client.ts";
import type { TurnState } from "../protocol/types.ts";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import { initialState, reduceShellState } from "../state/reducer.ts";
import {
  runtimeCommandDispatch,
  sessionListOverlayLines,
  sessionResumeOverlayLines,
} from "../state/sessionCommands.ts";

type ScriptedState = ReturnType<typeof initialState>;
type ExpectedScriptedTurnState = Exclude<TurnState, "running">;

type ScriptedAction =
  | { type: "approval.respond"; choice: string }
  | {
      type: "approval.respond_raw";
      decision_id: string;
      choice: string;
      expect_error?: boolean;
    }
  | { type: "clarify.respond"; response: string }
  | { type: "session.resume"; session_id: string }
  | {
      type: "turn.submit_expect";
      message: string;
      expected_state: ExpectedScriptedTurnState;
    }
  | { type: "turn.submit_interrupt"; message: string };

async function dumpStateIfRequested(state: ReturnType<typeof initialState>): Promise<void> {
  const dumpPath = process.env.MYCLI_NODE_TUI_STATE_DUMP;
  if (!dumpPath) {
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(dumpPath, `${JSON.stringify(state)}\n`, "utf8");
}

export async function runScriptedClient(
  scriptRaw = process.env.MYCLI_NODE_TUI_SCRIPT || "[]",
): Promise<void> {
  const themeInit =
    process.env.MYCLI_TUI_THEME === undefined
      ? {}
      : { rawThemeName: process.env.MYCLI_TUI_THEME };
  let state = initialState(themeInit);
  const client = new GatewayClient({
    input: process.stdin,
    output: process.stdout,
    log: (event) => {
      if (event.method === "runtime.event") {
        return;
      }
      state = reduceShellState(state, {
        type: "gateway.event",
        method: event.method,
        params: event.params,
      });
      process.stderr.write(`[node-tui] ${event.method}\n`);
    },
  });
  client.start();
  try {
    const bootstrap = await client.send("session.bootstrap", {
      protocol_version: 1,
      client: { name: "mycli-node-tui", version: "0.2.0" },
    });
    state = reduceShellState(state, { type: "bootstrap.result", payload: bootstrap });
    const script = JSON.parse(scriptRaw) as unknown[];
    let turnSequence = 0;
    for (const item of script) {
      if (isScriptedAction(item)) {
        await runScriptedAction(client, () => state, item);
        continue;
      }
      if (typeof item !== "string" || !item.trim()) {
        continue;
      }
      if (item.startsWith("/")) {
        if (isLocalCommand(item)) {
          state = reduceShellState(state, handleLocalCommand(item, state));
          const last = state.transcript.at(-1);
          if (last?.text) {
            process.stderr.write(`[node-tui] ${last.text}\n`);
          }
          continue;
        }
        const result = await runRuntimeCommand(client, item);
        for (const line of result.lines) {
          process.stderr.write(`[node-tui] ${line}\n`);
        }
        if (result.exit_requested === true) {
          await client.send("shutdown", {});
          await dumpStateIfRequested(state);
          return;
        }
        continue;
      }
      turnSequence += 1;
      const clientTurnId = `script_${turnSequence}`;
      await client.send("turn.submit", { message: item, client_turn_id: clientTurnId });
      const completed = await client.waitForEvent(
        "turn.completed",
        (event) => event.params?.client_turn_id === clientTurnId,
      );
      if (completed.params.turn_state === "waiting_approval") {
        await waitForPending(() => state.pendingApproval, "approval.request");
      } else if (completed.params.turn_state === "waiting_clarification") {
        await waitForPending(() => state.pendingClarification, "clarify.request");
      } else {
        await waitForTerminalStatus(client, clientTurnId);
      }
    }
    await client.send("shutdown", {});
    await dumpStateIfRequested(state);
  } finally {
    client.stop();
  }
}

function isScriptedAction(item: unknown): item is ScriptedAction {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return false;
  }
  const type = (item as Record<string, unknown>).type;
  if (type === "approval.respond") {
    return typeof (item as Record<string, unknown>).choice === "string";
  }
  if (type === "approval.respond_raw") {
    const record = item as Record<string, unknown>;
    return typeof record.decision_id === "string" && typeof record.choice === "string";
  }
  if (type === "clarify.respond") {
    return typeof (item as Record<string, unknown>).response === "string";
  }
  if (type === "session.resume") {
    return typeof (item as Record<string, unknown>).session_id === "string";
  }
  if (type === "turn.submit_expect") {
    const record = item as Record<string, unknown>;
    return (
      typeof record.message === "string" && isExpectedScriptedTurnState(record.expected_state)
    );
  }
  if (type === "turn.submit_interrupt") {
    return typeof (item as Record<string, unknown>).message === "string";
  }
  return false;
}

async function runScriptedAction(
  client: GatewayClient,
  getState: () => ScriptedState,
  action: ScriptedAction,
): Promise<void> {
  const state = getState();
  if (action.type === "turn.submit_interrupt") {
    const clientTurnId = `script_interrupt_${Date.now()}`;
    await client.send("turn.submit", {
      message: action.message,
      client_turn_id: clientTurnId,
    });
    await client.waitForEvent(
      "turn.started",
      (event) => event.params?.client_turn_id === clientTurnId,
    );
    await client.send("turn.interrupt", {});
    await waitForInterruptedTerminal(client, clientTurnId);
    await waitForInterruptedStatus(client, clientTurnId);
    return;
  }
  if (action.type === "turn.submit_expect") {
    const clientTurnId = `script_expect_${Date.now()}`;
    await client.send("turn.submit", {
      message: action.message,
      client_turn_id: clientTurnId,
    });
    await client.waitForEvent(
      "turn.started",
      (event) => event.params?.client_turn_id === clientTurnId,
    );
    await waitForExpectedTurnState(client, getState, clientTurnId, action.expected_state);
    return;
  }
  if (action.type === "session.resume") {
    await client.send("session.resume", { session_id: action.session_id });
    return;
  }
  if (action.type === "approval.respond") {
    const decisionId = pendingId(state.pendingApproval, "decision_id", "approval.respond");
    const result = await sendForScriptedState(
      client,
      getState,
      "approval.respond",
      {
        decision_id: decisionId,
        choice: action.choice,
      },
      false,
    );
    const clientTurnId = stringField(result, "client_turn_id", "approval.respond");
    await client.waitForEvent(
      "turn.completed",
      (event) => event.params?.client_turn_id === clientTurnId,
    );
    await waitForTerminalStatus(client, clientTurnId);
    return;
  }
  if (action.type === "approval.respond_raw") {
    await sendForScriptedState(
      client,
      getState,
      "approval.respond",
      {
        decision_id: action.decision_id,
        choice: action.choice,
      },
      action.expect_error === true,
    );
    return;
  }
  const requestId = pendingId(state.pendingClarification, "request_id", "clarify.respond");
  const result = await sendForScriptedState(
    client,
    getState,
    "clarify.respond",
    {
      request_id: requestId,
      response: action.response,
    },
    false,
  );
  const clientTurnId = stringField(result, "client_turn_id", "clarify.respond");
  await client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === clientTurnId,
  );
  await waitForTerminalStatus(client, clientTurnId);
}

async function runRuntimeCommand(
  client: GatewayClient,
  command: string,
): Promise<{ lines: string[]; exit_requested?: boolean }> {
  const dispatch = runtimeCommandDispatch(command);
  if (dispatch.kind === "invalid") {
    return { lines: dispatch.lines };
  }
  if (dispatch.kind === "session.list") {
    const result = await client.send("session.list", {});
    return { lines: sessionListOverlayLines(result) };
  }
  if (dispatch.kind === "session.resume") {
    const result = await client.send("session.resume", { session_id: dispatch.sessionId });
    return { lines: sessionResumeOverlayLines(result) };
  }
  const result = await client.send("command.run", { command: dispatch.command });
  return {
    lines: (result.lines as string[] | undefined) ?? [],
    ...(result.exit_requested === true ? { exit_requested: true } : {}),
  };
}

async function waitForExpectedTurnState(
  client: GatewayClient,
  getState: () => ScriptedState,
  clientTurnId: string,
  expectedState: ExpectedScriptedTurnState,
): Promise<void> {
  if (expectedState === "waiting_approval") {
    await waitForCompletedTurnState(client, clientTurnId, expectedState);
    await waitForPending(() => getState().pendingApproval, "approval.request");
    await waitForLiveStatus(client, clientTurnId, expectedState);
    return;
  }
  if (expectedState === "waiting_clarification") {
    await waitForCompletedTurnState(client, clientTurnId, expectedState);
    await waitForPending(() => getState().pendingClarification, "clarify.request");
    await waitForLiveStatus(client, clientTurnId, expectedState);
    return;
  }
  if (expectedState === "interrupted") {
    await waitForInterruptedTerminal(client, clientTurnId);
    await waitForInterruptedStatus(client, clientTurnId);
    return;
  }
  await waitForCompletedTurnState(client, clientTurnId, expectedState);
  await waitForLiveStatus(client, clientTurnId, expectedState);
}

async function waitForCompletedTurnState(
  client: GatewayClient,
  clientTurnId: string,
  expectedState: ExpectedScriptedTurnState,
): Promise<void> {
  await client.waitForEvent(
    "turn.completed",
    (event) =>
      event.params?.client_turn_id === clientTurnId &&
      event.params?.turn_state === expectedState,
  );
}

async function waitForInterruptedTerminal(
  client: GatewayClient,
  clientTurnId: string,
): Promise<void> {
  await Promise.race([
    client.waitForEvent(
      "turn.completed",
      (event) =>
        event.params?.client_turn_id === clientTurnId &&
        event.params?.turn_state === "interrupted",
    ),
    client.waitForEvent(
      "turn.completion_suppressed",
      (event) =>
        event.params?.client_turn_id === clientTurnId &&
        event.params?.reason === "interrupt_requested",
    ),
  ]);
}

async function sendForScriptedState(
  client: GatewayClient,
  getState: () => ScriptedState,
  method: string,
  params: Record<string, unknown>,
  expectError: boolean,
): Promise<Record<string, unknown>> {
  try {
    return await client.send(method, params);
  } catch (error: unknown) {
    const gatewayError =
      error instanceof GatewayRequestError
        ? error
        : new GatewayRequestError({
            code: "request_failed",
            message: error instanceof Error ? error.message : "Request failed.",
            method,
          });
    const state = getState();
    Object.assign(
      state,
      reduceShellState(state, {
        type: "request.failed",
        method: gatewayError.method || method,
        code: gatewayError.code,
        message: gatewayError.message,
      }),
    );
    if (expectError) {
      return {};
    }
    throw error;
  }
}

async function waitForInterruptedStatus(
  client: GatewayClient,
  clientTurnId: string,
): Promise<void> {
  await client.waitForEvent(
    "turn.status",
    (event) =>
      event.params?.client_turn_id === clientTurnId &&
      event.params?.state === "interrupted" &&
      event.params?.terminal === true,
  );
}

async function waitForLiveStatus(
  client: GatewayClient,
  clientTurnId: string,
  expectedState: ExpectedScriptedTurnState,
): Promise<void> {
  await client.waitForEvent(
    "status.update",
    (event) =>
      event.params?.client_turn_id === clientTurnId &&
      event.params?.state === expectedState,
  );
}

async function waitForTerminalStatus(client: GatewayClient, clientTurnId: string): Promise<void> {
  await client.waitForEvent(
    "status.update",
    (event) =>
      event.params?.client_turn_id === clientTurnId &&
      (event.params?.state === "completed" ||
        event.params?.state === "failed" ||
        event.params?.state === "interrupted" ||
        event.params?.state === "rejected"),
  );
}

function isExpectedScriptedTurnState(value: unknown): value is ExpectedScriptedTurnState {
  return (
    value === "waiting_approval" ||
    value === "waiting_clarification" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "rejected"
  );
}

async function waitForPending(
  getPending: () => Record<string, unknown> | null,
  eventName: string,
): Promise<void> {
  if (getPending()) {
    return;
  }
  await Promise.resolve();
  if (getPending()) {
    return;
  }
  throw new Error(`${eventName} did not update scripted client state.`);
}

function pendingId(
  pending: Record<string, unknown> | null,
  key: string,
  actionName: string,
): string {
  const value = pending?.[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${actionName} requires pending ${key}.`);
}

function stringField(payload: Record<string, unknown>, key: string, actionName: string): string {
  const value = payload[key];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${actionName} response missing ${key}.`);
}
