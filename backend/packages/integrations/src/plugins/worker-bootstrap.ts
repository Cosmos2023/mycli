import { createInterface } from "node:readline";
import { isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	parsePluginV2ProtocolMessage,
	type PluginV2ProtocolMessage,
} from "@mycli/contracts";
import type {
	PluginCommandDefinition,
	PluginContextV2,
	PluginHandler,
	PluginHookDefinition,
	PluginProtocolRegistration,
	PluginResultType,
	PluginToolDefinition,
} from "./types.ts";

type InitializeMessage = Extract<PluginV2ProtocolMessage, { readonly type: "initialize" }>;
type InvokeMessage = Extract<PluginV2ProtocolMessage, { readonly type: "invoke" }>;
type ShutdownMessage = Extract<PluginV2ProtocolMessage, { readonly type: "shutdown" }>;
type PluginInputSchema = Extract<PluginProtocolRegistration, { readonly kind: "tool" }>["input_schema"];

interface RegisteredHandler {
	readonly kind: "tool" | "hook" | "command";
	readonly handler: PluginHandler;
}

const MAX_DIAGNOSTIC_CHARS = 8_192;
const entryPath = process.argv[2] ?? "";
const handlers = new Map<string, RegisteredHandler>();
const active = new Set<AbortController>();
let initialized = false;
let registrationOpen = false;
let diagnosticChars = 0;

redirectConsole();

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => { void acceptLine(line); });
input.once("close", () => {
	for (const controller of active) controller.abort();
});

async function acceptLine(line: string): Promise<void> {
	let message: PluginV2ProtocolMessage;
	try {
		message = parsePluginV2ProtocolMessage(JSON.parse(line) as unknown);
	} catch {
		writeDiagnostic("invalid host protocol message");
		process.exitCode = 2;
		input.close();
		return;
	}
	if (message.type === "initialize") {
		await initialize(message);
		return;
	}
	if (message.type === "invoke") {
		void invoke(message);
		return;
	}
	if (message.type === "shutdown") {
		shutdown(message);
		return;
	}
	writeError(message.request_id, "protocol_invalid", "Unsupported host message.");
}

async function initialize(message: InitializeMessage): Promise<void> {
	if (initialized || registrationOpen) {
		writeError(message.request_id, "protocol_invalid", "Plugin already initialized.");
		return;
	}
	if (!isAbsolute(entryPath) || ![".js", ".mjs"].includes(extname(entryPath))) {
		writeError(message.request_id, "registration_mismatch", "Plugin entry is invalid.");
		return;
	}
	registrationOpen = true;
	const registrations: PluginProtocolRegistration[] = [];
	try {
		const moduleValue = await import(pathToFileURL(entryPath).href);
		const register = moduleValue.register;
		if (typeof register !== "function") throw registrationError();
		const context = pluginContext(message, registrations);
		await register(context);
		registrationOpen = false;
		initialized = true;
		writeMessage({
			version: 2,
			type: "registered",
			request_id: message.request_id,
			registrations,
		});
	} catch (error) {
		registrationOpen = false;
		const code = isRegistrationError(error) ? "registration_mismatch" : "plugin_error";
		writeError(message.request_id, code, "Plugin registration failed.");
	}
}

function pluginContext(
	message: InitializeMessage,
	registrations: PluginProtocolRegistration[],
): PluginContextV2 {
	const tokens = new Set<string>();
	const names = new Set<string>();
	const add = (
		registration: PluginProtocolRegistration,
		handler: PluginHandler,
	): void => {
		if (!registrationOpen || initialized) throw registrationError();
		if (typeof handler !== "function") throw registrationError();
		if (tokens.has(registration.token) || names.has(`${registration.kind}:${registration.name}`)) {
			throw registrationError();
		}
		assertDeclared(message, registration);
		const parsed = parsePluginV2ProtocolMessage({
			version: 2,
			type: "registered",
			request_id: message.request_id,
			registrations: [registration],
		});
		if (parsed.type !== "registered") throw registrationError();
		const validated = parsed.registrations[0];
		if (!validated) throw registrationError();
		tokens.add(validated.token);
		names.add(`${validated.kind}:${validated.name}`);
		registrations.push(validated);
		handlers.set(validated.token, Object.freeze({ kind: validated.kind, handler }));
	};
	return Object.freeze({
		registerTool: (definition: PluginToolDefinition, handler: PluginHandler): void => {
			add({
				kind: "tool",
				token: `tool:${definition.name}`,
				name: definition.name,
				description: definition.description,
				input_schema: inputSchema(definition.inputSchema),
			}, handler);
		},
		registerHook: (definition: PluginHookDefinition, handler: PluginHandler): void => {
			add({
				kind: "hook",
				token: `hook:${definition.name}`,
				name: definition.name,
				hook_point: definition.hookPoint,
				input_schema: {
					type: "object",
					properties: {},
					additionalProperties: true,
				},
			}, handler);
		},
		registerCommand: (definition: PluginCommandDefinition, handler: PluginHandler): void => {
			add({
				kind: "command",
				token: `command:${definition.name}`,
				name: definition.name,
				description: definition.description,
				input_schema: inputSchema(definition.inputSchema),
			}, handler);
		},
	});
}

