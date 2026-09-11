import assert from "node:assert/strict";
import test from "node:test";
import { validateExecPolicyProposal } from "../../src/index.ts";

test("accepts a narrow exact prefix for the unknown segment", () => {
	assert.deepEqual(validate("python -m pytest -q", ["python", "-m", "pytest"]), {
		pattern: ["python", "-m", "pytest"],
	});
	assert.deepEqual(validate(
		"pwd && python -m pytest -q",
		["python", "-m", "pytest"],
	), { pattern: ["python", "-m", "pytest"] });
	assert.deepEqual(validate("npm run test -- --watch=false", ["npm", "run", "test"]), {
		pattern: ["npm", "run", "test"],
	});
});

test("rejects invalid, non-prefix, cross-segment, and complex proposals", () => {
	for (const [command, pattern] of [
		["python script.py", []],
		["python script.py", ["node"]],
		["python script.py | cat", ["python", "script.py", "cat"]],
		["python $SCRIPT", ["python"]],
	] as const) {
		assert.equal(validate(command, pattern).pattern, undefined, command);
	}
	assert.equal(validate("python script.py", ["python", 7] as unknown as string[]).pattern, undefined);
});

test("rejects broad interpreters, shells, escalation, and destructive families", () => {
	for (const [command, pattern, shellKind] of [
		["python script.py", ["python"], "posix"],
		["python3 -c pass", ["python3", "-c"], "posix"],
		["node app.js", ["node"], "posix"],
		["bash -lc make", ["bash", "-lc"], "posix"],
		["sudo make install", ["sudo"], "posix"],
		["rm build.txt", ["rm"], "posix"],
		["git reset --hard HEAD", ["git", "reset", "--hard"], "posix"],
		["git clean -fd", ["git", "clean"], "posix"],
		["git push --force origin main", ["git", "push", "--force"], "posix"],
		["chmod -R 777 build", ["chmod", "-R"], "posix"],
		["Remove-Item -Recurse build", ["Remove-Item", "-Recurse"], "powershell"],
	] as const) {
		assert.equal(validate(command, pattern, { shellKind }).pattern, undefined, command);
	}
});

test("rejects sensitive values and explicit ask or deny policy", () => {
	for (const [command, pattern] of [
		["tool --token abc123", ["tool", "--token", "abc123"]],
		["env API_KEY=abc tool", ["env", "API_KEY=abc"]],
		["tool password=abc", ["tool", "password=abc"]],
		["tool '<redacted>'", ["tool", "<redacted>"]],
	] as const) {
		assert.equal(validate(command, pattern).pattern, undefined, command);
	}
	for (const decision of ["ask", "deny"] as const) {
		assert.equal(validate("python -m pytest -q", ["python", "-m", "pytest"], {
			rules: [{
				source: "project",
				index: 0,
				pattern: ["python", "-m", "pytest"],
				decision,
			}],
		}).pattern, undefined);
	}
});

function validate(
	command: string,
	pattern: readonly string[],
	options: {
		readonly shellKind?: "posix" | "powershell" | "cmd";
		readonly rules?: readonly {
			readonly source: "user" | "project" | "session";
			readonly index: number;
			readonly pattern: readonly string[];
			readonly decision: "allow" | "ask" | "deny";
		}[];
	} = {},
) {
	return validateExecPolicyProposal({
		toolName: "Shell",
		argumentsValue: { command, prefix_rule: pattern },
		shellKind: options.shellKind ?? "posix",
		rules: options.rules ?? [],
		approvalPolicy: "shell_command_analysis",
	});
}
