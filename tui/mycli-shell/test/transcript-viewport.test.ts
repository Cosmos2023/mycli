import assert from "node:assert/strict";
import test from "node:test";
import { CollapsedToolGroupComponent } from "../src/components/collapsed-tool-group.ts";
import { TranscriptViewportComponent } from "../src/shell-runtime.ts";
import { Container, type Component } from "../src/tui-core/tui.ts";

class CountingComponent extends Container {
	renderCalls = 0;

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

function viewportFor(components: Component[], maxRows: number): TranscriptViewportComponent {
	const content = new Container();
	const header = new Container();
	const transcript = new Container();
	for (const component of components) transcript.addChild(component);
	content.addChild(header);
	content.addChild(transcript);
	return new TranscriptViewportComponent(content, () => 10, maxRows);
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

test("transcript viewport does not cache components without a render key", () => {
	const component = new VolatileComponent();
	const viewport = viewportFor([component], 20);

	assert.equal(viewport.render(80).includes("frame 1"), true);
	assert.equal(viewport.render(80).includes("frame 2"), true);
	assert.equal(component.renderCalls, 2);
});

test("transcript viewport uses component tail rendering for tall active content", () => {
	const component = new TailComponent();
	const viewport = viewportFor([component], 20);

	const lines = viewport.render(80);

	assert.equal(component.renderCalls, 0);
	assert.equal(component.tailRenderCalls, 1);
	assert.equal(lines.at(-1), "line 9999");
});

test("running shell groups remain outside the transcript render cache", () => {
	const component = new CollapsedToolGroupComponent({
		id: "running-shells",
		items: [{
			kind: "bash",
			bash: { id: "shell-1", command: "npm test", status: "running", expanded: true },
		}],
	});

	assert.equal(component.getRenderCacheKey(), undefined);
});
