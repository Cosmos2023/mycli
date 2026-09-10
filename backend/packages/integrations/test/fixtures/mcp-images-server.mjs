import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==";
const server = new McpServer({ name: "image-fixture", version: "1.0.0" });
if (!process.argv.includes("--resources-only")) {
	server.registerTool("inspect_image", { description: "Return a local fixture image.", inputSchema: {} }, async () => ({
		content: [{ type: "text", text: "MCP image attached" }, { type: "image", mimeType: "image/png", data: image }],
	}));
}
server.registerResource("readme", "data:///readme", { mimeType: "text/plain" }, async () => ({
	contents: [{ uri: "data:///readme", text: "Resource text reached the model." }],
}));
server.registerResource("image", "data:///image", { mimeType: "image/png" }, async () => ({
	contents: [{ uri: "data:///image", mimeType: "image/png", blob: image }],
}));
server.registerResource("note", new ResourceTemplate("data:///notes/{name}", { list: undefined }),
	{ mimeType: "text/plain" }, async (uri, { name }) => ({ contents: [{ uri: uri.href, text: `Note ${name}` }] }));
await server.connect(new StdioServerTransport());
