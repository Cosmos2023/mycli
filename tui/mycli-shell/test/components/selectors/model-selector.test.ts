import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionScope } from "@mycli/contracts";
import { ModelSelectorComponent } from "../../../src/components/selectors/model-selector.ts";
import type { MycliShellModel, MycliShellProviderRoute } from "../../../src/model.ts";
import type { TUI } from "../../../src/tui-core/index.ts";
import { visibleWidth } from "../../../src/tui-core/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;

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

const providerRoutes: MycliShellProviderRoute[] = [
	{
		id: "openai",
		name: "OpenAI",
		protocols: ["responses"],
		protocol: "responses",
		activation: "active",
		configured: true,
		ready: true,
		current: true,
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		protocols: ["chat_completions"],
		protocol: "chat_completions",
		activation: "active",
		configured: true,
		ready: true,
		current: false,
	},
];

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

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

test("model selector applies the catalog default reasoning to the session on Enter", () => {
	const selected: Array<{ model: MycliShellModel; scope: ModelSelectionScope }> = [];
	const component = selector((model, scope) => selected.push({ model, scope }));

	component.handleInput("\r");

	assert.equal(selected[0]?.model.model, "gpt-5.4");
	assert.equal(selected[0]?.model.thinkingLevel, "medium");
	assert.equal(selected[0]?.scope, "session");
});

test("model selector respects the height budget with errors and blocks hidden confirmation", () => {
	let height = 7;
	let selections = 0;
	const component = new ModelSelectorComponent({
		tui, models, maxHeight: () => height, onSelect: () => { selections += 1; }, onCancel() {},
	});
	component.handleInput("\r");
	assert.equal(selections, 0);
	for (height of [1, 7, 8, 9, 12]) {
		component.setError("Provider rejected the selection.");
		assert.ok(component.render(80).length <= height);
	}
	component.handleInput("\r");
	assert.equal(selections, 1);
});

test("model selector fast path falls back to the first supported reasoning effort", () => {
	let selected: MycliShellModel | undefined;
	const component = new ModelSelectorComponent({
		tui,
		models: [{
			...models[0]!,
			defaultReasoningEffort: undefined,
			supportedReasoningEfforts: ["high", "low"],
		}],
		onSelect: (model) => { selected = model; },
		onCancel() {},
	});

	component.handleInput("\r");
	assert.equal(selected?.thinkingLevel, "high");
});

test("model selector fast path fences duplicate input and permits retry after failure", () => {
	const selected: string[] = [];
	const component = selector((model) => selected.push(model.model));

	component.handleInput("\r");
	component.handleInput("\r");
	assert.deepEqual(selected, ["gpt-5.4"]);

	component.setError("Selection failed.");
	component.handleInput("\r");
	assert.deepEqual(selected, ["gpt-5.4", "gpt-5.4"]);
});

test("model selector opens reasoning options with Tab for models with multiple efforts", () => {
	const component = selector();

	component.handleInput("\t");

	const output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /Select reasoning effort/);
	assert.match(output, /low/);
	assert.match(output, /medium/);
	assert.doesNotMatch(output, /deepseek-chat/);
});

test("model selector escape restores the model query and selection", () => {
	const component = selector();
	component.handleInput("g");
	component.handleInput("\t");

	component.handleInput("\x1b");

	const output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /Select model/);
	assert.match(output, /gpt-5.4/);
	assert.equal(component.getSearchInput().getValue(), "g");
});

