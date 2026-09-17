import { parseGatewayParams, type GatewayParams, type PluginCatalog, type PluginDetail, type PluginOperation } from "@mycli/contracts";
import { packageIssue } from "@mycli/integrations";
import { GatewayFailure } from "./node-gateway-errors.ts";
import type { NodeGatewaySessionController } from "./node-gateway-session-controller.ts";
import type { CreateNodeGatewayOptions } from "./node-gateway-types.ts";

interface OperationEntry {
	readonly params: GatewayParams<"plugin.operation.start">;
	readonly controller: AbortController;
	result: PluginOperation;
	task: Promise<void>;
}

/** Owns cancellable package work; UI polling never owns the actual transaction. */
export class NodeGatewayPluginController {
	readonly #operations = new Map<string, OperationEntry>();
	readonly #reads = new Set<AbortController>();
	#closed = false;

	constructor(private readonly options: {
		readonly session: NodeGatewaySessionController;
		readonly createCatalog: CreateNodeGatewayOptions["pluginCatalog"];
		readonly timeoutMs?: number;
	}) {}

	async catalog(raw: Record<string, unknown>): Promise<PluginCatalog> {
		const params = parseGatewayParams("plugin.catalog", raw);
		this.options.session.assertMutationContext(params);
		const controller = new AbortController();
		this.#reads.add(controller);
		try {
			const service = await this.service();
			this.options.session.assertMutationContext(params);
			return await service.list(controller.signal, params.marketplace);
		} finally { this.#reads.delete(controller); }
	}

	async inspect(raw: Record<string, unknown>): Promise<PluginDetail> {
		const params = parseGatewayParams("plugin.inspect", raw);
		this.options.session.assertMutationContext(params);
		const controller = new AbortController();
		this.#reads.add(controller);
		try {
			const service = await this.service();
			this.options.session.assertMutationContext(params);
			return await service.inspect(params.target, params.revision, controller.signal);
		} finally { this.#reads.delete(controller); }
	}

	start(raw: Record<string, unknown>): PluginOperation {
		const params = parseGatewayParams("plugin.operation.start", raw);
		this.options.session.assertMutationContext(params);
		if (this.#closed) throw new GatewayFailure("gateway_closed", "Plugin management is closed.");
		const previous = this.#operations.get(params.operation_id);
		if (previous) {
			if (JSON.stringify(previous.params) !== JSON.stringify(params)) throw new GatewayFailure("invalid_params", "Plugin operation ID is already in use.");
			return previous.result;
		}
		if ([...this.#operations.values()].some((entry) => entry.result.state === "running")) {
			throw new GatewayFailure("gateway_overloaded", "Another plugin operation is still finishing.", { dispatched: false });
		}
		const entry: OperationEntry = { params, controller: new AbortController(),
			result: { operation_id: params.operation_id, state: "running", message: "Updating plugin packages…", issues: [] }, task: Promise.resolve() };
		while (this.#operations.size >= 32) this.#operations.delete(this.#operations.keys().next().value!);
		this.#operations.set(params.operation_id, entry);
		entry.task = this.execute(entry);
		return entry.result;
	}

	get(raw: Record<string, unknown>): PluginOperation { return this.entry(raw).result; }
	cancel(raw: Record<string, unknown>): PluginOperation {
		const entry = this.entry(raw);
		if (entry.result.state === "running") entry.controller.abort();
		return entry.result;
	}

	cancelPending(): void {
		for (const controller of this.#reads) controller.abort();
		for (const entry of this.#operations.values()) if (entry.result.state === "running") entry.controller.abort();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.cancelPending();
		await Promise.all([...this.#operations.values()].map((entry) => entry.task));
	}

	private async service(): Promise<Awaited<ReturnType<NonNullable<CreateNodeGatewayOptions["pluginCatalog"]>>>> {
		if (this.#closed || !this.options.createCatalog) throw new GatewayFailure("unavailable_feature", "Plugin management is unavailable.");
		return this.options.createCatalog(this.options.session.workspaceRoot());
	}

	private entry(raw: Record<string, unknown>): OperationEntry {
		const params = parseGatewayParams("plugin.operation.get", raw);
		const entry = this.#operations.get(params.operation_id);
		if (!entry || entry.params.session_id !== params.session_id || entry.params.generation !== params.generation) {
			throw new GatewayFailure("invalid_params", "Plugin operation was not found for this session.");
		}
		return entry;
	}

	private async execute(entry: OperationEntry): Promise<void> {
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; entry.controller.abort(); }, this.options.timeoutMs ?? 300_000);
		timer.unref();
		try {
			const service = await this.service();
			this.options.session.assertMutationContext(entry.params);
			entry.controller.signal.throwIfAborted();
			const response = await service.change(entry.params.change, entry.controller.signal);
			// Atomic commit can win cancellation. Never relabel a committed result as cancelled.
			entry.result = { operation_id: entry.params.operation_id, state: response.ok ? "completed" : "failed",
				message: response.message.slice(0, 1024), issues: [...response.issues].slice(0, 64) };
		} catch (error) {
			const cancelled = entry.controller.signal.aborted;
			entry.result = { operation_id: entry.params.operation_id, state: cancelled && !timedOut ? "cancelled" : "failed",
				message: timedOut ? "Plugin operation timed out." : cancelled ? "Plugin operation cancelled." : "Plugin operation failed. Refresh the list and try again.",
				issues: [timedOut ? "plugin_operation_timeout" : cancelled ? "plugin_operation_cancelled" : packageIssue(error)] };
		} finally { clearTimeout(timer); }
	}
}
