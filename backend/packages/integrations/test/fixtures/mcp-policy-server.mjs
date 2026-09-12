import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "mcp-policy-fixture", version: "1" });
server.registerTool("probe", { inputSchema: {} }, async () => {
  const writable = async (path) => {
    if (!path) return false;
    try { await writeFile(path, "fixture"); return true; } catch { return false; }
  };
  let network = false;
  if (process.env.MCP_LOCAL_URL) {
    try { network = (await fetch(process.env.MCP_LOCAL_URL, { signal: AbortSignal.timeout(500) })).ok; } catch {}
  }
  const result = { cwd: process.cwd(), pid: process.pid, proxy: process.env.HTTP_PROXY,
    network, inside: await writable(process.env.MCP_INSIDE), outside: await writable(process.env.MCP_OUTSIDE),
    metadata: await writable(process.env.MCP_METADATA) };
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});
server.registerTool("wait", { inputSchema: {} }, async (_args, extra) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    extra.signal.addEventListener("abort", () => { clearTimeout(timer); reject(extra.signal.reason); }, { once: true });
  });
  return { content: [{ type: "text", text: "finished" }] };
});
await server.connect(new StdioServerTransport());
