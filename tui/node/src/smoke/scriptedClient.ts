import { GatewayClient } from "../protocol/client.ts";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import { initialState, reduceShellState } from "../state/reducer.ts";

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
    for (const item of script) {
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
      const clientTurnId = `script_${Date.now()}`;
      await client.send("turn.submit", { message: item, client_turn_id: clientTurnId });
      await client.waitForEvent(
        "turn.completed",
        (event) => event.params?.client_turn_id === clientTurnId,
      );
    }
    await client.send("shutdown", {});
    await dumpStateIfRequested(state);
  } finally {
    client.stop();
  }
}
