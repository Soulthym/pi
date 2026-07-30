import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { TranscriptViewport } from "../src/modes/interactive/components/transcript-viewport.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function createTuiStub(requestRender: () => void): TUI {
	return {
		terminal: {
			columns: 80,
			rows: 24,
		},
		requestRender,
	} as unknown as TUI;
}

describe("BashExecutionComponent animation", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("invalidates its cached transcript item on loader frames", () => {
		vi.useFakeTimers();
		let renderRequests = 0;
		const viewport = new TranscriptViewport({ height: 20, overscanRows: 0 });
		const component = new BashExecutionComponent(
			"sleep 1",
			createTuiStub(() => renderRequests++),
		);
		viewport.addChild(component);

		const firstFrame = viewport.render(80).join("\n");
		expect(firstFrame).toContain("⠋");

		vi.advanceTimersByTime(80);
		const secondFrame = viewport.render(80).join("\n");

		expect(renderRequests).toBeGreaterThan(0);
		expect(secondFrame).toContain("⠙");
		expect(secondFrame).not.toBe(firstFrame);

		component.setComplete(0, false);
	});
});
