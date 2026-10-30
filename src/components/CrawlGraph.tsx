import { AlertTriangle, GitBranch, LoaderCircle, Radar } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CrawledPage, CrawlGraphResponse } from "../../shared/contracts/index.js";
import { getCrawlGraph } from "../api/crawls";
import { layoutCrawlGraph } from "./crawlGraphLayout";

interface CrawlGraphProps {
	crawlId: string | null;
	target: string;
	revision: number;
	pages: CrawledPage[];
	isRunning: boolean;
}

function pageLabel(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? parsed.hostname : parsed.pathname;
		return path.length > 22 ? `${path.slice(0, 19)}…` : path;
	} catch {
		return url.slice(0, 22);
	}
}

/** Spider marks the last persisted page, never an inferred in-flight request. */
export function CrawlGraph({ crawlId, target, revision, pages, isRunning }: CrawlGraphProps) {
	const [result, setResult] = useState<{
		crawlId: string;
		revision: number;
		graph: CrawlGraphResponse;
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadingId, setLoadingId] = useState<string | null>(null);
	const [selection, setSelection] = useState<string | null>(null);
	useEffect(() => {
		if (!crawlId) return;
		const controller = new AbortController();
		// Coalesce bursty crawl events to avoid request storms against the local API.
		const task = setTimeout(async () => {
			setLoadingId(crawlId);
			try {
				const response = await getCrawlGraph(crawlId, controller.signal);
				if (controller.signal.aborted) return;
				if (response.ok) {
					setResult({ crawlId, revision, graph: response.data });
					setError(null);
				} else {
					setError(response.error);
				}
			} catch {
				if (!controller.signal.aborted) setError("Could not retrieve the saved crawl graph");
			} finally {
				if (!controller.signal.aborted) setLoadingId(null);
			}
		}, 450);
		return () => {
			clearTimeout(task);
			controller.abort();
		};
	}, [crawlId, revision]);

	const graph = result?.crawlId === crawlId && result.revision <= revision ? result.graph : null;
	const layout = useMemo(() => layoutCrawlGraph(target, graph?.edges ?? []), [target, graph]);
	const nodesByUrl = useMemo(
		() => new Map(layout.nodes.map((node) => [node.url, node])),
		[layout.nodes],
	);
	const visited = useMemo(() => new Set(pages.map((page) => page.url)), [pages]);
	const latest = pages.find((page) => nodesByUrl.has(page.url))?.url;
	const spiderAt = nodesByUrl.get(latest ?? target) ?? layout.nodes[0];
	const selectedUrl = selection && nodesByUrl.has(selection) ? selection : (latest ?? target);
	const selectedNode = nodesByUrl.get(selectedUrl);
	const active = Boolean(crawlId);
	const lastSavedLabel = latest ? pageLabel(latest) : "Seed page";

	return (
		<section aria-label="Live crawl graph" className="glass-panel p-5">
			<div className="flex flex-wrap items-center justify-between gap-3 mb-3">
				<div className="flex items-center gap-2">
					<GitBranch size={18} className="text-miku-accent" aria-hidden="true" />
					<div>
						<h2 className="text-base font-bold text-miku-accent">Crawl map</h2>
						<p className="text-xs text-miku-text/75">
							Admitted page paths. Spider follows the last saved page.
						</p>
					</div>
				</div>
				<div className="flex items-center gap-3 text-xs text-miku-text">
					<span>{graph?.count ?? 0} accepted links</span>
					{crawlId !== null && loadingId === crawlId && (
						<span className="inline-flex items-center gap-1" role="status">
							<LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> Refreshing
						</span>
					)}
				</div>
			</div>

			{!active ? (
				<div className="h-44 rounded-xl border border-dashed border-miku-border flex flex-col justify-center items-center gap-2 text-miku-text/70">
					<Radar size={25} aria-hidden="true" />
					<p className="text-sm">Start a crawl to map the accepted page paths.</p>
				</div>
			) : (
				<>
					{error && (
						<p role="alert" className="text-sm text-red-700 flex items-center gap-2 mb-2">
							<AlertTriangle size={14} aria-hidden="true" /> {error}
						</p>
					)}
					<div className="relative rounded-xl border border-miku-border/80 bg-white/70 overflow-auto h-80">
						<svg
							role="img"
							aria-label={`Crawl traversal graph with ${layout.nodes.length} visible pages and ${layout.links.length} links`}
							xmlns="http://www.w3.org/2000/svg"
							viewBox={`0 0 ${layout.width} ${layout.height}`}
							width={layout.width}
							height={layout.height}
							className="max-w-none"
						>
							<defs>
								<pattern id="crawl-graph-dots" width="24" height="24" patternUnits="userSpaceOnUse">
									<circle cx="2" cy="2" r="1" fill="#cbd4ef" opacity=".7" />
								</pattern>
							</defs>
							<rect width={layout.width} height={layout.height} fill="url(#crawl-graph-dots)" />
							{layout.links.map((edge) => {
								const from = nodesByUrl.get(edge.source);
								const to = nodesByUrl.get(edge.target);
								if (!from || !to) return null;
								return (
									<path
										key={`${edge.source}\n${edge.target}`}
										d={`M${from.x},${from.y} C${from.x + 95},${from.y} ${to.x - 95},${to.y} ${to.x},${to.y}`}
										fill="none"
										stroke="#a8afe7"
										strokeWidth="2.2"
										strokeOpacity=".8"
									/>
								);
							})}
							{layout.nodes.map((node) => {
								const isVisited = visited.has(node.url);
								const isSelected = node.url === selectedUrl;
								return (
									<g
										key={node.url}
										transform={`translate(${node.x},${node.y})`}
										className="pointer-events-none"
									>
										<circle
											r={isSelected ? 19 : 15}
											fill={isVisited ? "#69c9e5" : "#e9e8fa"}
											stroke={isSelected ? "#776ddf" : "#a2a4eb"}
											strokeWidth={isSelected ? 3 : 1.5}
										/>
										<circle r="4.5" fill={isVisited ? "#fff" : "#776ddf"} />
										<text
											y="34"
											textAnchor="middle"
											fill="#646b98"
											fontSize="10.5"
											fontWeight="600"
										>
											{pageLabel(node.url)}
										</text>
									</g>
								);
							})}
							{spiderAt && (
								<g
									transform={`translate(${spiderAt.x},${spiderAt.y - 26})`}
									style={{
										transition: "transform 720ms cubic-bezier(.22,.8,.24,1)",
										pointerEvents: "none",
									}}
								>
									<g
										className={isRunning ? "crawl-spider-legs-active" : ""}
										fill="none"
										stroke="#635bb5"
										strokeWidth="2.8"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<g className="crawl-spider-legs-left">
											<path d="M-4,-4 L-13,-13 L-21,-9 M-7,-1 L-19,-5 L-25,1 M-7,4 L-19,9 L-25,13 M-3,8 L-12,17 L-19,19" />
										</g>
										<g className="crawl-spider-legs-right">
											<path d="M4,-4 L13,-13 L21,-9 M7,-1 L19,-5 L25,1 M7,4 L19,9 L25,13 M3,8 L12,17 L19,19" />
										</g>
									</g>
									<ellipse rx="10" ry="11" fill="#776ddf" stroke="#fff" strokeWidth="1.5" />
									<circle cx="-3" cy="-3" r="2" fill="white" />
									<circle cx="3" cy="-3" r="2" fill="white" />
								</g>
							)}
						</svg>
					</div>
					<div className="mt-3 flex flex-wrap items-start justify-between gap-3 text-xs text-miku-text">
						<div className="min-w-0">
							<label htmlFor="crawl-graph-selection" className="font-bold text-miku-accent">
								Selected page
							</label>
							<select
								id="crawl-graph-selection"
								className="block max-w-full rounded-md border border-miku-border bg-white p-1 mt-1"
								value={selectedUrl}
								onChange={(event) => setSelection(event.target.value)}
							>
								{layout.nodes.map((node) => (
									<option value={node.url} key={node.url}>
										{pageLabel(node.url)}
									</option>
								))}
							</select>
							<p className="break-all mt-1">{selectedNode?.url ?? target}</p>
							<span className="text-miku-text/70">
								Depth {selectedNode?.depth ?? 0} ·{" "}
								{visited.has(selectedUrl) ? "Stored" : "Not stored"}
							</span>
						</div>
						<div className="text-right">
							<span>Spider: {lastSavedLabel}</span>
							{layout.hiddenNodes > 0 && <p>{layout.hiddenNodes} more nodes omitted from view</p>}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
