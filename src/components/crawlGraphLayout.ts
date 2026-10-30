import type { CrawlGraphResponse } from "../../shared/contracts/index.js";

const MAX_VISIBLE_NODES = 40;
const COLUMN_GAP = 185;
const ROW_GAP = 64;

export interface GraphNode {
	url: string;
	depth: number;
	x: number;
	y: number;
}

export interface CrawlGraphLayout {
	nodes: GraphNode[];
	links: CrawlGraphResponse["edges"];
	width: number;
	height: number;
	totalEdges: number;
	hiddenNodes: number;
}

/**
 * Stable, bounded breadth/depth layout of admitted traversal links.
 * It never infers edges, even when a page links to a previously visited URL.
 */
export function layoutCrawlGraph(
	seedUrl: string,
	edges: CrawlGraphResponse["edges"],
): CrawlGraphLayout {
	const ordered = [...edges].sort(
		(a, b) =>
			a.depth - b.depth || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
	);
	const depths = new Map<string, number>([[seedUrl, 0]]);
	for (const edge of ordered) {
		if (!depths.has(edge.source)) continue;
		if (depths.has(edge.target)) continue;
		if (depths.size >= MAX_VISIBLE_NODES) break;
		depths.set(edge.target, edge.depth);
	}
	const groups = new Map<number, string[]>();
	for (const [url, depth] of depths) {
		const urls = groups.get(depth) ?? [];
		urls.push(url);
		groups.set(depth, urls);
	}
	const maxDepth = Math.max(...groups.keys(), 0);
	const width = Math.max(940, maxDepth * COLUMN_GAP + 180);
	const maxRows = Math.max(...Array.from(groups.values(), (urls) => urls.length), 1);
	const height = Math.max(290, maxRows * ROW_GAP + 70);
	const nodes = [...groups].flatMap(([depth, urls]) =>
		urls.map((url, index) => ({
			url,
			depth,
			x: maxDepth === 0 ? width / 2 : 90 + depth * ((width - 180) / maxDepth),
			y: ((index + 1) * height) / (urls.length + 1),
		})),
	);
	const visible = new Set(depths.keys());
	return {
		nodes,
		links: ordered.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
		width,
		height,
		totalEdges: edges.length,
		hiddenNodes: Math.max(
			0,
			new Set([seedUrl, ...edges.map((edge) => edge.target)]).size - nodes.length,
		),
	};
}