test("model selector fast-selects fixed efforts while Tab retains scope options", () => {
	const selected: Array<{ model: MycliShellModel; scope: ModelSelectionScope }> = [];
	const noEffort = selector((model, scope) => selected.push({ model, scope }));
	noEffort.handleInput("deepseek-chat");
	noEffort.handleInput("\r");

	const fixedEffort = selector((model, scope) => selected.push({ model, scope }));
	fixedEffort.handleInput("deepseek-reasoner");
	fixedEffort.handleInput("\r");

	assert.equal(selected[0]?.model.model, "deepseek-chat");
	assert.equal(selected[0]?.model.thinkingLevel, undefined);
	assert.equal(selected[0]?.scope, "session");
	assert.equal(selected[1]?.model.model, "deepseek-reasoner");
	assert.equal(selected[1]?.model.thinkingLevel, "medium");
	assert.equal(selected[1]?.scope, "session");

	const advanced = selector((model, scope) => selected.push({ model, scope }));
	advanced.handleInput("deepseek-chat");
	advanced.handleInput("\t");
	assert.match(stripAnsi(advanced.render(100).join("\n")), /Choose where to apply/);
	advanced.handleInput("\x1b[B");
	advanced.handleInput("\r");
	assert.equal(selected[2]?.scope, "user");
});

test("model selector defaults to session scope and can select user scope", () => {
	const selected: Array<{ model: string; scope: ModelSelectionScope }> = [];
	const component = selector((model, scope) => selected.push({ model: model.model, scope }));

	component.handleInput("\t");
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
	assert.equal(selected.at(-1)?.scope, "session");
});

test("model selector submits one scope request at a time and allows retry after failure", () => {
	const selected: ModelSelectionScope[] = [];
	const component = selector((_model, scope) => selected.push(scope));
	component.handleInput("deepseek-chat");
	component.handleInput("\t");

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
	reasoning.handleInput("\t");
	reasoning.handleInput("\r");
	reasoning.handleInput("\x1b");
	assert.match(stripAnsi(reasoning.render(100).join("\n")), /Select reasoning effort/);

	const noReasoning = selector();
	noReasoning.handleInput("deepseek-chat");
	noReasoning.handleInput("\t");
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

	component.handleInput("\t");
	component.handleInput("\r");
	for (const width of [20, 30, 40]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
		}
	}
});

