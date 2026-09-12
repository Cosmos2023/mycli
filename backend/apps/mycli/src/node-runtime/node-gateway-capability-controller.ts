import { parseGatewayParams, type GatewayResult } from "@mycli/contracts";
import { IntegrationEnablementError, SkillSelectionError, HookSelectionError, HookAllowlistStoreError } from "@mycli/integrations";
import { GatewayFailure } from "./node-gateway-errors.ts";
import type { NodeGatewaySessionController } from "./node-gateway-session-controller.ts";
import type { NodeGatewayIntegrations, CreateNodeGatewayOptions } from "./node-gateway-types.ts";

/** Session ownership and cleanup for skill and hook configuration requests. */
export class NodeGatewayCapabilityController {
	readonly #pending = new Map<AbortController, Promise<unknown>>();
	#closed = false;

	constructor(private readonly options: {
		readonly session: NodeGatewaySessionController;
		readonly integrations: () => NodeGatewayIntegrations | undefined;
		readonly workspace?: CreateNodeGatewayOptions["workspaceCommands"];
		readonly loadTranscriptPage?: CreateNodeGatewayOptions["loadTranscriptPage"];
	}) {}

	skillsList(raw: Record<string, unknown>): Promise<GatewayResult<"skills.list">> {
		const params = parseGatewayParams("skills.list", raw);
		return this.run(params, async () => {
			const service = this.options.integrations()?.skills;
			if (!service) throw new GatewayFailure("unavailable_feature", "Skill management is unavailable.");
			const result = await service.list();
			return { revision: result.revision, skills: [...result.skills] };
		});
	}

	skillsWrite(raw: Record<string, unknown>): Promise<GatewayResult<"skills.config.write">> {
		const params = parseGatewayParams("skills.config.write", raw);
		return this.run(params, async (signal) => {
			const service = this.options.integrations()?.skills;
			if (!service) throw new GatewayFailure("unavailable_feature", "Skill management is unavailable.");
			const result = await service.setEnabled({ id: params.id, revision: params.revision,
				skillRevision: params.skill_revision, enabled: params.enabled }, signal);
			return { revision: result.revision, skills: [...result.skills] };
		});
	}

	hooksList(raw: Record<string, unknown>): Promise<GatewayResult<"hooks.list">> {
		const params = parseGatewayParams("hooks.list", raw);
		return this.run(params, async () => {
			const service = this.options.integrations()?.hookManagement;
			if (!service) throw new GatewayFailure("unavailable_feature", "Hook management is unavailable.");
			const result = await service.list();
			return { revision: result.revision, hooks: result.hooks.map((hook) => ({ ...hook, command: [...hook.command] })) };
		});
	}

	hooksWrite(raw: Record<string, unknown>): Promise<GatewayResult<"hooks.config.write">> {
			const params = parseGatewayParams("hooks.config.write", raw);
			return this.run(params, async (signal) => {
				const service = this.options.integrations()?.hookManagement;
				if (!service) throw new GatewayFailure("unavailable_feature", "Hook management is unavailable.");
				const result = await service.write({ id: params.id, revision: params.revision, hookRevision: params.hook_revision, action: params.action }, signal);
				return { revision: result.revision, hooks: result.hooks.map((hook) => ({ ...hook, command: [...hook.command] })) };
			});
	}

	workspaceDiff(raw: Record<string, unknown>): Promise<GatewayResult<"workspace.diff">> {
		const params = parseGatewayParams("workspace.diff", raw);
		return this.run(params, async (signal) => {
			if (!this.options.workspace) throw new GatewayFailure("unavailable_feature", "Git diff is unavailable.");
			return this.options.workspace.diff(this.options.session.workspaceRoot(), signal);
		});
	}

	sessionPreview(raw: Record<string, unknown>): Promise<GatewayResult<"session.preview">> {
		const params = parseGatewayParams("session.preview", raw);
		return this.run(params, async () => {
			if (!this.options.loadTranscriptPage) throw new GatewayFailure("unavailable_feature", "Session preview is unavailable.");
			const page = this.options.loadTranscriptPage(params.target_session_id, { limit: 20 });
			const recent = page.items.filter((item) => item.type === "user_message" || item.type === "assistant_message");
			const messages = recent.slice(-8);
			const truncated = page.nextBefore !== null || recent.length > messages.length || messages.some((item) => (item.text?.length ?? 0) > 2000);
			const text = messages.map((item) => `${item.type === "user_message" ? "You" : "Assistant"}\n${(item.text ?? "").slice(0, 2000)}`).join("\n\n");
			return { text: (text || "No recent conversation messages.") + (truncated ? "\n\n[Preview shortened]" : ""), truncated };
		});
	}

	cancelPending(): void {
		for (const controller of this.#pending.keys()) controller.abort();
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.cancelPending();
		await Promise.allSettled(this.#pending.values());
	}

	private async run<Result>(
		context: { readonly session_id: string; readonly generation: number },
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		if (this.#closed) throw new GatewayFailure("gateway_closed", "Integration management is closed.");
		this.options.session.assertMutationContext(context);
		const controller = new AbortController();
		const task = Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			this.options.session.assertMutationContext(context);
			return operation(controller.signal);
		});
		this.#pending.set(controller, task);
		try {
			const result = await task;
			controller.signal.throwIfAborted();
			this.options.session.assertMutationContext(context);
			return result;
		} catch (error) {
			if (controller.signal.aborted) throw new GatewayFailure("interrupted", "Integration settings request was cancelled.");
			if (error instanceof HookSelectionError) throw new GatewayFailure("invalid_params", error.message);
			if (error instanceof SkillSelectionError || error instanceof IntegrationEnablementError && error.code === "integration_settings_changed") {
				throw new GatewayFailure("invalid_params", "The selected skill or settings changed. Reopen /skills and retry.");
			}
			if (error instanceof IntegrationEnablementError || error instanceof HookAllowlistStoreError) {
				throw new GatewayFailure("config_error", "Unable to read or save integration settings.");
			}
			throw error;
		} finally { this.#pending.delete(controller); }
	}
}
