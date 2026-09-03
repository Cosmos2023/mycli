import assert from "node:assert/strict";
import test from "node:test";
import {
	PROVIDER_IDS,
	PROVIDER_ROUTE_ID_MAX_CHARS,
	isProviderId,
	isProviderRouteId,
	parseProviderRouteId,
	type ProviderRouteId,
} from "../src/index.ts";

test("accepts stable provider ids as provider routes without weakening the stable guard", () => {
	for (const provider of PROVIDER_IDS) {
		const route: ProviderRouteId = provider;
		assert.equal(parseProviderRouteId(route), provider);
		assert.equal(isProviderRouteId(route), true);
		assert.equal(isProviderId(route), true);
	}

	const experimental = parseProviderRouteId("cloudflare-ai-gateway");
	assert.equal(experimental, "cloudflare-ai-gateway");
	assert.equal(isProviderRouteId(experimental), true);
	assert.equal(isProviderId(experimental), false);
});

test("rejects malformed provider route ids at the shared boundary", () => {
	const invalid = [
		undefined,
		null,
		0,
		"",
		" openai",
		"openai ",
		"OpenAI",
		"1provider",
		"provider_name",
		"provider.name",
		"provider--name",
		"provider-",
		"provider\nname",
		"provider\0name",
		`p${"a".repeat(PROVIDER_ROUTE_ID_MAX_CHARS)}`,
	] as const;

	for (const value of invalid) {
		assert.equal(isProviderRouteId(value), false);
		assert.throws(() => parseProviderRouteId(value), TypeError);
	}
});

test("accepts the maximum bounded provider route id", () => {
	const route = `p${"a".repeat(PROVIDER_ROUTE_ID_MAX_CHARS - 1)}`;
	assert.equal(parseProviderRouteId(route), route);
});
