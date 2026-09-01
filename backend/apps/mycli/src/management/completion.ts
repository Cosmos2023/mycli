import {
	CLI_COMMAND_CATALOG,
	CLI_COMMAND_NAMES,
	ROOT_CLI_OPTIONS,
	type CliArgumentDescriptor,
	type CliCommandDescriptor,
	type CliCommandNode,
	type CliOptionDescriptor,
	type CompletionShell,
} from "./cli-command-catalog.ts";

interface CompletionCandidate {
	readonly value: string;
	readonly description: string;
}

export function renderShellCompletion(shell: CompletionShell): string {
	switch (shell) {
		case "bash": return renderBashCompletion();
		case "zsh": return renderZshCompletion();
		case "fish": return renderFishCompletion();
		case "powershell": return renderPowerShellCompletion();
	}
}

function renderBashCompletion(): string {
	const rootCandidates = candidatesToWords([
		...commandCandidates(CLI_COMMAND_CATALOG),
		...optionCandidates(ROOT_CLI_OPTIONS),
	]);
	const lines = [
		"# bash completion for mycli",
		"_mycli_completion() {",
		"\tlocal cur prev root action candidates",
		"\tCOMPREPLY=()",
		"\tcur=\"${COMP_WORDS[COMP_CWORD]}\"",
		"\tprev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
		"\troot=\"${COMP_WORDS[1]:-}\"",
		"\taction=\"${COMP_WORDS[2]:-}\"",
		"",
		...renderBashFixedValueCases(),
		"\tif (( COMP_CWORD == 1 )); then",
		`\t\tcandidates=${bashQuote(rootCandidates)}`,
		"\t\tCOMPREPLY=( $(compgen -W \"$candidates\" -- \"$cur\") )",
		"\t\treturn",
		"\tfi",
		"",
		"\tcase \"$root\" in",
	];
	for (const command of CLI_COMMAND_CATALOG) {
		lines.push(...renderBashCommand(command));
	}
	lines.push(
		"\t\t*) candidates=\"\" ;;",
		"\tesac",
		"\tCOMPREPLY=( $(compgen -W \"$candidates\" -- \"$cur\") )",
		"}",
		"complete -F _mycli_completion mycli",
		"",
	);
	return lines.join("\n");
}

function renderBashFixedValueCases(): readonly string[] {
	const cases = fixedOptionValues();
	if (cases.length === 0) return [];
	return [
		"\tcase \"$prev\" in",
		...cases.flatMap(({ flags, candidates }) => [
			`\t\t${flags.join("|")})`,
			`\t\t\tcandidates=${bashQuote(candidatesToWords(candidates))}`,
			"\t\t\tCOMPREPLY=( $(compgen -W \"$candidates\" -- \"$cur\") )",
			"\t\t\treturn",
			"\t\t\t;;",
		]),
		"\tesac",
		"",
	];
}

function renderBashCommand(command: CliCommandDescriptor): readonly string[] {
	const parentCandidates = nodeCandidates(command, { includeSubcommands: true });
	if (!command.subcommands?.length) {
		return [
			`\t\t${command.name}) candidates=${bashQuote(candidatesToWords(parentCandidates))} ;;`,
		];
	}
	return [
		`\t\t${command.name})`,
		"\t\t\tif (( COMP_CWORD == 2 )); then",
		`\t\t\t\tcandidates=${bashQuote(candidatesToWords(parentCandidates))}`,
		"\t\t\telse",
		"\t\t\t\tcase \"$action\" in",
		...command.subcommands.flatMap((subcommand) => [
			`\t\t\t\t\t${subcommand.name}) candidates=${bashQuote(candidatesToWords(
				nodeCandidates(subcommand),
			))} ;;`,
		]),
		`\t\t\t\t\t*) candidates=${bashQuote(candidatesToWords(parentCandidates))} ;;`,
		"\t\t\t\tesac",
		"\t\t\tfi",
		"\t\t\t;;",
	];
}

