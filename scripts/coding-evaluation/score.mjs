import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { containedPath } from "./corpus.mjs";

export async function scoreTask(task, workspace) {
	const root = await realpath(workspace);
	const results = [];
	for (const check of task.checks) {
		try {
			const path = await realpath(containedPath(root, check.path));
			if (containedPath(root, check.path) !== path) throw new Error("symlink_not_allowed");
			if (check.kind === "json") assert.deepEqual(JSON.parse(await readFile(path, "utf8")), check.expected);
			else {
				const module = await import(pathToFileURL(path).href);
				const invoke = async () => module[check.name](...check.args);
				if (check.throws) await assert.rejects(invoke, { name: check.throws });
				else assert.deepEqual(await invoke(), check.expected);
			}
			results.push({ id: check.id, passed: true });
		} catch { results.push({ id: check.id, passed: false }); }
	}
	for (const path of task.immutable) {
		let passed = false;
		try { passed = await readFile(containedPath(root, path), "utf8") === task.files[path]; } catch { /* A deleted guideline fails the check. */ }
		results.push({ id: `immutable:${path}`, passed });
	}
	return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		let input = "";
		for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new Error("input_limit"); }
		const { task, workspace, nonce } = JSON.parse(input);
		const checks = await scoreTask(task, workspace);
		process.stdout.write(`${JSON.stringify({ nonce, checks })}\n`);
	} catch { process.exitCode = 1; }
}
