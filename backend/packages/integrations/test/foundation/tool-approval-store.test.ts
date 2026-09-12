import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IntegrationToolApprovalStore } from "../../src/index.ts";

test("remembered MCP grants survive reopen, replace changed definitions, and revoke only the selected server", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-integration-grants-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new IntegrationToolApprovalStore(root);
	assert.deepEqual(await store.load(), []);
	const scopes = ["mcp:web:search", "mcp:other:read", "plugin:demo:run"].map((id) => ({ id, fingerprint: "a".repeat(64) }));
	await Promise.all(scopes.map((scope) => store.allow(scope)));
	await store.allow({ ...scopes[0]!, fingerprint: "b".repeat(64) });
	const reopened = new IntegrationToolApprovalStore(root);
	assert.equal((await reopened.load()).length, 3);
	assert.equal((await reopened.load()).find((scope) => scope.id === scopes[0]!.id)?.fingerprint, "b".repeat(64));
	await reopened.revokeMcpServer("web");
	assert.deepEqual((await store.load()).map((scope) => scope.id).sort(), ["mcp:other:read", "plugin:demo:run"]);
	const content = await readFile(join(root, ".mycli/integration-tool-approvals.json"), "utf8");
	assert.deepEqual(Object.keys(JSON.parse(content).tools[0]).sort(), ["fingerprint", "id"]);
});

test("corrupt or oversized grant files fail closed without overwriting the file", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-integration-grants-invalid-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new IntegrationToolApprovalStore(root);
	const scope = { id: "mcp:web:read", fingerprint: "a".repeat(64) };
	await store.allow(scope);
	const path = join(root, ".mycli/integration-tool-approvals.json");
	for (const content of ['{"version":99,"tools":[]}', JSON.stringify({ version: 1, tools: [scope, scope] }), "private".repeat(44_000)]) {
		await writeFile(path, content);
		await assert.rejects(store.load(), /Integration approval storage/u);
		await assert.rejects(store.allow(scope), /Integration approval storage/u);
		assert.equal(await readFile(path, "utf8"), content);
	}
});
