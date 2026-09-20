import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@mycli/core";
import {
	createRunExecutionSnapshot,
	createToolCatalogSnapshot,
	parseRunExecutionSnapshot,
	replaceRunPolicySnapshot,
	RUN_EXECUTION_SNAPSHOT_MAX_BYTES,
	TOOL_CATALOG_SNAPSHOT_MAX_BYTES,
	toolExposureForSnapshot,
} from "../../src/index.ts";

test("run execution snapshots own deeply frozen policy and catalog values", () => {
	const schema = {
		type: "object",
		properties: { query: { type: "string" } },
		additionalProperties: false,
	};
	const writableRoots = [resolve("/workspace")];
	const direct = definition("builtin:search", "Search", schema);
	const deferred = definition("mcp:docs:search", "docs_search");
	const snapshot = createRunExecutionSnapshot({
		turnId: "turn-1",
		collaborationMode: "plan",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots,
				readOnlyRoots: [resolve("/workspace/vendor")], allowLocalBinding: true, writableTemp: false,
			},
		},
		policyConfiguration: {
			trust: "trusted",
			permission: "workspace",
			source: "session",
		},
		toolCatalog: {
			catalogVersion: 7,
			directTools: [direct],
			deferredTools: [deferred],
			skillCatalog: "- review: Review the repository",
		},
	});

	schema.properties.query.type = "number";
	writableRoots.push("/outside");
	assert.equal(snapshot.toolCatalog.directTools[0]?.inputSchema.properties
		&& Reflect.get(snapshot.toolCatalog.directTools[0].inputSchema.properties, "query")
		&& Reflect.get(Reflect.get(snapshot.toolCatalog.directTools[0].inputSchema.properties, "query"), "type"), "string");
	assert.deepEqual(snapshot.policy?.profile.writableRoots, [resolve("/workspace")]);
	assert.equal(Object.isFrozen(snapshot), true);
	assert.equal(Object.isFrozen(snapshot.toolCatalog.directTools), true);
	assert.equal(Object.isFrozen(snapshot.toolCatalog.directTools[0]?.inputSchema), true);
	assert.equal(Object.isFrozen(snapshot.policy?.profile.writableRoots), true);
	assert.deepEqual(snapshot.policy?.profile.readOnlyRoots, [resolve("/workspace/vendor")]);
	assert.equal(Object.isFrozen(snapshot.policy?.profile.readOnlyRoots), true);
	const restoredPolicy = parseRunExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)), "turn-1").policy?.profile;
	assert.equal(restoredPolicy?.allowLocalBinding, true);
	assert.equal(restoredPolicy?.writableTemp, false);
	assert.deepEqual(
		toolExposureForSnapshot(snapshot.toolCatalog, ["missing", "docs_search"])
			.map((tool) => tool.name),
		["Search", "docs_search"],
	);
});

test("run snapshots retain structured egress rules and reject malformed ones", () => {
	const networkEgress = {
		default: "deny" as const,
		allow: [{
			to: [{ cidr: "10.0.0.0/8", except: ["10.1.0.0/16"] }],
			ports: [{ protocol: "tcp" as const, port: 443, endPort: 444 }],
		}],
	};
	const input = {
		turnId: "turn-egress",
		collaborationMode: "default" as const,
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "workspace-write" as const,
				filesystem: "workspace_write" as const,
				network: "enabled" as const,
				networkEgress,
				writableRoots: [resolve("/workspace")],
			},
		},
		policyConfiguration: { trust: "trusted" as const, permission: "workspace" as const, source: "session" as const },
		toolCatalog: { catalogVersion: 7, directTools: [], deferredTools: [], skillCatalog: "" },
	};
	const snapshot = createRunExecutionSnapshot(input);
	assert.deepEqual(snapshot.policy?.profile.networkEgress, networkEgress);
	assert.equal(Object.isFrozen(snapshot.policy?.profile.networkEgress), true);
	const restored = parseRunExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)), "turn-egress")
		.policy?.profile;
	assert.deepEqual(restored?.networkEgress, networkEgress);
	assert.throws(() => createRunExecutionSnapshot({
		...input,
		policy: {
			...input.policy,
			profile: {
				...input.policy.profile,
				networkEgress: { default: "allow" as never, allow: networkEgress.allow },
			},
		},
	}), TypeError);
});

test("run execution snapshot parsing verifies identity and catalog fingerprints", () => {
	const snapshot = createRunExecutionSnapshot({
		turnId: "turn-1",
		collaborationMode: "default",
		toolCatalog: {
			catalogVersion: 1,
			directTools: [definition("builtin:read", "Read")],
		},
	});
	const restored = parseRunExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)), "turn-1");
	assert.deepEqual(restored, snapshot);
	assert.equal(Object.isFrozen(restored.toolCatalog.directTools[0]?.inputSchema), true);

	const tampered = JSON.parse(JSON.stringify(snapshot)) as {
		toolCatalog: { directTools: Array<{ description: string }> };
	};
	tampered.toolCatalog.directTools[0]!.description = "Changed after suspension";
	assert.throws(
		() => parseRunExecutionSnapshot(tampered, "turn-1"),
		/tool catalog snapshot fingerprint is invalid/u,
	);
	assert.throws(
		() => parseRunExecutionSnapshot(snapshot, "turn-2"),
		/run execution snapshot turn does not match continuation/u,
	);
	assert.equal(createToolCatalogSnapshot({
		catalogVersion: 1,
		directTools: [],
		skillCatalog: "",
	}).skillCatalog, undefined);
	assert.throws(() => createToolCatalogSnapshot({
		catalogVersion: 1,
		directTools: [
			definition("duplicate:id", "first"),
			definition("duplicate:id", "second"),
		],
	}), /duplicate run tool id/u);
	assert.throws(() => createToolCatalogSnapshot({
		catalogVersion: 1,
		directTools: Array.from(
			{ length: 257 },
			(_, index) => definition(`builtin:${index}`, `tool_${index}`),
		),
		deferredTools: Array.from(
			{ length: 256 },
			(_, index) => definition(`mcp:${index}`, `deferred_${index}`),
		),
	}), /tool catalog exceeds tool count limit/u);
});

