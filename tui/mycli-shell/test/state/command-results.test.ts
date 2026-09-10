import assert from "node:assert/strict";
import test from "node:test";

import { commandResultFromGateway } from "../../src/state/command-results.ts";

test("command result parser accepts version one and rejects unsupported versions", () => {
	const parsed = commandResultFromGateway({
		result_id: "command:1",
		display: {
			version: 1,
			kind: "list",
			command: "/tools",
			title: "Tools",
			severity: "info",
			rows: [{ key: "Read", label: "Read", values: ["file"] }],
		},
		lines: ["Tools", "Read  file"],
	});

	assert.equal(parsed?.id, "command:1");
	assert.equal(parsed?.display.kind, "list");
	assert.equal(parsed?.display.rows[0]?.label, "Read");
	assert.deepEqual(parsed?.fallbackLines, ["Tools", "Read  file"]);
	assert.equal(commandResultFromGateway({ result_id: "command:2", display: { version: 2 } }), null);
});

test("command result parser rejects partial nested rows", () => {
	const parsed = commandResultFromGateway({
		result_id: "command:1",
		display: {
			version: 1,
			kind: "list",
			command: "/tools",
			title: "Tools",
			severity: "info",
			rows: [{ key: "Read", values: ["file"] }],
		},
		lines: ["Tools"],
	});

	assert.equal(parsed, null);
});
