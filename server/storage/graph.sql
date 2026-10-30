-- Admitted parent-child traversal edges survive queue completion and resume.
-- Only successfully scheduled URLs are recorded; this is not a graph of every
-- hyperlink encountered, nor a record of rejected/nofollow destinations.
CREATE TABLE crawl_graph_edges (
  crawl_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  target_url TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK(depth >= 1 AND depth <= 5),
  PRIMARY KEY (crawl_id, source_url, target_url),
  FOREIGN KEY (crawl_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
) WITHOUT ROWID;
