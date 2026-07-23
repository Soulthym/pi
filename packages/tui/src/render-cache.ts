import type { Component } from "./tui.ts";

type RenderCacheEntry = {
	epoch: number;
	width: number;
	version: number;
	lines: readonly string[];
};

export type RenderCacheResult = {
	lines: readonly string[];
	height: number;
	cacheHit: boolean;
};

/**
 * Opt-in render cache for callers that own a component's mutation version.
 *
 * Components without a version are rendered on every call. This is the
 * compatibility path for extension components that implement only the public
 * Component contract.
 */
export class ComponentRenderCache {
	private entries = new WeakMap<Component, RenderCacheEntry>();
	private epoch = 0;

	render(component: Component, width: number, version?: number): RenderCacheResult {
		if (version !== undefined) {
			const entry = this.entries.get(component);
			if (entry?.epoch === this.epoch && entry.width === width && entry.version === version) {
				return { lines: entry.lines, height: entry.lines.length, cacheHit: true };
			}
		}

		// Copy the array so later component mutations cannot alter the cached snapshot.
		const lines = component.render(width).slice();
		if (version !== undefined) {
			this.entries.set(component, { epoch: this.epoch, width, version, lines });
		}
		return { lines, height: lines.length, cacheHit: false };
	}

	invalidate(component: Component): void {
		this.entries.delete(component);
	}

	invalidateAll(): void {
		this.epoch += 1;
		this.entries = new WeakMap();
	}
}
