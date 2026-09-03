#!/usr/bin/env node

import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
	CI_TEST_SUITE_ORDER,
	discoverTestCatalog,
	REPOSITORY_ROOT,
	selectTestCatalog,
	summarizeTestCatalog,
	TEST_SUITE_NAMES,
	TEST_TARGETS,
} from "./test-suite-catalog.mjs";

const SELECTOR_NAMES = Object.freeze([...TEST_SUITE_NAMES, "ci"]);

export function parseArguments(argv) {
	const suites = [];
	const forwarded = [];
	let list = false;
	let json = false;
	let help = false;
	let forwarding = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (forwarding) {
			forwarded.push(argument);
			continue;
		}
		if (argument === "--") {
			forwarding = true;
			continue;
		}
		if (argument === "--suite") {
			const value = argv[index + 1];
			if (value === undefined) throw new Error("test_suite_value_required");
			suites.push(value);
			index += 1;
			continue;
		}
		if (argument.startsWith("--suite=")) {
			suites.push(argument.slice("--suite=".length));
			continue;
		}
		if (argument === "--list") {
			list = true;
			continue;
		}
		if (argument === "--json") {
			json = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		forwarded.push(argument);
	}

	const selectors = suites.length > 0 ? suites : ["ci"];
	for (const suite of selectors) {
		if (!SELECTOR_NAMES.includes(suite)) throw new Error(`unknown_test_suite: ${suite}`);
	}
	return {
		suites: expandSuiteSelectors(selectors),
		forwarded,
		list,
		json,
		help,
	};
}

export function expandSuiteSelectors(selectors) {
	const suites = [];
	for (const selector of selectors) {
		const expanded = selector === "ci" ? CI_TEST_SUITE_ORDER : [selector];
		for (const suite of expanded) {
			if (!suites.includes(suite)) suites.push(suite);
		}
	}
	return suites;
}

export async function runSelectedTestSuites(options) {
	const catalog = await discoverTestCatalog();
	const selected = selectTestCatalog(catalog, options.suites);
	if (options.list) {
		renderCatalog(selected, options.json);
		return 0;
	}

	const startedAt = performance.now();
	for (const suite of options.suites) {
		const suiteRows = selected.filter((row) => row.suite === suite);
		const suiteStartedAt = performance.now();
		process.stderr.write(`\n[test:${suite}] ${suiteRows.length} files\n`);
		for (const target of TEST_TARGETS) {
			const rows = suiteRows.filter((row) => row.targetId === target.id);
			if (rows.length === 0) continue;
			const code = await runTarget(target, rows, options.forwarded, suite);
			if (code !== 0) return code;
		}
		process.stderr.write(
			`[test:${suite}] passed in ${formatDuration(performance.now() - suiteStartedAt)}\n`,
		);
	}
	process.stderr.write(
		`\n[test] ${selected.length} files passed in ${formatDuration(performance.now() - startedAt)}\n`,
	);
	return 0;
}

async function runTarget(target, rows, forwarded, suite) {
	const cwd = join(REPOSITORY_ROOT, target.root);
	const files = rows.map(({ file }) => relative(cwd, join(REPOSITORY_ROOT, file)));
	const args = [];
	if (target.sourceCondition !== false) args.push("--conditions=mycli-source");
	if (target.typescript !== false) args.push("--import", "tsx");
	args.push("--test");
	if (target.testConcurrency !== undefined) {
		args.push(`--test-concurrency=${target.testConcurrency}`);
	}
	if (!forwarded.some((argument) => argument.startsWith("--test-reporter"))) {
		args.push("--test-reporter=dot");
	}
	args.push(...forwarded, ...files);
	process.stderr.write(`  ${target.label}: ${files.length}\n`);

	return await new Promise((resolveExit) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env: { ...process.env, MYCLI_TEST_SUITE: suite },
			stdio: "inherit",
		});
		child.once("error", (error) => {
			process.stderr.write(`test_runner_spawn_failed: ${error.message}\n`);
			resolveExit(1);
		});
		child.once("exit", (code, signal) => {
			if (signal !== null) {
				process.stderr.write(`test_runner_interrupted: ${signal}\n`);
				resolveExit(1);
				return;
			}
			resolveExit(code ?? 1);
		});
	});
}

function renderCatalog(catalog, json) {
	const summary = summarizeTestCatalog(catalog);
	if (json) {
		process.stdout.write(`${JSON.stringify({
			total: catalog.length,
			suites: summary,
			files: catalog,
		}, null, 2)}\n`);
		return;
	}
	process.stdout.write(`Test catalog: ${catalog.length} files\n`);
	for (const suite of TEST_SUITE_NAMES) {
		process.stdout.write(`  ${suite.padEnd(11)} ${summary[suite]}\n`);
	}
}

function renderHelp() {
	process.stdout.write([
		"Usage: node scripts/run-test-suite.mjs [options] [-- <node:test options>]",
		"",
		`Suites: ${SELECTOR_NAMES.join(", ")}`,
		"  --suite <name>  Select one or more suites (default: ci)",
		"  --list          Print the catalog without running tests",
		"  --json          Use JSON with --list",
		"  --help          Show this help",
		"",
	].join("\n"));
}

function formatDuration(milliseconds) {
	return `${(milliseconds / 1_000).toFixed(1)}s`;
}

async function main() {
	try {
		const options = parseArguments(process.argv.slice(2));
		if (options.help) {
			renderHelp();
			return 0;
		}
		return await runSelectedTestSuites(options);
	} catch (error) {
		const message = error instanceof Error ? error.message : "test_runner_failed";
		process.stderr.write(`${message}\n`);
		return 1;
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