function assertDeclared(
	message: InitializeMessage,
	registration: PluginProtocolRegistration,
): void {
	if (registration.kind === "tool" && !message.declared.tools.includes(registration.name)) {
		throw registrationError();
	}
	if (registration.kind === "command" && !message.declared.commands.includes(registration.name)) {
		throw registrationError();
	}
	if (registration.kind === "hook" && !message.declared.hooks.includes(registration.hook_point)) {
		throw registrationError();
	}
}

function inputSchema(value: Readonly<Record<string, unknown>>): PluginInputSchema {
	if (value.type !== "object" || !isRecord(value.properties)) throw registrationError();
	return value as PluginInputSchema;
}

async function invoke(message: InvokeMessage): Promise<void> {
	if (!initialized || !handlers.has(message.target)) {
		writeError(message.request_id, "unknown_target", "Plugin target is unavailable.");
		return;
	}
	const registered = handlers.get(message.target)!;
	const controller = new AbortController();
	active.add(controller);
	try {
		const raw = await registered.handler(Object.freeze({ ...message.input }), controller.signal);
		writeMessage({
			version: 2,
			type: "result",
			request_id: message.request_id,
			value: {
				result_type: resultType(registered.kind),
				value: normalizeResult(registered.kind, raw),
			},
		});
	} catch {
		writeError(message.request_id, "handler_failed", "Plugin handler failed.");
	} finally {
		active.delete(controller);
	}
}

function shutdown(message: ShutdownMessage): void {
	for (const controller of active) controller.abort();
	writeMessage({
		version: 2,
		type: "shutdown_complete",
		request_id: message.request_id,
	});
	input.close();
	setImmediate(() => process.exit(0));
}

function normalizeResult(
	kind: RegisteredHandler["kind"],
	value: unknown,
): Readonly<Record<string, unknown>> {
	if (isRecord(value)) return value;
	const text = value === undefined ? "" : String(value);
	if (kind === "tool") {
		return Object.freeze({ success: true, summary: text || "plugin tool completed", modelOutput: text, metadata: {} });
	}
	if (kind === "command") {
		return Object.freeze({ ok: true, summary: text || "plugin command completed", content: [], metadata: {} });
	}
	return Object.freeze({ action: "allow" });
}

function resultType(kind: RegisteredHandler["kind"]): PluginResultType {
	return kind === "tool" ? "tool_result" : kind === "hook" ? "hook_result" : "command_result";
}

function writeError(requestId: string, code: string, message: string): void {
	writeMessage({
		version: 2,
		type: "error",
		request_id: requestId,
		error: { code, message },
	});
}

function writeMessage(message: PluginV2ProtocolMessage): void {
	try {
		const parsed = parsePluginV2ProtocolMessage(message);
		process.stdout.write(`${JSON.stringify(parsed)}\n`);
	} catch {
		writeDiagnostic("worker response serialization failed");
		process.exitCode = 2;
		input.close();
	}
}

function redirectConsole(): void {
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		console[method] = (...values: readonly unknown[]): void => {
			writeDiagnostic(values.map(safeDiagnosticValue).join(" "));
		};
	}
}

function writeDiagnostic(value: string): void {
	if (diagnosticChars >= MAX_DIAGNOSTIC_CHARS) return;
	const text = value.replace(/\s+/gu, " ").trim().slice(0, MAX_DIAGNOSTIC_CHARS - diagnosticChars);
	if (!text) return;
	diagnosticChars += text.length;
	process.stderr.write(`${text}\n`);
}

function safeDiagnosticValue(value: unknown): string {
	if (typeof value === "string") return value.slice(0, 512);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return "[plugin value]";
}

function registrationError(): Error {
	const error = new Error("registration mismatch");
	error.name = "PluginRegistrationError";
	return error;
}

function isRegistrationError(error: unknown): boolean {
	return error instanceof Error && error.name === "PluginRegistrationError";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
