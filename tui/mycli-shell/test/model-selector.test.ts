import assert from "node:assert/strict";
import test from "node:test";
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

function selector(onSelect: (model: MycliShellModel) => void = () => {}): ModelSelectorComponent {
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

test("model selector applies models with zero or one effort directly", () => {
	const selected: MycliShellModel[] = [];
	const noEffort = selector((model) => selected.push(model));
	noEffort.handleInput("deepseek-chat");
	noEffort.handleInput("\r");

	const fixedEffort = selector((model) => selected.push(model));
	fixedEffort.handleInput("deepseek-reasoner");
	fixedEffort.handleInput("\r");

	assert.equal(selected[0]?.model, "deepseek-chat");
	assert.equal(selected[0]?.thinkingLevel, undefined);
	assert.equal(selected[1]?.model, "deepseek-reasoner");
	assert.equal(selected[1]?.thinkingLevel, "medium");
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
});
