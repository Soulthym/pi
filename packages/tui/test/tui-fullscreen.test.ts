import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
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

	takeWrites(): string {
		return this.writes.splice(0).join("");
	}
}

function countWritesContaining(writes: string[], sequence: string): number {
	return writes.filter((write) => write.includes(sequence)).length;
}

function countOccurrences(value: string, sequence: string): number {
	return value.split(sequence).length - 1;
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

class MutableLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

describe("TUI fullscreen rendering", () => {
	it("renders only the visible tail into a fixed absolute-position frame", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(new MutableLines(["one", "two", "three", "four", "five"]));

		tui.start();
		try {
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const output = terminal.takeWrites();

			assert.deepEqual(viewport, ["three", "four", "five"]);
			assert.match(output, /\x1b\[1;1H/);
			assert.match(output, /\x1b\[2;1H/);
			assert.match(output, /\x1b\[3;1H/);
			assert.equal(output.includes("\x1b[3J"), false);
		} finally {
			tui.stop();
		}
	});

	it("emits only changed visible rows", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const component = new MutableLines(["one", "two", "three", "four", "five"]);
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(component);
		tui.start();

		try {
			await terminal.waitForRender();
			terminal.takeWrites();

			component.lines[4] = "FIVE";
			tui.requestRender();
			await terminal.waitForRender();
			const changedOutput = terminal.takeWrites();
			assert.equal(countOccurrences(changedOutput, "\x1b[2K"), 1);
			assert.match(changedOutput, /\x1b\[3;1H/);
			assert.equal(changedOutput.includes("\x1b[1;1H"), false);
			assert.equal(changedOutput.includes("\x1b[2;1H"), false);

			component.lines[0] = "ONE";
			tui.requestRender();
			await terminal.waitForRender();
			assert.equal(terminal.takeWrites().includes("\x1b[2K"), false);
		} finally {
			tui.stop();
		}
	});

	it("rebuilds a bounded frame on resize without clearing scrollback", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(new MutableLines(["one", "two", "three", "four", "five"]));
		tui.start();

		try {
			await terminal.waitForRender();
			terminal.takeWrites();
			terminal.resize(20, 4);
			await terminal.waitForRender();
			const output = terminal.takeWrites();

			assert.deepEqual(terminal.getViewport(), ["two", "three", "four", "five"]);
			assert.equal(countOccurrences(output, "\x1b[2K"), 4);
			assert.equal(output.includes("\x1b[2J"), true);
			assert.equal(output.includes("\x1b[3J"), false);
		} finally {
			tui.stop();
		}
	});

	it("uses absolute positioning for the IME cursor", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(new MutableLines(["one", "two", `ok${CURSOR_MARKER}`]));

		tui.start();
		try {
			await terminal.waitForRender();
			assert.equal(terminal.takeWrites().includes("\x1b[3;3H"), true);
		} finally {
			tui.stop();
		}
	});

	it("restores primary-screen text without adding transcript output", async () => {
		const terminal = new RecordingTerminal(20, 3);
		terminal.write("shell prompt");
		await terminal.flush();
		terminal.takeWrites();
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(new MutableLines(["agent output"]));

		tui.start();
		await terminal.waitForRender();
		tui.stop();
		await terminal.flush();

		assert.equal(terminal.getViewport()[0], "shell prompt");
	});
});

describe("TUI fullscreen continuity", () => {
	it("repaints the frame after leaving and re-entering fullscreen", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TUI(terminal);
		tui.setScreenMode("fullscreen");
		tui.addChild(new MutableLines(["agent output"]));

		tui.start();
		await terminal.waitForRender();
		terminal.takeWrites();
		tui.stop();
		terminal.takeWrites();

		tui.start();
		try {
			await terminal.waitForRender();
			const output = terminal.takeWrites();
			assert.equal(output.includes("\x1b[2J"), true);
			assert.equal(output.includes("agent output"), true);
		} finally {
			tui.stop();
		}
	});
});
