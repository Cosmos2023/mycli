import {
	mkdir,
	readFile,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { SQLiteSessionStore, projectMutationMetadata } from "@mycli/storage";
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
import Database from "better-sqlite3";

type JsonObject = Record<string, unknown>;

interface FixtureCase {
	readonly name: string;
	readonly tool: "Edit" | "Patch" | "Write";
	readonly setup: Readonly<{ kind: string; path: string; content?: string }>;
	readonly pre_read?: boolean;
	readonly after_read_content?: string;
	readonly argument_factory?: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

interface Fixture {
	readonly cases: readonly FixtureCase[];
	readonly transcript: FixtureTranscript;
	readonly failure_transcript: FixtureTranscript;
}

interface FixtureTranscript {
	readonly session_id: string;
	readonly client_turn_id: string;
	readonly turn_id: string;
	readonly response_id: string;
	readonly call_id: string;
	readonly tool_name: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly receipt: string;
	readonly summary: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly error_kind?: string;
}

interface CaseState {
	readonly workspace: string;
	readonly protectedPath: string;
}

const [action, first, second, third] = process.argv.slice(2);
if (action === "probe" && first && second && third) {
	const fixture = JSON.parse(await readFile(third, "utf8")) as Fixture;
	await mkdir(first, { recursive: true });
	const manifest = builtinToolManifest();
	const exposure = planToolExposure(manifest);
	const cases = [];
	for (const scenario of fixture.cases) {
		cases.push(await executeCase(join(first, scenario.name), scenario, exposure));
	}
	writeTranscript(second, first, fixture);
	process.stdout.write(`${JSON.stringify({
		inventory: exposure.map((tool) => tool.name),
		parameters: Object.fromEntries(manifest.tools.map((tool) => [
			tool.name,
			tool.parameters.map((parameter) => parameter.name),
		])),
		cases,
	})}\n`);
} else if (action === "read-db" && first && second) {
	const store = new SQLiteSessionStore({ dbPath: first });
	try {
		const messages = rawMessages(first, second);
		process.stdout.write(`${JSON.stringify({
			types: store.loadConversationItems(second).map((item) => item.type),
			signature: transcriptSignature(messages),
		})}\n`);
	} finally {
		store.close();
	}
} else {
	throw new Error("usage: node_runtime_m4_parity_helper <probe root db fixture|read-db db session>");
}

async function executeCase(
	root: string,
	scenario: FixtureCase,
	exposure: ReturnType<typeof planToolExposure>,
): Promise<JsonObject> {
	const state = await setupCase(root, scenario.setup);
	const snapshots = new FileSnapshotStore();
	const runtime = new FileMutationRuntime({ workspaceRoot: state.workspace, snapshots });
	const router = new ToolRouter({
		adapters: [
			new ReadTool({ workspaceRoot: state.workspace, snapshots }),
			new EditTool(runtime),
			new PatchTool(runtime),
			new WriteTool({ runtime }),
		],
		exposure,
	});
	const argumentsValue: Record<string, unknown> = { ...scenario.arguments };
	let readSha256: string | undefined;
	if (scenario.pre_read) {
		const read = await router.execute({
			callId: `${scenario.name}-read`,
			name: "Read",
			argumentsJson: JSON.stringify({
				file_path: argumentsValue.file_path,
				offset: 1,
				limit: 20,
			}),
		}, { signal: new AbortController().signal });
		if (!read.success || typeof read.metadata.sha256 !== "string") {
			throw new Error(`fixture pre-read failed: ${scenario.name}`);
		}
		readSha256 = read.metadata.sha256;
	}
	if (scenario.after_read_content !== undefined) {
		await writeFile(state.protectedPath, scenario.after_read_content, "utf8");
	}
	applyArgumentFactory(argumentsValue, scenario.argument_factory, readSha256);
	const before = await pathState(state.protectedPath);
	const result = await router.execute({
		callId: `${scenario.name}-call`,
		name: scenario.tool,
		argumentsJson: JSON.stringify(argumentsValue),
	}, { signal: new AbortController().signal });
	const mutation = projectMutationMetadata(result.metadata, result.success);
	const change = mutation.file_changes?.[0];
	if (change && (change.diff.length > 200_000 || change.diff.split("\n").length > 5_000)) {
		throw new Error(`fixture diff is unbounded: ${scenario.name}`);
	}
	return {
		name: scenario.name,
		tool: scenario.tool,
		success: result.success,
		status: result.success && typeof result.metadata.status === "string"
			? result.metadata.status
			: null,
		error_kind: result.success ? null : result.errorKind ?? null,
		matches: typeof result.metadata.matches === "number" ? result.metadata.matches : null,
		receipt: result.success ? result.modelOutput : null,
		change_kind: change?.kind ?? null,
		added_lines: change?.added_lines ?? null,
		removed_lines: change?.removed_lines ?? null,
		preserved: await pathState(state.protectedPath) === before,
		final_content: await smallText(state.protectedPath),
	};
}

async function setupCase(root: string, setup: FixtureCase["setup"]): Promise<CaseState> {
	const workspace = join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	if (setup.kind === "outside_text") {
		const protectedPath = join(root, "outside.txt");
		await writeFile(protectedPath, setup.content ?? "", "utf8");
		return { workspace, protectedPath };
	}
	if (setup.kind === "symlink_escape") {
		const outside = join(root, "outside");
		await mkdir(outside);
		const protectedPath = join(outside, "outside.txt");
		await writeFile(protectedPath, setup.content ?? "", "utf8");
		await symlink(outside, join(workspace, "link"), "dir");
		return { workspace, protectedPath };
	}
	const protectedPath = join(workspace, setup.path);
	await mkdir(dirname(protectedPath), { recursive: true });
	switch (setup.kind) {
		case "text":
			await writeFile(protectedPath, setup.content ?? "", "utf8");
			break;
		case "binary":
			await writeFile(protectedPath, Buffer.from([0, 1, 2]));
			break;
		case "invalid_utf8":
			await writeFile(protectedPath, Buffer.from([0xff, 0xfe]));
			break;
		case "directory":
			await mkdir(protectedPath);
			break;
		case "large_text":
			await writeFile(protectedPath, "x\n".repeat(500_001), "utf8");
			break;
		case "missing":
			break;
		default:
			throw new Error(`unknown setup kind: ${setup.kind}`);
	}
	return { workspace, protectedPath };
}

function applyArgumentFactory(
	argumentsValue: Record<string, unknown>,
	factory: string | undefined,
	readSha256: string | undefined,
): void {
	switch (factory) {
		case undefined:
			return;
		case "oversized_content":
			argumentsValue.content = "x".repeat(1_000_001);
			return;
		case "secret_content":
			argumentsValue.content = "api_key = 'fixture-secret-value'\n";
			return;
		case "snapshot_sha256":
			if (!readSha256) throw new Error("fixture snapshot hash is missing");
			argumentsValue.expected_sha256 = readSha256;
			return;
		default:
			throw new Error(`unknown argument factory: ${factory}`);
	}
}

async function pathState(path: string): Promise<string> {
	try {
		const target = await stat(path);
		if (target.isDirectory()) return "directory";
		return `file:${(await readFile(path)).toString("base64")}`;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return "missing";
		throw error;
	}
}

async function smallText(path: string): Promise<string | null> {
	try {
		const target = await stat(path);
		if (!target.isFile() || target.size > 10_000) return null;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
		return /[\u0000-\u0006\u000e-\u001a\u001c-\u001f]/u.test(text) ? null : text;
	} catch (error) {
		if (hasCode(error, "ENOENT") || error instanceof TypeError) return null;
		throw error;
	}
}

function writeTranscript(dbPath: string, workspaceRoot: string, fixture: Fixture): void {
	const store = new SQLiteSessionStore({ dbPath, clock: () => "2026-08-04T00:00:00.000Z" });
	try {
		appendTranscript(store, workspaceRoot, fixture.transcript);
		appendTranscript(store, workspaceRoot, fixture.failure_transcript);
	} finally {
		store.close();
	}
}

function appendTranscript(
	store: SQLiteSessionStore,
	workspaceRoot: string,
	transcript: FixtureTranscript,
): void {
	const success = !transcript.error_kind;
	store.reserveTurn({
		sessionId: transcript.session_id,
		clientTurnId: transcript.client_turn_id,
		turnId: transcript.turn_id,
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: transcript.session_id,
		userText: "Run the requested file tool",
		startedAt: "2026-08-04T00:00:00.000Z",
	});
	store.appendAssistantToolCalls({
		sessionId: transcript.session_id,
		clientTurnId: transcript.client_turn_id,
		assistantText: "",
		calls: [{
			callId: transcript.call_id,
			name: transcript.tool_name,
			argumentsJson: JSON.stringify(transcript.arguments),
		}],
		responseId: transcript.response_id,
	});
	store.appendToolResult({
		sessionId: transcript.session_id,
		clientTurnId: transcript.client_turn_id,
		result: {
			callId: transcript.call_id,
			toolName: transcript.tool_name,
			output: transcript.receipt,
			success,
		},
		summary: transcript.summary,
		metadata: transcript.metadata ?? {
			path: transcript.arguments.file_path,
			errorKind: transcript.error_kind,
		},
		...(transcript.error_kind ? { errorKind: transcript.error_kind } : {}),
	});
	store.completeTurn({
		sessionId: transcript.session_id,
		clientTurnId: transcript.client_turn_id,
		assistantText: "Tool result handled.",
		usage: {},
		responseId: "resp-final",
		completedAt: "2026-08-04T00:00:01.000Z",
	});
}

function rawMessages(dbPath: string, sessionId: string): JsonObject[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return database.prepare(`
			SELECT payload_json FROM conversation_messages
			WHERE session_id = ? ORDER BY message_index
		`).all(sessionId).map((row) => JSON.parse(String(
			(row as { payload_json: unknown }).payload_json,
		)) as JsonObject);
	} finally {
		database.close();
	}
}

function transcriptSignature(messages: readonly JsonObject[]): JsonObject {
	const assistant = messages[1] ?? {};
	const tool = messages[2] ?? {};
	const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
	const call = isRecord(calls[0]) ? calls[0] : {};
	const metadata = isRecord(tool.metadata) ? tool.metadata : {};
	const blocks = Array.isArray(tool.blocks) ? tool.blocks : [];
	const block = isRecord(blocks[0]) ? blocks[0] : {};
	const blockMetadata = isRecord(block.metadata) ? block.metadata : {};
	return {
		call_id: call.call_id ?? null,
		tool_name: call.name ?? null,
		receipt: tool.content ?? null,
		success: metadata.success ?? null,
		error_kind: metadata.error_kind ?? null,
		file_changes: metadata.file_changes ?? null,
		block_file_changes: blockMetadata.file_changes ?? null,
	};
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
