import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {}

function createSessionManager(options: { sessionFile?: string } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => "test-session",
		getSessionDir: () => "/tmp/pi-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: string | Uint8Array,
			callback?: () => void,
		) => {
			callback?.();
			return true;
		}) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			`${chalk.dim("To resume this session:")} ${APP_NAME} --session test-session\n`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: string | Uint8Array,
			callback?: () => void,
		) => {
			callback?.();
			return true;
		}) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("signal-triggered shutdown flushes terminal restoration before exiting", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
			if (String(chunk) === "\x1b[0m") {
				completeFlush = callback;
			}
			return true;
		}) as typeof process.stdout.write);
		const order: string[] = [];
		const context = createContext(order);

		const shutdownPromise = callShutdown(context, { fromSignal: true });
		await vi.waitFor(() => expect(completeFlush).toBeTypeOf("function"));

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(exit).not.toHaveBeenCalled();

		completeFlush?.();
		await shutdownPromise;

		expect(exit).toHaveBeenCalledWith(0);
	});

	test("interactive shutdown flushes terminal restoration before exiting", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, callback?: () => void) => {
			if (String(chunk) === "\x1b[0m") {
				completeFlush = callback;
			}
			return true;
		}) as typeof process.stdout.write);
		const order: string[] = [];
		const context = createContext(order);

		const shutdownPromise = callShutdown(context);
		await vi.waitFor(() => expect(completeFlush).toBeTypeOf("function"));

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(exit).not.toHaveBeenCalled();

		completeFlush?.();
		await shutdownPromise;

		expect(exit).toHaveBeenCalledWith(0);
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});
});

type FatalRuntimeThis = {
	showError: (message: string) => void;
	stop: () => void;
};

type UncaughtCrashThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	ui: { stop: () => void };
};

type InteractiveModePrototypeWithFatalPaths = {
	handleFatalRuntimeError(this: FatalRuntimeThis, prefix: string, error: unknown): Promise<never>;
	uncaughtCrash(this: UncaughtCrashThis, error: Error): Promise<never>;
};

async function callFatalRuntimeError(context: FatalRuntimeThis, prefix: string, error: unknown): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithFatalPaths).handleFatalRuntimeError.call(
			context,
			prefix,
			error,
		);
	} catch (caught) {
		if (!(caught instanceof ProcessExitError)) throw caught;
	}
}

async function callUncaughtCrash(context: UncaughtCrashThis, error: Error): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithFatalPaths).uncaughtCrash.call(context, error);
	} catch (caught) {
		if (!(caught instanceof ProcessExitError)) throw caught;
	}
}

describe("InteractiveMode fatal terminal restoration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
	});

	test("flushes a fatal runtime error before exiting", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string | Uint8Array, callback?: () => void) => {
			completeFlush = callback;
			return true;
		}) as typeof process.stdout.write);
		const context: FatalRuntimeThis = {
			showError: vi.fn(),
			stop: vi.fn(),
		};

		const fatalPromise = callFatalRuntimeError(context, "Failed to resume session", new Error("broken"));

		expect(context.showError).toHaveBeenCalledWith("Failed to resume session: broken");
		expect(context.stop).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();

		completeFlush?.();
		await fatalPromise;

		expect(exit).toHaveBeenCalledWith(1);
	});

	test("flushes uncaught-exception restoration before exiting", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string | Uint8Array, callback?: () => void) => {
			completeFlush = callback;
			return true;
		}) as typeof process.stdout.write);
		const context: UncaughtCrashThis = {
			isShuttingDown: false,
			unregisterSignalHandlers: vi.fn(),
			ui: { stop: vi.fn() },
		};

		const crashPromise = callUncaughtCrash(context, new Error("crash"));

		expect(context.isShuttingDown).toBe(true);
		expect(context.unregisterSignalHandlers).toHaveBeenCalledTimes(1);
		expect(context.ui.stop).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();

		completeFlush?.();
		await crashPromise;

		expect(exit).toHaveBeenCalledWith(1);
	});
});
