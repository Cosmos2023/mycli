import { GatewayClient } from "./client.js";

const client = new GatewayClient({
  input: process.stdin,
  output: process.stdout,
  log: (event) => {
    process.stderr.write(`[node-tui] ${event.method}\n`);
  },
});

client.start();

async function main() {
  try {
    await client.send("session.bootstrap", {
      protocol_version: 1,
      client: { name: "mycli-node-tui", version: "0.1.0" },
    });
    const script = JSON.parse(process.env.MYCLI_NODE_TUI_SCRIPT || "[]");
    for (const item of script) {
      if (typeof item !== "string" || !item.trim()) {
        continue;
      }
      if (item.startsWith("/")) {
        const result = await client.send("command.run", { command: item });
        for (const line of result.lines ?? []) {
          process.stderr.write(`[node-tui] ${line}\n`);
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
  } finally {
    client.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`[node-tui] error: ${error.message}\n`);
  process.exitCode = 1;
});
