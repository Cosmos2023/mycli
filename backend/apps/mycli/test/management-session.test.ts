import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRuntimeSessionStore } from "@mycli/storage";
import { renderManagementResponse } from "../src/management/render.ts";
import { SessionManagementService } from "../src/management/session.ts";
import type { SessionManagementCommand } from "../src/management/types.ts";
import { saveSessionPreferences } from "../src/node-runtime/session-preferences.ts";
import { SessionService } from "../src/node-runtime/session-service.ts";

test("session management shares list visibility, deterministic rendering, and safe mutations", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-session-management-"));
	const store = openRuntimeSessionStore({
		dbPath: join(root, "sessions.db"),
		reconcileRuntimeState: false,
	});
	t.after(() => store.close());
	t.after(() => rm(root, { recursive: true, force: true }));
	store.importLegacyConversation({
		sessionId: "session-a",
		workspaceRoot: root,
		threadId: "session-a",
		messages: [
			{ role: "user", content: "Inspect release status" },
			{ role: "assistant", content: "Release status is ready" },
		],
	});
	saveSessionPreferences(store, {
		sessionId: "session-a",
		workspaceRoot: root,
		threadId: "session-a",
		preferences: {
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
			apiBaseUrl: "https://example.invalid/v1",
			authRef: "private-account",
			reasoningEffort: "high",
			collaborationMode: "plan",
			permissionProfile: "full-access",
		},
	});
	const sessions = new SessionService({
		store,
		currentConfig: () => ({
			workspaceRoot: root,
			provider: "openai",
			protocol: "responses",
			model: "gpt-test",
			apiBaseUrl: "https://example.invalid/v1",
			authRef: "private-account",
			reasoningEffort: "high",
			thinkingEnabled: true,
		}),
		currentPermissionProfile: () => "workspace",
		loadModelCatalog: async () => [],
		hasCredential: () => true,
	});
	const service = new SessionManagementService(sessions);
	const list: SessionManagementCommand = {
		kind: "session",
		action: "list",
		json: false,
		all: false,
		last: false,
		workspaceRoot: root,
		model: "gpt-test",
		collaborationMode: "plan",
		permissionProfile: "full-access",
		status: "active",
		limit: 20,
	};
	const listed = service.execute(list);
	assert.equal(listed.ok, true);
	assert.deepEqual(listed.sessions?.map((session) => session.id), ["session-a"]);
	assert.equal(
		renderManagementResponse(list, listed),
		`mycli session list\nsession id=session-a cwd=${JSON.stringify(root)}`
		+ " last_active=" + listed.sessions![0]!.lastActiveAt
		+ " model=gpt-test effort=high mode=plan permission=full-access"
		+ " status=active lock=unlocked\n",
	);
	const jsonList = { ...list, json: true } as const;
	assert.deepEqual(
		JSON.parse(renderManagementResponse(jsonList, service.execute(jsonList))),
		service.execute(jsonList),
	);

	const archive = service.execute({
		kind: "session",
		action: "archive",
		sessionId: "session-a",
		json: false,
	});
	assert.equal(archive.session?.lifecycleStatus, "archived");
	assert.deepEqual(service.execute(list).sessions, []);
	assert.deepEqual(
		service.execute({ ...list, all: true, status: undefined }).sessions?.map((session) => session.id),
		["session-a"],
	);

	const protectedDelete: SessionManagementCommand = {
		kind: "session",
		action: "delete",
		sessionId: "session-a",
		force: false,
		json: false,
	};
	const rejected = service.execute(protectedDelete);
	assert.equal(rejected.ok, false);
	assert.deepEqual(rejected.issues, ["confirmation_required"]);
	assert.equal(sessions.load("session-a").lifecycleStatus, "archived");

	service.execute({
		kind: "session",
		action: "unarchive",
		sessionId: "session-a",
		json: false,
	});
	const exported = service.execute({
		kind: "session",
		action: "export",
		sessionId: "session-a",
		json: true,
	});
	assert.deepEqual(exported.exportedSession?.messages.map((message) => message.text), [
		"Inspect release status",
		"Release status is ready",
	]);
	assert.equal(JSON.stringify(exported).includes("private-account"), false);

	const deleted = service.execute({ ...protectedDelete, force: true });
	assert.equal(deleted.session?.lifecycleStatus, "deleted");
	assert.deepEqual(service.execute(list).sessions, []);
});
