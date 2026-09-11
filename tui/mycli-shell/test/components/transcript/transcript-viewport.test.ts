import assert from "node:assert/strict";
import test from "node:test";
import { BashExecutionComponent } from "../../../src/components/transcript/bash-execution.ts";
import {
	CollapsedToolGroupComponent,
} from "../../../src/components/transcript/collapsed-tool-group.ts";
import {
	TranscriptViewportComponent,
} from "../../../src/components/transcript/transcript-viewport.ts";
import { Container, type Component } from "../../../src/tui-core/tui.ts";

class CountingComponent extends Container {
	renderCalls = 0;
	cacheKeyReads = 0;

	constructor(private line: string) {
		super();
	}

	setLine(line: string): void {
		this.line = line;
		this.invalidate();
	}

	override render(): string[] {
		this.renderCalls += 1;
		return [this.line];
	}

	override getRenderCacheKey(): number | undefined {
		this.cacheKeyReads += 1;
		return super.getRenderCacheKey();
	}
}

class VolatileComponent implements Component {
	renderCalls = 0;

	invalidate(): void {}

	render(): string[] {
		this.renderCalls += 1;
		return [`frame ${this.renderCalls}`];
	}
}

class TailComponent implements Component {
	renderCalls = 0;
	tailRenderCalls = 0;

	invalidate(): void {}

	render(): string[] {
		this.renderCalls += 1;
		return Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
	}

	renderTail(_width: number, maxRows: number) {
		this.tailRenderCalls += 1;
		return {
			lines: Array.from({ length: maxRows }, (_, index) => `line ${10_000 - maxRows + index}`),
			totalLines: 10_000,
		};
	}
}

class MutableLinesComponent extends Container {
	renderCalls = 0;
	cacheKeyReads = 0;

	constructor(private lines: string[]) {
		super();
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		this.invalidate();
	}

	override render(): string[] {
		this.renderCalls += 1;
		return this.lines;
	}

	override getRenderCacheKey(): number | undefined {
		this.cacheKeyReads += 1;
		return super.getRenderCacheKey();
	}
}

function viewportFor(
	components: Component[],
	maxRows: number,
	contentRevision?: () => unknown,
): TranscriptViewportComponent {
	return viewportHarness(components, maxRows, contentRevision).viewport;
}

function viewportHarness(
	components: Component[],
	maxRows: number,
	contentRevision?: () => unknown,
	height = 10,
): { viewport: TranscriptViewportComponent; transcript: Container } {
	const content = new Container();
	const header = new Container();
	const transcript = new Container();
	for (const component of components) transcript.addChild(component);
	content.addChild(header);
	content.addChild(transcript);
	return {
		viewport: new TranscriptViewportComponent(content, () => height, maxRows, contentRevision),
		transcript,
	};
}

test("transcript viewport renders only the bounded tail", () => {
	const components = Array.from({ length: 10_000 }, (_, index) => new CountingComponent(`line ${index}`));
	const viewport = viewportFor(components, 20);

	const lines = viewport.render(80);

	assert.equal(lines.at(-1), "line 9999");
	assert.equal(components.slice(0, -20).some((component) => component.renderCalls > 0), false);
	assert.equal(components.slice(-20).every((component) => component.renderCalls === 1), true);
});

test("transcript viewport reuses stable tail chunks and rerenders invalidated content", () => {
	const components = Array.from({ length: 100 }, (_, index) => new CountingComponent(`line ${index}`));
	const viewport = viewportFor(components, 20);
	viewport.render(80);

	viewport.render(80);
	assert.equal(components.slice(-20).every((component) => component.renderCalls === 1), true);

	const active = components.at(-1)!;
	active.setLine("updated tail");
	const lines = viewport.render(80);
	assert.equal(lines.at(-1), "updated tail");
	assert.equal(active.renderCalls, 2);
	assert.equal(components.slice(-20, -1).every((component) => component.renderCalls === 1), true);

	viewport.render(60);
	assert.equal(components.slice(-20, -1).every((component) => component.renderCalls === 2), true);
	assert.equal(active.renderCalls, 3);
});

