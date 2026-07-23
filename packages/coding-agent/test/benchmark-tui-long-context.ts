import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { type Component, Container, Text } from "../../tui/src/index.ts";

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
		},
		null,
		2,
	)}\n`,
);
