import assert from "node:assert";
import type { Component } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { TranscriptViewport } from "../src/modes/interactive/components/transcript-viewport.ts";

class CountingComponent implements Component {
	lines: string[];
	renderCount = 0;
	invalidateCount = 0;
	renderedWidths: number[] = [];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		this.renderCount += 1;
		this.renderedWidths.push(width);
		return [...this.lines];
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

function createSingleLineItems(count: number): CountingComponent[] {
	return Array.from({ length: count }, (_, index) => new CountingComponent([`item-${index}`]));
}

function addItems(viewport: TranscriptViewport, items: CountingComponent[]): void {
	for (const item of items) viewport.addChild(item);
}

describe("TranscriptViewport virtualization", () => {
	it("renders backward from the live edge and skips old items", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 2 });
		const items = createSingleLineItems(10);
		addItems(viewport, items);

		assert.deepEqual(viewport.render(80), ["item-7", "item-8", "item-9"]);
		assert.deepEqual(
			items.map((item) => item.renderCount),
			[0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
		);

		viewport.render(80);
		assert.deepEqual(
			items.map((item) => item.renderCount),
			[0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
		);
	});

	it("renders only a dirty visible item and defers dirty offscreen items", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(8);
		addItems(viewport, items);
		viewport.render(80);

		items[7].lines = ["changed-tail"];
		viewport.invalidateItem(items[7]);
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "changed-tail"]);
		assert.equal(items[7].renderCount, 2);
		assert.equal(items[6].renderCount, 1);

		items[0].lines = ["changed-head"];
		viewport.invalidateItem(items[0]);
		viewport.render(80);
		assert.equal(items[0].renderCount, 0);

		viewport.scrollToTop();
		assert.deepEqual(viewport.render(80), ["changed-head", "item-1", "item-2"]);
		assert.equal(items[0].renderCount, 1);
	});

	it("reuses cached items on height changes and rewraps only visible items on width changes", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(10);
		addItems(viewport, items);
		viewport.render(80);

		viewport.setViewportHeight(4);
		assert.deepEqual(viewport.render(80), ["item-6", "item-7", "item-8", "item-9"]);
		assert.equal(items[6].renderCount, 1);
		assert.equal(items[7].renderCount, 1);

		viewport.render(79);
		assert.equal(items[5].renderCount, 0);
		for (const item of items.slice(6)) {
			assert.deepEqual(item.renderedWidths, [80, 79]);
		}
	});

	it("jumps to the top without measuring the preceding transcript", () => {
		const viewport = new TranscriptViewport({ height: 4, overscanRows: 0 });
		const items = createSingleLineItems(100);
		addItems(viewport, items);
		viewport.scrollToTop();

		assert.deepEqual(viewport.render(80), ["item-0", "item-1", "item-2", "item-3"]);
		assert.deepEqual(
			items.slice(0, 6).map((item) => item.renderCount),
			[1, 1, 1, 1, 0, 0],
		);
		assert.equal(items[99].renderCount, 0);
	});
});

describe("TranscriptViewport anchors", () => {
	it("keeps an item-and-line anchor stable when new output arrives", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(10);
		addItems(viewport, items);
		assert.deepEqual(viewport.render(80), ["item-7", "item-8", "item-9"]);

		viewport.scrollByLines(-2);
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "item-7"]);
		assert.equal(viewport.isFollowingTail(), false);

		viewport.addChild(new CountingComponent(["item-10"]));
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "item-7"]);

		viewport.scrollToBottom();
		assert.deepEqual(viewport.render(80), ["item-8", "item-9", "item-10"]);
		assert.equal(viewport.isFollowingTail(), true);
	});

	it("anchors within variable-height items", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const first = new CountingComponent(["a-0", "a-1"]);
		const second = new CountingComponent(["b-0", "b-1", "b-2"]);
		const third = new CountingComponent(["c-0"]);
		addItems(viewport, [first, second, third]);

		assert.deepEqual(viewport.render(80), ["b-1", "b-2", "c-0"]);
		viewport.scrollByLines(-1);
		assert.deepEqual(viewport.render(80), ["b-0", "b-1", "b-2"]);

		second.lines = ["new", "b-0", "b-1", "b-2"];
		viewport.invalidateItem(second);
		assert.deepEqual(viewport.render(80), ["new", "b-0", "b-1"]);
	});

	it("returns to live following when scrolling reaches the tail", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(8);
		addItems(viewport, items);
		viewport.render(80);
		viewport.scrollByLines(-2);
		viewport.render(80);

		viewport.scrollByLines(20);
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "item-7"]);
		assert.equal(viewport.isFollowingTail(), true);
	});
});

describe("TranscriptViewport cache retention", () => {
	it("bounds inactive rendered lines while retaining item metadata", () => {
		const viewport = new TranscriptViewport({ height: 2, overscanRows: 0, maxCachedLines: 4 });
		const items = createSingleLineItems(10);
		addItems(viewport, items);
		viewport.render(80);
		viewport.scrollToTop();
		viewport.render(80);
		viewport.scrollByLines(2);
		viewport.render(80);

		assert.ok(viewport.getCachedLineCount() <= 4);
		const tailRenderCounts = items.slice(8).map((item) => item.renderCount);
		viewport.scrollToBottom();
		viewport.render(80);
		assert.deepEqual(
			items.slice(8).map((item) => item.renderCount),
			tailRenderCounts.map((count) => count + 1),
		);
	});

	it("uses a global epoch only for explicit full invalidation", () => {
		const viewport = new TranscriptViewport({ height: 2, overscanRows: 0 });
		const items = createSingleLineItems(6);
		addItems(viewport, items);
		viewport.render(80);

		viewport.invalidate();
		viewport.render(80);

		assert.deepEqual(
			items.map((item) => item.invalidateCount),
			[1, 1, 1, 1, 1, 1],
		);
		assert.deepEqual(
			items.map((item) => item.renderCount),
			[0, 0, 0, 0, 2, 2],
		);
	});
});
