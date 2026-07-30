import type { ScreenMode } from "@earendil-works/pi-tui";

export type InteractiveScreenModeEnvironment = {
	requestedMode?: string;
	term?: string;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
};

/** Resolve the opt-in fullscreen test mode with conservative terminal fallback. */
export function resolveInteractiveScreenMode(environment: InteractiveScreenModeEnvironment = {}): ScreenMode {
	const requestedMode = environment.requestedMode ?? process.env.PI_TUI_MODE;
	const term = environment.term ?? process.env.TERM;
	const stdinIsTTY = environment.stdinIsTTY ?? process.stdin.isTTY === true;
	const stdoutIsTTY = environment.stdoutIsTTY ?? process.stdout.isTTY === true;

	if (requestedMode !== "fullscreen") return "inline";
	if (!stdinIsTTY || !stdoutIsTTY || term === "dumb") return "inline";
	return "fullscreen";
}