test("transcript viewport bounds a native scrollback prefix before a held component", () => {
	const components = Array.from({ length: 10 }, (_, index) => new CountingComponent(`line ${index}`));
	const { viewport, transcript } = viewportHarness(components, 5, undefined, 2);

	assert.deepEqual(
		viewport.scrollbackPrefixBefore(transcript, 8, 80),
		["line 5", "line 6", "line 7"],
	);
	assert.equal(components.slice(0, 5).every((component) => component.renderCalls === 0), true);
	assert.equal(components.slice(5).every((component) => component.renderCalls === 1), true);

	const shortComponents = Array.from({ length: 6 }, (_, index) => new CountingComponent(`short ${index}`));
	const short = viewportHarness(shortComponents, 6, undefined, 3);
	assert.deepEqual(
		short.viewport.scrollbackPrefixBefore(short.transcript, 5, 80),
		["short 0", "short 1", "short 2"],
	);
});

test("transcript viewport retains bounded content for an unchanged owner revision", () => {
	const components = Array.from({ length: 10_000 }, (_, index) => new CountingComponent(`line ${index}`));
	let revision = 1;
	const viewport = viewportFor(components, 10_000, () => revision);

	viewport.render(80);
	const cacheKeyReads = components.reduce((total, component) => total + component.cacheKeyReads, 0);
	viewport.render(80);

	assert.equal(components.reduce((total, component) => total + component.cacheKeyReads, 0), cacheKeyReads);
	revision += 1;
	viewport.render(80);
	assert.equal(components.every((component) => component.cacheKeyReads === 2), true);

	viewport.render(60);
	assert.equal(components.every((component) => component.cacheKeyReads === 3), true);

	viewport.invalidate();
	viewport.render(60);
	assert.equal(components.every((component) => component.cacheKeyReads === 4), true);
});

test("transcript viewport reconciles a validated component tail without reading the stable prefix", () => {
	const components = Array.from({ length: 10_000 }, (_, index) => new CountingComponent(`line ${index}`));
	let revision = 1;
	const { viewport, transcript } = viewportHarness(components, 10_000, () => revision);
	viewport.render(80);

	components.at(-1)!.setLine("updated tail");
	revision += 1;
	viewport.markSectionTailChanged(transcript, components.length - 1);
	const lines = viewport.render(80);

	assert.equal(lines.at(-1), "updated tail");
	assert.equal(components.slice(0, -1).every((component) => component.cacheKeyReads === 1), true);
	assert.equal(components.at(-1)!.cacheKeyReads, 2);
});

test("transcript viewport merges coalesced tail hints to the earliest stable prefix", () => {
	const components = Array.from({ length: 100 }, (_, index) => new CountingComponent(`line ${index}`));
	let revision = 1;
	const { viewport, transcript } = viewportHarness(components, 100, () => revision);
	viewport.render(80);

	components[98]!.setLine("updated 98");
	viewport.markSectionTailChanged(transcript, 98);
	components[99]!.setLine("updated 99");
	viewport.markSectionTailChanged(transcript, 99);
	revision += 1;
	const lines = viewport.render(80);

	assert.equal(lines.includes("updated 98"), true);
	assert.equal(lines.includes("updated 99"), true);
	assert.equal(components.slice(0, 98).every((component) => component.cacheKeyReads === 1), true);
	assert.equal(components.slice(98).every((component) => component.cacheKeyReads === 2), true);
});

