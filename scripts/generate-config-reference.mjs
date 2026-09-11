import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import {
	renderConfigExampleToml,
	renderConfigReferenceJson,
	renderConfigReferenceMarkdown,
	resolveConfig,
} from "@mycli/config";

const ROOT = process.cwd();
const OUTPUTS = new Map([
	["docs/reference/configuration.md", renderConfigReferenceMarkdown],
	["docs/reference/configuration-reference.json", renderConfigReferenceJson],
	["docs/reference/config.example.toml", renderConfigExampleToml],
]);

const config = await resolveConfig({
	homeDir: join(ROOT, ".generated-config-reference", "home"),
	workspaceRoot: join(ROOT, ".generated-config-reference", "workspace"),
	systemConfigPath: join(ROOT, ".generated-config-reference", "system.toml"),
	env: {},
	workspaceTrust: "untrusted",
	createSessionId: () => "configuration-reference",
});

const expected = new Map([...OUTPUTS].map(([path, render]) => [path, render(config)]));
if (process.argv.includes("--check")) {
	const drift = [];
	for (const [path, content] of expected) {
		let current;
		try {
			current = await readFile(join(ROOT, path), "utf8");
		} catch {
			current = undefined;
		}
		if (current !== content) drift.push(path);
	}
	if (drift.length > 0) {
		throw new Error(`generated configuration reference drift: ${drift.join(", ")}`);
	}
	process.stdout.write("configuration reference is current\n");
} else {
	for (const [path, content] of expected) {
		const absolute = join(ROOT, path);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, content, "utf8");
	}
	process.stdout.write(`generated ${expected.size} configuration reference files\n`);
}
