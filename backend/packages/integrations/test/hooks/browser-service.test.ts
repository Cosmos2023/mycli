import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookBrowserService, configuredHookEnablement } from "../../src/hooks/browser-service.ts";
import { HookAllowlistStore } from "../../src/hooks/allowlist.ts";
import { IntegrationEnablementStore } from "../../src/foundation/enablement-store.ts";
import type { ConfiguredHookSpec } from "../../src/hooks/types.ts";

test("hook browser separates enablement and exact-command trust and rejects stale previews", async (t) => {
	const homeDir = await mkdtemp(join(tmpdir(), "mycli-hook-browser-"));
	t.after(() => rm(homeDir, { recursive: true, force: true }));
	let spec: ConfiguredHookSpec = { hookId: "check", name: "user:check:stop", scope: "user", configPath: join(homeDir, "hooks.json"),
		hookPoint: "stop", command: ["node", "check.mjs"], enabled: false, timeoutMs: 2000, workingDirectory: "workspace", envPolicy: "minimal", matcher: { kind: "any" } };
	const service = new HookBrowserService({ homeDir, configured: async () => [spec], plugins: () => [] });
	const first = await service.list(); const hook = first.hooks[0]!;
	assert.deepEqual(hook.command, spec.command); assert.equal(hook.trusted, false);
	const enabled = await service.write({ id: hook.id, hookRevision: hook.revision, revision: first.revision, action: "enable" }, new AbortController().signal);
	assert.equal(enabled.hooks[0]?.enabled, true); assert.equal(enabled.hooks[0]?.trusted, false);
	assert.equal(configuredHookEnablement(spec, await new IntegrationEnablementStore({ homeDir }).load()).enabled, true);
	const approved = await service.write({ id: hook.id, hookRevision: hook.revision, revision: enabled.revision, action: "trust" }, new AbortController().signal);
	assert.equal(approved.hooks[0]?.trusted, true);
	spec = { ...spec, command: ["node", "different.mjs"] };
	await assert.rejects(service.write({ id: hook.id, hookRevision: approved.hooks[0]!.revision, revision: approved.revision, action: "trust" }, new AbortController().signal), /changed/);
	assert.equal((await new HookAllowlistStore({ homeDir }).statusFor(spec)).allowed, false);
	const latest = await service.list(); const aborted = new AbortController(); aborted.abort();
	await assert.rejects(service.write({ id: hook.id, hookRevision: latest.hooks[0]!.revision, revision: latest.revision, action: "trust" }, aborted.signal));
	assert.equal((await new HookAllowlistStore({ homeDir }).statusFor(spec)).allowed, false);
});
