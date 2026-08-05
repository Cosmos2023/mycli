import { mkdir, readFile } from "node:fs/promises";
import process from "node:process";
import {
	executionPolicy,
	formatShellResult,
	ShellOutputBuffer,
	TerminalOutputNormalizer,
	type PermissionProfile,
} from "@mycli/tools";

type JsonObject = Record<string, unknown>;

interface Fixture {
	readonly version: number;
	readonly buffer_cases: readonly BufferCase[];
	readonly decoder_cases: readonly DecoderCase[];
	readonly model_cases: readonly ModelCase[];
	readonly permission_profiles: readonly PermissionProfile[];
	readonly scenarios: readonly JsonObject[];
}

interface BufferCase {
	readonly id: string;
	readonly max_chars: number;
	readonly chunks: readonly string[];
	readonly cursor: number;
}

interface DecoderCase {
	readonly id: string;
	readonly chunks_hex: readonly string[];
}

interface ModelCase {
	readonly id: string;
	readonly shell_id: string;
	readonly chunk_id: string;
	readonly wall_time_seconds: number;
	readonly terminal_state: string | null;
	readonly exit_code: number | null;
	readonly output: string;
	readonly max_output_tokens: number;
}

const [action, fixturePath, workspace] = process.argv.slice(2);
if (action !== "probe" || !fixturePath || !workspace) {
	throw new Error("usage: node_runtime_m6_parity_helper probe <fixture> <workspace>");
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;
if (fixture.version !== 1) throw new Error("unsupported M6 parity fixture version");
await mkdir(workspace, { recursive: true });

const buffers = fixture.buffer_cases.map((scenario) => {
	const output = new ShellOutputBuffer({ maxChars: scenario.max_chars });
	for (const chunk of scenario.chunks) output.append(chunk);
	const result = output.read(scenario.cursor);
	return {
		id: scenario.id,
		text: result.text,
		next_cursor: result.nextCursor,
		output_chars: result.outputChars,
		omitted_chars: result.omittedChars,
		cursor_was_evicted: result.cursorWasEvicted,
	};
});

const decoders = fixture.decoder_cases.map((scenario) => {
	const normalizer = new TerminalOutputNormalizer();
	let text = "";
	let replacementCount = 0;
	for (const encoded of scenario.chunks_hex) {
		const output = normalizer.push(Uint8Array.from(Buffer.from(encoded, "hex")));
		text += output.text;
		replacementCount += output.replacementCount;
	}
	const final = normalizer.finish();
	text += final.text;
	replacementCount += final.replacementCount;
	return {
		id: scenario.id,
		text,
		replacement_count: replacementCount,
	};
});

const models = fixture.model_cases.map((scenario) => {
	const text = formatShellResult({
		chunkId: scenario.chunk_id,
		wallTimeSeconds: scenario.wall_time_seconds,
		shellId: scenario.shell_id,
		terminalState: scenario.terminal_state,
		exitCode: scenario.exit_code,
		output: scenario.output,
		maxOutputTokens: scenario.max_output_tokens,
	}).modelOutput;
	return normalizedModel(scenario, text);
});

const permissions = fixture.permission_profiles.map((profile) => {
	const policy = executionPolicy(profile, workspace);
	return {
		id: profile,
		mode: policy.mode,
		filesystem: policy.filesystem,
		network: policy.network,
		writable_roots: policy.writableRoots.length,
	};
});

process.stdout.write(`${JSON.stringify({
	buffers,
	decoders,
	models,
	permissions,
	scenarios: fixture.scenarios,
})}\n`);

function normalizedModel(scenario: ModelCase, text: string): JsonObject {
	const status = text.split("\n").find((line) => line.startsWith("Process "));
	if (!status) throw new Error(`M6 model result lacks status: ${scenario.id}`);
	return {
		id: scenario.id,
		status,
		output_present: text.includes(scenario.output),
		bounded: text.length <= scenario.max_output_tokens * 4,
	};
}
