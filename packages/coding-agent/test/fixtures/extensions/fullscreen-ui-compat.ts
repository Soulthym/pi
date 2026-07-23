import { Type } from "typebox";
import { Container, Spacer, Text } from "../../../../tui/src/index.ts";
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
		context.ui.setFooter((_tui, theme, footerData) => {
			const footer = new Text(theme.fg("dim", footerData.getGitBranch() ?? "no branch"), 1, 0);
			return Object.assign(footer, { dispose: footerData.onBranchChange(() => {}) });
		});
		context.ui.setWidget("compat-above", ["above"], { placement: "aboveEditor" });
		context.ui.setWidget("compat-below", (_tui, theme) => new Text(theme.fg("muted", "below"), 1, 0), {
			placement: "belowEditor",
		});
		context.ui.setEditorComponent((tui, theme, keybindings) => new CompatibilityEditor(tui, theme, keybindings));
	});

	pi.registerCommand("fullscreen-compat-overlay", {
		description: "Exercise custom overlay rendering.",
		async handler(_args, context) {
			await context.ui.custom<void>(
				(_tui, theme, _keybindings, done) => {
					const component = new Container();
					component.addChild(new Text(theme.fg("accent", "compat overlay"), 1, 0));
					component.addChild(new Spacer(1));
					component.addChild({
						render: () => ["press any key"],
						handleInput: () => done(),
						invalidate() {},
					});
					return component;
				},
				{ overlay: true, overlayOptions: { width: "50%", maxHeight: "50%" } },
			);
		},
	});
}
