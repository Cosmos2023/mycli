import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import type { ModelCatalogEntry } from "@mycli/config";
import { PROVIDER_IDS } from "@mycli/core";
import { openRuntimeSessionStore } from "@mycli/storage";
import {
	loadSessionPreferences,
	parseSessionPreferences,
	saveSessionPreferences,
} from "../src/node-runtime/session-preferences.ts";
import {
	SessionService,
	SessionServiceError,
} from "../src/node-runtime/session-service.ts";

test("parses stable and dynamic provider routes and rejects malformed identities", () => {
	for (const provider of PROVIDER_IDS.filter((candidate) => ![
		"openai", "codex", "compatible", "qwen", "deepseek", "anthropic",
	].includes(candidate))) {
		const preferences = parseSessionPreferences({
			state_version: 1,
			provider,
			protocol: "chat_completions",
			model: `${provider}-model`,
			api_base_url: `https://${provider}.example.test/v1`,
			auth_ref: provider,
			reasoning_effort: "none",
			collaboration_mode: "default",
		});
		assert.equal(preferences.provider, provider);
		assert.equal(preferences.protocol, "chat_completions");
	}
	const dynamic = parseSessionPreferences({
		state_version: 1,
		provider: "google",
		protocol: "chat_completions",
		model: "future-model",
		api_base_url: "https://example.test/v1",
		auth_ref: "google",
		reasoning_effort: "none",
		collaboration_mode: "default",
	});
	assert.equal(dynamic.provider, "google");

	for (const provider of ["Google", "google_cloud", "google--cloud", "google\ncloud"] as const) {
		assert.throws(() => parseSessionPreferences({
			state_version: 1,
			provider,
			protocol: "chat_completions",
			model: "future-model",
			api_base_url: "https://example.test/v1",
			auth_ref: "google",
			reasoning_effort: "none",
			collaboration_mode: "default",
		}));
	}
});

test("session service owns bounded list metadata mutations and redacted export", async (t) => {
	const fixture = await sessionFixture(t);
	const service = fixture.service;

	assert.deepEqual(service.list().map((item) => item.id), ["source-session"]);
	const named = service.rename("source-session", "Release notes");
	assert.equal(named.title, "Release notes");
	assert.equal(named.metadataRevision, 1);
	assert.equal(service.list({ search: "release" })[0]?.id, "source-session");

	const archived = service.archive("source-session");
	assert.equal(archived.lifecycleStatus, "archived");
	assert.deepEqual(service.list(), []);
	assert.equal(service.list({ includeArchived: true })[0]?.id, "source-session");
	const restored = service.archive("source-session", false);
	assert.equal(restored.lifecycleStatus, "active");

	const exported = service.export("source-session");
	assert.deepEqual(exported.messages.map((item) => item.type), [
		"user_message",
		"assistant_message",
	]);
	assert.equal(JSON.stringify(exported).includes("secret"), false);

	const deleted = service.delete("source-session");
	assert.equal(deleted.lifecycleStatus, "deleted");
	assert.deepEqual(service.list({ includeArchived: true }), []);
	assert.equal(service.list({ includeDeleted: true })[0]?.id, "source-session");
	assert.throws(
		() => service.rename("source-session", "No longer mutable"),
		(error: unknown) => error instanceof SessionServiceError
			&& error.code === "session_deleted",
	);
});