function renderZshCompletion(): string {
	const rootCandidates = uniqueCandidates([
		...commandCandidates(CLI_COMMAND_CATALOG),
		...optionCandidates(ROOT_CLI_OPTIONS),
	]);
	const lines = [
		"#compdef mycli",
		"# zsh completion for mycli",
		"_mycli() {",
		"\tlocal root action previous",
		"\tlocal -a candidates",
		"\troot=\"${words[2]:-}\"",
		"\taction=\"${words[3]:-}\"",
		"\tprevious=\"${words[CURRENT-1]:-}\"",
		"",
		"\tcase \"$previous\" in",
	];
	for (const { flags, candidates } of fixedOptionValues()) {
		lines.push(
			`\t\t${flags.join("|")})`,
			...zshCandidateAssignment(candidates, 3),
			"\t\t\t_describe 'value' candidates",
			"\t\t\treturn",
			"\t\t\t;;",
		);
	}
	lines.push(
		"\tesac",
		"",
		"\tif (( CURRENT == 2 )); then",
		...zshCandidateAssignment(rootCandidates, 2),
		"\t\t_describe 'mycli command' candidates",
		"\t\treturn",
		"\tfi",
		"",
		"\tcase \"$root\" in",
	);
	for (const command of CLI_COMMAND_CATALOG) {
		lines.push(...renderZshCommand(command));
	}
	lines.push(
		"\t\t*) candidates=() ;;",
		"\tesac",
		"\t_describe 'mycli argument' candidates",
		"}",
		"compdef _mycli mycli",
		"",
	);
	return lines.join("\n");
}

function renderZshCommand(command: CliCommandDescriptor): readonly string[] {
	const parentCandidates = nodeCandidates(command, { includeSubcommands: true });
	if (!command.subcommands?.length) {
		return [
			`\t\t${command.name})`,
			...zshCandidateAssignment(parentCandidates, 3),
			"\t\t\t;;",
		];
	}
	return [
		`\t\t${command.name})`,
		"\t\t\tif (( CURRENT == 3 )); then",
		...zshCandidateAssignment(parentCandidates, 4),
		"\t\t\telse",
		"\t\t\t\tcase \"$action\" in",
		...command.subcommands.flatMap((subcommand) => [
			`\t\t\t\t\t${subcommand.name})`,
			...zshCandidateAssignment(
				nodeCandidates(subcommand),
				6,
			),
			"\t\t\t\t\t\t;;",
		]),
		"\t\t\t\t\t*)",
		...zshCandidateAssignment(parentCandidates, 6),
		"\t\t\t\t\t\t;;",
		"\t\t\t\tesac",
		"\t\t\tfi",
		"\t\t\t;;",
	];
}

function zshCandidateAssignment(
	candidates: readonly CompletionCandidate[],
	indentLevel: number,
): readonly string[] {
	const indent = "\t".repeat(indentLevel);
	return [
		`${indent}candidates=(`,
		...uniqueCandidates(candidates).map((candidate) => (
			`${indent}\t${zshQuote(`${candidate.value}:${candidate.description}`)}`
		)),
		`${indent})`,
	];
}

function renderFishCompletion(): string {
	const rootNames = CLI_COMMAND_NAMES.join(" ");
	const rootCondition = `not __fish_seen_subcommand_from ${rootNames}`;
	const lines = [
		"# fish completion for mycli",
		"complete -c mycli -e",
	];
	for (const command of CLI_COMMAND_CATALOG) {
		lines.push(fishValueCompletion(rootCondition, command.name, command.description));
	}
	for (const option of ROOT_CLI_OPTIONS) {
		lines.push(fishOptionCompletion(rootCondition, option));
	}
	for (const command of CLI_COMMAND_CATALOG) {
		const commandCondition = `__fish_seen_subcommand_from ${command.name}`;
		const commandOptionCondition = command.subcommands?.length
			? `${commandCondition}; and not __fish_seen_subcommand_from ${
				command.subcommands.map((subcommand) => subcommand.name).join(" ")
			}`
			: commandCondition;
		for (const option of command.options ?? []) {
			lines.push(fishOptionCompletion(commandOptionCondition, option));
		}
		for (const argument of command.arguments ?? []) {
			lines.push(...fishArgumentCompletions(commandCondition, argument));
		}
		if (!command.subcommands?.length) continue;
		const subcommandNames = command.subcommands.map((subcommand) => subcommand.name).join(" ");
		const actionCondition = `${commandCondition}; and not __fish_seen_subcommand_from ${subcommandNames}`;
		for (const subcommand of command.subcommands) {
			lines.push(fishValueCompletion(actionCondition, subcommand.name, subcommand.description));
			const subcommandCondition = `${commandCondition}; and __fish_seen_subcommand_from ${subcommand.name}`;
			for (const option of subcommand.options ?? []) {
				lines.push(fishOptionCompletion(subcommandCondition, option));
			}
			for (const argument of subcommand.arguments ?? []) {
				lines.push(...fishArgumentCompletions(subcommandCondition, argument));
			}
		}
	}
	lines.push("");
	return lines.join("\n");
}

