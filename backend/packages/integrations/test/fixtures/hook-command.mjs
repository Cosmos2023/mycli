import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, value] = process.argv.slice(2);

if (mode === "grandchild") {
	await writeFile(value, String(process.pid), "utf8");
	process.on("SIGTERM", () => undefined);
	setInterval(() => undefined, 1_000);
} else {
	let raw = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) raw += chunk;
	const input = raw ? JSON.parse(raw) : {};

	switch (mode) {
		case "allow":
			respond({ action: "allow", additional_contexts: ["bounded context"] });
			break;
		case "deny":
			respond({ action: "deny", message: "blocked by fixture" });
			break;
		case "path-deny":
			respond({
				action: "deny",
				message: "blocked /Users/private/project/file.ts C:\\Users\\Private\\file.ts",
			});
			break;
		case "modify":
			respond({
				action: "modify",
				modified_args: {
					path: "changed.md",
					inputVersion: input.version,
					eventName: input.hook_event_name,
				},
			});
			break;
		case "codex-block":
			respond({ decision: "block", reason: "codex blocked" });
			break;
		case "codex-context":
			respond({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: "codex context",
				},
			});
			break;
		case "exit2":
			process.stderr.write("blocked with exit two");
			process.exitCode = 2;
			break;
		case "plain":
			process.stdout.write("plain session context\n");
			break;
		case "invalid":
			process.stdout.write("{not-json");
			break;
		case "nonzero":
			process.stdout.write("api_key=sk-private-value");
			process.stderr.write("token=private-value");
			process.exitCode = 7;
			break;
		case "overflow":
			process.stdout.write("x".repeat(20_000));
			process.stderr.write("y".repeat(20_000));
			break;
		case "environment":
			respond({
				action: "modify",
				modified_args: {
					hasHome: Boolean(process.env.HOME),
					hasPrivate: Boolean(process.env.PRIVATE_TOKEN),
					hasPath: Boolean(process.env.PATH),
					hookId: process.env.MYCLI_HOOK_ID,
				},
			});
			break;
		case "cwd":
			respond({ action: "modify", modified_args: { cwdBase: basename(process.cwd()) } });
			break;
		case "marker":
			await writeFile(value, "spawned", "utf8");
			respond({ action: "allow" });
			break;
		case "hang-tree": {
			spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", value], {
				stdio: "ignore",
			});
			setInterval(() => undefined, 1_000);
			break;
		}
		default:
			respond({ action: "error", message: "unknown fixture mode" });
	}
}

function respond(payload) {
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}
