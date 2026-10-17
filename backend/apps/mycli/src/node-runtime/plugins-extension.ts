import type { ExtensionDefinition } from "@mycli/extensions";
import type { RuntimeIntegrationComposition } from "./integration-composition.ts";

export interface PluginsExtensionOptions {
	readonly composition: RuntimeIntegrationComposition;
}

/**
 * Compiled ESM plugins as an extension, for the part of them the session catalog holds: the tool
 * registrations a loaded plugin exposes.
 *
 * Plugin hooks, resources, diagnostics, and commands stay on the integration composition — they are
 * not catalog entries, and the registry has no slot for them yet.
 */
export function createPluginsExtension(options: PluginsExtensionOptions): ExtensionDefinition {
	const { composition } = options;
	return {
		id: "plugin",
		tools: {
			// Read on every call: plugins load, reload, and unload while the session runs.
			toolRegistrations: () => composition.registrations
				.filter((registration) => registration.source === "plugin"),
		},
	};
}
