import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorOptions {
	command: string;
	content: string;
	/** Inline callers announce the handoff; fullscreen callers suppress it to keep the primary screen clean. */
	announce?: boolean;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

const TERMINAL_OUTPUT_FLUSH_TIMEOUT_MS = 1000;

export async function flushTerminalOutput(): Promise<void> {
	if (!process.stdout.isTTY) return;

	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve();
		};
		const timeout = setTimeout(finish, TERMINAL_OUTPUT_FLUSH_TIMEOUT_MS);

		try {
			// A non-empty final write is a stream-ordering barrier; a terminal
			// handoff or process exit may otherwise overtake restoration writes.
			process.stdout.write("\x1b[0m", finish);
		} catch {
			finish();
		}
	});
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = options.command.split(" ");
		if (options.announce !== false) {
			process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);
		}

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: readFileSync(filePath, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
