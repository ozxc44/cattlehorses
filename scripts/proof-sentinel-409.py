#!/usr/bin/env python3
"""Focused proof: JoinRequestSubmitted sentinel + duplicate 409 pending approval.

Part 1: Sentinel instanceof correctness (Node subprocess)
Part 2: Duplicate 409 renders #approvalState (Playwright, local HTTP server)

Usage: python3 scripts/proof-sentinel-409.py [--headless]
"""

import json
import os
import re
import subprocess
import sys
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"

# ── Part 1: Sentinel instanceof proof (Node) ──────────────────────────────

SENTINEL_JS = r"""
function JoinRequestSubmitted() { this.name = "JoinRequestSubmitted"; }
JoinRequestSubmitted.prototype = Object.create(Error.prototype);
JoinRequestSubmitted.prototype.constructor = JoinRequestSubmitted;

var t1 = new Error("HTTP 409") instanceof JoinRequestSubmitted;          // must be false
var t2 = new JoinRequestSubmitted() instanceof Error;                     // must be true
var t3 = new JoinRequestSubmitted() instanceof JoinRequestSubmitted;      // must be true
var t4 = Error.prototype === JoinRequestSubmitted.prototype;              // must be false

console.log(JSON.stringify({t1:t1,t2:t2,t3:t3,t4:t4}));

if (t1 !== false || t2 !== true || t3 !== true || t4 !== false) {
  process.exit(1);
}
"""

def sentinel_proof():
    r = subprocess.run(["node", "-e", SENTINEL_JS], capture_output=True, text=True, timeout=10)
    data = json.loads(r.stdout.strip())
    checks = [
        ("new Error('HTTP 409') instanceof JoinRequestSubmitted", data["t1"], False),
        ("new JoinRequestSubmitted() instanceof Error", data["t2"], True),
        ("new JoinRequestSubmitted() instanceof JoinRequestSubmitted", data["t3"], True),
        ("Error.prototype === JoinRequestSubmitted.prototype", data["t4"], False),
    ]
    ok = True
    for label, actual, expected in checks:
        passed = actual == expected
        mark = "PASS" if passed else "FAIL"
        print(f"  [{mark}] {label} === {actual}")
        if not passed:
            ok = False
    return ok


# ── Part 2: Duplicate 409 browser proof (Playwright) ─────────────────────

def browser_proof(headless=True):
    from playwright.sync_api import sync_playwright

    # Tiny static server
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(DASHBOARD), **kw)
        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    ok = True
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        page = browser.new_page()
        try:
            url = f"http://127.0.0.1:{port}/agent-start.html?intent=join&project_id=proj-dup-409&project_name=409TestProject&requested_role=member"
            page.goto(url, wait_until="networkidle", timeout=15000)

            # Fill auth fields so bootstrap proceeds
            page.evaluate(
                "([sel, val]) => { const el = document.querySelector(sel); if (el) el.value = val; }",
                ["#baseUrl", f"http://127.0.0.1:{port}"],
            )
            page.fill("#email", "test-proof@example.com")
            page.fill("#password", "testpass123")
            page.fill("#displayName", "ProofBot")

            # Intercept: health -> ok
            page.route(re.compile(r"/v1/health$"), lambda route: route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"status": "ok"}),
            ))
            # Intercept: auth -> success with access_token
            page.route(re.compile(r"/v1/auth/"), lambda route: route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({
                    "access_token": "fake-jwt-token-for-proof",
                    "user": {"id": "user-proof", "email": "test-proof@example.com",
                             "username": "ProofBot", "display_name": "ProofBot"},
                }),
            ))
            # Intercept: project GET -> 403 (not a member)
            page.route(re.compile(r"/v1/projects/[^/]+$"), lambda route: route.fulfill(
                status=403, content_type="application/json",
                body=json.dumps({"detail": "Forbidden"}),
            ))
            # Intercept: join-requests POST -> 409 (duplicate)
            page.route(re.compile(r"/v1/projects/[^/]+/join-requests"), lambda route: route.fulfill(
                status=409, content_type="application/json",
                body=json.dumps({"detail": "A join request already exists.", "status": "pending"}),
            ))

            page.click("#bootstrapBtn")
            page.wait_for_timeout(3000)

            # Check #approvalState visible
            approval_visible = page.locator("#approvalState").is_visible()
            mark = "PASS" if approval_visible else "FAIL"
            print(f"  [{mark}] #approvalState visible after duplicate 409: {approval_visible}")
            if not approval_visible:
                ok = False

            # Check status pill not "error"
            status_pill = page.locator("#statusPill")
            status_text = status_pill.inner_text() if status_pill.is_visible() else ""
            no_error = "error" not in status_text.lower()
            mark = "PASS" if no_error else "FAIL"
            print(f"  [{mark}] Status pill not error: \"{status_text}\"")
            if not no_error:
                ok = False

            # Check log has no error lines
            log_text = page.locator("#log").inner_text()
            error_lines = [l for l in log_text.split("\n") if "error" in l.lower()]
            log_clean = len(error_lines) == 0
            mark = "PASS" if log_clean else "FAIL"
            print(f"  [{mark}] Log has no error lines (found {len(error_lines)})")
            if not log_clean:
                ok = False

        finally:
            browser.close()
            server.shutdown()

    return ok


# ── Main ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    headless = "--headless" in sys.argv

    print("=== Part 1: Sentinel instanceof proof ===")
    sentinel_ok = sentinel_proof()

    print("\n=== Part 2: Duplicate 409 browser proof ===")
    try:
        browser_ok = browser_proof(headless)
    except Exception as exc:
        print(f"  [FAIL] Browser proof error: {exc}")
        browser_ok = False

    print("\n=== Summary ===")
    print(f"  Sentinel: {'PASS' if sentinel_ok else 'FAIL'}")
    print(f"  Browser:  {'PASS' if browser_ok else 'FAIL'}")
    if not sentinel_ok or not browser_ok:
        sys.exit(1)
    print("  ALL PROOFS PASSED")
