import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/modes/interactive/external-editor.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/external-editor.ts")>();
	return {
		...actual,
		editInExternalEditor: vi.fn(),
	};
});

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
};

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): Promise<void>;
};

function callHandleCtrlZ(context: HandleCtrlZThis): Promise<void> {
	return (interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

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

describe("InteractiveMode.handleCtrlZ", () => {
	beforeEach(() => {
		setStdoutIsTTY(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
	});

	test("shows a status message and skips suspend on Windows", async () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = { ui, showStatus };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			await callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("flushes terminal restoration before suspending and restores the TUI on SIGCONT", async () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
			_chunk: string | Uint8Array,
			callback?: () => void,
		) => {
			completeFlush = callback;
			return true;
		}) as typeof process.stdout.write);

		const suspendPromise = callHandleCtrlZ(context);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(stdoutWrite).toHaveBeenCalledWith("\x1b[0m", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();

		completeFlush?.();
		await suspendPromise;

		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("cleans up the temporary handlers if suspension fails", async () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		await expect(callHandleCtrlZ(context)).rejects.toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});

type ExternalEditorThis = {
	settingsManager: { getExternalEditorCommand: () => string };
	editor: {
		getExpandedText: () => string;
		getText: () => string;
		setText: (text: string) => void;
	};
	ui: FakeUi & { getScreenMode: () => "fullscreen" | "inline" };
};

type InteractiveModePrototypeWithExternalEditor = {
	handleOpenExternalEditor(this: ExternalEditorThis): Promise<void>;
};

describe("InteractiveMode external-editor handoff", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
	});

	test("flushes terminal restoration before launching the editor", async () => {
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string | Uint8Array, callback?: () => void) => {
			completeFlush = callback;
			return true;
		}) as typeof process.stdout.write);
		const externalEditor = vi.mocked(editInExternalEditor).mockReset().mockResolvedValue({
			status: "complete",
			content: "edited",
		});
		const context: ExternalEditorThis = {
			settingsManager: { getExternalEditorCommand: () => "nvim" },
			editor: {
				getExpandedText: () => "original",
				getText: () => "collapsed",
				setText: vi.fn(),
			},
			ui: {
				stop: vi.fn(),
				start: vi.fn(),
				requestRender: vi.fn(),
				getScreenMode: () => "fullscreen",
			},
		};

		const editPromise = (
			interactiveModePrototype as InteractiveModePrototypeWithExternalEditor
		).handleOpenExternalEditor.call(context);

		expect(context.ui.stop).toHaveBeenCalledTimes(1);
		expect(externalEditor).not.toHaveBeenCalled();

		completeFlush?.();
		await editPromise;

		expect(externalEditor).toHaveBeenCalledWith({ command: "nvim", content: "original", announce: false });
		expect(context.editor.setText).toHaveBeenCalledWith("edited");
		expect(context.ui.start).toHaveBeenCalledTimes(1);
		expect(context.ui.requestRender).toHaveBeenCalledWith(true);
	});
});

type ExtensionEditorHandoffThis = {
	editor: {
		getText: () => string;
		setText: (text: string) => void;
	};
	tui: FakeUi & { getScreenMode: () => "fullscreen" | "inline" };
	externalEditorCommand: string;
};

type ExtensionEditorPrototypeWithExternalEditor = {
	handleOpenExternalEditor(this: ExtensionEditorHandoffThis): Promise<void>;
};

describe("ExtensionEditorComponent external-editor handoff", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
	});

	test("flushes restoration and suppresses the notice in fullscreen", async () => {
		setStdoutIsTTY(true);
		let completeFlush: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: string | Uint8Array, callback?: () => void) => {
			completeFlush = callback;
			return true;
		}) as typeof process.stdout.write);
		const externalEditor = vi.mocked(editInExternalEditor).mockReset().mockResolvedValue({
			status: "complete",
			content: "edited",
		});
		const context: ExtensionEditorHandoffThis = {
			editor: {
				getText: () => "original",
				setText: vi.fn(),
			},
			tui: {
				stop: vi.fn(),
				start: vi.fn(),
				requestRender: vi.fn(),
				getScreenMode: () => "fullscreen",
			},
			externalEditorCommand: "nvim",
		};

		const editPromise = (
			ExtensionEditorComponent.prototype as unknown as ExtensionEditorPrototypeWithExternalEditor
		).handleOpenExternalEditor.call(context);

		expect(context.tui.stop).toHaveBeenCalledTimes(1);
		expect(externalEditor).not.toHaveBeenCalled();

		completeFlush?.();
		await editPromise;

		expect(externalEditor).toHaveBeenCalledWith({ command: "nvim", content: "original", announce: false });
		expect(context.editor.setText).toHaveBeenCalledWith("edited");
		expect(context.tui.start).toHaveBeenCalledTimes(1);
		expect(context.tui.requestRender).toHaveBeenCalledWith(true);
	});
});
