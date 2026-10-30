// biome-ignore-all lint/suspicious/noConsole: This CLI harness must emit diagnostics and a JSON verification receipt.
/**
 * Real browser/UI smoke against a disposable local Miku server.
 * Does not contact public websites, reuse browser profiles, or mutate user data.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) =>
		server.once("error", reject).listen(0, "127.0.0.1", resolve),
	);
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

const directory = mkdtempSync(join(tmpdir(), "miku-graph-browser-"));
const port = await freePort();
const fixturePort = await freePort();
const site = Bun.serve({
	hostname: "127.0.0.1",
	port: fixturePort,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
		if (path === "/") {
			await Bun.sleep(1300);
			return new Response(
				"<html><title>Graph fixture</title><body><main><h1>Graph fixture</h1><p>Real crawler output and a stable page to inspect.</p></main></body></html>",
				{ headers: { "content-type": "text/html" } },
			);
		}
		return new Response("Not found", { status: 404 });
	},
});
const child = Bun.spawn(["bun", "server/server.ts"], {
	cwd: process.cwd(),
	env: {
		...process.env,
		NODE_ENV: "development",
		PORT: String(port),
		DB_PATH: join(directory, "crawler.db"),
		MAX_STORAGE_MB: "1024",
		LOG_LEVEL: "warn",
	},
	stdout: "pipe",
	stderr: "pipe",
});
let browser;
let page;
const apiActivity = [];
try {
	const base = `http://127.0.0.1:${port}`;
	let healthy = false;
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) })).ok) {
				healthy = true;
				break;
			}
		} catch {}
		await Bun.sleep(100);
	}
	assert(healthy, "Backend did not become healthy");
	browser = await chromium.launch({
		executablePath: "/usr/bin/google-chrome",
		headless: true,
		args: ["--no-sandbox"],
	});
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("response", (response) => {
		if (response.url().includes("/api/"))
			apiActivity.push({ status: response.status(), url: new URL(response.url()).pathname });
	});
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/"))
			apiActivity.push({ failed: request.failure()?.errorText, url: request.url() });
	});
	await page.goto(base, { waitUntil: "domcontentloaded" });
	await page.getByRole("heading", { name: "Crawl map" }).waitFor();
	await page.locator("#target-url").fill(`http://localhost:${fixturePort}/`);
	await page.getByRole("button", { name: "Lightning Strike Attack (Skip Animation)" }).click();
	await page.locator('svg[aria-label^="Crawl traversal graph"]').waitFor({ timeout: 7000 });
	await page.getByLabel("Selected page").waitFor({ timeout: 20_000 });
	await page.waitForFunction(
		() => {
			const node = document.querySelector('[aria-label="Live crawl graph"]');
			return node?.textContent?.includes("Stored");
		},
		undefined,
		{ timeout: 20_000 },
	);
	await page.waitForTimeout(600);
	const graph = await page
		.locator('svg[aria-label^="Crawl traversal graph"]')
		.getAttribute("aria-label");
	assert(graph?.includes("1 visible pages"), graph);
	assert.equal(await page.getByLabel("Selected page").count(), 1);
	assert.equal(errors.length, 0, JSON.stringify(errors));
	const shot = "tmp/crawl-graph-browser.png";
	mkdirSync("tmp", { recursive: true });
	await page.screenshot({ path: shot, fullPage: true });
	console.log(
		JSON.stringify(
			{
				ok: true,
				browser: await browser.version(),
				graph,
				selectedPage: await page.getByLabel("Selected page").inputValue(),
				screenshot: shot,
				pageErrors: errors,
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error("UI_SMOKE_ERROR", String(error).slice(0, 1200));
	if (page) {
		console.error("UI_CURRENT_URL", page.url());
		console.error(
			"UI_TEXT",
			(
				await page
					.locator("body")
					.textContent()
					.catch(() => "")
			).slice(0, 3500),
		);
		console.error(
			"UI_ALERTS",
			await page
				.locator('[role="alert"]')
				.allTextContents()
				.catch(() => []),
		);
		console.error("UI_API_ACTIVITY", apiActivity);
		console.error(
			"UI_BACKEND_RUNS",
			await fetch(`http://127.0.0.1:${port}/api/crawls`)
				.then((x) => x.text())
				.catch(String),
		);
		console.error("UI_INPUT", await page.locator("#target-url").inputValue().catch(String));
		mkdirSync("tmp", { recursive: true });
		await page.screenshot({ path: "tmp/crawl-graph-failed.png", fullPage: true }).catch(() => {});
	}
	throw error;
} finally {
	await browser?.close();
	child.kill("SIGTERM");
	await Promise.race([child.exited, Bun.sleep(9000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
	site.stop(true);
	rmSync(directory, { recursive: true, force: true });
}
