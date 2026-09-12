import { stableModelInputJson } from "@mycli/core";
import type { ApprovalPolicy, ExtensionToolApprovalPolicy } from "../policy/approval-policy.ts";
import type { DeferredToolCandidate, ToolAdapter } from "../types.ts";
import type { ToolRouter } from "./router.ts";
import type { ToolSearchTool } from "./tool-search-tool.ts";

export interface ExtensionCatalogTool extends DeferredToolCandidate {
	readonly adapter: ToolAdapter;
}

export interface ExtensionCatalogSnapshot {
	readonly version: number;
	readonly tools: readonly ExtensionCatalogTool[];
	readonly skillCatalog: string;
}

/** Publish routes, policy, discovery, and the run's source snapshot as one synchronous commit. */
export class ExtensionToolCatalog {
	readonly #router: ToolRouter;
	readonly #search: ToolSearchTool;
	readonly #policy: ApprovalPolicy;
	#snapshot: ExtensionCatalogSnapshot = Object.freeze({ version: 0, tools: Object.freeze([]), skillCatalog: "" });

	constructor(router: ToolRouter, search: ToolSearchTool, policy: ApprovalPolicy) {
		this.#router = router;
		this.#search = search;
		this.#policy = policy;
	}

	get snapshot(): ExtensionCatalogSnapshot { return this.#snapshot; }

	replace(input: ExtensionCatalogSnapshot, policies: readonly ExtensionToolApprovalPolicy[]): void {
		if (!Number.isSafeInteger(input.version) || input.version < this.#snapshot.version) throw new TypeError("invalid extension catalog version");
		const policyNames = new Set(policies.map((policy) => policy.name));
		for (const tool of input.tools) {
			if (!policyNames.has(tool.definition.name)
				|| stableModelInputJson(tool.definition) !== stableModelInputJson(tool.adapter.definition)) {
				throw new TypeError("inconsistent extension catalog registration");
			}
		}
		const snapshot = Object.freeze({ ...input, tools: Object.freeze([...input.tools]) });
		const installRoutes = this.#router.prepareDynamicAdapters(snapshot.tools.map((tool) => tool.adapter));
		const installPolicy = this.#policy.prepareExtensionTools(policies);
		const installSearch = this.#search.prepareCandidates(snapshot.tools);
		installRoutes();
		installPolicy();
		installSearch();
		this.#snapshot = snapshot;
	}
}
