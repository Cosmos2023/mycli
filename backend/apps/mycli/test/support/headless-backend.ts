import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { NodeBackend } from "../../src/node-runtime/node-backend.ts";

export interface FakeHeadlessRequest {
	readonly id: string;
	readonly method: string;
	readonly params: Readonly<Record<string, unknown>>;
}

export function fakeHeadlessBackend(options: {
	readonly trust?: string;
	readonly pending?: boolean;
	readonly onSubmit?: (request: FakeHeadlessRequest, emit: (method: string, params: Readonly<Record<string, unknown>>) => void) => void;
} = {}): {
	readonly backend: NodeBackend;
	readonly requests: FakeHeadlessRequest[];
	readonly closed: () => boolean;
	readonly exit: () => void;
} {
	const input = new PassThrough();
	const output = new PassThrough();
	const requests: FakeHeadlessRequest[] = [];
	let resolveCompletion!: (code: number) => void;
	let closed = false;
	const completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
	const emit = (method: string, params: Readonly<Record<string, unknown>>): void => {
		input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
	};
	const lines = createInterface({ input: output, crlfDelay: Infinity });
	lines.on("line", (line) => {
		const request = JSON.parse(line) as FakeHeadlessRequest;
		requests.push(request);
		const result = request.method === "session.bootstrap" ? {
			protocol_version: 1, workspace: "/repo", provider: "test-provider",
			session_id: "test-session", model: "test-model",
			status: { trust: { state: options.trust ?? "trusted" }, pending_decision: options.pending ?? false },
		} : request.method === "permissions.update" ? { permissions: { active: "read-only" }, status: {} } : { accepted: true };
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
		if (request.method === "turn.submit") {
			emit("turn.started", { client_turn_id: request.params.client_turn_id, turn_id: "test-turn" });
			if (options.onSubmit) options.onSubmit(request, emit);
			else completeHeadlessTurn(request, emit, "done");
		}
	});
	emit("runtime.ready", { session_id: "test-session" });
	const close = (): void => { closed = true; lines.close(); input.end(); output.end(); resolveCompletion(0); };
	return {
		backend: { transport: { input, output }, completion, close: async () => close(), kill: close, diagnostic: () => "" },
		requests, closed: () => closed, exit: () => resolveCompletion(1),
	};
}

export function completeHeadlessTurn(request: FakeHeadlessRequest, emit: (method: string, params: Readonly<Record<string, unknown>>) => void, text: string): void {
	const clientTurnId = request.params.client_turn_id;
	emit("message.delta", { client_turn_id: clientTurnId, text });
	emit("turn.completed", {
		client_turn_id: clientTurnId, turn_id: "test-turn", assistant_message: text,
		activity_events: [], progress_updates: [], plan_steps: [], pending_decision: false,
		turn_state: "completed", usage: { input_tokens: 2, output_tokens: 3 },
	});
}
