import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_ROOT = fileURLToPath(new URL("../../tests/fixtures/coding-evaluation/", import.meta.url));

export async function loadCorpus(root = CORPUS_ROOT) {
	const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw new Error("evaluation_manifest_invalid");
	const ids = new Set();
	const tasks = [];
	for (const entry of manifest.tasks) {
		const bytes = await readFile(containedPath(root, entry.path));
		if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("evaluation_fixture_hash_mismatch");
		const task = JSON.parse(bytes.toString("utf8"));
		validateTask(task);
		if (ids.has(task.id)) throw new Error("evaluation_duplicate_task");
		ids.add(task.id);
		tasks.push(task);
	}
	return { version: manifest.version, tasks };
}

export function containedPath(root, value) {
	if (typeof value !== "string" || value.includes("\0") || isAbsolute(value)) throw new Error("evaluation_path_invalid");
	const path = resolve(root, value);
	const rel = relative(root, path);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("evaluation_path_invalid");
	return path;
}

function validateTask(task) {
	if (!/^[a-z][a-z0-9-]+$/u.test(task.id) || typeof task.title !== "string" || typeof task.prompt !== "string"
		|| !task.files || typeof task.files !== "object" || Array.isArray(task.files)
		|| !Array.isArray(task.checks) || !task.checks.length || !Array.isArray(task.immutable)) throw new Error("evaluation_task_invalid");
	containedPath(CORPUS_ROOT, task.cwd);
	for (const [path, content] of Object.entries(task.files)) {
		containedPath(CORPUS_ROOT, path);
		if (typeof content !== "string") throw new Error("evaluation_file_invalid");
	}
	for (const path of task.immutable) if (!(path in task.files)) throw new Error("evaluation_immutable_invalid");
	const checks = new Set();
	for (const check of task.checks) {
		containedPath(CORPUS_ROOT, check.path);
		if (checks.has(check.id) || typeof check.id !== "string" || !["export", "json"].includes(check.kind)
			|| (check.kind === "export" && (typeof check.name !== "string" || !Array.isArray(check.args)))) throw new Error("evaluation_check_invalid");
		checks.add(check.id);
	}
}
