import type { Database } from "bun:sqlite";

/** Read-only projection over edges durably admitted by CrawlQueue. */
export function createCrawlGraphRepo(db: Database) {
	const edges = db.prepare<{ source: string; target: string; depth: number }, [string]>(`
    SELECT source_url AS source, target_url AS target, depth
    FROM crawl_graph_edges
    WHERE crawl_id = ?
    ORDER BY depth ASC, source_url ASC, target_url ASC
  `);

	return {
		list(crawlId: string) {
			const result = edges.all(crawlId);
			return { edges: result, count: result.length };
		},
	};
}
