import type { Component } from "@earendil-works/pi-tui";
import type { TranscriptViewport } from "./transcript-viewport.ts";

export type FullscreenLayoutOptions = {
	getHeight: () => number;
	top: readonly Component[];
	transcript: TranscriptViewport;
	status: readonly Component[];
	widgetsAbove: readonly Component[];
	editor: Component;
	widgetsBelow: readonly Component[];
	footer: Component;
};

type RenderedRegions = {
	top: string[];
	status: string[];
	widgetsAbove: string[];
	editor: string[];
	widgetsBelow: string[];
	footer: string[];
};

/** Assigns a fixed terminal frame to coding-agent chrome and transcript rows. */
export class FullscreenLayout implements Component {
	private readonly getHeight: () => number;
	private readonly top: readonly Component[];
	private readonly transcript: TranscriptViewport;
	private readonly status: readonly Component[];
	private readonly widgetsAbove: readonly Component[];
	private readonly editor: Component;
	private readonly widgetsBelow: readonly Component[];
	private readonly footer: Component;

	constructor(options: FullscreenLayoutOptions) {
		this.getHeight = options.getHeight;
		this.top = options.top;
		this.transcript = options.transcript;
		this.status = options.status;
		this.widgetsAbove = options.widgetsAbove;
		this.editor = options.editor;
		this.widgetsBelow = options.widgetsBelow;
		this.footer = options.footer;
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.getHeight()));
		if (height === 0) {
			this.transcript.setViewportHeight(0);
			return [];
		}

		const regions: RenderedRegions = {
			top: this.renderComponents(this.top, width),
			status: this.renderComponents(this.status, width),
			widgetsAbove: this.renderComponents(this.widgetsAbove, width),
			editor: this.editor.render(width),
			widgetsBelow: this.renderComponents(this.widgetsBelow, width),
			footer: this.footer.render(width),
		};

		const requiredHeight = regions.editor.length + regions.footer.length;
		if (requiredHeight > height) {
			this.transcript.setViewportHeight(0);
			return this.renderTinyFrame(regions.editor, regions.footer, height);
		}

		// Hide optional regions in visual-distraction order when the terminal is
		// too small. Pending/status information is retained after headers/widgets.
		for (const region of ["top", "widgetsBelow", "widgetsAbove", "status"] as const) {
			if (this.getChromeHeight(regions) <= height) break;
			regions[region] = [];
		}

		const transcriptHeight = Math.max(0, height - this.getChromeHeight(regions));
		this.transcript.setViewportHeight(transcriptHeight);
		const transcriptLines = this.transcript.render(width).slice(0, transcriptHeight);
		const transcriptPadding = Array.from({ length: transcriptHeight - transcriptLines.length }, () => "");

		return [
			...regions.top,
			...transcriptLines,
			...transcriptPadding,
			...regions.status,
			...regions.widgetsAbove,
			...regions.editor,
			...regions.widgetsBelow,
			...regions.footer,
		];
	}

	invalidate(): void {
		const components = new Set<Component>([
			...this.top,
			this.transcript,
			...this.status,
			...this.widgetsAbove,
			this.editor,
			...this.widgetsBelow,
			this.footer,
		]);
		for (const component of components) component.invalidate();
	}

	private renderComponents(components: readonly Component[], width: number): string[] {
		const lines: string[] = [];
		for (const component of components) lines.push(...component.render(width));
		return lines;
	}

	private getChromeHeight(regions: RenderedRegions): number {
		return (
			regions.top.length +
			regions.status.length +
			regions.widgetsAbove.length +
			regions.editor.length +
			regions.widgetsBelow.length +
			regions.footer.length
		);
	}

	private renderTinyFrame(editorLines: string[], footerLines: string[], height: number): string[] {
		const footerHeight = Math.min(footerLines.length, 1, height);
		const editorHeight = Math.max(0, height - footerHeight);
		const visibleEditorLines = editorHeight === 0 ? [] : editorLines.slice(-editorHeight);
		return [...visibleEditorLines, ...footerLines.slice(-footerHeight)];
	}
}
