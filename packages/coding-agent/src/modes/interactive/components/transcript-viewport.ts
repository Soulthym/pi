import { type Component, ComponentRenderCache, Container } from "@earendil-works/pi-tui";

export type TranscriptViewportOptions = {
	height?: number;
	overscanRows?: number;
	maxCachedLines?: number;
};

type ItemState = {
	version: number;
	measuredWidth: number | undefined;
	measuredHeight: number | undefined;
	cachedLineCount: number;
	lastUsed: number;
};

type ViewportAnchor = {
	component: Component;
	lineOffset: number;
};

type RenderedItem = {
	component: Component;
	lines: readonly string[];
	lineOffset: number;
};

/**
 * Height-aware transcript container with caller-owned item invalidation.
 *
 * Component identity is the stable item identity. The live-edge path renders
 * backward from the newest item and stops after the viewport plus overscan is
 * filled, so old transcript items are neither rendered nor measured.
 */
export class TranscriptViewport extends Container {
	private readonly cache = new ComponentRenderCache();
	private readonly itemStates = new Map<Component, ItemState>();
	private readonly itemIndices = new Map<Component, number>();
	private viewportHeight: number;
	private overscanRows: number | undefined;
	private maxCachedLines: number | undefined;
	private totalCachedLines = 0;
	private useCounter = 0;
	private anchor: ViewportAnchor | undefined;
	private lastFrameTop: ViewportAnchor | undefined;
	private lastWidth: number | undefined;

	constructor(options: TranscriptViewportOptions = {}) {
		super();
		this.viewportHeight = this.normalizeRowCount(options.height ?? 0);
		this.overscanRows = options.overscanRows === undefined ? undefined : this.normalizeRowCount(options.overscanRows);
		this.maxCachedLines =
			options.maxCachedLines === undefined ? undefined : this.normalizeRowCount(options.maxCachedLines);
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.itemIndices.set(component, this.children.length - 1);
		this.ensureItemState(component);
	}

	insertChildBefore(component: Component, before: Component): void {
		const index = this.children.indexOf(before);
		if (index === -1) {
			this.addChild(component);
			return;
		}
		this.children.splice(index, 0, component);
		this.ensureItemState(component);
		this.reindexFrom(index);
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;

		if (this.anchor?.component === component) {
			const replacement = this.children[index + 1] ?? this.children[index - 1];
			this.anchor = replacement ? { component: replacement, lineOffset: 0 } : undefined;
		}
		if (this.lastFrameTop?.component === component) {
			this.lastFrameTop = undefined;
		}
		this.children.splice(index, 1);
		this.dropItem(component);
		this.reindexFrom(index);
	}

	override clear(): void {
		this.children = [];
		this.cache.invalidateAll();
		this.itemStates.clear();
		this.itemIndices.clear();
		this.totalCachedLines = 0;
		this.anchor = undefined;
		this.lastFrameTop = undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.cache.invalidateAll();
		this.totalCachedLines = 0;
		for (const state of this.itemStates.values()) {
			state.version += 1;
			state.measuredWidth = undefined;
			state.measuredHeight = undefined;
			state.cachedLineCount = 0;
		}
	}

	invalidateItem(component: Component): void {
		const state = this.ensureItemState(component);
		state.version += 1;
		state.measuredWidth = undefined;
		state.measuredHeight = undefined;
		this.totalCachedLines -= state.cachedLineCount;
		state.cachedLineCount = 0;
		this.cache.invalidate(component);
	}

	setViewportHeight(height: number): void {
		this.viewportHeight = this.normalizeRowCount(height);
	}

	getViewportHeight(): number {
		return this.viewportHeight;
	}

	setOverscanRows(rows: number | undefined): void {
		this.overscanRows = rows === undefined ? undefined : this.normalizeRowCount(rows);
	}

	setMaxCachedLines(lines: number | undefined): void {
		this.maxCachedLines = lines === undefined ? undefined : this.normalizeRowCount(lines);
		this.evictInactiveItems(new Set());
	}

	getCachedLineCount(): number {
		return this.totalCachedLines;
	}

