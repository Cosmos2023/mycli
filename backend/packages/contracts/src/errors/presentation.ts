import type { ErrorContext } from "./error-context.ts";
import { errorDefinition } from "./catalog.ts";

export function errorSummary(context: ErrorContext): string {
	const summary = errorDefinition(context.reason).summary;
	if (context.reason === "runtime.retry_exhausted" && context.causes?.length) {
		return `${summary.slice(0, -1)}: ${errorDefinition(context.causes[0]!.reason).summary}`;
	}
	return summary;
}

export function errorPublicDetails(context: ErrorContext): string | undefined {
	const details = context.details;
	const parts: string[] = [];
	if (details && "model" in details && details.model) parts.push(`Model: ${details.model}.`);
	if (context.reason === "capability.image_input_unsupported" && details && "input_origin" in details) {
		parts.push(context.scope.kind === "tool_call" && context.outcome.state === "not_started"
			? "This tool requires image-input support."
			: details.input_origin === "tool" ? "This conversation contains a tool image."
			: details.input_origin === "history" ? "This conversation contains an image."
				: "The submitted input contains an image.");
	}
	if (details && "exit_code" in details && details.exit_code !== undefined) parts.push(`Exit code: ${details.exit_code}.`);
	if (details && "http_status" in details && details.http_status !== undefined) parts.push(`HTTP ${details.http_status}.`);
	if (context.outcome.state === "unknown") parts.push("The operation's outcome has not been confirmed.");
	else if (context.scope.kind === "tool_call" && context.outcome.state === "not_started") parts.push("The operation did not start.");
	if (context.reason !== "runtime.retry_exhausted" && context.causes?.length) {
		parts.push(`Cause: ${errorDefinition(context.causes[0]!.reason).summary}`);
	}
	return parts.length ? parts.join(" ") : undefined;
}
