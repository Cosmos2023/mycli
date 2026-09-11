import assert from "node:assert/strict";
import test from "node:test";
import { LoginFlowComponent, type LoginFlowResult } from "../../../src/components/selectors/login-flow.ts";
import type { TUI } from "../../../src/tui-core/index.ts";

const tui = { requestRender() {} } as unknown as TUI;

test("standalone login preserves the resolved credential ref when backing out and reselecting", () => {
	const saved: LoginFlowResult[] = [];
	let cancelled = 0;
	const component = new LoginFlowComponent({
		tui,
		providers: [{ id: "qwen", name: "Qwen", authRef: "qwen", configured: true }],
		initialProviderId: "qwen",
		initialAuthRef: "qwen-work",
		onSubmit: (result) => { saved.push(result); },
		onCancel: () => { cancelled += 1; },
	});
	component.handleInput("discarded-key");
	component.handleInput("\x1b");
	assert.match(component.render(100).join("\n"), /Select provider to configure/);
	assert.match(component.render(100).join("\n"), /login required/);
	component.handleInput("\r");
	component.handleInput("replacement-key");
	component.handleInput("\r");
	assert.deepEqual(saved, [{ providerId: "qwen", authRef: "qwen-work", apiKey: "replacement-key" }]);
	component.handleInput("\x1b");
	component.handleInput("\x1b");
	assert.equal(cancelled, 1);
});

test("model login delegates back to its caller instead of entering the login provider list", () => {
	let returned = 0;
	const component = new LoginFlowComponent({
		tui,
		providers: [{ id: "qwen", name: "Qwen", authRef: "qwen-work", configured: false }],
		initialProviderId: "qwen",
		onSubmit() {},
		onCancel: () => assert.fail("Back must return to the model selector."),
		onBack: () => { returned += 1; },
	});
	component.handleInput("\x1b");
	assert.equal(returned, 1);
	assert.doesNotMatch(component.render(100).join("\n"), /Select provider to configure/);
});
