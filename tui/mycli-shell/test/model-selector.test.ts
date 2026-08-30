import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionScope } from "@mycli/contracts";
import { ModelSelectorComponent } from "../src/components/model-selector.ts";
import type { MycliShellModel } from "../src/model.ts";
import type { TUI } from "../src/tui-core/index.ts";
import { visibleWidth } from "../src/tui-core/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

const tui = { requestRender() {} } as unknown as TUI;

const models: MycliShellModel[] = [
	{
		provider: "openai",
		protocol: "responses",
		model: "gpt-5.4",
		name: "GPT-5.4",
		description: "Frontier coding and reasoning model",
		baseUrl: "https://api.openai.com/v1",
		supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
		defaultReasoningEffort: "medium",
		current: true,
	},
	{
		provider: "deepseek",
		protocol: "chat_completions",
		model: "deepseek-chat",
		description: "Fast chat model",
		baseUrl: "https://api.deepseek.com",
		supportedReasoningEfforts: [],
		default: true,
	},
	{
		provider: "deepseek",
		protocol: "chat_completions",
		model: "deepseek-reasoner",
		description: "Fixed reasoning model",
		baseUrl: "https://api.deepseek.com",
		supportedReasoningEfforts: ["medium"],
		defaultReasoningEffort: "medium",
	},
];

function selector(
	onSelect: (model: MycliShellModel, scope: ModelSelectionScope) => void = () => {},
): ModelSelectorComponent {
	return new ModelSelectorComponent({
		tui,
		models,
		currentModel: models[0],
		onSelect,
		onCancel() {},
	});
}

test("model selector opens a second stage only for models with multiple efforts", () => {
	const component = selector();

	component.handleInput("\r");

	const output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /Select reasoning effort/);
	assert.match(output, /low/);
	assert.match(output, /medium/);
	assert.doesNotMatch(output, /deepseek-chat/);
});

test("model selector escape restores the model query and selection", () => {
	const component = selector();
	component.handleInput("g");
	component.handleInput("\r");

	component.handleInput("\x1b");

	const output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /Select model/);
	assert.match(output, /gpt-5.4/);
	assert.equal(component.getSearchInput().getValue(), "g");
});

test("model selector sends zero and one effort models through the scope stage", () => {
	const selected: Array<{ model: MycliShellModel; scope: ModelSelectionScope }> = [];
	const noEffort = selector((model, scope) => selected.push({ model, scope }));
	noEffort.handleInput("deepseek-chat");
	noEffort.handleInput("\r");
	assert.match(stripAnsi(noEffort.render(100).join("\n")), /Choose where to apply/);
	assert.equal(selected.length, 0);
	noEffort.handleInput("\r");

	const fixedEffort = selector((model, scope) => selected.push({ model, scope }));
	fixedEffort.handleInput("deepseek-reasoner");
	fixedEffort.handleInput("\r");
	fixedEffort.handleInput("\r");

	assert.equal(selected[0]?.model.model, "deepseek-chat");
	assert.equal(selected[0]?.model.thinkingLevel, undefined);
	assert.equal(selected[0]?.scope, "session");
	assert.equal(selected[1]?.model.model, "deepseek-reasoner");
	assert.equal(selected[1]?.model.thinkingLevel, "medium");
	assert.equal(selected[1]?.scope, "session");
});

test("model selector defaults to session scope and can select user scope", () => {
	const selected: Array<{ model: string; scope: ModelSelectionScope }> = [];
	const component = selector((model, scope) => selected.push({ model: model.model, scope }));

	component.handleInput("\r");
	component.handleInput("\r");
	let output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /Choose where to apply/);
	assert.match(output, /› Use for this session/);
	assert.match(output, /Make user default/);

	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.deepEqual(selected, [{ model: "gpt-5.4", scope: "user" }]);

	const sessionComponent = selector((model, scope) => selected.push({ model: model.model, scope }));
	sessionComponent.handleInput("deepseek-chat");
	sessionComponent.handleInput("\r");
	sessionComponent.handleInput("\r");
	assert.equal(selected.at(-1)?.scope, "session");
});

test("model selector submits one scope request at a time and allows retry after failure", () => {
	const selected: ModelSelectionScope[] = [];
	const component = selector((_model, scope) => selected.push(scope));
	component.handleInput("deepseek-chat");
	component.handleInput("\r");

	component.handleInput("\r");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.deepEqual(selected, ["session"]);

	component.setError("Selection failed.");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.deepEqual(selected, ["session", "user"]);
});

test("model selector escape returns from scope to the preceding stage", () => {
	const reasoning = selector();
	reasoning.handleInput("\r");
	reasoning.handleInput("\r");
	reasoning.handleInput("\x1b");
	assert.match(stripAnsi(reasoning.render(100).join("\n")), /Select reasoning effort/);

	const noReasoning = selector();
	noReasoning.handleInput("deepseek-chat");
	noReasoning.handleInput("\r");
	noReasoning.handleInput("\x1b");
	assert.match(stripAnsi(noReasoning.render(100).join("\n")), /Select model/);
	assert.equal(noReasoning.getSearchInput().getValue(), "deepseek-chat");
});

test("model selector shows inline backend errors", () => {
	const component = selector();

	component.setError("Provider rejected this model.");

	assert.match(stripAnsi(component.render(80).join("\n")), /Provider rejected this model/);
});

test("model selector never renders wider than narrow terminal", () => {
	const component = selector();

	for (const width of [30, 40, 60, 100]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
		}
	}

	component.handleInput("\r");
	component.handleInput("\r");
	for (const width of [20, 30, 40]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
		}
	}
});
