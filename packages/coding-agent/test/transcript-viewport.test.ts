import assert from "node:assert";
import type { Component } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import type { CustomEntry } from "../src/core/session-manager.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import {
	type TranscriptItemInvalidationHandler,
	TranscriptViewport,
} from "../src/modes/interactive/components/transcript-viewport.ts";

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

class NotifyingComponent extends CountingComponent {
	private invalidationHandler: TranscriptItemInvalidationHandler;

	setTranscriptInvalidationHandler(handler: TranscriptItemInvalidationHandler): void {
		this.invalidationHandler = handler;
	}

	override invalidate(): void {
		super.invalidate();
		this.invalidationHandler?.();
	}

	setLines(lines: string[]): void {
		this.lines = lines;
		this.invalidationHandler?.();
	}
}

function createSingleLineItems(count: number): CountingComponent[] {
	return Array.from({ length: count }, (_, index) => new CountingComponent([`item-${index}`]));
}

function addItems(viewport: TranscriptViewport, items: CountingComponent[]): void {
	for (const item of items) viewport.addChild(item);
}

describe("TranscriptViewport virtualization", () => {
	it("preserves ordinary Container rendering until a viewport height is assigned", () => {
		const viewport = new TranscriptViewport();
		const items = createSingleLineItems(4);
		addItems(viewport, items);

		assert.deepEqual(viewport.render(80), ["item-0", "item-1", "item-2", "item-3"]);
		assert.equal(viewport.getViewportHeight(), undefined);
	});

	it("scrolls separately owned startup items and preserves them across conversation clears", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const header = new CountingComponent(["header"]);
		const resources = new CountingComponent(["resources"]);
		viewport.setLeadingComponents([header, resources]);
		addItems(viewport, createSingleLineItems(5));

		assert.deepEqual(viewport.render(80), ["item-2", "item-3", "item-4"]);
		assert.equal(header.renderCount, 0);
		assert.equal(resources.renderCount, 0);

		viewport.scrollToTop();
		assert.deepEqual(viewport.render(80), ["header", "resources", "item-0"]);

		header.lines = ["updated-header"];
		assert.deepEqual(viewport.render(80), ["updated-header", "resources", "item-0"]);

		viewport.clear();
		assert.deepEqual(viewport.render(80), ["updated-header", "resources"]);
	});

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

	it("automatically versions Pi-owned invalidation sources", () => {
		const viewport = new TranscriptViewport({ height: 1, overscanRows: 0 });
		const component = new NotifyingComponent(["before"]);
		viewport.addChild(component);
		assert.deepEqual(viewport.render(80), ["before"]);

		component.setLines(["after"]);
		assert.deepEqual(viewport.render(80), ["after"]);
		assert.equal(component.renderCount, 2);

		viewport.removeChild(component);
		component.setLines(["detached"]);
		assert.deepEqual(viewport.render(80), []);
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
	it("keeps render work flat across large transcript sizes", () => {
		const measure = (itemCount: number): { initialCalls: number; idleCalls: number; visibleLines: number } => {
			const viewport = new TranscriptViewport({ height: 24, overscanRows: 24 });
			const items = createSingleLineItems(itemCount);
			addItems(viewport, items);
			const visibleLines = viewport.render(80).length;
			const initialCalls = items.reduce((total, item) => total + item.renderCount, 0);
			viewport.render(80);
			const callsAfterIdle = items.reduce((total, item) => total + item.renderCount, 0);
			return { initialCalls, idleCalls: callsAfterIdle - initialCalls, visibleLines };
		};

		assert.deepEqual(measure(100), { initialCalls: 48, idleCalls: 0, visibleLines: 24 });
		assert.deepEqual(measure(10_000), { initialCalls: 48, idleCalls: 0, visibleLines: 24 });
	});
});

describe("TranscriptViewport extension compatibility", () => {
	it("rerenders visible custom renderer components without caching offscreen ones", () => {
		const viewport = new TranscriptViewport({ height: 2, overscanRows: 0 });
		const messageRendererComponent = new CountingComponent(["message-before"]);
		const message: CustomMessage = {
			role: "custom",
			customType: "dynamic-message",
			content: "message",
			display: true,
			timestamp: 0,
		};
		viewport.addChild(new CustomMessageComponent(message, () => messageRendererComponent));

		assert.deepEqual(viewport.render(80), ["", "message-before"]);
		messageRendererComponent.lines = ["message-after"];
		assert.deepEqual(viewport.render(80), ["", "message-after"]);
		assert.equal(messageRendererComponent.renderCount, 2);

		viewport.clear();
		const entryRendererComponent = new CountingComponent(["entry-before"]);
		const entry: CustomEntry = {
			type: "custom",
			id: "entry",
			parentId: null,
			timestamp: "2026-07-24T00:00:00.000Z",
			customType: "dynamic-entry",
		};
		viewport.addChild(new CustomEntryComponent(entry, () => entryRendererComponent));

		assert.deepEqual(viewport.render(80), ["", "entry-before"]);
		entryRendererComponent.lines = ["entry-after"];
		assert.deepEqual(viewport.render(80), ["", "entry-after"]);
		assert.equal(entryRendererComponent.renderCount, 2);

		viewport.clear();
		const offscreenRendererComponent = new CountingComponent(["offscreen"]);
		viewport.addChild(new CustomMessageComponent(message, () => offscreenRendererComponent));
		addItems(viewport, createSingleLineItems(4));
		assert.deepEqual(viewport.render(80), ["item-2", "item-3"]);
		assert.equal(offscreenRendererComponent.renderCount, 0);
	});
});

describe("TranscriptViewport anchors", () => {
	it("keeps an item-and-line anchor stable when new output arrives", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(10);
		items[9] = new NotifyingComponent(["item-9"]);
		addItems(viewport, items);
		assert.deepEqual(viewport.render(80), ["item-7", "item-8", "item-9"]);

		viewport.scrollByLines(-2);
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "item-7"]);
		assert.equal(viewport.isFollowingTail(), false);
		assert.equal(viewport.hasPendingOutput(), false);

		viewport.invalidate();
		assert.equal(viewport.hasPendingOutput(), false);

		viewport.addChild(new CountingComponent(["item-10"]));
		assert.deepEqual(viewport.render(80), ["item-5", "item-6", "item-7"]);
		assert.equal(viewport.hasPendingOutput(), true);

		viewport.scrollToBottom();
		assert.deepEqual(viewport.render(80), ["item-8", "item-9", "item-10"]);
		assert.equal(viewport.isFollowingTail(), true);
		assert.equal(viewport.hasPendingOutput(), false);
	});

	it("handles vertical SGR wheel input in bounded line increments", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		addItems(viewport, createSingleLineItems(10));
		assert.deepEqual(viewport.render(80), ["item-7", "item-8", "item-9"]);

		assert.equal(viewport.handleMouseInput("\x1b[<64;20;5M"), true);
		assert.deepEqual(viewport.render(80), ["item-4", "item-5", "item-6"]);
		assert.equal(viewport.handleMouseInput("\x1b[<64;20;5m"), false);
		assert.equal(viewport.handleMouseInput("\x1b[<0;20;5M"), false);

		assert.equal(viewport.handleMouseInput("\x1b[<65;20;5M"), true);
		assert.deepEqual(viewport.render(80), ["item-7", "item-8", "item-9"]);
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
	it("preserves pending-output state across presentation-only updates", () => {
		const viewport = new TranscriptViewport({ height: 3, overscanRows: 0 });
		const items = createSingleLineItems(8);
		addItems(viewport, items);
		viewport.render(80);
		viewport.scrollByLines(-2);

		viewport.withPreservedPendingOutput(() => viewport.invalidateItem(items[5]));
		assert.equal(viewport.hasPendingOutput(), false);

		viewport.addChild(new CountingComponent(["new-output"]));
		assert.equal(viewport.hasPendingOutput(), true);
		viewport.withPreservedPendingOutput(() => viewport.invalidateItem(items[6]));
		assert.equal(viewport.hasPendingOutput(), true);
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
