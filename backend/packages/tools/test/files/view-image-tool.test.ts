import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { executionPolicy, ToolRouter, ViewImageTool, type ToolExecutionOptions } from "../../src/index.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==";
const OPTIONS: ToolExecutionOptions = {
	signal: new AbortController().signal, ownerSessionId: "session", callId: "image", publishLifecycle: () => undefined,
};

test("text-only models reject view_image before inspecting arguments or filesystem", async () => {
	const tool = new ViewImageTool({ workspaceRoot: "/missing-workspace", homeDir: "/missing-home" });
	const result = await tool.execute({ get path() { throw new Error("must reject before reading the path"); } }, {
		...OPTIONS, imageInputSupported: false, imageDetailOriginalSupported: true, errorContextVersion: 1,
	});
	assert.equal(result.errorContext?.reason, "capability.image_input_unsupported");
	assert.deepEqual(result.errorContext?.outcome, { state: "not_started", effects: "none" });
	assert.equal(result.images, undefined);
});

test("view_image returns pixels through the router without binary display metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-image-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "image.png"), Buffer.from(PNG, "base64"));
	const adapter = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	const router = new ToolRouter({ adapters: [adapter], exposure: [adapter.definition] });
	for (const path of ["image.png", "~/image.png", join(root, "image.png")]) {
		const result = await router.execute({ callId: "image", name: "view_image", argumentsJson: JSON.stringify({ path }) }, OPTIONS);
		assert.equal(result.success, true);
		assert.deepEqual(result.images, [{ mediaType: "image/png", data: PNG, detail: "high" }]);
		assert.equal(JSON.stringify(result.metadata).includes(PNG), false);
		assert.equal(result.modelOutput.includes(PNG), false);
	}
});

test("view_image enforces symlink boundaries and honors explicit readable roots", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const outside = join(root, "private.png");
	await writeFile(outside, Buffer.from(PNG, "base64"));
	await symlink(outside, join(workspace, "link.png"));
	const tool = new ViewImageTool({ workspaceRoot: workspace, homeDir: root });
	for (const path of [outside, "../private.png", "link.png"]) {
		const result = await tool.execute({ path }, OPTIONS);
		assert.equal(result.errorKind, "workspace_escape");
		assert.equal(result.images, undefined);
		assert.equal(JSON.stringify(result).includes("private.png"), false);
	}
	const policy = { ...executionPolicy("read-only", workspace), readableRoots: [await realpath(root)] };
	const result = await tool.execute({ path: outside }, { ...OPTIONS, executionPolicy: policy });
	assert.equal(result.success, true);
	assert.deepEqual(result.images, [{ mediaType: "image/png", data: PNG, detail: "high" }]);
});

test("view_image decodes actual content, resizes proportionally, and preserves original pixels", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-resize-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const data = await sharp({ create: { width: 3_000, height: 1_500, channels: 3, background: "red" } }).png().toBuffer();
	await writeFile(join(root, "without-extension"), data);
	await writeFile(join(root, "mislabelled.jpg"), data);
	const tool = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	for (const detail of [undefined, "high", "original"] as const) {
		const result = await tool.execute({ path: "without-extension", ...(detail ? { detail } : {}) }, OPTIONS);
		assert.equal(result.success, true, result.modelOutput);
		assert.equal(result.images?.[0]?.mediaType, "image/png");
		const decoded = await sharp(Buffer.from(result.images![0]!.data, "base64")).metadata();
		assert.equal(decoded.width, detail === "original" ? 3_000 : 2_048);
		assert.equal(decoded.height, detail === "original" ? 1_500 : 1_024);
		if (detail === "original") assert.equal(result.images![0]!.data, data.toString("base64"));
	}
	assert.equal((await tool.execute({ path: "mislabelled.jpg" }, OPTIONS)).images?.[0]?.mediaType, "image/png");
	const fallback = await tool.execute({ path: "without-extension", detail: "original" },
		{ ...OPTIONS, imageDetailOriginalSupported: false });
	assert.equal(fallback.images?.[0]?.detail, "high");
	assert.equal((await sharp(Buffer.from(fallback.images![0]!.data, "base64")).metadata()).width, 2_048);
});

test("view_image rejects corrupt images, SVG, and invalid detail without image output", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-decode-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "fake.png"), "this is not an image");
	await writeFile(join(root, "truncated.png"), Buffer.from(PNG, "base64").subarray(0, 60));
	await writeFile(join(root, "vector.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
	const tool = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	for (const path of ["fake.png", "truncated.png", "vector.svg"]) {
		const result = await tool.execute({ path }, OPTIONS);
		assert.equal(result.errorKind, "invalid_image");
		assert.equal(result.images, undefined);
	}
	for (const detail of ["low", "auto", "", null, 1]) {
		assert.equal((await tool.execute({ path: "missing.png", detail }, OPTIONS)).errorKind, "invalid_arguments");
	}
});

test("view_image preserves PNG JPEG WebP bytes and converts decoded GIF pixels to PNG", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-formats-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tool = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	for (const format of ["png", "jpeg", "webp", "gif"] as const) {
		const data = await sharp({ create: { width: 10, height: 5, channels: 3, background: "red" } }).toFormat(format).toBuffer();
		await writeFile(join(root, format), data);
		const result = await tool.execute({ path: format, detail: "original" }, OPTIONS);
		assert.equal(result.success, true, result.modelOutput);
		const image = result.images![0]!;
		assert.equal(image.mediaType, format === "gif" ? "image/png" : `image/${format}`);
		const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
		assert.equal(metadata.width, 10);
		assert.equal(metadata.height, 5);
		if (format !== "gif") assert.equal(image.data, data.toString("base64"));
	}
});

test("view_image bounds failures and stops cancelled reads", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-view-failures-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "private.txt"), "text");
	await writeFile(join(root, "private-large.png"), Buffer.alloc(10_000_001));
	const tool = new ViewImageTool({ workspaceRoot: root, homeDir: root });
	for (const path of ["private.txt", "private-missing.png", "private-large.png", "~other/image.png", "\0"]) {
		const result = await tool.execute({ path }, OPTIONS);
		assert.equal(result.success, false);
		assert.equal(result.images, undefined);
		assert.equal(JSON.stringify(result).includes("private"), false);
	}
	await assert.rejects(tool.execute({ path: "private.txt" }, { ...OPTIONS, signal: AbortSignal.abort() }), { name: "AbortError" });
});