	isFollowingTail(): boolean {
		return this.anchor === undefined;
	}

	scrollToTop(): void {
		const first = this.children[0];
		this.anchor = first ? { component: first, lineOffset: 0 } : undefined;
	}

	scrollToBottom(): void {
		this.anchor = undefined;
	}

	scrollByLines(lines: number): void {
		if (lines === 0 || this.lastWidth === undefined || this.children.length === 0) return;
		const startingAnchor = this.anchor ?? this.lastFrameTop;
		if (!startingAnchor) return;

		this.anchor =
			lines < 0
				? this.moveAnchorUp(startingAnchor, -lines, this.lastWidth)
				: this.moveAnchorDown(startingAnchor, lines, this.lastWidth);
	}

	override render(width: number): string[] {
		this.lastWidth = width;
		if (this.viewportHeight === 0 || this.children.length === 0) {
			this.lastFrameTop = undefined;
			this.evictInactiveItems(new Set());
			return [];
		}

		const activeItems = new Set<Component>();
		const lines = this.anchor ? this.renderFromAnchor(width, activeItems) : this.renderFromTail(width, activeItems);
		this.evictInactiveItems(activeItems);
		return lines;
	}

	private renderFromTail(width: number, activeItems: Set<Component>): string[] {
		const targetRows = this.viewportHeight + this.getOverscanRows();
		const rendered: RenderedItem[] = [];
		let renderedRows = 0;

		for (let index = this.children.length - 1; index >= 0 && renderedRows < targetRows; index--) {
			const component = this.children[index];
			const lines = this.renderItem(component, width);
			activeItems.add(component);
			rendered.unshift({ component, lines, lineOffset: 0 });
			renderedRows += lines.length;
		}

		const allLines = this.flattenRenderedItems(rendered);
		const visibleLines = allLines.slice(-this.viewportHeight);
		this.lastFrameTop = this.findTopAnchor(rendered, allLines.length - visibleLines.length);
		return visibleLines;
	}

	private renderFromAnchor(width: number, activeItems: Set<Component>): string[] {
		const anchor = this.anchor;
		if (!anchor) return this.renderFromTail(width, activeItems);
		const anchorIndex = this.resolveItemIndex(anchor.component);
		if (anchorIndex === -1) {
			this.anchor = undefined;
			return this.renderFromTail(width, activeItems);
		}

		const targetRows = this.viewportHeight + this.getOverscanRows();
		const rendered: RenderedItem[] = [];
		let renderedRows = 0;
		let lastRenderedIndex = anchorIndex - 1;

		for (let index = anchorIndex; index < this.children.length && renderedRows < targetRows; index++) {
			const component = this.children[index];
			const lines = this.renderItem(component, width);
			const lineOffset = index === anchorIndex ? Math.min(anchor.lineOffset, lines.length) : 0;
			activeItems.add(component);
			rendered.push({ component, lines, lineOffset });
			renderedRows += Math.max(0, lines.length - lineOffset);
			lastRenderedIndex = index;
		}

		const allLines = this.flattenRenderedItems(rendered);
		const visibleLines = allLines.slice(0, this.viewportHeight);
		this.lastFrameTop = this.findTopAnchor(rendered, 0);
		if (lastRenderedIndex === this.children.length - 1 && allLines.length <= this.viewportHeight) {
			this.anchor = undefined;
			return this.renderFromTail(width, activeItems);
		}
		return visibleLines;
	}

	private renderItem(component: Component, width: number): readonly string[] {
		const state = this.ensureItemState(component);
		const result = this.cache.render(component, width, state.version);
		state.lastUsed = ++this.useCounter;
		state.measuredWidth = width;
		state.measuredHeight = result.height;
		if (!result.cacheHit) {
			this.totalCachedLines -= state.cachedLineCount;
			state.cachedLineCount = result.height;
			this.totalCachedLines += state.cachedLineCount;
		}
		return result.lines;
	}