test("provider-first selector opens the current route and cycles providers without a back step", async () => {
	const requested: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => providerRoutes,
		onModelLoad: async (providerId) => {
			requested.push(providerId);
			return models.filter((model) => model.provider === providerId);
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();

	let output = stripAnsi(component.render(100).join("\n"));
	assert.deepEqual(requested, ["openai"]);
	assert.match(output, /OpenAI/);
	assert.match(output, /gpt-5\.4/);
	assert.match(output, /\[\/\] provider/);
	assert.doesNotMatch(output, /deepseek-chat/);

	component.handleInput("]");
	await flush();
	await flush();

	output = stripAnsi(component.render(100).join("\n"));
	assert.deepEqual(requested, ["openai", "deepseek"]);
	assert.match(output, /deepseek-chat/);
	assert.doesNotMatch(output, /gpt-5\.4/);
});

test("provider-first selector keeps the searchable provider list one back action away", async () => {
	const requested: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => providerRoutes,
		onModelLoad: async (providerId) => {
			requested.push(providerId);
			return models.filter((model) => model.provider === providerId);
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();
	component.handleInput("\x1b");

	assert.match(stripAnsi(component.render(100).join("\n")), /Select provider/);
	assert.deepEqual(requested, ["openai"]);
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	await flush();
	assert.deepEqual(requested, ["openai", "deepseek"]);
});

test("provider-first selector asks for a provider when no current route exists", async () => {
	const requested: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => providerRoutes.map((provider) => ({ ...provider, current: false })),
		onModelLoad: async (providerId) => {
			requested.push(providerId);
			return [];
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();

	assert.match(stripAnsi(component.render(100).join("\n")), /Select provider/);
	assert.deepEqual(requested, []);
});

test("provider-first selector skips the provider stage for one active route", async () => {
	const requested: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => [providerRoutes[0]!],
		onModelLoad: async (providerId) => {
			requested.push(providerId);
			return models.filter((model) => model.provider === providerId);
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();

	assert.deepEqual(requested, ["openai"]);
	assert.match(stripAnsi(component.render(100).join("\n")), /Select model/);
});

test("provider-first selector routes missing credentials to login before loading models", async () => {
	let loginProvider = "";
	let modelLoads = 0;
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => [{ ...providerRoutes[0]!, ready: false }],
		onModelLoad: async () => {
			modelLoads += 1;
			return [];
		},
		onLoginRequired: (provider) => { loginProvider = provider.id; },
		onSelect() {},
		onCancel() {},
	});
	await flush();

	assert.equal(loginProvider, "openai");
	assert.equal(modelLoads, 0);
	assert.match(stripAnsi(component.render(30).join("\n")), /Loading providers|Select provider/);
});

test("provider refresh after login retains the saved provider across a failed load and retry", async () => {
	let failLoad = false;
	const loaded: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		preferredProviderId: "openai",
		onProviderLoad: async () => {
			if (failLoad) throw new Error("Provider refresh unavailable.");
			return providerRoutes;
		},
		onModelLoad: async (providerId) => {
			loaded.push(providerId);
			return models.filter((model) => model.provider === providerId);
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();
	failLoad = true;
	component.refreshProviders("deepseek");
	await flush();
	assert.match(stripAnsi(component.render(100).join("\n")), /Provider refresh unavailable/);
	failLoad = false;
	component.handleInput("\r");
	await flush();
	assert.deepEqual(loaded, ["openai", "deepseek"]);
});

test("provider-first selector discards a stale model response after switching routes", async () => {
	let resolveOpenAi: ((value: MycliShellModel[]) => void) | undefined;
	let resolveDeepSeek: ((value: MycliShellModel[]) => void) | undefined;
	const accepted: string[] = [];
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => providerRoutes,
		onModelLoad: (providerId) => new Promise<MycliShellModel[]>((resolve) => {
			if (providerId === "openai") resolveOpenAi = resolve;
			else resolveDeepSeek = resolve;
		}),
		onModelsLoaded: (providerId) => accepted.push(providerId),
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();
	component.handleInput("\x1b");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	await flush();
	resolveDeepSeek?.(models.filter((model) => model.provider === "deepseek"));
	await flush();
	resolveOpenAi?.(models.filter((model) => model.provider === "openai"));
	await flush();

	assert.deepEqual(accepted, ["deepseek"]);
	const output = stripAnsi(component.render(100).join("\n"));
	assert.match(output, /deepseek-chat/);
	assert.doesNotMatch(output, /gpt-5\.4/);
});

test("provider-first selector keeps loading errors bounded and retryable", async () => {
	let attempts = 0;
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => [providerRoutes[0]!],
		onModelLoad: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("catalog unavailable api_key=selector-secret-sentinel");
			return models.filter((model) => model.provider === "openai");
		},
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();
	assert.match(stripAnsi(component.render(40).join("\n")), /catalog unavailable/);
	assert.doesNotMatch(stripAnsi(component.render(40).join("\n")), /selector-secret-sentinel/);
	component.handleInput("\r");
	await flush();

	assert.equal(attempts, 2);
	assert.match(stripAnsi(component.render(40).join("\n")), /gpt-5\.4/);
});

test("provider-first selector bounds large catalogs and narrow provider rows", async () => {
	const largeCatalog = Array.from({ length: 50 }, (_, index): MycliShellModel => ({
		provider: "openai",
		protocol: "responses",
		model: `gpt-${String(index).padStart(2, "0")}`,
		baseUrl: "https://api.openai.com/v1",
	}));
	const component = new ModelSelectorComponent({
		tui,
		models: [],
		onProviderLoad: async () => [providerRoutes[0]!],
		onModelLoad: async () => largeCatalog,
		onSelect() {},
		onCancel() {},
	});
	await flush();
	await flush();
	const output = stripAnsi(component.render(24).join("\n"));
	assert.match(output, /1\/50/);
	assert.equal((output.match(/gpt-\d\d/g) ?? []).length, 10);
	for (const line of component.render(24)) assert.ok(visibleWidth(line) <= 24);
});
