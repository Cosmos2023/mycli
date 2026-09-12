import { modelInputSha256 } from "@mycli/core";
import type { McpServerConfig } from "./types.ts";

/** Hash transport credentials and policy without persisting their raw values in authorization. */
export function mcpConfigFingerprint(configs: readonly McpServerConfig[]): string {
	return modelInputSha256([...configs].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