test("resume preview is provider-free and repairs changed settings through a fork", async (t) => {
	const fixture = await sessionFixture(t, { catalog: [currentModel()] });
	const sourceBefore = fixture.service.load("source-session");
	const preview = await fixture.service.previewResume("source-session");
	assert.equal(preview.ready, false);
	assert.deepEqual(preview.issues.map((item) => item.code), [
		"unsupported_model",
		"missing_credential",
	]);
	assert.deepEqual(preview.actions, ["fork_with_current_settings"]);

	const repaired = await fixture.service.applyResumeRepair({
		sessionId: "source-session",
		expectedMetadataRevision: preview.session.metadataRevision,
		action: "fork_with_current_settings",
	});
	assert.equal(repaired.forked, true);
	assert.equal(repaired.sessionId, "recovered-session");
	assert.equal(repaired.summary.model, "current-model");
	assert.equal(repaired.summary.permissionProfile, "workspace");
	assert.equal(repaired.summary.parentId, "source-session");
	assert.deepEqual(fixture.service.load("source-session"), sourceBefore);
	assert.equal(loadSessionPreferences(fixture.store, "source-session")?.model, "old-model");
	assert.equal(loadSessionPreferences(fixture.store, "recovered-session")?.model, "current-model");
});

test("resume repair requires the preview revision and reports pending interaction once", async (t) => {
	const fixture = await sessionFixture(t);
	const database = new Database(fixture.dbPath);
	try {
		database.prepare(`
			INSERT INTO session_state (session_id, state_key, payload_json, updated_at)
			VALUES (?, 'pending_decision', ?, ?)
		`).run(
			"source-session",
			JSON.stringify({ state_version: 1 }),
			"2026-08-30T00:00:00.000Z",
		);
	} finally {
		database.close();
	}
	const preview = await fixture.service.previewResume("source-session");
	assert.equal(preview.issues.filter((item) => item.code === "pending_interaction").length, 1);
	await assert.rejects(
		() => fixture.service.applyResumeRepair({
			sessionId: "source-session",
			expectedMetadataRevision: preview.session.metadataRevision + 1,
			action: "fork_with_current_settings",
		}),
		(error: unknown) => error instanceof SessionServiceError
			&& error.code === "session_changed",
	);
});

async function sessionFixture(
	t: TestContext,
	options: { readonly catalog?: readonly ModelCatalogEntry[] } = {},
): Promise<{
	readonly dbPath: string;
	readonly store: ReturnType<typeof openRuntimeSessionStore>;
	readonly service: SessionService;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-service-"));
	const dbPath = join(root, "sessions.db");
	const store = openRuntimeSessionStore({ dbPath, reconcileRuntimeState: false });
	t.after(() => store.close());
	t.after(() => rm(root, { recursive: true, force: true }));
	store.importLegacyConversation({
		sessionId: "source-session",
		workspaceRoot: root,
		threadId: "source-session",
		messages: [
			{ role: "user", content: "Inspect release status" },
			{ role: "assistant", content: "Release status is ready" },
		],
	});
	saveSessionPreferences(store, {
		sessionId: "source-session",
		workspaceRoot: root,
		threadId: "source-session",
		preferences: {
			provider: "openai",
			protocol: "responses",
			model: "old-model",
			apiBaseUrl: "https://old.example/v1",
			authRef: "old-auth",
			reasoningEffort: "high",
			collaborationMode: "plan",
			permissionProfile: "full-access",
		},
	});
	const service = new SessionService({
		store,
		currentConfig: () => ({
			workspaceRoot: root,
			provider: "openai",
			protocol: "responses",
			model: "current-model",
			apiBaseUrl: "https://current.example/v1",
			authRef: "current-auth",
			reasoningEffort: "medium",
			thinkingEnabled: true,
		}),
		currentPermissionProfile: () => "workspace",
		loadModelCatalog: async () => options.catalog ?? [],
		hasCredential: (preferences) => preferences.authRef === "current-auth",
		createSessionId: () => "recovered-session",
		clock: () => "2026-08-30T12:00:00.000Z",
	});
	return { dbPath, store, service };
}

function currentModel(): ModelCatalogEntry {
	return Object.freeze({
		provider: "openai",
		protocol: "responses",
		model: "current-model",
		displayName: "Current model",
		description: "Current test model",
		baseUrl: "https://current.example/v1",
		authRef: "current-auth",
		supportedReasoningEfforts: Object.freeze(["medium"] as const),
		defaultReasoningEffort: "medium",
		isDefault: true,
		isCurrent: true,
	});
}