test("transcript viewport falls back when a shrinking tail exposes older bounded rows", () => {
	const stable = Array.from({ length: 9 }, (_, index) => new CountingComponent(`line ${index}`));
	const tail = new MutableLinesComponent(["tail 1", "tail 2", "tail 3", "tail 4"]);
	let revision = 1;
	const { viewport, transcript } = viewportHarness([...stable, tail], 5, () => revision);

	assert.deepEqual(viewport.render(80).slice(0, 5), ["line 8", "tail 1", "tail 2", "tail 3", "tail 4"]);
	tail.setLines(["tail final"]);
	revision += 1;
	viewport.markSectionTailChanged(transcript, stable.length);

	assert.deepEqual(viewport.render(80).slice(0, 5), ["line 5", "line 6", "line 7", "line 8", "tail final"]);
});

test("transcript viewport rolls a full bounded window without reading stable component keys", () => {
	const stable = Array.from({ length: 9_999 }, (_, index) => new CountingComponent(`line ${index}`));
	const tail = new MutableLinesComponent(["tail 1"]);
	let revision = 1;
	const { viewport, transcript } = viewportHarness([...stable, tail], 10_000, () => revision, 10_000);
	viewport.render(80);

	tail.setLines(["tail 1", "tail 2"]);
	revision += 1;
	viewport.markSectionTailChanged(transcript, stable.length);
	const lines = viewport.render(80);

	assert.equal(lines.length, 10_000);
	assert.equal(lines[0], "line 1");
	assert.deepEqual(lines.slice(-2), ["tail 1", "tail 2"]);
	assert.equal(stable.every((component) => component.cacheKeyReads === 1), true);
	assert.equal(tail.cacheKeyReads, 2);
});

test("rolled bounded rows remain available to native scrollback collection", () => {
	const stable = Array.from({ length: 4 }, (_, index) => new CountingComponent(`line ${index}`));
	const tail = new MutableLinesComponent(["tail 1"]);
	let revision = 1;
	const { viewport, transcript } = viewportHarness([...stable, tail], 5, () => revision, 2);
	assert.deepEqual(viewport.scrollbackPrefix(80), ["line 0", "line 1", "line 2"]);

	tail.setLines(["tail 1", "tail 2"]);
	revision += 1;
	viewport.markSectionTailChanged(transcript, stable.length);

	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), ["line 3"]);
	assert.equal(stable.every((component) => component.cacheKeyReads === 1), true);
});

test("logical row origins disambiguate repeated native scrollback lines", () => {
	const components = Array.from({ length: 5 }, () => new CountingComponent("same"));
	let revision = 1;
	const { viewport, transcript } = viewportHarness(components, 5, () => revision, 2);
	assert.deepEqual(viewport.scrollbackPrefix(80), ["same", "same", "same"]);

	const prefixLength = transcript.children.length;
	transcript.addChild(new CountingComponent("same"));
	revision += 1;
	viewport.markSectionTailChanged(transcript, prefixLength);

	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), ["same"]);
});

test("native viewport expansion does not redraw or recommit owned history rows", () => {
	const content = new Container();
	const transcript = new Container();
	content.addChild(transcript);
	const original = Array.from({ length: 8 }, (_, index) => `line ${index}`);
	for (const line of original) transcript.addChild(new CountingComponent(line));
	let height = 4;
	let revision = 0;
	const viewport = new TranscriptViewportComponent(content, () => height, 8, () => revision);
	const history = viewport.scrollbackPrefix(80);
	height = 2;
	history.push(...viewport.takeNewScrollbackLines(80, true));
	height = 4;

	assert.deepEqual([...history, ...viewport.render(80).filter(Boolean)], original);
	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), []);
	height = 2;
	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), []);
	height = 4;
	for (let index = 8; index < 12; index += 1) {
		const prefixLength = transcript.children.length;
		transcript.addChild(new CountingComponent(`line ${index}`));
		revision += 1;
		viewport.markSectionTailChanged(transcript, prefixLength);
		history.push(...viewport.takeNewScrollbackLines(80, true));
		assert.deepEqual(
			[...history, ...viewport.render(80).filter(Boolean)],
			Array.from({ length: index + 1 }, (_, line) => `line ${line}`),
		);
	}
});

