import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { ComponentRenderCache } from "./render-cache.ts";
import type { TranscriptItemInvalidationHandler } from "./transcript-viewport.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

type RenderBlockDefinition = {
	key: string;
	content: string;
	create: (content: string) => Component;
};

type RenderBlockState = {
	content: string;
	component: Component;
};

class RenderChunkContainer extends Container {
	private readonly renderCache = new ComponentRenderCache();

	override invalidate(): void {
		super.invalidate();
		this.renderCache.invalidateAll();
	}

	override render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			// Reconciliation replaces changed blocks, so a retained child identity
			// is immutable until explicit global invalidation clears this cache.
			for (const line of this.renderCache.render(child, width, 0).lines) lines.push(line);
		}
		return lines;
	}
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: RenderChunkContainer;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private transcriptInvalidationHandler: TranscriptItemInvalidationHandler;
	private renderBlocks = new Map<string, RenderBlockState>();

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;

		// Container for text/thinking content
		this.contentContainer = new RenderChunkContainer();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	setTranscriptInvalidationHandler(handler: TranscriptItemInvalidationHandler): void {
		this.transcriptInvalidationHandler = handler;
	}

	override invalidate(): void {
		super.invalidate();
		this.renderBlocks.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.renderBlocks.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		this.renderBlocks.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.renderBlocks.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage): void {
		this.lastMessage = message;
		const blocks: RenderBlockDefinition[] = [];

		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			blocks.push({
				key: "leading-spacer",
				content: "",
				create: () => new Spacer(1),
			});
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				blocks.push({
					key: `text:${i}`,
					content: content.text.trim(),
					create: (text) => new Markdown(text, this.outputPad, 0, this.markdownTheme),
				});
			} else if (content.type === "thinking") {
				const thinkingStart = i;
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					blocks.push({
						key: `thinking-hidden:${thinkingStart}`,
						content: this.hiddenThinkingLabel,
						create: (text) => new Text(theme.italic(theme.fg("thinkingText", text)), this.outputPad, 0),
					});
				} else {
					// Render each run of thinking blocks as one Markdown section.
					blocks.push({
						key: `thinking:${thinkingStart}`,
						content: thinkingBlocks.join("\n\n"),
						create: (text) =>
							new Markdown(text, this.outputPad, 0, this.markdownTheme, {
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							}),
					});
				}
				if (hasVisibleContentAfter) {
					blocks.push({
						key: `thinking-spacer:${thinkingStart}`,
						content: "",
						create: () => new Spacer(1),
					});
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			blocks.push({
				key: "length-spacer",
				content: "",
				create: () => new Spacer(1),
			});
			blocks.push({
				key: "length-error",
				content:
					"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
				create: (text) => new Text(theme.fg("error", text), this.outputPad, 0),
			});
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				blocks.push({
					key: "stop-error-spacer",
					content: "",
					create: () => new Spacer(1),
				});
				blocks.push({
					key: "stop-error",
					content: abortMessage,
					create: (text) => new Text(theme.fg("error", text), this.outputPad, 0),
				});
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				blocks.push({
					key: "stop-error-spacer",
					content: "",
					create: () => new Spacer(1),
				});
				blocks.push({
					key: "stop-error",
					content: `Error: ${errorMsg}`,
					create: (text) => new Text(theme.fg("error", text), this.outputPad, 0),
				});
			}
		}
		this.reconcileRenderBlocks(blocks);
		this.transcriptInvalidationHandler?.();
	}

	private reconcileRenderBlocks(blocks: readonly RenderBlockDefinition[]): void {
		const previousBlocks = this.renderBlocks;
		const nextBlocks = new Map<string, RenderBlockState>();
		this.contentContainer.clear();

		for (const block of blocks) {
			const previous = previousBlocks.get(block.key);
			const component = previous?.content === block.content ? previous.component : block.create(block.content);
			nextBlocks.set(block.key, { content: block.content, component });
			this.contentContainer.addChild(component);
		}

		this.renderBlocks = nextBlocks;
	}
}
