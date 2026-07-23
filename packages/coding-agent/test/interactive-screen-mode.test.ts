import assert from "node:assert";
import { describe, it } from "vitest";
import { resolveInteractiveScreenMode } from "../src/modes/interactive/screen-mode.ts";

describe("resolveInteractiveScreenMode", () => {
	it("keeps inline mode as the default during staged rollout", () => {
		assert.equal(
			resolveInteractiveScreenMode({
				requestedMode: "",
				term: "xterm-256color",
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
			"inline",
		);
	});

	it("allows fullscreen through the explicit test switch", () => {
		assert.equal(
			resolveInteractiveScreenMode({
				requestedMode: "fullscreen",
				term: "xterm-256color",
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
			"fullscreen",
		);
	});

	it("falls back for non-TTY and dumb terminals", () => {
		for (const environment of [
			{ term: "xterm-256color", stdinIsTTY: false, stdoutIsTTY: true },
			{ term: "xterm-256color", stdinIsTTY: true, stdoutIsTTY: false },
			{ term: "dumb", stdinIsTTY: true, stdoutIsTTY: true },
		]) {
			assert.equal(resolveInteractiveScreenMode({ requestedMode: "fullscreen", ...environment }), "inline");
		}
	});
});
