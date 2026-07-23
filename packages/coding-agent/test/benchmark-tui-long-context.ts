import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { type Component, Container, type Terminal, Text, TUI } from "../../tui/src/index.ts";

type FixtureContent = {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
};

type FixtureMessage = {
	role?: unknown;
	content?: unknown;
};

type FixtureEntry = {
	type?: unknown;
	message?: unknown;
};

type Metric = {
	durationMs: number;
	renderCalls: number;
	preparedLines: number;
	visibleLines: number;
	preparedBytes: number;
	visibleBytes: number;
};

class CountingComponent implements Component {
	private component: Component;
	renderCalls = 0;

	constructor(component: Component) {
		this.component = component;
	}

	render(width: number): string[] {
		this.renderCalls += 1;
		return this.component.render(width);
	}

	invalidate(): void {
		this.component.invalidate();
	}
}

class RecordingTerminal implements Terminal {
	private resizeHandler: (() => void) | undefined;
	private width: number;
	private height: number;
	bytesWritten = 0;

	constructor(columns: number, rows: number) {
		this.width = columns;
		this.height = rows;
	}

	start(_onInput: (data: string) => void, onResize: () => void): void {
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.bytesWritten += Buffer.byteLength(data);
	}

	get columns(): number {
		return this.width;
	}

	get rows(): number {
		return this.height;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(lines: number): void {
		if (lines > 0) this.write(`\x1b[${lines}B`);
		if (lines < 0) this.write(`\x1b[${-lines}A`);
	}

	hideCursor(): void {
		this.write("\x1b[?25l");
	}

	showCursor(): void {
		this.write("\x1b[?25h");
	}

	clearLine(): void {
		this.write("\x1b[K");
	}

	clearFromCursor(): void {
		this.write("\x1b[J");
	}

	clearScreen(): void {
		this.write("\x1b[2J\x1b[H");
	}

	setTitle(title: string): void {
		this.write(`\x1b]0;${title}\x07`);
	}

	setProgress(_active: boolean): void {}

	resetBytes(): void {
		this.bytesWritten = 0;
	}

	resize(columns: number, rows: number): void {
		this.width = columns;
		this.height = rows;
		this.resizeHandler?.();
	}
}

function extractMessageText(message: FixtureMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";

	const blocks: string[] = [];
	for (const value of message.content) {
		if (!value || typeof value !== "object") continue;
		const block = value as FixtureContent;
		if (block.type === "text" && typeof block.text === "string") {
			blocks.push(block.text);
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			blocks.push(block.thinking);
		}
	}
	return blocks.join("\n\n");
}

function parseFixture(path: string): FixtureMessage[] {
	const messages: FixtureMessage[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		const value = JSON.parse(line) as FixtureEntry;
		if (value.type !== "message" || !value.message || typeof value.message !== "object") continue;
		messages.push(value.message as FixtureMessage);
	}
	return messages;
}

function measure(
	root: Container,
	components: readonly CountingComponent[],
	width: number,
	viewportRows?: number,
): Metric {
	const callsBefore = components.reduce((total, component) => total + component.renderCalls, 0);
	const startedAt = performance.now();
	const rendered = root.render(width);
	const lines = viewportRows === undefined ? rendered : rendered.slice(-viewportRows);
	const durationMs = performance.now() - startedAt;
	const callsAfter = components.reduce((total, component) => total + component.renderCalls, 0);
	return {
		durationMs,
		renderCalls: callsAfter - callsBefore,
		preparedLines: rendered.length,
		visibleLines: lines.length,
		preparedBytes: Buffer.byteLength(rendered.join("\r\n")),
		visibleBytes: Buffer.byteLength(lines.join("\r\n")),
	};
}

function average(metrics: readonly Metric[]): Metric {
	const count = metrics.length;
	return {
		durationMs: metrics.reduce((total, metric) => total + metric.durationMs, 0) / count,
		renderCalls: metrics.reduce((total, metric) => total + metric.renderCalls, 0) / count,
		preparedLines: metrics.reduce((total, metric) => total + metric.preparedLines, 0) / count,
		visibleLines: metrics.reduce((total, metric) => total + metric.visibleLines, 0) / count,
		preparedBytes: metrics.reduce((total, metric) => total + metric.preparedBytes, 0) / count,
		visibleBytes: metrics.reduce((total, metric) => total + metric.visibleBytes, 0) / count,
	};
}

function repeat(runs: number, run: () => Metric): Metric {
	return average(Array.from({ length: runs }, run));
}

async function settleRender(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

async function measureTerminalBytes(
	components: readonly CountingComponent[],
	streamingTarget: Text,
): Promise<Record<string, number>> {
	const terminal = new RecordingTerminal(80, 24);
	const tui = new TUI(terminal);
	for (const component of components) tui.addChild(component);

	tui.start();
	terminal.resetBytes();
	await settleRender();
	const initial = terminal.bytesWritten;

	terminal.resetBytes();
	tui.requestRender();
	await settleRender();
	const idle = terminal.bytesWritten;

	terminal.resetBytes();
	streamingTarget.setText("terminal streaming update");
	tui.requestRender();
	await settleRender();
	const streaming = terminal.bytesWritten;

	terminal.resetBytes();
	terminal.resize(100, 24);
	await settleRender();
	const widthChange = terminal.bytesWritten;

	terminal.resetBytes();
	terminal.resize(100, 30);
	await settleRender();
	const heightChange = terminal.bytesWritten;

	terminal.resetBytes();
	tui.invalidate();
	tui.requestRender();
	await settleRender();
	const globalInvalidation = terminal.bytesWritten;

	tui.stop();
	return { initial, idle, streaming, widthChange, heightChange, globalInvalidation };
}

const directory = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(directory, "fixtures", "large-session.jsonl");
const messages = parseFixture(fixturePath);
const root = new Container();
const components: CountingComponent[] = [];
const mutableTexts: Text[] = [];

for (const message of messages) {
	const text = extractMessageText(message);
	if (!text.trim()) continue;
	const textComponent = new Text(text, 1, 0);
	const component = new CountingComponent(textComponent);
	root.addChild(component);
	components.push(component);
	mutableTexts.push(textComponent);
}

const runs = 5;
const initial = measure(root, components, 80);
const idle = repeat(runs, () => measure(root, components, 80));
const viewportSlice = repeat(runs, () => measure(root, components, 80, 24));
const widthChange = repeat(runs, () => measure(root, components, 100));

const streamingTarget = mutableTexts.at(-1);
if (!streamingTarget) throw new Error("Large-session fixture contains no visible messages");
let streamingSuffix = "";
const streaming = repeat(runs, () => {
	streamingSuffix += ".";
	streamingTarget.setText(`streaming${streamingSuffix}`);
	return measure(root, components, 80);
});

const globalInvalidation = repeat(runs, () => {
	root.invalidate();
	return measure(root, components, 80);
});

const terminalBytes = await measureTerminalBytes(components, streamingTarget);

process.stdout.write(
	`${JSON.stringify(
		{
			fixture: "test/fixtures/large-session.jsonl",
			fixtureMessages: messages.length,
			visibleComponents: components.length,
			runs,
			scenarios: {
				initial,
				idle,
				viewportSlice,
				widthChange,
				streaming,
				globalInvalidation,
			},
			terminalBytes,
		},
		null,
		2,
	)}\n`,
);
