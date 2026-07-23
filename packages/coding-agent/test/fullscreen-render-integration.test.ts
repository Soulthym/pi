import assert from "node:assert";
import { type Component, type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, it } from "vitest";
import { FullscreenLayout } from "../src/modes/interactive/components/fullscreen-layout.ts";
import {
	type TranscriptItemInvalidationHandler,
	TranscriptViewport,
} from "../src/modes/interactive/components/transcript-viewport.ts";

class RecordingTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	writes: string[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	takeOutput(): string {
		return this.writes.splice(0).join("");
	}
}

class NotifyingLine implements Component {
	line: string;
	renderCount = 0;
	private invalidationHandler: TranscriptItemInvalidationHandler;

	constructor(line: string) {
		this.line = line;
	}

	setTranscriptInvalidationHandler(handler: TranscriptItemInvalidationHandler): void {
		this.invalidationHandler = handler;
	}

	setLine(line: string): void {
		this.line = line;
		this.invalidationHandler?.();
	}

	render(_width: number): string[] {
		this.renderCount += 1;
		return [this.line];
	}

	invalidate(): void {}
}

class StaticLine implements Component {
	private readonly line: string;

	constructor(line: string) {
		this.line = line;
	}

	render(_width: number): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

async function settleRender(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

describe("fullscreen long-context integration", () => {
	it("keeps component work and terminal output screen-bounded", async () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		const transcript = new TranscriptViewport();
		const items = Array.from({ length: 10_000 }, (_, index) => new NotifyingLine(`item-${index}`));
		for (const item of items) transcript.addChild(item);
		const layout = new FullscreenLayout({
			getHeight: () => terminal.rows,
			top: [],
			transcript,
			status: [],
			widgetsAbove: [],
			editor: new StaticLine("editor"),
			widgetsBelow: [],
			footer: new StaticLine("footer"),
		});
		tui.addChild(layout);

		tui.start();
		try {
			await settleRender();
			const initialOutput = terminal.takeOutput();
			const initialCalls = items.reduce((total, item) => total + item.renderCount, 0);
			assert.equal(initialCalls, 44);
			assert.equal(initialOutput.includes("item-0"), false);
			assert.equal(initialOutput.includes("item-9999"), true);
			assert.equal(initialOutput.includes("\x1b[3J"), false);
			assert.ok(Buffer.byteLength(initialOutput) < 20_000);

			tui.requestRender();
			await settleRender();
			const idleOutput = terminal.takeOutput();
			assert.equal(
				items.reduce((total, item) => total + item.renderCount, 0),
				initialCalls,
			);
			assert.equal(idleOutput.includes("\x1b[2K"), false);

			items[9_999].setLine("changed-tail");
			tui.requestRender();
			await settleRender();
			const changedOutput = terminal.takeOutput();
			assert.equal(
				items.reduce((total, item) => total + item.renderCount, 0),
				initialCalls + 1,
			);
			assert.equal(changedOutput.includes("changed-tail"), true);
			assert.equal(changedOutput.split("\x1b[2K").length - 1, 1);
		} finally {
			tui.stop();
		}
	});
});
