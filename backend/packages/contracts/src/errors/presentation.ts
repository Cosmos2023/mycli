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
	if (context.reason === "provider.output_limit" && details && "max_output_tokens" in details
		&& details.max_output_tokens !== undefined) parts.push(`Output limit: ${details.max_output_tokens} tokens.`);
	if (context.reason === "runtime.compaction_summary_too_long" && details && "summary_tokens" in details
		&& details.summary_tokens !== undefined && details.summary_max_tokens !== undefined) {
		parts.push(`Summary length: ${details.summary_tokens} estimated tokens; limit: ${details.summary_max_tokens}.`);
	}
	if (context.source === "integration" && details) {
		if ("integration" in details && details.integration) parts.push(`Integration: ${details.integration}.`);
		if ("operation" in details && details.operation) parts.push(`Operation: ${details.operation}.`);
		if ("phase" in details && details.phase) parts.push(`Phase: ${details.phase}.`);
		if ("rpc_code" in details && details.rpc_code !== undefined) parts.push(`RPC ${details.rpc_code}.`);
		if ("transport_code" in details && details.transport_code) parts.push(`Transport: ${details.transport_code}.`);
		if ("legacy_kind" in details && details.legacy_kind) parts.push(`Failure: ${details.legacy_kind}.`);
		if ("timeout_ms" in details && details.timeout_ms !== undefined) parts.push(`Timeout: ${details.timeout_ms} ms.`);
		if ("signal" in details && details.signal) parts.push(`Signal: ${details.signal}.`);
	}
	if (context.outcome.state === "unknown") parts.push("The operation's outcome has not been confirmed.");
	else if (context.scope.kind === "tool_call" && context.outcome.state === "not_started") parts.push("The operation did not start.");
	if (context.reason !== "runtime.retry_exhausted" && context.causes?.length) {
		parts.push(`Cause: ${errorDefinition(context.causes[0]!.reason).summary}`);
	}
	return parts.length ? parts.join(" ") : undefined;
}
