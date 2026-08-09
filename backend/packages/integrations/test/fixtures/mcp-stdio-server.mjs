#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const server = new McpServer({ name: "mycli-test-stdio", version: "1.0.0" });

server.registerTool("echo", {
	description: "Echo text.",
	inputSchema: { text: z.string() },
}, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));

server.registerTool("wait", {
	description: "Wait until the request is cancelled.",
	inputSchema: { delay_ms: z.number().int().positive() },
}, async ({ delay_ms }, extra) => {
	await new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, delay_ms);
		extra.signal.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(extra.signal.reason ?? new Error("cancelled"));
		}, { once: true });
	});
	return { content: [{ type: "text", text: "finished" }] };
});

server.registerResource(
	"readme",
	"file:///README.md",
	{ description: "Fixture resource", mimeType: "text/plain" },
	async () => ({ contents: [{ uri: "file:///README.md", text: "fixture readme" }] }),
);

if (process.env.MCP_PID_FILE) {
	await writeFile(process.env.MCP_PID_FILE, String(process.pid), "utf8");
}

const transport = new StdioServerTransport();
await server.connect(transport);
