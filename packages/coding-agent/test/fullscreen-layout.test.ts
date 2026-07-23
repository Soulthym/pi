import assert from "node:assert";
import type { Component } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { FullscreenLayout } from "../src/modes/interactive/components/fullscreen-layout.ts";
import { TranscriptViewport } from "../src/modes/interactive/components/transcript-viewport.ts";

class LinesComponent implements Component {
	lines: string[];
	invalidateCount = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}
}

function createLayout(height: () => number): {
	layout: FullscreenLayout;
	transcript: TranscriptViewport;
	regions: Record<string, LinesComponent>;
} {
	const transcript = new TranscriptViewport({ overscanRows: 0 });
	for (let index = 0; index < 10; index++) transcript.addChild(new LinesComponent([`message-${index}`]));
	const regions = {
		top: new LinesComponent(["header"]),
		status: new LinesComponent(["status"]),
		widgetsAbove: new LinesComponent(["widget-above"]),
		editor: new LinesComponent(["editor-1", "editor-2"]),
		widgetsBelow: new LinesComponent(["widget-below"]),
		footer: new LinesComponent(["footer"]),
	};
	const layout = new FullscreenLayout({
		getHeight: height,
		top: [regions.top],
		transcript,
		status: [regions.status],
		widgetsAbove: [regions.widgetsAbove],
		editor: regions.editor,
		widgetsBelow: [regions.widgetsBelow],
		footer: regions.footer,
	});
	return { layout, transcript, regions };
}

describe("FullscreenLayout", () => {
	it("assigns remaining rows to the transcript", () => {
		const { layout, transcript } = createLayout(() => 12);

		assert.deepEqual(layout.render(80), [
			"header",
			"message-5",
			"message-6",
			"message-7",
			"message-8",
			"message-9",
			"status",
			"widget-above",
			"editor-1",
			"editor-2",
			"widget-below",
			"footer",
		]);
		assert.equal(transcript.getViewportHeight(), 5);
	});

	it("pads short transcripts so the editor and footer stay at the bottom", () => {
		let height = 8;
		const transcript = new TranscriptViewport({ overscanRows: 0 });
		transcript.addChild(new LinesComponent(["only-message"]));
		const editor = new LinesComponent(["editor"]);
		const footer = new LinesComponent(["footer"]);
		const layout = new FullscreenLayout({
			getHeight: () => height,
			top: [],
			transcript,
			status: [],
			widgetsAbove: [],
			editor,
			widgetsBelow: [],
			footer,
		});

		assert.deepEqual(layout.render(80), ["only-message", "", "", "", "", "", "editor", "footer"]);
		height = 5;
		assert.deepEqual(layout.render(80), ["only-message", "", "", "editor", "footer"]);
	});

	it("drops optional chrome before clipping editor and footer", () => {
		const { layout, transcript } = createLayout(() => 3);

		assert.deepEqual(layout.render(80), ["editor-1", "editor-2", "footer"]);
		assert.equal(transcript.getViewportHeight(), 0);
	});

	it("keeps a minimal footer when required chrome exceeds the screen", () => {
		const transcript = new TranscriptViewport();
		const layout = new FullscreenLayout({
			getHeight: () => 2,
			top: [],
			transcript,
			status: [],
			widgetsAbove: [],
			editor: new LinesComponent(["editor-1", "editor-2", "editor-3"]),
			widgetsBelow: [],
			footer: new LinesComponent(["footer-1", "footer-2"]),
		});

		assert.deepEqual(layout.render(80), ["editor-3", "footer-2"]);
	});

	it("propagates global invalidation once to each region", () => {
		const { layout, regions } = createLayout(() => 12);
		layout.invalidate();

		for (const component of Object.values(regions)) {
			assert.equal(component.invalidateCount, 1);
		}
	});
});
