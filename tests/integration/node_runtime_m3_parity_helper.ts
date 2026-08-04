import { readFile } from "node:fs/promises";
import process from "node:process";
import { SQLiteSessionStore } from "@mycli/storage";
import {
	builtinToolManifest,
	planToolExposure,
	ReadTool,
	ToolRouter,
} from "@mycli/tools";

interface Fixture {
	readonly inventory: { readonly parameters: readonly string[] };
	readonly read_cases: readonly {
		readonly name: string;
		readonly arguments: Readonly<Record<string, unknown>>;
	}[];
	readonly transcript: {
		readonly session_id: string;
		readonly client_turn_id: string;
		readonly turn_id: string;
		readonly response_id: string;
		readonly call: {
			readonly call_id: string;
			readonly name: string;
			readonly arguments: Readonly<Record<string, unknown>>;
		};
		readonly tool_output: string;
		readonly summary: string;
	};
}

const [action, first, second, third] = process.argv.slice(2);
if (action === "probe" && first && second && third) {
	const workspaceRoot = first;
	const dbPath = second;
	const fixture = JSON.parse(await readFile(third, "utf8")) as Fixture;
	const manifest = builtinToolManifest();
	const exposure = planToolExposure(manifest);
	const router = new ToolRouter({
		adapters: [new ReadTool({ workspaceRoot })],
		exposure,
	});
	const readCases = [];
	for (const [index, scenario] of fixture.read_cases.entries()) {
		const result = await router.execute({
			callId: `fixture-${index + 1}`,
			name: "Read",
			argumentsJson: JSON.stringify(scenario.arguments),
		}, { signal: new AbortController().signal });
		readCases.push({
			name: scenario.name,
			success: result.success,
			path: result.success && typeof result.metadata.path === "string"
				? result.metadata.path
				: null,
			shown_lines: numberOrNull(result.metadata.shownLines),
			truncated: typeof result.metadata.truncated === "boolean"
				? result.metadata.truncated
				: null,
			error_kind: result.errorKind ?? null,
		});
	}
	writeTranscript(dbPath, workspaceRoot, fixture);
	process.stdout.write(`${JSON.stringify({
		inventory: exposure.map((tool) => tool.name),
		parameters: manifest.tools[0]?.parameters.map((parameter) => parameter.name) ?? [],
		read_cases: readCases,
	})}\n`);
} else if (action === "read-db" && first && second) {
	const store = new SQLiteSessionStore({ dbPath: first });
	try {
		process.stdout.write(`${JSON.stringify(store.loadConversationItems(second))}\n`);
	} finally {
		store.close();
	}
} else {
	throw new Error("usage: node_runtime_m3_parity_helper <probe workspace db fixture|read-db db session>");
}

function writeTranscript(dbPath: string, workspaceRoot: string, fixture: Fixture): void {
	const transcript = fixture.transcript;
	const call = transcript.call;
	const store = new SQLiteSessionStore({ dbPath, clock: () => "2026-08-04T00:00:00.000Z" });
	try {
		store.reserveTurn({
			sessionId: transcript.session_id,
			clientTurnId: transcript.client_turn_id,
			turnId: transcript.turn_id,
			requestFingerprint: `sha256:${"a".repeat(64)}`,
			workspaceRoot,
			threadId: transcript.session_id,
			userText: "Read README.md",
			startedAt: "2026-08-04T00:00:00.000Z",
		});
		store.appendAssistantToolCalls({
			sessionId: transcript.session_id,
			clientTurnId: transcript.client_turn_id,
			assistantText: "",
			calls: [{
				callId: call.call_id,
				name: call.name,
				argumentsJson: JSON.stringify(call.arguments),
			}],
			responseId: transcript.response_id,
		});
		store.appendToolResult({
			sessionId: transcript.session_id,
			clientTurnId: transcript.client_turn_id,
			result: {
				callId: call.call_id,
				toolName: call.name,
				output: transcript.tool_output,
				success: true,
			},
			summary: transcript.summary,
		});
		store.completeTurn({
			sessionId: transcript.session_id,
			clientTurnId: transcript.client_turn_id,
			assistantText: "README inspected.",
			usage: {},
			responseId: "resp-final",
			completedAt: "2026-08-04T00:00:01.000Z",
		});
	} finally {
		store.close();
	}
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
