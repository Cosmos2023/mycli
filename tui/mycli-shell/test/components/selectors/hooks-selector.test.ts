import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { HooksSelectorComponent } from "../../../src/components/selectors/hooks-selector.ts";
import type { MycliShellHookCatalog } from "../../../src/model.ts";

test("hook trust requires reviewing the command and an explicit second selection", async () => {
	const catalog: MycliShellHookCatalog = { revision: "a".repeat(64), hooks: [{ id: "b".repeat(64), revision: "c".repeat(64), name: "check", point: "stop", source: "user", path: "/hooks.json",
		command: ["node", "check script.mjs"], enabled: true, trusted: false, trustSource: "allowlist" }] };
	const changes: string[] = [];
	const selector = new HooksSelectorComponent({ manager: { load: async () => catalog, write: async (_hook, action) => { changes.push(action); return catalog; } }, onCancel() {} });
	try {
		await setImmediate(); selector.handleInput("\r"); selector.handleInput("\r");
		assert.match(stripVTControlCharacters(selector.render(80).join("\n")), /node "check script.mjs"/);
		selector.handleInput("\x1b[B"); selector.handleInput("\r");
		assert.deepEqual(changes, []);
		selector.handleInput("\r"); assert.deepEqual(changes, [], "Cancel is the default");
		selector.handleInput("\x1b[B"); selector.handleInput("\r");
		selector.handleInput("\x1b[B"); selector.handleInput("\r"); await setImmediate();
		assert.deepEqual(changes, ["trust"]);
	} finally { selector.dispose(); }
});