function fishValueCompletion(condition: string, value: string, description: string): string {
	return `complete -c mycli -f -n ${fishQuote(condition)} -a ${fishQuote(value)} -d ${fishQuote(description)}`;
}

function fishOptionCompletion(condition: string, option: CliOptionDescriptor): string {
	const flags = option.flags.flatMap((flag) => {
		if (flag.startsWith("--")) return ["-l", fishQuote(flag.slice(2))];
		if (flag.startsWith("-") && flag.length === 2) return ["-s", fishQuote(flag.slice(1))];
		return [];
	});
	const value = option.value
		? [
			"-r",
			...(option.value.values?.length
				? ["-f", "-a", fishQuote(option.value.values.join(" "))]
				: []),
		]
		: [];
	return [
		"complete -c mycli",
		"-n", fishQuote(condition),
		...flags,
		...value,
		"-d", fishQuote(option.description),
	].join(" ");
}

function fishArgumentCompletions(
	condition: string,
	argument: CliArgumentDescriptor,
): readonly string[] {
	if (!argument.values?.length) return [];
	const unusedCondition = `${condition}; and not __fish_seen_subcommand_from ${argument.values.join(" ")}`;
	return argument.values.map((value) => fishValueCompletion(
		unusedCondition,
		value,
		argument.description,
	));
}

function renderPowerShellCompletion(): string {
	const rootCandidates = uniqueCandidates([
		...commandCandidates(CLI_COMMAND_CATALOG),
		...optionCandidates(ROOT_CLI_OPTIONS),
	]);
	const lines = [
		"# PowerShell completion for mycli",
		"Register-ArgumentCompleter -Native -CommandName mycli -ScriptBlock {",
		"\tparam($wordToComplete, $commandAst, $cursorPosition)",
		"\t$tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })",
		"\t$root = if ($tokens.Count -gt 1) { $tokens[1] } else { '' }",
		"\t$action = if ($tokens.Count -gt 2) { $tokens[2] } else { '' }",
		"\t$previous = if ($tokens.Count -gt 1) { $tokens[$tokens.Count - 2] } else { '' }",
		`\t$knownRoots = @(${CLI_COMMAND_NAMES.map(powerShellQuote).join(", ")})`,
		"\t$candidates = @()",
		"\t$handledValue = $false",
		"",
		"\tswitch ($previous) {",
	];
	for (const { flags, candidates } of fixedOptionValues()) {
		for (const flag of flags) {
			lines.push(
				`\t\t${powerShellQuote(flag)} {`,
				...powerShellCandidateAssignment(candidates, 3),
				"\t\t\t$handledValue = $true",
				"\t\t\tbreak",
				"\t\t}",
			);
		}
	}
	lines.push(
		"\t}",
		"",
		"\tif (-not $handledValue) {",
		"\t\tif (-not $root -or $knownRoots -notcontains $root -or ($tokens.Count -eq 2 -and $wordToComplete)) {",
		...powerShellCandidateAssignment(rootCandidates, 3),
		"\t\t} else {",
		"\t\t\tswitch ($root) {",
	);
	for (const command of CLI_COMMAND_CATALOG) {
		lines.push(...renderPowerShellCommand(command));
	}
	lines.push(
		"\t\t\t}",
		"\t\t}",
		"\t}",
		"",
		"\tforeach ($candidate in $candidates) {",
		"\t\t$parts = $candidate -split '\\|', 2",
		"\t\t$value = $parts[0]",
		"\t\tif ($value -like \"$wordToComplete*\") {",
		"\t\t\t[System.Management.Automation.CompletionResult]::new(",
		"\t\t\t\t$value, $value, 'ParameterValue', $parts[1]",
		"\t\t\t)",
		"\t\t}",
		"\t}",
		"}",
		"",
	);
	return lines.join("\n");
}

