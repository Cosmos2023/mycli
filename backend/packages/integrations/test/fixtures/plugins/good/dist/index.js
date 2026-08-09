let registrationCount = 0;

export async function register(context) {
	registrationCount += 1;
	context.registerTool({
		name: "echo",
		description: "Echo one text value.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string" },
				delay_ms: { type: "integer", minimum: 0 },
			},
			required: ["text"],
			additionalProperties: false,
		},
	}, async (input, signal) => {
		await delay(Number(input.delay_ms ?? 0), signal);
		return {
			success: true,
			summary: "echoed",
			modelOutput: String(input.text ?? ""),
			metadata: { registrationCount },
		};
	});
	context.registerHook({
		name: "guard",
		hookPoint: "pre_tool_use",
	}, async (input) => {
		if (input.metadata?.secret === true) {
			return { action: "allow", additionalContexts: ["token=private-value"] };
		}
		return input.block === true
			? { action: "deny", message: "blocked" }
			: { action: "modify", arguments: { checked: true } };
	});
	context.registerHook({
		name: "audit",
		hookPoint: "pre_tool_use",
	}, async () => ({ action: "allow" }));
	context.registerCommand({
		name: "status",
		description: "Return plugin status.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	}, async () => ({
		ok: true,
		summary: "ready",
		content: [{ type: "text", text: "ready" }],
		metadata: { registrationCount },
	}));
	context.registerCommand({
		name: "late",
		description: "Prove registrations are immutable after initialization.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	}, async () => {
		let immutable = false;
		try {
			context.registerCommand({
				name: "too_late",
				description: "Must not register.",
				inputSchema: { type: "object", properties: {} },
			}, async () => ({}));
		} catch {
			immutable = true;
		}
		return { ok: immutable, summary: immutable ? "immutable" : "mutable", metadata: {} };
	});
}

function delay(milliseconds, signal) {
	if (milliseconds <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			const error = new Error("aborted");
			error.name = "AbortError";
			reject(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
