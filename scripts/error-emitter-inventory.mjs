import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ERROR_REASONS, RUNTIME_ERROR_CODES, errorDefinition, legacyGatewayReason, legacyRuntimeReason, legacyToolReason } from "@mycli/contracts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE = join(ROOT, "tests/fixtures/error-system/emitters.json");
const roots = ["providers", "runtime", "tools", "storage", "config", "integrations"].map((name) => [`backend/packages/${name}/src`, name]);
roots.push(["backend/apps/mycli/src", "gateway"], ["tui/mycli-shell/src", "tui"]);

export function inventoryErrorEmitters() {
	const rows = new Map();
	for (const [root, domain] of roots) for (const path of files(join(ROOT, root))) {
		const file = relative(ROOT, path).split("\\").join("/");
		const source = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		const add = (boundary, code, reason, evidence = "legacy_code") => {
			const preferredScope = domain === "tools" || boundary === "tool_result" ? "tool_call"
				: domain === "gateway" ? "request" : domain === "storage" ? "session"
					: domain === "runtime" ? "turn" : domain === "providers" ? "provider_attempt" : "application";
			const scopes = errorDefinition(reason).scopes;
			const scope = scopes.includes(preferredScope) ? preferredScope : scopes[0];
			const row = { file, boundary, code, evidence, scope, reason };
			rows.set(JSON.stringify(row), row);
		};
		const fallback = () => domain === "tools" ? "tool.failure_unclassified"
			: domain === "storage" ? "storage.failure_unclassified" : domain === "providers" ? "provider.failure_unclassified"
				: domain === "config" ? "config.invalid" : domain === "integrations" ? "integration.failure_unclassified"
					: domain === "tui" ? "tui.render_failed" : domain === "gateway" ? "gateway.failure_unclassified" : "runtime.internal_error";
		const classify = (code) => domain === "tools" ? legacyToolReason(code)
			: RUNTIME_ERROR_CODES.includes(code) ? legacyRuntimeReason(code)
				: domain === "gateway" ? legacyGatewayReason(code) : fallback();
		const visit = (node) => {
			if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
				const value = literal(node.initializer);
				if (node.name.text === "reason" && ERROR_REASONS.includes(value)) add("typed_context", value, value, "typed_guard");
				if (node.name.text === "errorKind" && value) add("tool_result", value, legacyToolReason(value));
				if (node.name.text === "code" && RUNTIME_ERROR_CODES.includes(value)) add("runtime_failure", value, legacyRuntimeReason(value));
			}
			if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /(?:Error|Failure)$/u.test(node.expression.text)) {
				const boundary = node.expression.text;
				const first = node.arguments?.[0];
				let code = literal(first);
				if (code && !/^[a-z][a-z0-9_]*$/u.test(code)) code = undefined;
				if (boundary === "StorageFailure") code = "persistence_error";
				if (boundary === "ProviderFailure" && first && ts.isObjectLiteralExpression(first)) {
					const field = first.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(source) === "code");
					code = field && ts.isPropertyAssignment(field) ? literal(field.initializer) : undefined;
				}
				add(boundary, code ?? "*", code ? classify(code) : fallback(), code ? "legacy_code" : "explicit_generic_fallback");
			}
			if ((domain === "tools" || domain === "integrations") && ts.isCallExpression(node)
				&& ts.isIdentifier(node.expression) && ["failure", "shellFailure", "failureResult", "failedResult"].includes(node.expression.text)) {
				const code = node.arguments.map(literal).find((value) => value && /^[a-z][a-z0-9_]*$/u.test(value));
				if (code) add("tool_result", code, legacyToolReason(code));
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return [...rows.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function files(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
		? files(join(root, entry.name)) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [join(root, entry.name)] : []);
}

function literal(node) {
	return node && ts.isStringLiteral(node) ? node.text : undefined;
}

export function checkErrorEmitterInventory() {
	const bytes = readFileSync(FIXTURE);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), readFileSync(`${FIXTURE}.sha256`, "utf8").trim());
	assert.deepEqual(inventoryErrorEmitters(), JSON.parse(bytes.toString("utf8")), "Error emitter coverage changed; review classifications before regenerating the inventory.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	if (process.argv.includes("--write")) {
		const rows = inventoryErrorEmitters();
		const bytes = `[\n${rows.map((row) => `  ${JSON.stringify(row)}`).join(",\n")}\n]\n`;
		writeFileSync(FIXTURE, bytes);
		writeFileSync(`${FIXTURE}.sha256`, `${createHash("sha256").update(bytes).digest("hex")}\n`);
		process.stdout.write(`Recorded ${rows.length} error boundary classifications.\n`);
	} else checkErrorEmitterInventory();
}