function renderPowerShellCommand(command: CliCommandDescriptor): readonly string[] {
	const parentCandidates = nodeCandidates(command, { includeSubcommands: true });
	if (!command.subcommands?.length) {
		return [
			`\t\t\t\t${powerShellQuote(command.name)} {`,
			...powerShellCandidateAssignment(parentCandidates, 5),
			"\t\t\t\t\tbreak",
			"\t\t\t\t}",
		];
	}
	const knownActions = command.subcommands.map((subcommand) => powerShellQuote(subcommand.name));
	return [
		`\t\t\t\t${powerShellQuote(command.name)} {`,
		`\t\t\t\t\t$knownActions = @(${knownActions.join(", ")})`,
		"\t\t\t\t\tif (-not $action -or $knownActions -notcontains $action -or ($tokens.Count -eq 3 -and $wordToComplete)) {",
		...powerShellCandidateAssignment(parentCandidates, 6),
		"\t\t\t\t\t} else {",
		"\t\t\t\t\t\tswitch ($action) {",
		...command.subcommands.flatMap((subcommand) => [
			`\t\t\t\t\t\t\t${powerShellQuote(subcommand.name)} {`,
			...powerShellCandidateAssignment(
				nodeCandidates(subcommand),
				8,
			),
			"\t\t\t\t\t\t\t\tbreak",
			"\t\t\t\t\t\t\t}",
		]),
		"\t\t\t\t\t\t}",
		"\t\t\t\t\t}",
		"\t\t\t\t\tbreak",
		"\t\t\t\t}",
	];
}

function powerShellCandidateAssignment(
	candidates: readonly CompletionCandidate[],
	indentLevel: number,
): readonly string[] {
	const indent = "\t".repeat(indentLevel);
	const values = uniqueCandidates(candidates).map((candidate) => (
		powerShellQuote(`${candidate.value}|${candidate.description}`)
	));
	return [`${indent}$candidates = @(${values.join(", ")})`];
}

function nodeCandidates(
	node: CliCommandNode,
	options: {
		readonly includeSubcommands?: boolean;
	} = {},
): readonly CompletionCandidate[] {
	return uniqueCandidates([
		...(options.includeSubcommands ? commandCandidates(node.subcommands ?? []) : []),
		...optionCandidates(node.options ?? []),
		...argumentCandidates(node.arguments ?? []),
	]);
}

function commandCandidates(
	commands: readonly CliCommandNode[],
): readonly CompletionCandidate[] {
	return commands.map((command) => ({
		value: command.name,
		description: command.description,
	}));
}

function optionCandidates(
	options: readonly CliOptionDescriptor[],
): readonly CompletionCandidate[] {
	return options.flatMap((option) => option.flags.map((flag) => ({
		value: flag,
		description: option.description,
	})));
}

function argumentCandidates(
	arguments_: readonly CliArgumentDescriptor[],
): readonly CompletionCandidate[] {
	return arguments_.flatMap((argument) => (argument.values ?? []).map((value) => ({
		value,
		description: argument.description,
	})));
}

function fixedOptionValues(): readonly {
	readonly flags: readonly string[];
	readonly candidates: readonly CompletionCandidate[];
}[] {
	const valuesByFlags = new Map<string, {
		readonly flags: readonly string[];
		readonly candidates: CompletionCandidate[];
	}>();
	for (const option of allOptions()) {
		if (!option.value?.values?.length) continue;
		const key = option.flags.join("\u0000");
		const current = valuesByFlags.get(key) ?? { flags: option.flags, candidates: [] };
		current.candidates.push(...option.value.values.map((value) => ({
			value,
			description: option.value?.description ?? option.description,
		})));
		valuesByFlags.set(key, current);
	}
	return [...valuesByFlags.values()].map((entry) => ({
		flags: entry.flags,
		candidates: uniqueCandidates(entry.candidates),
	}));
}

function allOptions(): readonly CliOptionDescriptor[] {
	return [
		...ROOT_CLI_OPTIONS,
		...CLI_COMMAND_CATALOG.flatMap((command) => [
			...(command.options ?? []),
			...(command.subcommands ?? []).flatMap((subcommand) => subcommand.options ?? []),
		]),
	];
}

function uniqueCandidates(
	candidates: readonly CompletionCandidate[],
): readonly CompletionCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		if (seen.has(candidate.value)) return false;
		seen.add(candidate.value);
		return true;
	});
}

function candidatesToWords(candidates: readonly CompletionCandidate[]): string {
	return uniqueCandidates(candidates).map((candidate) => candidate.value).join(" ");
}

function bashQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function zshQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`).replaceAll(":", "\\:")}'`;
}

function fishQuote(value: string): string {
	return `'${value.replaceAll("'", "\\'")}'`;
}

function powerShellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
