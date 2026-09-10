import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const LAYER_DEPENDENCIES = {
	model: [],
	foundation: ["model", "theme", "tui-core"],
	"tui-core": [],
	theme: ["tui-core"],
	state: ["model", "foundation", "theme"],
	transport: ["state"],
	transcript: ["model", "foundation", "theme", "tui-core"],
	interaction: ["model", "foundation", "theme", "tui-core"],
	components: ["model", "foundation", "theme", "tui-core", "transcript", "interaction"],
	platform: ["model", "foundation", "tui-core"],
	application: ["model", "foundation", "tui-core", "theme", "state", "transport", "transcript", "interaction", "components", "platform"],
	entry: ["model", "foundation", "tui-core", "theme", "state", "transport", "transcript", "interaction", "components", "platform", "application"],
} satisfies Record<string, readonly string[]>;
type Layer = keyof typeof LAYER_DEPENDENCIES;

function layerFor(file: string): Layer {
	if (file === "model.ts") return "model";
	if (["safe-ui-text.ts", "stable-variant.ts", "version.ts"].includes(file)) return "foundation";
	if (["index.ts", "gateway.ts", "demo.ts", "setup.ts"].includes(file)) return "entry";
	const directory = file.split("/")[0]!;
	assert.ok(directory in LAYER_DEPENDENCIES, `Source module needs an architectural owner: ${file}`);
	return directory as Layer;
}

function moduleSpecifiers(source: ts.SourceFile): string[] {
	const modules: string[] = [];
	const visit = (node: ts.Node): void => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			modules.push(node.moduleSpecifier.text);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
			modules.push(node.argument.literal.text);
		} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument)) modules.push(argument.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return modules;
}

test("TUI modules follow their dependency layers without cycles or backend implementation imports", () => {
	const files = readdirSync(SOURCE_ROOT, { recursive: true })
		.filter((file): file is string => typeof file === "string" && file.endsWith(".ts"))
		.map(file => file.split(sep).join("/"));
	const sources = new Set(files);
	const graph = new Map<string, string[]>();
	const violations: string[] = [];
	for (const file of files) {
		const absolute = resolve(SOURCE_ROOT, file);
		const source = ts.createSourceFile(file, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
		const layer = layerFor(file);
		const dependencies: string[] = [];
		for (const specifier of moduleSpecifiers(source)) {
			if (!specifier.startsWith(".")) {
				if ((specifier.startsWith("@mycli/") && !["@mycli/contracts", "@mycli/gateway"].includes(specifier))
					|| specifier === "@cosmos2023/mycli" || specifier.startsWith("@cosmos2023/mycli/")) {
					violations.push(`${file} imports backend implementation ${specifier}`);
				}
				if (specifier === "@mycli/gateway" && layer !== "transport") violations.push(`${file} bypasses the gateway transport boundary`);
				continue;
			}
			const target = relative(SOURCE_ROOT, resolve(dirname(absolute), specifier)).split(sep).join("/");
			if (!sources.has(target)) {
				violations.push(`${file} imports missing or external source ${specifier}`);
				continue;
			}
			dependencies.push(target);
			const targetLayer = layerFor(target);
			const allowed: readonly string[] = LAYER_DEPENDENCIES[layer];
			if (layer !== targetLayer && !allowed.includes(targetLayer)) violations.push(`${file} -> ${target}`);
		}
		graph.set(file, dependencies);
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const walk = (file: string, trail: readonly string[]): void => {
		if (visiting.has(file)) {
			violations.push(`Dependency cycle: ${[...trail.slice(trail.indexOf(file)), file].join(" -> ")}`);
			return;
		}
		if (visited.has(file)) return;
		visiting.add(file);
		for (const dependency of graph.get(file) ?? []) walk(dependency, [...trail, file]);
		visiting.delete(file);
		visited.add(file);
	};
	for (const file of files) walk(file, []);
	assert.deepEqual(violations, []);
});
