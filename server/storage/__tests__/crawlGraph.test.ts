import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createCrawlOptionsFixture,
	createInMemoryStorage,
	getTestDatabase,
} from "../../__tests__/storageFixture.js";
import { createStorage } from "../db.js";

describe("durable admitted crawl graph", () => {
	test("persists each admitted parent-child edge beyond queue completion, without duplicate edges", () => {
		const storage = createInMemoryStorage();
		try {
			storage.repos.crawlRuns.createRun("graph", createCrawlOptionsFixture());
			const child = {
				url: "https://example.com/child",
				depth: 1,
				domain: "example.com",
				retries: 0,
				availableAt: 0,
				parentUrl: "https://example.com/",
			};
			storage.repos.crawlQueue.enqueueMany("graph", [child]);
			expect(storage.repos.graph.list("graph")).toEqual({
				edges: [{ source: "https://example.com/", target: child.url, depth: 1 }],
				count: 1,
			});
			getTestDatabase(storage)
				.query("DELETE FROM crawl_queue_items WHERE crawl_id = ? AND url = ?")
				.run("graph", child.url);
			expect(storage.repos.graph.list("graph").edges).toHaveLength(1);
			storage.repos.crawlRuns.transition("graph", "completed", { stopReason: null });
			expect(storage.repos.graph.list("graph").edges).toHaveLength(1);
			storage.repos.crawlRuns.deleteRun("graph");
			expect(storage.repos.graph.list("graph")).toEqual({ edges: [], count: 0 });
		} finally {
			storage.close();
		}
	});

	test("migrates an exact legacy schema additively, preserving a stored crawl", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "miku-graph-upgrade-"));
		const dbPath = path.join(dir, "crawler.db");
		try {
			const old = new Database(dbPath);
			old.exec(readFileSync(path.join(import.meta.dir, "..", "schema.sql"), "utf8"));
			const oldOptions = createCrawlOptionsFixture();
			old
				.query("INSERT INTO crawl_runs (id, status, options_json) VALUES (?, ?, ?)")
				.run("preserved", "paused", JSON.stringify(oldOptions));
			old.close();
			const migrated = createStorage(dbPath);
			try {
				expect(migrated.repos.crawlRuns.getById("preserved")?.status).toBe("paused");
				expect(migrated.repos.graph.list("preserved")).toEqual({ edges: [], count: 0 });
			} finally {
				migrated.close();
			}
			const reopened = createStorage(dbPath);
			try {
				expect(reopened.repos.crawlRuns.getById("preserved")?.status).toBe("paused");
			} finally {
				reopened.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("failed queue insertion rolls back graph changes atomically", () => {
		const storage = createInMemoryStorage();
		try {
			storage.repos.crawlRuns.createRun("graph", createCrawlOptionsFixture());
			const child = {
				url: "https://example.com/child",
				depth: 1,
				domain: "example.com",
				retries: 0,
				availableAt: 0,
				parentUrl: "https://example.com/",
			};
			expect(() => storage.repos.crawlQueue.enqueueMany("graph", [child, child])).toThrow();
			expect(storage.repos.graph.list("graph")).toEqual({ edges: [], count: 0 });
		} finally {
			storage.close();
		}
	});
});
