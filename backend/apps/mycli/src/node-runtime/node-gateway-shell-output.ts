import { parseGatewayEvent, type GatewayEventNotification } from "@mycli/contracts";
import type { GatewayWriteCoalescing } from "@mycli/gateway/flow-control";

export const GATEWAY_SHELL_OUTPUT_MAX_CHARS = 10_000;

type ShellOutputParams = Extract<GatewayEventNotification, { method: "shell.output" }>["params"];

export function shellOutputCoalescing(notification: GatewayEventNotification): GatewayWriteCoalescing | undefined {
	const output = shellOutputParams(notification);
	if (!output) return undefined;
	const ownership = notification.method === "runtime.event" ? notification.params : output;
	return {
		key: JSON.stringify([
			notification.method, ownership.session_id, ownership.generation, ownership.turn_id,
			output.shell_id, output.call_id,
		]),
		merge: mergeShellOutputFrames,
	};
}

function shellOutputParams(notification: GatewayEventNotification): ShellOutputParams | undefined {
	if (notification.method === "shell.output") return notification.params;
	if (notification.method === "runtime.event" && notification.params.type === "shell.output") {
		return notification.params.payload as ShellOutputParams;
	}
	return undefined;
}

function mergeShellOutputFrames(previousFrame: string, nextFrame: string): string {
	const previous = shellOutputParams(parseGatewayEvent(JSON.parse(previousFrame) as unknown))!;
	const notification = parseGatewayEvent(JSON.parse(nextFrame) as unknown);
	const next = shellOutputParams(notification)!;
	const previousText = previous.output_delta ?? "";
	const nextText = next.output_delta ?? "";
	const nextStart = next.next_cursor === undefined ? undefined : next.next_cursor - nextText.length;
	const gap = previous.next_cursor === undefined || nextStart === undefined
		? 0 : Math.max(0, nextStart - previous.next_cursor);
	const overlap = previous.next_cursor === undefined || nextStart === undefined
		? 0 : Math.max(0, Math.min(nextText.length, previous.next_cursor - nextStart));
	const combined = gap > 0 ? nextText : previousText + nextText.slice(overlap);
	let output = combined.slice(-GATEWAY_SHELL_OUTPUT_MAX_CHARS);
	// A bounded suffix must not start halfway through a UTF-16 surrogate pair.
	if (output.length < combined.length && /^[\uDC00-\uDFFF]/u.test(output)) output = output.slice(1);
	const discarded = combined.length - output.length + (gap > 0 ? previousText.length + gap : 0);
	const params: ShellOutputParams = {
		...next,
		output_delta: output,
		omitted_output_chars: Math.max(
			next.omitted_output_chars ?? 0,
			(previous.omitted_output_chars ?? 0) + discarded,
		),
	};
	const merged = notification.method === "runtime.event"
		? { ...notification, params: { ...notification.params, payload: params } }
		: { ...notification, params };
	return `${JSON.stringify(merged)}\n`;
}
