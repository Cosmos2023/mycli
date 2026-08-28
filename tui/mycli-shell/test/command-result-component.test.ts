import assert from "node:assert/strict";
import test from "node:test";

import { CommandResultComponent } from "../src/components/command-result.ts";
import type {
	MycliShellCommandDisplay,
	MycliShellCommandResult,
} from "../src/model.ts";
import { visibleWidth } from "../src/tui-core/tui.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function result(display: Partial<MycliShellCommandDisplay>): MycliShellCommandResult {
	return {
		id: "command:test",
		display: {
			version: 1,
			kind: "notice",
			command: "/test",
			title: "Test",
			severity: "info",
			fields: [],
			rows: [],
			sections: [],
			suggestions: [],
			omittedRows: 0,
			omittedChars: 0,
			...display,
		},
		fallbackLines: [],
		folded: true,
	};
}

test("status uses a compact bordered command surface", () => {
	const status = result({
		kind: "status",
		command: "/status",
		title: "mycli",
		fields: [
			{ label: "Model", value: "gpt-5.4" },
			{ label: "Directory", value: "/repo/mycli" },
		],
	});
	const output = stripAnsi(new CommandResultComponent(status).render(80).join("\n"));

	assert.match(output, /^\n\/status\n\n╭─+/);
	assert.match(output, /╭─+/);
	assert.match(output, /Model\s+gpt-5\.4/);
	assert.match(output, /Directory\s+\/repo\/mycli/);
});

test("list and notice results stay borderless and compact", () => {
	const tools = result({
		kind: "list",
		command: "/tools",
		title: "Tools",
		summary: "2 available",
		rows: [
			{ key: "Read", label: "Read", values: ["file", "auto allow"] },
			{ key: "Shell", label: "Shell", values: ["shell", "asks approval"] },
		],
	});
	const undo = result({
		kind: "notice",
		command: "/undo",
		title: "Undo complete",
		severity: "success",
		summary: "Restored src/mycli/app.py",
	});
	const toolsOutput = stripAnsi(new CommandResultComponent(tools).render(100).join("\n"));
	const undoOutput = stripAnsi(new CommandResultComponent(undo).render(100).join("\n"));

	assert.match(toolsOutput, /^\n\/tools\n\n/);
	assert.match(toolsOutput, /Tools\s+2 available/);
	assert.match(toolsOutput, /Read\s+file\s+auto allow/);
	assert.doesNotMatch(toolsOutput, /╭|╰/);
	assert.equal(undoOutput.trim(), "/undo\n✓ Restored src/mycli/app.py");
});

test("notice results wrap complete text with a stable continuation indent", () => {
	const compact = result({
		kind: "notice",
		command: "/compact",
		title: "Nothing to compact",
		severity: "info",
		summary: "Nothing to compact. Only base context and retained recent turns remain.",
	});

	for (const width of [40, 60, 80, 100]) {
		const lines = new CommandResultComponent(compact).render(width).map(stripAnsi);
		const notice = lines.slice(2);
		assert.equal(notice.join(" ").replace(/\s+/gu, " ").trim(), "• Nothing to compact. Only base context and retained recent turns remain.");
		for (const continuation of notice.slice(1)) assert.match(continuation, /^  \S/u);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${line}`);
	}
});

test("errors show reason usage and suggestions without a border", () => {
	const error = result({
		kind: "error",
		command: "/memory add",
		title: "Command error",
		severity: "error",
		summary: "Missing memory value.",
		usage: "/memory add <kind> <key> <value>",
		suggestions: ["/memory"],
	});
	const output = stripAnsi(new CommandResultComponent(error).render(100).join("\n"));

	assert.match(output, /^\n\/memory add\n! Missing memory value\./);
	assert.match(output, /Usage: \/memory add <kind> <key> <value>/);
	assert.match(output, /Did you mean: \/memory/);
	assert.doesNotMatch(output, /╭|╰/);
});

test("command surfaces remain width-safe with CJK fields and long paths", () => {
	const status = result({
		kind: "status",
		command: "/status",
		title: "状态",
		fields: [
			{ label: "工作目录", value: `/Users/cosmos/${"very-long/".repeat(20)}mycli` },
			{ label: "模型", value: "deepseek-v4-flash" },
		],
	});

	for (const width of [60, 100, 160]) {
		const lines = new CommandResultComponent(status).render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${stripAnsi(line)}`);
		}
	}
});

test("every command presentation remains width-safe with its command prefix", () => {
	const displays: Partial<MycliShellCommandDisplay>[] = [
		{
			kind: "diagnostic",
			command: "/context",
			title: "Context",
			fields: [{ label: "上下文窗口", value: "123456 / 200000" }],
		},
		{
			kind: "list",
			command: "/tools plugins",
			title: "Plugins",
			rows: [{ key: "plugin", label: "很长的插件名称", values: ["available"] }],
		},
		{
			kind: "notice",
			command: "/sandbox danger-full-access",
			title: "Sandbox",
			summary: "Changed sandbox mode",
		},
		{
			kind: "error",
			command: "/memory add",
			title: "Command error",
			summary: "Missing memory value",
		},
	];

	for (const display of displays) {
		for (const width of [12, 24, 60]) {
			for (const line of new CommandResultComponent(result(display)).render(width)) {
				assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${stripAnsi(line)}`);
			}
		}
	}
});

test("folded lists show eight rows and the full hidden count", () => {
	const tools = result({
		kind: "list",
		command: "/tools",
		title: "Tools",
		rows: Array.from({ length: 12 }, (_, index) => ({
			key: `tool-${index + 1}`,
			label: `Tool ${index + 1}`,
			values: ["available"],
		})),
		omittedRows: 3,
	});
	const output = stripAnsi(new CommandResultComponent(tools).render(100).join("\n"));

	assert.match(output, /Tool 8/);
	assert.doesNotMatch(output, /Tool 9\s/);
	assert.match(output, /\.\.\. 7 more/);
});

test("empty lists and preformatted omissions have explicit text", () => {
	const empty = result({ kind: "list", command: "/skills", title: "Skills" });
	const preformatted = result({
		kind: "preformatted",
		command: "/trace",
		title: "Trace",
		preformatted: "head\ntail",
		omittedChars: 42,
	});

	assert.match(stripAnsi(new CommandResultComponent(empty).render(80).join("\n")), /^\n\/skills\n\nSkills\n  No items/);
	const output = stripAnsi(new CommandResultComponent(preformatted).render(80).join("\n"));
	assert.match(output, /^\n\/trace\n\nhead\ntail/);
	assert.match(output, /42 chars omitted/);
});

test("diagnostics use compact bordered cards with a separate command line", () => {
	const diagnostic = result({
		kind: "diagnostic",
		command: "/usage",
		title: "Usage",
		fields: [{ label: "Turns", value: "3" }],
		sections: [
			{
				title: "Cumulative tokens",
				fields: [{ label: "Input tokens", value: "100000" }],
				rows: [],
			},
		],
	});
	const output = stripAnsi(new CommandResultComponent(diagnostic).render(100).join("\n"));

	assert.match(output, /^\n\/usage\n\n╭─+/);
	assert.match(output, /│  Usage/);
	assert.match(output, /Cumulative tokens/);
	assert.match(output, /Input tokens\s+100000/);
	assert.doesNotMatch(output, /\b(?:USE|CTX|CMD)\b/);
});