test("policy replacement preserves the original catalog and configuration snapshot", () => {
	const catalog = createToolCatalogSnapshot({
		catalogVersion: 3,
		directTools: [definition("builtin:read", "Read")],
	});
	const original = createRunExecutionSnapshot({
		turnId: "turn-1",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "read-only",
				filesystem: "read_only",
				network: "disabled",
				writableRoots: [],
			},
		},
		policyConfiguration: { trust: "trusted", permission: "read-only" },
		toolCatalog: catalog,
	});
	const updated = replaceRunPolicySnapshot(original, {
		toolsEnabled: true,
		profile: {
			mode: "workspace-write",
			filesystem: "workspace_write",
			network: "disabled",
			writableRoots: [resolve("/workspace")],
		},
	});

	assert.equal(updated.toolCatalog, original.toolCatalog);
	assert.equal(updated.collaborationMode, "default");
	assert.deepEqual(updated.policy?.configuration, original.policy?.configuration);
	assert.deepEqual(updated.policy?.profile.writableRoots, [resolve("/workspace")]);
});

test("run execution snapshots reject inconsistent or authority-expanding policy payloads", () => {
	const toolCatalog = {
		catalogVersion: 1,
		directTools: [definition("builtin:read", "Read")],
	};
	assert.throws(() => createRunExecutionSnapshot({
		turnId: "turn-mode-mismatch",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "read-only",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots: [resolve("/workspace")],
			},
		},
		toolCatalog,
	}), /mode and filesystem do not match/u);
	assert.throws(() => createRunExecutionSnapshot({
		turnId: "turn-relative-root",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots: ["relative/path"],
			},
		},
		toolCatalog,
	}), /absolute paths/u);
	assert.throws(() => createRunExecutionSnapshot({
		turnId: "turn-trust-mismatch",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "read-only",
				filesystem: "read_only",
				network: "disabled",
				writableRoots: [],
			},
		},
		policyConfiguration: { trust: "untrusted", permission: "read-only" },
		toolCatalog,
	}), /trust does not match toolsEnabled/u);
});

test("run execution snapshots bound the complete frozen catalog and continuation payload", () => {
	const oversizedCatalog = Array.from({ length: 40 }, (_, index) => ({
		...definition(`mcp:test:${index}`, `tool_${index}`),
		description: "x".repeat(60_000),
	}));
	assert.ok(Buffer.byteLength(JSON.stringify(oversizedCatalog), "utf8")
		> TOOL_CATALOG_SNAPSHOT_MAX_BYTES);
	assert.throws(() => createToolCatalogSnapshot({
		catalogVersion: 1,
		directTools: oversizedCatalog,
	}), /tool catalog snapshot exceeds size limit/u);

	const largeCatalog = createToolCatalogSnapshot({
		catalogVersion: 2,
		directTools: Array.from({ length: 24 }, (_, index) => ({
			...definition(`plugin:test:${index}`, `plugin_${index}`),
			description: "y".repeat(60_000),
		})),
	});
	const longRoots = (prefix: string) => Array.from({ length: 256 }, (_, index) => {
		const suffix = `-${index}`;
		const root = resolve("/");
		return `${root}${prefix}${"r".repeat(4_096 - prefix.length - suffix.length - root.length)}${suffix}`;
	});
	const serializedCandidate = {
		version: 1,
		turnId: "turn-oversized",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				readableRoots: longRoots("read-"),
				writableRoots: longRoots("write-"),
			},
		} as const,
		toolCatalog: largeCatalog,
	};
	assert.ok(Buffer.byteLength(JSON.stringify(serializedCandidate), "utf8")
		> RUN_EXECUTION_SNAPSHOT_MAX_BYTES);
	assert.throws(() => createRunExecutionSnapshot({
		turnId: serializedCandidate.turnId,
		collaborationMode: serializedCandidate.collaborationMode,
		policy: serializedCandidate.policy,
		toolCatalog: largeCatalog,
	}), /run execution snapshot exceeds size limit/u);
});

function definition(
	id: string,
	name: string,
	inputSchema: Readonly<Record<string, unknown>> = Object.freeze({
		type: "object",
		properties: Object.freeze({}),
		additionalProperties: false,
	}),
): ToolDefinition {
	return {
		id,
		name,
		description: `${name} test tool`,
		inputSchema,
	};
}

test("run snapshots preserve denied-read boundaries across durable serialization", () => {
	const workspace = resolve("workspace");
	const secret = join(workspace, "secrets");
	const snapshot = createRunExecutionSnapshot({
		turnId: "deny-turn",
		collaborationMode: "default",
		policy: {
			toolsEnabled: true,
			profile: {
				mode: "workspace-write",
				filesystem: "workspace_write",
				network: "enabled",
				writableRoots: [workspace],
				deniedReadRoots: [secret],
				deniedReadGlobs: ["**/.env"],
			},
		},
		toolCatalog: { catalogVersion: 1, directTools: [] },
	});
	const restored = parseRunExecutionSnapshot(JSON.parse(JSON.stringify(snapshot)), "deny-turn");
	assert.deepEqual(restored.policy?.profile.deniedReadRoots, [secret]);
	assert.deepEqual(restored.policy?.profile.deniedReadGlobs, ["**/.env"]);
	assert.equal(Object.isFrozen(restored.policy?.profile.deniedReadGlobs), true);
});