test("native viewport preserves equal-text rows when its height grows", () => {
	const content = new Container();
	const transcript = new Container();
	content.addChild(transcript);
	for (let index = 0; index < 8; index += 1) transcript.addChild(new CountingComponent("same"));
	let height = 2;
	const viewport = new TranscriptViewportComponent(content, () => height, 8, () => 0);
	const history = viewport.scrollbackPrefix(80);
	height = 4;
	assert.equal([...history, ...viewport.render(80).filter(Boolean)].length, 8);
	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), []);
});

test("native history anchors survive a full rebuild of a rolled bounded window", () => {
	const content = new Container();
	const transcript = new Container();
	content.addChild(transcript);
	for (let index = 0; index < 8; index += 1) transcript.addChild(new CountingComponent(`line ${index}`));
	let height = 4;
	let revision = 0;
	const viewport = new TranscriptViewportComponent(content, () => height, 8, () => revision);
	const history = viewport.scrollbackPrefix(80);
	transcript.addChild(new CountingComponent("line 8"));
	revision += 1;
	viewport.markSectionTailChanged(transcript, 8);
	history.push(...viewport.takeNewScrollbackLines(80, true));
	viewport.render(80);
	height = 8;
	revision += 1;
	viewport.markContentChanged();
	assert.deepEqual(
		[...history, ...viewport.render(80).filter(Boolean)],
		Array.from({ length: 9 }, (_, index) => `line ${index}`),
	);
	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), []);
});

test("rendered bounded rolls retain displaced rows until native scrollback collects them", () => {
	const components = Array.from({ length: 5 }, (_, index) => new CountingComponent(`line ${index}`));
	let revision = 1;
	const { viewport, transcript } = viewportHarness(components, 5, () => revision, 2);
	assert.deepEqual(viewport.scrollbackPrefix(80), ["line 0", "line 1", "line 2"]);

	for (let index = 5; index <= 8; index += 1) {
		const prefixLength = transcript.children.length;
		transcript.addChild(new CountingComponent(`line ${index}`));
		revision += 1;
		viewport.markSectionTailChanged(transcript, prefixLength);
		viewport.render(80);
	}

	assert.deepEqual(
		viewport.takeNewScrollbackLines(80),
		["line 3", "line 4", "line 5", "line 6"],
	);
});

test("full-height component tails keep repeated native scrollback rows distinct", () => {
	const tail = new MutableLinesComponent(Array.from({ length: 5 }, () => "same"));
	let revision = 1;
	const { viewport, transcript } = viewportHarness([tail], 5, () => revision, 2);
	assert.deepEqual(viewport.scrollbackPrefix(80), ["same", "same", "same"]);

	tail.setLines(Array.from({ length: 6 }, () => "same"));
	revision += 1;
	viewport.markSectionTailChanged(transcript, 0);

	assert.deepEqual(viewport.takeNewScrollbackLines(80, true), ["same"]);
});

test("full-height component tails retain delayed native scrollback rows", () => {
	const tail = new MutableLinesComponent(
		Array.from({ length: 5 }, (_, index) => `line ${index}`),
	);
	let revision = 1;
	const { viewport, transcript } = viewportHarness([tail], 5, () => revision, 2);
	assert.deepEqual(viewport.scrollbackPrefix(80), ["line 0", "line 1", "line 2"]);

	for (let lineCount = 6; lineCount <= 9; lineCount += 1) {
		tail.setLines(Array.from({ length: lineCount }, (_, index) => `line ${index}`));
		revision += 1;
		viewport.markSectionTailChanged(transcript, 0);
		viewport.render(80);
	}

	assert.deepEqual(
		viewport.takeNewScrollbackLines(80),
		["line 3", "line 4", "line 5", "line 6"],
	);
});