	private flattenRenderedItems(rendered: RenderedItem[]): string[] {
		const lines: string[] = [];
		for (const item of rendered) {
			for (let line = item.lineOffset; line < item.lines.length; line++) {
				lines.push(item.lines[line]);
			}
		}
		return lines;
	}

	private findTopAnchor(rendered: RenderedItem[], skippedRows: number): ViewportAnchor | undefined {
		let remaining = skippedRows;
		for (const item of rendered) {
			const availableRows = Math.max(0, item.lines.length - item.lineOffset);
			if (remaining >= availableRows) {
				remaining -= availableRows;
				continue;
			}
			return { component: item.component, lineOffset: item.lineOffset + remaining };
		}
		return undefined;
	}

	private moveAnchorUp(anchor: ViewportAnchor, rows: number, width: number): ViewportAnchor {
		let index = this.resolveItemIndex(anchor.component);
		if (index === -1) return anchor;
		let offset = Math.min(anchor.lineOffset, this.renderItem(this.children[index], width).length);
		let remaining = rows;

		while (remaining > 0) {
			if (offset >= remaining) {
				offset -= remaining;
				break;
			}
			remaining -= offset;
			index -= 1;
			if (index < 0) {
				index = 0;
				offset = 0;
				break;
			}
			offset = this.renderItem(this.children[index], width).length;
		}
		return { component: this.children[index], lineOffset: offset };
	}

	private moveAnchorDown(anchor: ViewportAnchor, rows: number, width: number): ViewportAnchor {
		let index = this.resolveItemIndex(anchor.component);
		if (index === -1) return anchor;
		let offset = Math.min(anchor.lineOffset, this.renderItem(this.children[index], width).length);
		let remaining = rows;

		while (remaining > 0) {
			const lines = this.renderItem(this.children[index], width);
			const availableRows = Math.max(0, lines.length - offset);
			if (availableRows >= remaining) {
				offset += remaining;
				break;
			}
			remaining -= availableRows;
			index += 1;
			if (index >= this.children.length) {
				index = this.children.length - 1;
				offset = this.renderItem(this.children[index], width).length;
				break;
			}
			offset = 0;
		}
		return { component: this.children[index], lineOffset: offset };
	}

	private ensureItemState(component: Component): ItemState {
		let state = this.itemStates.get(component);
		if (!state) {
			state = {
				version: 0,
				measuredWidth: undefined,
				measuredHeight: undefined,
				cachedLineCount: 0,
				lastUsed: 0,
			};
			this.itemStates.set(component, state);
		}
		return state;
	}

	private dropItem(component: Component): void {
		const state = this.itemStates.get(component);
		if (state) {
			this.totalCachedLines -= state.cachedLineCount;
		}
		this.cache.invalidate(component);
		this.itemStates.delete(component);
		this.itemIndices.delete(component);
	}

	private evictInactiveItems(activeItems: Set<Component>): void {
		const budget = this.maxCachedLines ?? Math.max(1, this.viewportHeight * 4);
		if (this.totalCachedLines <= budget) return;

		const candidates = [...this.itemStates.entries()]
			.filter(([component, state]) => state.cachedLineCount > 0 && !activeItems.has(component))
			.sort((first, second) => first[1].lastUsed - second[1].lastUsed);
		for (const [component, state] of candidates) {
			if (this.totalCachedLines <= budget) break;
			this.cache.invalidate(component);
			this.totalCachedLines -= state.cachedLineCount;
			state.cachedLineCount = 0;
		}
	}

	private resolveItemIndex(component: Component): number {
		const indexed = this.itemIndices.get(component);
		if (indexed !== undefined && this.children[indexed] === component) return indexed;
		const actual = this.children.indexOf(component);
		if (actual !== -1) this.itemIndices.set(component, actual);
		return actual;
	}

	private reindexFrom(start: number): void {
		for (let index = start; index < this.children.length; index++) {
			this.itemIndices.set(this.children[index], index);
		}
	}

	private getOverscanRows(): number {
		return this.overscanRows ?? this.viewportHeight;
	}

	private normalizeRowCount(value: number): number {
		return Math.max(0, Math.floor(value));
	}
}
