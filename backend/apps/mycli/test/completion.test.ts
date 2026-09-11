import assert from "node:assert/strict";
import test from "node:test";
import {
	CLI_COMMAND_CATALOG,
	CLI_COMMAND_NAMES,
	COMPLETION_SHELLS,
	MANAGEMENT_COMMAND_NAMES,
	ROOT_CLI_OPTIONS,
	renderRootHelp,
	type CliCommandNode,
} from "../src/management/cli-command-catalog.ts";
import { renderShellCompletion } from "../src/management/completion.ts";

test("canonical CLI catalog derives command names, management names, and root help", () => {
	assert.deepEqual(
		CLI_COMMAND_NAMES,
		CLI_COMMAND_CATALOG.map((command) => command.name),
	);
	assert.deepEqual(
		MANAGEMENT_COMMAND_NAMES,
		CLI_COMMAND_CATALOG
			.filter((command) => command.execution === "management")
			.map((command) => command.name),
	);
	assert.equal(new Set(CLI_COMMAND_NAMES).size, CLI_COMMAND_NAMES.length);
	assert.deepEqual(
		CLI_COMMAND_CATALOG.find((command) => command.name === "completion")?.arguments?.[0]?.values,
		COMPLETION_SHELLS,
	);

	const help = renderRootHelp();
	for (const command of CLI_COMMAND_CATALOG) {
		assert.match(help, new RegExp(`^  ${escapeRegExp(command.usage)}(?: |$)`, "mu"));
	}
	for (const option of ROOT_CLI_OPTIONS) {
		for (const flag of option.flags) assert.ok(help.includes(flag), flag);
	}
});

test("bash zsh fish and PowerShell completions contain every catalog token", () => {
	const expectedTokens = new Set<string>();
	for (const command of CLI_COMMAND_CATALOG) collectNodeTokens(command, expectedTokens);
	for (const option of ROOT_CLI_OPTIONS) {
		for (const flag of option.flags) expectedTokens.add(flag);
	}

	const registrations = {
		bash: "complete -F _mycli_completion mycli",
		zsh: "compdef _mycli mycli",
		fish: "complete -c mycli",
		powershell: "Register-ArgumentCompleter -Native -CommandName mycli",
	} as const;
	for (const shell of COMPLETION_SHELLS) {
		const completion = renderShellCompletion(shell);
		assert.match(completion, new RegExp(escapeRegExp(registrations[shell]), "u"));
		assert.equal(completion.includes("\u001b["), false);
		assert.equal(completion.endsWith("\n"), true);
		for (const token of expectedTokens) {
			assert.ok(
				completion.includes(completionToken(shell, token)),
				`${shell}: missing ${token}`,
			);
		}
	}
});

function collectNodeTokens(node: CliCommandNode, target: Set<string>): void {
	target.add(node.name);
	for (const argument of node.arguments ?? []) {
		for (const value of argument.values ?? []) target.add(value);
	}
	for (const option of node.options ?? []) {
		for (const flag of option.flags) target.add(flag);
		for (const value of option.value?.values ?? []) target.add(value);
	}
	for (const subcommand of node.subcommands ?? []) collectNodeTokens(subcommand, target);
}

function completionToken(shell: typeof COMPLETION_SHELLS[number], token: string): string {
	if (shell !== "fish" || !token.startsWith("-")) return token;
	return token.startsWith("--") ? `-l '${token.slice(2)}'` : `-s '${token.slice(1)}'`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
