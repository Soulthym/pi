import { Type } from "typebox";
import { matchesKey, Text, truncateToWidth } from "../../../../tui/src/index.ts";
import { CustomEditor, type ExtensionAPI } from "../../../src/index.ts";

class CompatibilityEditor extends CustomEditor {}

const parameters = Type.Object({ value: Type.String() });

type ToolState = {
	renders: number;
};

export default function fullscreenUiCompatibilityExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("fullscreen-compat-message", (message, { expanded }, theme) => {
		const suffix = expanded ? " expanded" : "";
		return new Text(theme.fg("accent", `${String(message.content)}${suffix}`), 1, 0);
	});

	pi.registerEntryRenderer<{ label: string }>("fullscreen-compat-entry", (entry, { expanded }, theme) => {
		const label = entry.data?.label ?? "missing";
		return new Text(theme.fg(expanded ? "accent" : "muted", label), 1, 0);
	});

	pi.registerTool<typeof parameters, { echoed: string }, ToolState>({
		name: "fullscreen_compat_tool",
		label: "Fullscreen compatibility tool",
		description: "Exercises extension tool rendering contracts.",
		parameters,
		async execute(_toolCallId, args) {
			return {
				content: [{ type: "text", text: args.value }],
				details: { echoed: args.value },
			};
		},
		renderCall(args, theme, context) {
			context.state.renders = (context.state.renders ?? 0) + 1;
			return new Text(theme.fg("accent", `${args.value}:${context.state.renders}`), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const status = isPartial ? "partial" : expanded ? "expanded" : "complete";
			return new Text(theme.fg("muted", `${status}:${result.details?.echoed ?? context.args.value}`), 0, 0);
		},
	});

	pi.on("session_start", (_event, context) => {
		if (context.mode !== "tui") return;

		context.ui.setHeader((_tui, theme) => new Text(theme.fg("accent", "compat header"), 1, 0));
		context.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose,
				invalidate() {},
				render() {
					const branch = footerData.getGitBranch() ?? "no branch";
					const statuses = Array.from(footerData.getExtensionStatuses().values());
					const suffix = statuses.length > 0 ? ` ${statuses.join(" ")}` : "";
					return [theme.fg("dim", `${branch}${suffix}`)];
				},
			};
		});
		context.ui.setWidget("compat-above", ["above"], { placement: "aboveEditor" });
		context.ui.setWidget("compat-below", (_tui, theme) => new Text(theme.fg("muted", "below"), 1, 0), {
			placement: "belowEditor",
		});
		context.ui.setEditorComponent((tui, theme, keybindings) => new CompatibilityEditor(tui, theme, keybindings));
		context.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "ctrl+up")) return;
			context.ui.setStatus("compat-input", "extension captured Ctrl+Up");
			return { consume: true };
		});
	});

	pi.registerCommand("fullscreen-compat-transcript", {
		description: "Exercise custom message and entry transcript rendering.",
		async handler() {
			pi.sendMessage({
				customType: "fullscreen-compat-message",
				content: "compat message",
				display: true,
			});
			pi.appendEntry("fullscreen-compat-entry", { label: "compat entry" });
		},
	});

	// ctx.ui.custom() focuses the returned root, so input handling must live on
	// that component rather than a child of Container, which does not forward it.
	pi.registerCommand("fullscreen-compat-custom", {
		description: "Exercise non-overlay custom UI rendering.",
		async handler(_args, context) {
			await context.ui.custom<void>((_tui, theme, _keybindings, done) => ({
				render: () => [theme.fg("accent", "compat custom UI"), "press any key"],
				handleInput: () => done(),
				invalidate() {},
			}));
		},
	});

	pi.registerCommand("fullscreen-compat-overlay", {
		description: "Exercise custom overlay rendering.",
		async handler(_args, context) {
			await context.ui.custom<void>(
				(_tui, theme, _keybindings, done) => ({
					render: (width) => {
						const innerWidth = Math.max(1, width - 2);
						const border = (text: string) => theme.fg("border", text);
						const line = (text: string) =>
							border("│") + truncateToWidth(text, innerWidth, "...", true) + border("│");
						return [
							border(`╭${"─".repeat(innerWidth)}╮`),
							line(theme.fg("accent", " compat overlay")),
							line(""),
							line(" press any key"),
							border(`╰${"─".repeat(innerWidth)}╯`),
						];
					},
					handleInput: () => done(),
					invalidate() {},
				}),
				{ overlay: true, overlayOptions: { width: "50%", maxHeight: "50%" } },
			);
		},
	});
}
