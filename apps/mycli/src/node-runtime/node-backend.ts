import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolveConfig } from "@mycli/config";
import { OpenAIProviderRegistry } from "@mycli/providers";
import { NodeTurnRuntime } from "@mycli/runtime";
import { SQLiteSessionStore } from "@mycli/storage";
import {
	builtinToolManifest,
	EditTool,
	FileMutationRuntime,
	FileSnapshotStore,
	PatchTool,
	planToolExposure,
	ReadTool,
	ToolRouter,
	WriteTool,
} from "@mycli/tools";
import {
	createNodeGateway,
	type NodeGateway,
} from "./node-gateway.ts";

export type NodeBackend = NodeGateway;

export interface StartNodeBackendOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly args: readonly string[];
}

export async function startNodeBackend(options: StartNodeBackendOptions): Promise<NodeBackend> {
	const overrides = parseOverrides(options.args);
	const homeDir = runtimeHome(options.env);
	const config = await resolveConfig({
		homeDir,
		workspaceRoot: options.cwd,
		env: options.env,
		overrides,
	});
	const store = new SQLiteSessionStore({ dbPath: config.sessionsDbPath });
	const registry = new OpenAIProviderRegistry();
	const snapshots = new FileSnapshotStore();
	const mutationRuntime = new FileMutationRuntime({
		workspaceRoot: config.workspaceRoot,
		snapshots,
	});
	const adapters = [
		new ReadTool({ workspaceRoot: config.workspaceRoot, snapshots }),
		new EditTool(mutationRuntime),
		new PatchTool(mutationRuntime),
		new WriteTool({ runtime: mutationRuntime }),
	];
	const toolExposure = planToolExposure(builtinToolManifest());
	const toolRouter = new ToolRouter({ adapters, exposure: toolExposure });
	const runtime = new NodeTurnRuntime({
		sessionId: config.sessionId,
		workspaceRoot: config.workspaceRoot,
		threadId: config.sessionId,
		instructions: "You are mycli, a coding agent and personal assistant.",
		store,
		resolveConfig: (submission) => resolveConfig({
			homeDir,
			workspaceRoot: options.cwd,
			env: options.env,
			overrides: {
				session: config.sessionId,
				model: submission.modelOverride ?? overrides.model,
			},
		}),
		createProvider: (resolved) => registry.create(resolved),
		createTurnId: randomUUID,
		clock: () => new Date().toISOString(),
		planTools: () => toolExposure,
		toolRouter,
	});
	try {
		return createNodeGateway({
			sessionId: config.sessionId,
			workspaceRoot: config.workspaceRoot,
			provider: config.provider,
			model: config.model,
			toolNames: toolExposure.map((tool) => tool.name),
			maxPromptTokens: config.maxPromptTokens,
			runtime,
			loadConversation: (sessionId) => store.loadConversation(sessionId),
			close: () => store.close(),
		});
	} catch (error) {
		store.close();
		throw error;
	}
}

function parseOverrides(args: readonly string[]): { model?: string; session?: string } {
	const overrides: { model?: string; session?: string } = {};
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if ((flag !== "--model" && flag !== "--session") || value === undefined) {
			throw new Error("invalid_arguments: invalid Node runtime arguments");
		}
		if (flag === "--model") overrides.model = value;
		if (flag === "--session") overrides.session = value;
	}
	return overrides;
}

function runtimeHome(env: NodeJS.ProcessEnv): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}