test("transcript viewport amortizes metadata compaction across repeated bounded appends", () => {
	const components = Array.from({ length: 20 }, (_, index) => new CountingComponent(`line ${index}`));
	let revision = 1;
	const { viewport, transcript } = viewportHarness(components, 20, () => revision, 20);
	viewport.render(80);

	for (let index = 20; index < 1_120; index += 1) {
		const prefixLength = transcript.children.length;
		const component = new CountingComponent(`line ${index}`);
		components.push(component);
		transcript.addChild(component);
		revision += 1;
		viewport.markSectionTailChanged(transcript, prefixLength);
		viewport.render(80);
	}

	assert.deepEqual(viewport.render(80), Array.from({ length: 20 }, (_, index) => `line ${1_100 + index}`));
	assert.equal(components.every((component) => component.cacheKeyReads === 1), true);

	components.at(-1)!.setLine("updated final line");
	revision += 1;
	viewport.markSectionTailChanged(transcript, components.length - 1);
	assert.equal(viewport.render(80).at(-1), "updated final line");
	assert.equal(components.slice(0, -1).every((component) => component.cacheKeyReads === 1), true);
	assert.equal(components.at(-1)!.cacheKeyReads, 2);
});

test("transcript viewport does not cache components without a render key", () => {
	const component = new VolatileComponent();
	const viewport = viewportFor([component], 20, () => 1);

	assert.equal(viewport.render(80).includes("frame 1"), true);
	assert.equal(viewport.render(80).includes("frame 2"), true);
	assert.equal(component.renderCalls, 2);
});

test("retained transcript content keeps running shell elapsed time volatile", () => {
	const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
	let now = startedAt;
	const component = new BashExecutionComponent({
		id: "shell-1",
		command: "npm test",
		status: "running",
		startedAt: new Date(startedAt).toISOString(),
	}, () => now);
	const viewport = viewportFor([component], 20, () => 1);

	assert.match(viewport.render(80).join("\n"), /0s/u);
	now += 2_000;
	assert.match(viewport.render(80).join("\n"), /2s/u);
});

test("transcript viewport uses component tail rendering for tall active content", () => {
	const component = new TailComponent();
	const viewport = viewportFor([component], 20);

	const lines = viewport.render(80);

	assert.equal(component.renderCalls, 0);
	assert.equal(component.tailRenderCalls, 1);
	assert.equal(lines.at(-1), "line 9999");
});

test("exploration groups use the render cache and invalidate when execution finishes", () => {
	const shell = { id: "shell-1", command: "rg needle src", status: "running" as const };
	const component = new CollapsedToolGroupComponent({
		id: "running-shells",
		items: [{ kind: "bash", bash: shell }],
	});
	let revision = 1;
	const viewport = viewportFor([component], 20, () => revision);
	const cacheKey = component.getRenderCacheKey();
	assert.notEqual(cacheKey, undefined);
	assert.match(viewport.render(80).join("\n"), /Exploring/u);
	assert.equal(component.getRenderCacheKey(), cacheKey);
	revision += 1;
	component.updateGroup({ id: "running-shells", items: [{ kind: "bash", bash: { ...shell, status: "success" } }] });
	assert.notEqual(component.getRenderCacheKey(), cacheKey);
	assert.match(viewport.render(80).join("\n"), /Explored/u);
});

test("expanded search details retain live elapsed time", () => {
	const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
	let now = startedAt;
	const shell = { id: "search", command: "rg needle src", status: "running" as const, startedAt: new Date(startedAt).toISOString() };
	const component = new BashExecutionComponent(shell, () => now);
	assert.notEqual(component.getRenderCacheKey(), undefined);
	component.updateBash({ ...shell, expanded: true });
	const viewport = viewportFor([component], 20, () => 1);
	assert.equal(component.getRenderCacheKey(), undefined);
	assert.match(viewport.render(80).join("\n"), /0s/u);
	now += 2_000;
	assert.match(viewport.render(80).join("\n"), /2s/u);
});
