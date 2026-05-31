import { GatewayClient } from "../protocol/client.ts";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import { initialState, reduceShellState } from "../state/reducer.ts";

type ScriptedState = ReturnType<typeof initialState>;

type ScriptedAction =
  | { type: "approval.respond"; choice: string }
  | { type: "clarify.respond"; response: string };

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
        const result = await client.send("command.run", { command: item });
        for (const line of (result.lines as string[] | undefined) ?? []) {
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
  if (type === "clarify.respond") {
    return typeof (item as Record<string, unknown>).response === "string";
  }
  return false;
}

async function runScriptedAction(
  client: GatewayClient,
  getState: () => ScriptedState,
  action: ScriptedAction,
): Promise<void> {
  const state = getState();
  if (action.type === "approval.respond") {
    const decisionId = pendingId(state.pendingApproval, "decision_id", "approval.respond");
    const result = await client.send("approval.respond", {
      decision_id: decisionId,
      choice: action.choice,
    });
    const clientTurnId = stringField(result, "client_turn_id", "approval.respond");
    await client.waitForEvent(
      "turn.completed",
      (event) => event.params?.client_turn_id === clientTurnId,
    );
    await waitForTerminalStatus(client, clientTurnId);
    return;
  }
  const requestId = pendingId(state.pendingClarification, "request_id", "clarify.respond");
  const result = await client.send("clarify.respond", {
    request_id: requestId,
    response: action.response,
  });
  const clientTurnId = stringField(result, "client_turn_id", "clarify.respond");
  await client.waitForEvent(
    "turn.completed",
    (event) => event.params?.client_turn_id === clientTurnId,
  );
  await waitForTerminalStatus(client, clientTurnId);
}

async function waitForTerminalStatus(client: GatewayClient, clientTurnId: string): Promise<void> {
  await client.waitForEvent(
    "status.update",
    (event) =>
      event.params?.client_turn_id === clientTurnId &&
      (event.params?.state === "completed" ||
        event.params?.state === "failed" ||
        event.params?.state === "interrupted"),
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
