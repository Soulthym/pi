import assert from "node:assert";
import { describe, it } from "node:test";
import { TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	startCount = 0;
	stopCount = 0;

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.startCount++;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stopCount++;
		super.stop();
	}

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function countWritesContaining(writes: string[], sequence: string): number {
	return writes.filter((write) => write.includes(sequence)).length;
}

describe("TUI fullscreen lifecycle", () => {
	it("keeps inline mode as the low-level default", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);

		assert.equal(tui.getScreenMode(), "inline");
		tui.start();
		tui.stop();

		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049h"), 0);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049l"), 0);
	});

	it("enters fullscreen with mouse reporting and restores the primary screen", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");

		tui.start();
		tui.stop();

		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049h"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1000h"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1006h"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1006l"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1000l"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049l"), 1);
	});

	it("makes repeated start and stop calls idempotent", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");

		tui.start();
		tui.start();
		tui.stop();
		tui.stop();

		assert.equal(terminal.startCount, 1);
		assert.equal(terminal.stopCount, 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049h"), 1);
		assert.equal(countWritesContaining(terminal.writes, "\x1b[?1049l"), 1);
	});

	it("does not change screen ownership while running", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.start();

		try {
			assert.throws(() => tui.setScreenMode("fullscreen"), /while it is running/);
		} finally {
			tui.stop();
		}
	});
});
