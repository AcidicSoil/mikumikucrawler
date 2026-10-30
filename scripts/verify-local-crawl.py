#!/usr/bin/env python3
"""Run an isolated Miku API crawl against a bounded local site and verify SQLite/SSE.

Requires Bun and Python 3. No external target, browser, credentials, or daemon.
Prints a JSON receipt. All child processes and temporary artifacts are cleaned up.
"""
import json
import os
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PAGE = b"""<!doctype html><html><head><title>Local Crawl Fixture</title></head>
<body><main><h1>Local Crawl Fixture</h1><p>Persistent crawler verification.
Valid HTML and readable content for the Miku test.</p>
<a href="/child">Linked page (expected blocked by SSRF discovered-link policy)</a>
</main></body></html>"""


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_GET(self):
        if self.path == "/robots.txt":
            body = b"User-agent: *\nAllow: /\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
        elif self.path in ("/", "/child"):
            if self.path == "/":
                time.sleep(1.2)  # Allow the SSE observer to attach before crawl.page.
            body = PAGE if self.path == "/" else b"<html><title>Child</title><body>Child</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
        else:
            self.send_error(404)
            return
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fetch_json(url, *, payload=None, timeout=5):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method="POST" if body else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def await_healthy(base, process):
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError(f"Backend exited before health: {process.returncode}")
        try:
            result = fetch_json(base + "/health", timeout=1)
            if result:
                return
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            pass
        time.sleep(0.1)
    raise TimeoutError("Backend did not become healthy within 12 seconds")


def read_events(url, observed, done):
    try:
        request = urllib.request.Request(url, headers={"Accept": "text/event-stream"})
        with urllib.request.urlopen(request, timeout=9) as response:
            if response.status == 204:
                return
            current_type = ""
            for raw in response:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("event:"):
                    current_type = line.partition(":")[2].strip()
                elif line.startswith("data:"):
                    data = json.loads(line.partition(":")[2].strip())
                    observed.append({
                        "type": data.get("type") or current_type,
                        "sequence": data.get("sequence"),
                    })
                    if data.get("type") in {
                        "crawl.completed", "crawl.paused", "crawl.failed", "crawl.stopped"
                    }:
                        break
    except (TimeoutError, urllib.error.URLError, ValueError) as exc:
        observed.append({"observerError": type(exc).__name__})
    finally:
        done.set()


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    proc = None
    with tempfile.TemporaryDirectory(prefix="miku-local-crawl-") as temporary:
        db = Path(temporary) / "crawler.db"
        log_file = Path(temporary) / "server.log"
        env = os.environ.copy()
        env.update({
            "NODE_ENV": "development", "PORT": str(free_port()),
            "DB_PATH": str(db), "MAX_STORAGE_MB": "128",
            "RENDER": "false", "LOG_LEVEL": "warn",
        })
        base = f"http://127.0.0.1:{env['PORT']}"
        target = f"http://localhost:{server.server_port}/"
        events = []
        done = threading.Event()
        try:
            with log_file.open("wb") as logs:
                proc = subprocess.Popen(
                    ["bun", "server/server.ts"], cwd=REPO, env=env,
                    stdout=logs, stderr=subprocess.STDOUT, start_new_session=True,
                )
                await_healthy(base, proc)
                crawl_id = str(uuid.uuid4())
                options = {
                    "target": target, "crawlMethod": "links", "crawlDepth": 2,
                    "crawlDelay": 200, "maxPages": 2, "maxPagesPerDomain": 2,
                    "maxConcurrentRequests": 1, "retryLimit": 0,
                    "dynamic": False, "respectRobots": True,
                    "contentOnly": False, "saveMedia": False,
                }
                started = fetch_json(base + "/api/crawls", payload={
                    "id": crawl_id, "options": options,
                })
                assert started["id"] == crawl_id, started
                stream_thread = threading.Thread(
                    target=read_events,
                    args=(base + f"/api/crawls/{crawl_id}/events", events, done),
                    daemon=True,
                )
                stream_thread.start()
                final = None
                for _ in range(200):
                    snapshot = fetch_json(base + f"/api/crawls/{crawl_id}/snapshot")
                    final = snapshot["crawl"]
                    if final["status"] in {"completed", "stopped", "failed"}:
                        break
                    time.sleep(0.1)
                assert final and final["status"] == "completed", final
                done.wait(3)
                snapshot = fetch_json(base + f"/api/crawls/{crawl_id}/snapshot")
                graph = fetch_json(base + f"/api/crawls/{crawl_id}/graph")
                assert graph == {"edges": [], "count": 0}, graph
                assert snapshot["pageCount"] == 1, snapshot
                assert len(snapshot["pages"]) == 1, snapshot
                # This backend intentionally owns an exclusive SQLite lock while
                # running. Inspect the database only after graceful shutdown.
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=8)
                assert proc.returncode == 0, f"Backend shutdown exited {proc.returncode}"
                with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
                    db_row = conn.execute(
                        "SELECT status, success_count, event_sequence FROM crawl_runs WHERE id = ?",
                        (crawl_id,),
                    ).fetchone()
                    pages = conn.execute(
                        "SELECT url,title FROM pages WHERE crawl_id=?",
                        (crawl_id,),
                    ).fetchall()
                    queue = conn.execute(
                        "SELECT COUNT(*) FROM crawl_queue_items WHERE crawl_id=?",
                        (crawl_id,),
                    ).fetchone()[0]
                assert db_row and db_row[0] == "completed" and db_row[1] == 1, db_row
                assert len(pages) == 1 and pages[0][0] == target, pages
                assert queue == 0, queue
                assert any(x.get("type") in {"crawl.page", "crawl.completed"} for x in events), events
                print(json.dumps({
                    "ok": True, "crawlId": crawl_id, "status": final["status"],
                    "storedPages": snapshot["pageCount"],
                    "sqliteStatus": db_row[0], "sqliteSuccess": db_row[1],
                    "eventSequence": db_row[2], "eventTypes": [x.get("type") for x in events],
                    "queuedAfter": queue, "target": target,
                    "scope": "localhost seed only, no external network",
                }, indent=2))
        except Exception:
            if log_file.exists():
                print("SERVER_LOG_TAIL:", log_file.read_text(errors="replace")[-4000:])
            raise
        finally:
            if proc is not None and proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait(timeout=3)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
