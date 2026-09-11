import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	redactDoctorText,
	scanDoctorFiles,
} from "../src/management/doctor/redaction.ts";

test("doctor text redaction removes secret-shaped text", () => {
	const text = redactDoctorText([
		"Authorization: Bearer bearer-secret",
		"api_key=sk-test-secret",
		"command=private-command --token argument-secret",
		"prompt=private-prompt",
	].join(" "));

	assert.doesNotMatch(text, /bearer-secret|test-secret|private-command|argument-secret/u);
	assert.doesNotMatch(text, /private-prompt/u);
	assert.match(text, /\[REDACTED\]/u);
	assert.equal(redactDoctorText("api_key: present"), "api_key: present");
	assert.equal(redactDoctorText("api_key: missing"), "api_key: missing");
	assert.equal(redactDoctorText("api_key: unknown"), "api_key: unknown");
});

test("doctor secret scanning reports bounded references without file contents", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-doctor-redaction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const logs = join(root, "logs");
	await mkdir(logs, { recursive: true });
	const eventPath = join(logs, "model-events.jsonl");
	const errorPath = join(logs, "errors.log");
	const benignPath = join(logs, "agent.log");
	await writeFile(eventPath, `${JSON.stringify({
		config: { api_key: "config-test-secret" },
		headers: { Authorization: "Bearer header-test-secret" },
		env: { TOKEN: "env-test-secret" },
		stderr: "private-command token=plugin-test-secret",
		provider_payload: { output: "api_key=provider-test-secret" },
	})}\n`, "utf8");
	await writeFile(errorPath, "token=plain-test-secret\n", "utf8");
	await writeFile(benignPath, `${JSON.stringify({
		content: "ordinary model content",
		stderr: "ordinary bounded warning",
		provider_payload: { output: "ordinary provider output" },
	})}\n`, "utf8");

	const scan = await scanDoctorFiles({
		root,
		paths: [eventPath, errorPath, benignPath],
	});
	const rendered = JSON.stringify(scan);

	assert.equal(scan.scannedFileCount, 3);
	assert.equal(scan.findingCount, 6);
	assert.ok(scan.references.every((reference) => reference.startsWith("logs/")));
	assert.doesNotMatch(rendered, /config-test-secret|header-test-secret|env-test-secret/u);
	assert.doesNotMatch(rendered, /private-command|plugin-test-secret|provider-test-secret/u);
	assert.doesNotMatch(rendered, /plain-test-secret|ordinary model content|Bearer/u);
});
