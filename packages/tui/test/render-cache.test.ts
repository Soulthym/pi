import assert from "node:assert";
import { describe, it } from "node:test";
import { ComponentRenderCache } from "../src/render-cache.ts";
import type { Component } from "../src/tui.ts";

class CountingComponent implements Component {
	lines: string[];
	renderCount = 0;

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		this.renderCount += 1;
		return this.lines;
	}

	invalidate(): void {}
}

describe("ComponentRenderCache", () => {
	it("reuses an identical component, width, and version", () => {
		const cache = new ComponentRenderCache();
		const component = new CountingComponent(["one", "two"]);

		const first = cache.render(component, 80, 0);
		const second = cache.render(component, 80, 0);

		assert.strictEqual(component.renderCount, 1);
		assert.strictEqual(first.cacheHit, false);
		assert.strictEqual(second.cacheHit, true);
		assert.strictEqual(second.height, 2);
		assert.deepStrictEqual(second.lines, ["one", "two"]);
	});

	it("renders again when width or version changes", () => {
		const cache = new ComponentRenderCache();
		const component = new CountingComponent(["content"]);

		cache.render(component, 80, 0);
		cache.render(component, 79, 0);
		cache.render(component, 79, 1);

		assert.strictEqual(component.renderCount, 3);
	});

	it("keeps component identities independent", () => {
		const cache = new ComponentRenderCache();
		const first = new CountingComponent(["first"]);
		const second = new CountingComponent(["second"]);

		cache.render(first, 80, 0);
		cache.render(second, 80, 0);
		cache.render(first, 80, 0);
		cache.render(second, 80, 0);

		assert.strictEqual(first.renderCount, 1);
		assert.strictEqual(second.renderCount, 1);
	});

	it("uses the compatibility path when no version is supplied", () => {
		const cache = new ComponentRenderCache();
		const component = new CountingComponent(["extension"]);

		cache.render(component, 80);
		cache.render(component, 80);

		assert.strictEqual(component.renderCount, 2);
	});

	it("invalidates one component or the complete epoch", () => {
		const cache = new ComponentRenderCache();
		const first = new CountingComponent(["first"]);
		const second = new CountingComponent(["second"]);

		cache.render(first, 80, 0);
		cache.render(second, 80, 0);
		cache.invalidate(first);
		cache.render(first, 80, 0);
		cache.render(second, 80, 0);
		cache.invalidateAll();
		cache.render(first, 80, 0);
		cache.render(second, 80, 0);

		assert.strictEqual(first.renderCount, 3);
		assert.strictEqual(second.renderCount, 2);
	});

	it("isolates cached lines from the component's mutable array", () => {
		const cache = new ComponentRenderCache();
		const source = ["before"];
		const component = new CountingComponent(source);

		cache.render(component, 80, 0);
		source[0] = "after";
		const cached = cache.render(component, 80, 0);

		assert.deepStrictEqual(cached.lines, ["before"]);
		assert.strictEqual(component.renderCount, 1);
	});
});
