import { describe, expect, test } from "bun:test";
import { layoutCrawlGraph } from "../crawlGraphLayout";

describe("crawl graph projection", () => {
	const root = "https://example.com/";
	const edges = [
		{ source: root, target: `${root}a`, depth: 1 },
		{ source: root, target: `${root}b`, depth: 1 },
		{ source: `${root}a`, target: `${root}c`, depth: 2 },
	];
	test("keeps the seed, durable parent-child links, and deterministic coordinates", () => {
		const layout = layoutCrawlGraph(root, edges);
		expect(layout.nodes.map(({ url }) => url)).toEqual([root, `${root}a`, `${root}b`, `${root}c`]);
		expect(layout.links).toHaveLength(3);
		expect(layout.nodes[0]?.x).toBeLessThan(layout.nodes[1]?.x ?? 0);
		expect(layout.nodes[1]?.x).toBe(layout.nodes[2]?.x);
		expect(layoutCrawlGraph(root, [...edges].reverse())).toEqual(layout);
	});

	test("caps rendered links without losing the true discovered count", () => {
		const wide = Array.from({ length: 120 }, (_, index) => ({
			source: root,
			target: `${root}child-${index}`,
			depth: 1,
		}));
		const layout = layoutCrawlGraph(root, wide);
		expect(layout.nodes.length).toBeLessThanOrEqual(40);
		expect(layout.totalEdges).toBe(120);
		expect(layout.hiddenNodes).toBeGreaterThan(0);
		expect(
			layout.links.every((link) => layout.nodes.some((node) => node.url === link.target)),
		).toBe(true);
	});

	test("handles a seed without admitted links or graph cycles", () => {
		const seed = layoutCrawlGraph(root, []);
		expect(seed.nodes).toEqual([expect.objectContaining({ url: root, depth: 0 })]);
		expect(seed.links).toEqual([]);
		expect(seed.nodes[0]?.x).toBe(seed.width / 2);
		const cyclic = layoutCrawlGraph(root, [
			{ source: root, target: `${root}a`, depth: 1 },
			{ source: `${root}a`, target: root, depth: 2 },
		]);
		expect(cyclic.nodes).toHaveLength(2);
	});
});
