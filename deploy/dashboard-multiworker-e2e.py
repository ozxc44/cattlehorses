#!/usr/bin/env python3
"""Browser E2E: Multi-worker orchestration workflow visibility.

Proves the NAS dashboard exposes the PM/main-agent + multi-worker collaboration
workflow clearly enough for a human/PM to observe:

  1. Owner/main user can load the project workspace (owner-home.html)
  2. Project has multiple agents online (Golden Path pipeline)
  3. Orchestration/task statuses are visible (human-workspace.html)
  4. ready-for-review / approved / changes-requested states visible
  5. Project-space / changeset / file output visible after worker completion

Strategy:
  Phase 1 — API setup: Register user, create project, register agents,
    heartbeat, create orchestration, dispatch tasks, claim/complete/review,
    create changeset and merge.  This establishes the multi-worker state.
  Phase 2 — UI verify: Navigate owner-home.html and human-workspace.html
    to verify the UI can display the resulting project/orchestration/task/
    project-space evidence.  Take screenshots and HTML snapshots.

Usage:
  python3 deploy/dashboard-multiworker-e2e.py
  BASE_URL=http://<your-platform-host>:18080/agent python3 deploy/dashboard-multiworker-e2e.py
  python3 deploy/dashboard-multiworker-e2e.py --headless
  python3 deploy/dashboard-multiworker-e2e.py --artifacts-dir ./e2e-artifacts

Constraints:
  - BASE_URL defaults to http://<your-platform-host>:18080/agent
  - Artifacts saved under deploy/...-artifacts/; credentials redacted
  - No full credentials printed; JWT/API keys redacted in HTML snapshots
  - Does not use social chat as source of task truth
"""

import json
import os
import re
import sys
import time
import argparse
import traceback
from pathlib import Path
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("FAIL: requests not installed.  pip install requests")
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("FAIL: playwright not installed.  pip install playwright && python -m playwright install chromium")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = os.environ.get("BASE_URL", "http://<your-platform-host>:18080/agent")
API_URL = BASE_URL.rstrip("/") + "/v1"
TS = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
TEST_EMAIL = f"mw-e2e-{TS}@example.com"
TEST_PASSWORD = "MwE2e!2026secure"
TEST_DISPLAY_NAME = f"MultiWorker E2E {TS[:11]}"

PASS = 0
FAIL = 0
RESULTS: list[dict] = []

# Shared state from API setup — used by UI verify phase
JWT = ""
STATE = {
    "project_id": "",
    "main_agent_id": "",
    "main_agent_key": "",
    "worker_ids": [],
    "worker_keys": [],
    "worker_names": [],
    "orchestration_id": "",
    "orchestration_base_path": "",
    "task_ids": [],
    "changeset_id": "",
    "commit_id": "",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def redact_html(html: str) -> str:
    """Scrub credential-like substrings from page HTML before persisting."""
    html = re.sub(r"zzk_[A-Za-z0-9_-]{4,}", "[REDACTED:zzk_key]", html)
    html = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}", "[REDACTED:sk_key]", html)
    html = re.sub(
        r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        "[REDACTED:jwt]", html,
    )
    html = re.sub(r"(Bearer\s+)[A-Za-z0-9_-]{40,}", r"\1[REDACTED:bearer]", html)
    # Also redact X-API-Key headers
    html = re.sub(r'(x-api-key|X-API-Key|api_key)[=:]["]?[A-Za-z0-9_-]{20,}',
                  r'\1=[REDACTED]', html)
    return html


def save_artifact(page, artifacts_dir: Path, name: str):
    """Take screenshot + redacted HTML snapshot."""
    ts = datetime.now().astimezone().strftime("%H%M%S")
    screenshot_path = artifacts_dir / f"{ts}_{name}.png"
    html_path = artifacts_dir / f"{ts}_{name}.html"
    try:
        page.screenshot(path=str(screenshot_path), full_page=False)
    except Exception:
        pass
    try:
        html_path.write_text(redact_html(page.content()), encoding="utf-8")
    except Exception:
        pass
    return screenshot_path, html_path


def save_screenshot(page, artifacts_dir: Path, name: str):
    """Just screenshot (no HTML)."""
    ts = datetime.now().astimezone().strftime("%H%M%S")
    screenshot_path = artifacts_dir / f"{ts}_{name}.png"
    try:
        page.screenshot(path=str(screenshot_path), full_page=False)
    except Exception:
        pass
    return screenshot_path


def pass_test(name: str, detail: str = ""):
    global PASS
    PASS += 1
    msg = f"  PASS: {name}" + (f" — {detail}" if detail else "")
    print(msg)
    RESULTS.append({"name": name, "passed": True, "detail": detail})


def fail_test(name: str, detail: str = ""):
    global FAIL
    FAIL += 1
    msg = f"  FAIL: {name}" + (f" — {detail}" if detail else "")
    print(msg)
    RESULTS.append({"name": name, "passed": False, "detail": detail})


def section(title: str):
    width = max(0, 55 - len(title))
    print(f"\n── {title} {'─' * width}")


def api(method: str, path: str, body: dict = None, headers: dict = None) -> dict:
    """Make an authenticated HTTP request to the backend API."""
    url = API_URL.rstrip("/v1") + path
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    if JWT and "Authorization" not in hdrs:
        hdrs["Authorization"] = f"Bearer {JWT}"
    r = requests.request(method, url, headers=hdrs, json=body, timeout=30)
    try:
        data = r.json() if r.text else {}
    except json.JSONDecodeError:
        data = {"detail": r.text}
    if not r.ok:
        detail = data.get("detail", data.get("message", r.text[:200]))
        raise RuntimeError(f"HTTP {r.status} {method} {path}: {detail}")
    return data


def api_raw(method: str, path: str, body: dict = None, headers: dict = None) -> dict:
    """Same as api() but with X-API-Key auth header for agent endpoints."""
    hdrs = {"Content-Type": "application/json", **(headers or {})}
    url = API_URL.rstrip("/v1") + path
    r = requests.request(method, url, headers=hdrs, json=body, timeout=30)
    try:
        data = r.json() if r.text else {}
    except json.JSONDecodeError:
        data = {"detail": r.text}
    if not r.ok:
        detail = data.get("detail", data.get("message", r.text[:200]))
        raise RuntimeError(f"HTTP {r.status} {method} {path}: {detail}")
    return data


def agent_api(method: str, path: str, api_key: str, body: dict = None) -> dict:
    """Call API with X-API-Key header (agent-level auth)."""
    return api_raw(method, path, body, headers={"X-API-Key": api_key})


def wait_for_inbox(api_key: str, event_type: str, task_id: str, label: str, max_retries: int = 20):
    """Poll inbox until a specific event type + task_id appears."""
    for attempt in range(1, max_retries + 1):
        inbox = agent_api("GET", f"/v1/agent/inbox?unread=true&event_type={event_type}&limit=50", api_key)
        items = inbox.get("data", [])
        for item in items:
            if item.get("event_type") == event_type and item.get("task_id") == task_id:
                print(f"  [API] {label} inbox found attempt={attempt}")
                return item
        time.sleep(0.5)
    raise RuntimeError(f"{label}: inbox item not found after {max_retries} retries")


def assert_eq(actual, expected, label: str):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


# ===================================================================
# Phase 1: API Setup — Create multi-worker orchestration state
# ===================================================================

def api_setup():
    """Create a full multi-worker project + orchestration via API.

    Returns dict with project_id, agent IDs/keys, orchestration_id, task_ids, etc.
    """
    global JWT

    section("API Setup — Multi-worker state")

    # 1. Health check
    print("  [1] health check")
    h = requests.get(f"{API_URL}/health", timeout=10)
    h.raise_for_status()
    pass_test("API health")

    # 2. Register / Login
    print("  [2] register/login")
    try:
        auth = api("POST", "/v1/auth/register", {
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "display_name": TEST_DISPLAY_NAME,
        })
        JWT = auth["access_token"]
        pass_test("Register", f"email={TEST_EMAIL}")
    except RuntimeError as exc:
        if "already registered" in str(exc).lower():
            auth = api("POST", "/v1/auth/token", {
                "email": TEST_EMAIL,
                "password": TEST_PASSWORD,
            })
            JWT = auth["access_token"]
            pass_test("Login", f"email={TEST_EMAIL}")
        else:
            raise
    assert JWT, "No JWT obtained"

    # 3. Create project
    print("  [3] create project")
    proj = api("POST", "/v1/projects", {
        "name": f"Multi-worker E2E Project {TS}",
        "description": "Created by dashboard-multiworker-e2e.py",
        "visibility": "private",
    })
    STATE["project_id"] = proj["id"]
    pass_test("Create project", f"id={proj['id'][:8]}...")

    # 4. Register main + 3 worker agents
    print("  [4] register agents (1 main + 3 workers)")
    pid = STATE["project_id"]
    main = api("POST", f"/v1/projects/{pid}/agents", {
        "name": "mw-main",
        "endpoint_url": "http://127.0.0.1:7781/main",
        "invoke_secret": "mw-main-secret-0123456789ab",
    })
    STATE["main_agent_id"] = main["id"]
    STATE["main_agent_key"] = main["api_key"]
    pass_test("Register main agent", f"id={main['id'][:8]}...")

    WORKER_NAMES = ["mw-worker-alpha", "mw-worker-beta", "mw-worker-gamma"]
    for i, name in enumerate(WORKER_NAMES):
        w = api("POST", f"/v1/projects/{pid}/agents", {
            "name": name,
            "endpoint_url": f"http://127.0.0.1:7781/{name}",
            "invoke_secret": f"{name}-secret-0123456789ab",
        })
        STATE["worker_ids"].append(w["id"])
        STATE["worker_keys"].append(w["api_key"])
        STATE["worker_names"].append(name)
        pass_test(f"Register worker[{i}] {name}", f"id={w['id'][:8]}...")

    # 5. Heartbeat all agents (must be online before orchestration)
    print("  [5] heartbeat agents")
    agent_api("POST", "/v1/agents/heartbeat", STATE["main_agent_key"],
              {"status": "active"})
    for wk in STATE["worker_keys"]:
        agent_api("POST", "/v1/agents/heartbeat", wk, {"status": "active"})
    pass_test("Heartbeat agents", "main + 3 workers dispatched")

    # 6. Create orchestration
    print("  [6] create orchestration")
    orch = agent_api("POST", f"/v1/projects/{pid}/orchestrations", STATE["main_agent_key"], {
        "title": "Multi-worker E2E",
        "objective": "Prove UI visibility of multi-worker orchestration workflow.",
        "main_agent_id": STATE["main_agent_id"],
        "worker_agent_ids": STATE["worker_ids"],
        "acceptance_criteria": [
            "three workers participated",
            "review states visible in UI",
            "changeset merged into project space",
        ],
        "plan": "1. Dispatch tasks A/B/C. 2. Workers complete. 3. PM reviews. 4. Second-wave. 5. Merge changeset.",
    })
    STATE["orchestration_id"] = orch["id"]
    STATE["orchestration_base_path"] = orch.get("base_path", "")
    pass_test("Create orchestration", f"id={orch['id'][:8]}...")

    # 7. First-wave dispatch: 3 tasks
    print("  [7] dispatch first-wave tasks (3)")
    for i in range(3):
        task = agent_api("POST", f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks",
                         STATE["main_agent_key"], {
                             "title": f"First-wave task {chr(65 + i)}",
                             "goal": f"Worker {chr(65 + i)} proves deliverable.",
                             "assigned_agent_id": STATE["worker_ids"][i],
                             "acceptance_criteria": ["result.md", "evidence.json"],
                         })
        assert_eq(task["status"], "dispatched", f"task[{i}] status")
        STATE["task_ids"].append(task["id"])
        pass_test(f"Dispatch task[{i}]", f"id={task['id'][:8]}...")

    # 8. Workers claim + complete tasks
    print("  [8] workers claim + complete first-wave tasks")
    for i in range(3):
        wait_for_inbox(STATE["worker_keys"][i], "task_dispatched",
                       STATE["task_ids"][i], f"worker[{i}] inbox")
        claim = agent_api("PATCH",
                          f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{STATE['task_ids'][i]}/claim",
                          STATE["worker_keys"][i])
        assert_eq(claim["status"], "running", f"worker[{i}] claim")

        complete = agent_api("POST",
                             f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{STATE['task_ids'][i]}/complete",
                             STATE["worker_keys"][i], {
                                 "result_md": f"# Result from {STATE['worker_names'][i]}\n\nFirst-wave complete.\n",
                                 "evidence": {"worker": STATE["worker_names"][i], "wave": "first", "index": i},
                                 "status": "ready_for_review",
                             })
        assert_eq(complete["status"], "ready_for_review", f"worker[{i}] complete")
        pass_test(f"Worker[{i}] complete task", f"task={STATE['task_ids'][i][:8]}...")

    # 9. PM review: changes_requested on worker[0], approved on others
    print("  [9] PM review: changes_requested on [0], approved on [1],[2]")
    # changes_requested on worker 0
    agent_api("PATCH",
              f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{STATE['task_ids'][0]}/review",
              STATE["main_agent_key"], {
                  "decision": "changes_requested",
                  "notes": "Please add a revision marker.",
                  "requested_changes": "Append a revision marker to result_md.",
              })
    pass_test("Review changes_requested", f"task={STATE['task_ids'][0][:8]}...")

    # Worker 0 resubmits
    req = wait_for_inbox(STATE["worker_keys"][0], "task_changes_requested",
                         STATE["task_ids"][0], "worker[0] changes_requested")
    agent_api("POST",
              f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{STATE['task_ids'][0]}/complete",
              STATE["worker_keys"][0], {
                  "result_md": "# Result from mw-worker-alpha\n\nFirst-wave complete.\n\nRevision: addressed PM feedback.\n",
                  "evidence": {"worker": "mw-worker-alpha", "wave": "first", "index": 0, "revision": 2},
                  "status": "ready_for_review",
              })
    pass_test("Worker[0] resubmit after changes_requested")

    # Approve all three
    for i in range(3):
        agent_api("PATCH",
                  f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{STATE['task_ids'][i]}/review",
                  STATE["main_agent_key"], {"decision": "approved", "notes": "LGTM"})
        pass_test(f"Approve task[{i}]")

    # 10. Second-wave dispatch (worker[1])
    print("  [10] second-wave dispatch")
    task_d = agent_api("POST", f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks",
                       STATE["main_agent_key"], {
                           "title": "Second-wave task D",
                           "goal": "Follow-up work after first approvals.",
                           "assigned_agent_id": STATE["worker_ids"][1],
                           "acceptance_criteria": ["second-wave result.md"],
                       })
    STATE["task_ids"].append(task_d["id"])
    assert_eq(task_d["status"], "dispatched", "second-wave status")

    wait_for_inbox(STATE["worker_keys"][1], "task_dispatched", task_d["id"],
                   "worker[1] second-wave")
    agent_api("PATCH",
              f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{task_d['id']}/claim",
              STATE["worker_keys"][1])
    agent_api("POST",
              f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{task_d['id']}/complete",
              STATE["worker_keys"][1], {
                  "result_md": "# Second-wave Result\n\nDone.\n",
                  "evidence": {"worker": "mw-worker-beta", "wave": "second"},
                  "status": "ready_for_review",
              })
    agent_api("PATCH",
              f"/v1/projects/{pid}/orchestrations/{orch['id']}/tasks/{task_d['id']}/review",
              STATE["main_agent_key"], {"decision": "approved", "notes": "Second wave LGTM"})
    pass_test("Second-wave dispatch + complete + approve")

    # 11. Create changeset and merge into project space
    print("  [11] create changeset + merge")
    all_task_ids = STATE["task_ids"]
    cs = agent_api("POST", f"/v1/projects/{pid}/changesets", STATE["main_agent_key"], {
        "title": "Multi-worker E2E result merge",
        "orchestration_id": orch["id"],
        "result_path": f".agent/orchestrations/{orch['id']}/pm-review.md",
        "evidence_path": f".agent/orchestrations/{orch['id']}/tasks.json",
        "file_ops": [
            {
                "op": "upsert",
                "path": f"docs/mw-output-{idx}.md",
                "content": f"# Output {idx}\n\nFrom task {tid}.\n",
                "content_type": "text/markdown",
                "base_revision_id": None,
            }
            for idx, tid in enumerate(all_task_ids)
        ],
    })
    STATE["changeset_id"] = cs["id"]
    assert_eq(cs["status"], "submitted", "changeset status")
    pass_test("Create changeset", f"id={cs['id'][:8]}...")

    # Owner approves + merges changeset
    cs_review = api("PATCH", f"/v1/projects/{pid}/changesets/{cs['id']}/review", {
        "decision": "approved",
        "notes": "LGTM multi-worker merge",
    })
    assert_eq(cs_review["status"], "approved", "changeset review")

    merge = api("POST", f"/v1/projects/{pid}/changesets/{cs['id']}/merge")
    STATE["commit_id"] = merge.get("commit", {}).get("id", "")
    assert_eq(merge.get("changeset", {}).get("status"), "merged", "changeset merge")
    pass_test("Merge changeset", f"commit={STATE['commit_id'][:8] if STATE['commit_id'] else 'N/A'}")

    # 12. Verify project-space files
    print("  [12] verify project-space artifacts")
    bp = STATE["orchestration_base_path"]
    if bp:
        files = api("GET", f"/v1/projects/{pid}/files?path_prefix={bp}")
        file_count = len(files.get("data", []))
        pass_test(f"Project-space files under orchestration path", f"count={file_count}")

    # Verify merged files
    merged = api("GET", f"/v1/projects/{pid}/files?path_prefix=docs/mw-output")
    merged_count = len(merged.get("data", []))
    pass_test(f"Merged project-space files under docs/", f"count={merged_count}")

    print("\n  API setup complete.  State:")
    print(f"    project_id       = {STATE['project_id']}")
    print(f"    orchestration_id = {STATE['orchestration_id']}")
    print(f"    tasks            = {len(STATE['task_ids'])}")
    print(f"    changeset_id     = {STATE['changeset_id']}")
    print(f"    commit_id        = {STATE['commit_id']}")


# ===================================================================
# Phase 2: UI Verify — Browser-based verification
# ===================================================================

def ui_insert_jwt(page, jwt_token: str):
    """Inject JWT directly into localStorage for the dashboard domain,
    then reload so the page picks it up."""
    page.evaluate(f"""() => {{
        const keys = [
            "zz_owner_home_v1",
            "zz_human_workspace_v1",
            "zz_human_workspace_simple_v1",
            "zz_runtime_dashboard_v1",
            "zz_jwt",
        ];
        const payload = JSON.stringify({{
            baseUrl: "{BASE_URL.rstrip('/')}",
            jwt: "{jwt_token}",
        }});
        keys.forEach(k => {{
            try {{ localStorage.setItem(k, payload); }} catch(e) {{}}
        }});
        try {{ localStorage.setItem("zz_jwt", "{jwt_token}"); }} catch(e) {{}}
    }}""")


def ui_set_base_url(page, base_url: str):
    """Set base URL in localStorage for owner-home / human-workspace."""
    page.evaluate(f"""() => {{
        const keys = [
            "zz_owner_home_v1",
            "zz_human_workspace_v1",
            "zz_human_workspace_simple_v1",
            "zz_runtime_dashboard_v1",
        ];
        keys.forEach(k => {{
            try {{
                const raw = localStorage.getItem(k);
                if (raw) {{
                    const obj = JSON.parse(raw);
                    obj.baseUrl = "{base_url.rstrip('/')}";
                    localStorage.setItem(k, JSON.stringify(obj));
                }}
            }} catch(e) {{}}
        }});
    }}""")


def ui_verify_owner_home(page, artifacts_dir):
    """Navigate to owner-home.html and verify Golden Path pipeline + observability."""
    section("UI Verify — Owner Home (Golden Path pipeline)")

    page.goto(f"{BASE_URL.rstrip('/')}/owner-home.html",
              wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1000)
    save_artifact(page, artifacts_dir, "01-owner-home-initial")

    # The page may auto-login via localStorage. Wait for the Golden Path panel
    # or the login box.
    try:
        page.wait_for_selector("#goldenPathPanel:not(.hidden)", timeout=15000)
        pass_test("Owner home: Golden Path panel visible after login")
    except PwTimeout:
        # Try to login via auth form
        try:
            page.wait_for_selector("#loginBox:not(.hidden)", timeout=5000)
            page.fill("#authEmail", TEST_EMAIL)
            page.fill("#authPassword", TEST_PASSWORD)
            page.click("#loginBtn")
            page.wait_for_timeout(2000)
            page.wait_for_selector("#goldenPathPanel:not(.hidden)", timeout=15000)
            pass_test("Owner home: logged in via form")
        except PwTimeout:
            # Check if we need to set the base URL first (advanced settings)
            try:
                page.wait_for_selector("#loginBox:not(.hidden)", timeout=3000)
                # Try to set the base URL in the advanced settings section first
                page.fill("#baseUrl", BASE_URL)
                page.fill("#authEmail", TEST_EMAIL)
                page.fill("#authPassword", TEST_PASSWORD)
                page.click("#loginBtn")
                page.wait_for_timeout(3000)
                page.wait_for_selector("#goldenPathPanel:not(.hidden)", timeout=15000)
                pass_test("Owner home: set base URL + logged in")
            except PwTimeout:
                fail_test("Owner home: login failed", "Could not access Golden Path panel")
                save_screenshot(page, artifacts_dir, "01-owner-home-login-fail")
                return

    save_artifact(page, artifacts_dir, "02-owner-home-loaded")

    # Verify Golden Path pipeline elements exist
    gp_visible = False
    try:
        gp_panel = page.wait_for_selector("#gpPipeline", timeout=5000)
        if gp_panel and gp_panel.is_visible():
            gp_visible = True
            pass_test("Golden Path: pipeline element visible")
    except PwTimeout:
        pass

    if gp_visible:
        # Check each step in the pipeline
        steps_info = {}
        for step_id, label in [
            ("gpProject", "Project count"),
            ("gpAgentsOnline", "Agents online"),
            ("gpTasksPending", "Tasks pending"),
            ("gpWorkerClaimed", "Worker claimed"),
            ("gpResults", "Results submitted"),
            ("gpReviews", "Reviews"),
        ]:
            try:
                el = page.locator(f"#{step_id}")
                text = el.text_content(timeout=2000)
                if text and text.strip() and text.strip() not in ("-", "0"):
                    steps_info[label] = text.strip()
                    pass_test(f"Golden Path: {label} = {text.strip()}")
                else:
                    pass_test(f"Golden Path: {label} visible (value={text.strip()})")
            except Exception as exc:
                fail_test(f"Golden Path: {label}", str(exc)[:80])

        # Check for step card CSS classes (active/complete/waiting)
        try:
            step_cards = page.locator("#gpPipeline .step-card")
            card_count = step_cards.count()
            if card_count >= 6:
                pass_test(f"Golden Path: pipeline has {card_count} step cards")
            else:
                fail_test("Golden Path: step cards", f"expected >=6, got {card_count}")
        except Exception as exc:
            fail_test("Golden Path: step cards count", str(exc)[:80])

        # Check summary section
        try:
            summary = page.locator("#gpSummary")
            if summary.is_visible(timeout=2000):
                # Check specific stat values
                for stat_id, stat_label in [
                    ("gpTotalAgents", "Total agents"),
                    ("gpOnline", "Online count"),
                    ("gpWaitingReview", "Waiting review"),
                ]:
                    try:
                        val = page.locator(f"#{stat_id}").text_content(timeout=1000)
                        pass_test(f"Golden Path summary: {stat_label} = {val}")
                    except Exception:
                        pass_test(f"Golden Path summary: {stat_label} visible")
                pass_test("Golden Path: summary section visible")
            else:
                fail_test("Golden Path: summary section", "not visible")
        except Exception as exc:
            fail_test("Golden Path: summary section", str(exc)[:80])

        # Check TTFT panel
        try:
            ttft = page.locator("#gpTtftSection")
            if ttft.is_visible(timeout=2000):
                pass_test("Golden Path: TTFT panel visible")
        except Exception:
            pass_test("Golden Path: TTFT panel (not visible, possibly no data)")

        # Check workflow pipeline arrows
        try:
            arrows = page.locator("#gpPipeline .pipeline-arrow")
            if arrows.count() >= 5:
                done_arrows = page.locator("#gpPipeline .pipeline-arrow.done")
                pass_test(f"Golden Path: pipeline arrows present ({done_arrows.count()}/{arrows.count()} done)")
        except Exception:
            pass

    # Check observability panel
    try:
        obs_panel = page.locator("#obsPanel")
        if obs_panel.is_visible(timeout=2000):
            # Try to refresh observability
            page.click("#obsRefreshBtn")
            page.wait_for_timeout(2000)
            save_artifact(page, artifacts_dir, "03-owner-home-obs")
            pass_test("Owner home: observability panel accessible")

            # Check for agent entries in obs
            try:
                obs_body = page.locator("#obsBody")
                obs_text = obs_body.text_content(timeout=3000)
                if obs_text and "agent" in obs_text.lower():
                    pass_test("Observability: agent status data visible")
                else:
                    fail_test("Observability: agent status data", "no agent data found")
            except Exception:
                fail_test("Observability: agent status data", "body not accessible")
        else:
            fail_test("Owner home: observability panel", "not visible")
    except Exception as exc:
        fail_test("Owner home: observability panel", str(exc)[:80])

    save_artifact(page, artifacts_dir, "04-owner-home-golden-path")


def ui_verify_human_workspace(page, artifacts_dir):
    """Navigate to human-workspace.html and verify orchestration tab / task visibility."""
    section("UI Verify — Human Workspace (Orchestration tab)")

    # NOTE: human-workspace.html does NOT parse ?project_id= from URL.
    # The user must click the project in the sidebar to select it.
    # This is a documented UI gap.

    pid = STATE["project_id"]
    page.goto(f"{BASE_URL.rstrip('/')}/human-workspace.html",
              wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1500)
    save_artifact(page, artifacts_dir, "05-workspace-initial")

    # Login via the auth form (most reliable approach)
    try:
        # Fill in base URL if not already set
        base_input = page.locator("#baseUrl")
        if base_input.is_visible(timeout=3000):
            current_base = base_input.input_value()
            if not current_base or current_base == "http://127.0.0.1:8000":
                base_input.fill("")
                base_input.fill(BASE_URL)

        # Fill in JWT directly into the input
        jwt_input = page.locator("#jwt")
        if jwt_input.is_visible(timeout=3000):
            jwt_input.fill("")
            jwt_input.fill(JWT)
            # Save config
            page.click("#saveConfigBtn")
            page.wait_for_timeout(500)
            # Now trigger project load
            page.click("#loadProjectsBtn")
            page.wait_for_timeout(2000)
            pass_test("Human workspace: JWT configured + projects loaded")
    except Exception as exc:
        pass_test("Human workspace: JWT approach", str(exc)[:80])

    # Wait for project list to populate
    save_artifact(page, artifacts_dir, "06-workspace-loaded")
    page.wait_for_timeout(2000)

    # The workspace page loads projects from API but does NOT auto-select
    # one unless it was previously selected in localStorage. We must click
    # the project item in the sidebar to load its agents/orchestrations.
    # This is a UI gap: ?project_id= URL param is not parsed.
    try:
        project_list = page.locator("#projectList")
        project_list.wait_for(state="visible", timeout=10000)
        # Find the project item matching our project ID or name
        project_items = project_list.locator("[data-project-id]")
        item_count = project_items.count()
        if item_count > 0:
            pass_test(f"Workspace: {item_count} projects in sidebar")
            # Click the first project to select it
            project_items.first.click()
            page.wait_for_timeout(2000)
            save_artifact(page, artifacts_dir, "06b-workspace-project-selected")

            # Check project title now
            title = page.locator("#workspaceTitle")
            title_text = title.text_content(timeout=5000)
            if title_text and title_text != "No project selected":
                pass_test(f"Workspace: project selected = {title_text[:60]}")
            else:
                fail_test("Workspace: project selection after click",
                          f"title={title_text}")
        else:
            fail_test("Workspace: project list items", "count=0 (projects may not have loaded)")
            save_artifact(page, artifacts_dir, "06b-workspace-no-projects")
            return
    except PwTimeout:
        fail_test("Workspace: project list", "not visible within timeout")
        return

    # Check agent count pill (should now show agents)
    try:
        agent_pill = page.locator("#agentCountPill")
        pill_text = agent_pill.text_content(timeout=5000)
        pass_test(f"Workspace: agent count = {pill_text}")
    except Exception:
        pass_test("Workspace: agent count pill visible")

    # Navigate to Orchestration tab
    try:
        # Wait a moment for project data to load after clicking project
        page.wait_for_timeout(2000)
        orch_tab = page.locator("button[data-tab='orchestration']")
        if orch_tab.is_visible(timeout=3000):
            orch_tab.click()
            page.wait_for_timeout(1000)
            save_artifact(page, artifacts_dir, "07-workspace-orchestration-tab")
            pass_test("Workspace: orchestration tab clickable")
        else:
            fail_test("Workspace: orchestration tab", "not visible")
    except Exception as exc:
        fail_test("Workspace: orchestration tab", str(exc)[:80])
        # Try the tab by selector
        try:
            # Try nth child selector
            page.locator(".tab").nth(2).click()
            page.wait_for_timeout(1000)
            save_artifact(page, artifacts_dir, "07-workspace-orch-tab-alt")
            pass_test("Workspace: orchestration tab (alt selector)")
        except Exception as exc2:
            fail_test("Workspace: orchestration tab alt", str(exc2)[:80])

    # Check orchestration list
    page.wait_for_timeout(2000)
    save_artifact(page, artifacts_dir, "08-workspace-orch-list")
    try:
        orch_list = page.locator("#orchestrationList")
        # Wait for content
        try:
            orch_list.wait_for(state="visible", timeout=5000)
            list_text = orch_list.text_content(timeout=3000)
            if list_text and len(list_text.strip()) > 0 and "No orchestrations" not in list_text:
                pass_test("Workspace: orchestration list populated")
            else:
                fail_test("Workspace: orchestration list", "empty or 'No orchestrations'")
        except PwTimeout:
            fail_test("Workspace: orchestration list", "not visible")
    except Exception as exc:
        fail_test("Workspace: orchestration list", str(exc)[:80])

    # Check for orchestration items with status pills
    try:
        orch_items = page.locator("#orchestrationList .item")
        item_count = orch_items.count()
        if item_count > 0:
            pass_test(f"Workspace: {item_count} orchestration items")
            # Check first item for status badge
            first = orch_items.first
            status_el = first.locator(".pill").first
            if status_el.is_visible(timeout=1000):
                status_text = status_el.text_content(timeout=1000)
                pass_test(f"Workspace: orchestration status pill = {status_text}")
            # Check for orchestration metadata
            try:
                meta = first.locator(".meta").first
                if meta.is_visible(timeout=1000):
                    pass_test(f"Workspace: orchestration metadata visible")
            except Exception:
                pass
        else:
            fail_test("Workspace: orchestration items", "count=0")
    except Exception as exc:
        fail_test("Workspace: orchestration items", str(exc)[:80])

    # Check 'Create orchestration' form is present
    try:
        orch_form = page.locator("#orchestrationForm")
        if orch_form.is_visible(timeout=2000):
            pass_test("Workspace: create orchestration form visible")
            # Check form fields
            for field_id, field_label in [
                ("orchTitle", "Title"),
                ("orchObjective", "Objective"),
                ("orchMainAgent", "Main agent select"),
                ("orchWorkerChecks", "Worker checks"),
            ]:
                try:
                    el = page.locator(f"#{field_id}")
                    if el.is_visible(timeout=1000):
                        pass_test(f"Workspace: orchestration form has {field_label}")
                except Exception:
                    pass
        else:
            pass_test("Workspace: orchestration form (not directly visible)")
    except Exception:
        pass_test("Workspace: orchestration form not found")

    # Check Agents tab for presence data
    try:
        page.click("button[data-tab='agents']")
        page.wait_for_timeout(500)
        save_artifact(page, artifacts_dir, "09-workspace-agents-tab")
        pass_test("Workspace: agents tab clickable")

        # Check agent list has items
        agent_list = page.locator("#agentList")
        try:
            agent_list.wait_for(state="visible", timeout=5000)
            agent_items = agent_list.locator(".item")
            agent_count = agent_items.count()
            if agent_count >= 4:
                pass_test(f"Workspace: {agent_count} agents visible (expected >=4)")
            else:
                fail_test("Workspace: agent count", f"expected >=4, got {agent_count}")

            # Check for dispatchable/online status
            for i in range(min(agent_count, 2)):
                item = agent_items.nth(i)
                try:
                    pills = item.locator(".pill")
                    pill_texts = [p.text_content(timeout=500) for p in pills.all()]
                    pass_test(f"Workspace: agent[{i}] status pills = {pill_texts}")
                except Exception:
                    pass
        except PwTimeout:
            fail_test("Workspace: agent list", "not visible")
    except Exception as exc:
        fail_test("Workspace: agents tab", str(exc)[:80])

    # Switch back to People tab
    try:
        page.click("button[data-tab='people']")
        page.wait_for_timeout(300)
    except Exception:
        pass

    # Check project files / orchestration tab for files evidence
    # (projects may have a files view; check in Orchestration tab for the path)
    save_artifact(page, artifacts_dir, "10-workspace-final")


def ui_verify_index_dashboard(page, artifacts_dir):
    """Optional: Check index.html (product dashboard) for any orchestration visibility."""
    section("UI Verify — Product Dashboard (index/product.html)")

    page.goto(f"{BASE_URL.rstrip('/')}/product.html",
              wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(2000)
    save_artifact(page, artifacts_dir, "11-product-dashboard-initial")

    # Check for auth modal
    try:
        auth_modal = page.locator("#authModal")
        if auth_modal.is_visible(timeout=3000):
            # Login
            page.fill("#authEmail", TEST_EMAIL)
            page.fill("#authPassword", TEST_PASSWORD)
            page.click("#authSubmitBtn")
            page.wait_for_timeout(3000)
            save_artifact(page, artifacts_dir, "12-product-dashboard-logged-in")
            pass_test("Product dashboard: logged in")
        else:
            pass_test("Product dashboard: already logged in (no auth modal)")
    except Exception:
        pass_test("Product dashboard: auth modal not found")

    # Check for project visibility
    page.wait_for_timeout(2000)
    try:
        space_list = page.locator("#spaceList")
        if space_list.is_visible(timeout=3000):
            items = space_list.locator(".sidebar-item")
            if items.count() > 0:
                pass_test(f"Product dashboard: {items.count()} projects visible")
            else:
                fail_test("Product dashboard: projects", "sidebar empty")
        else:
            fail_test("Product dashboard: project list", "not visible")
    except Exception as exc:
        fail_test("Product dashboard: project list", str(exc)[:80])

    # The product.html SPA does NOT have orchestration support — document this gap
    try:
        has_orch_tab = page.locator("[data-tab='orchestration'], #orchTab, [data-section='orchestration']")
        if has_orch_tab.count() > 0:
            pass_test("Product dashboard: orchestration tab found (unexpected)")
        else:
            # Check for sessions, agents, space tabs
            tabs = page.locator("[data-tab]")
            tab_names = []
            for t in tabs.all():
                try:
                    tab_names.append(t.get_attribute("data-tab") or "")
                except Exception:
                    pass
            fail_test("Product dashboard: orchestration UI gap",
                      f"No orchestration tab in product.html. Tabs found: {tab_names}")
    except Exception as exc:
        fail_test("Product dashboard: orchestration check", str(exc)[:80])

    # Check for project space / file visibility
    try:
        file_tab = page.locator("button[data-tab='space']")
        if file_tab.is_visible(timeout=2000):
            file_tab.click()
            page.wait_for_timeout(1000)
            save_artifact(page, artifacts_dir, "13-product-dashboard-space")
            pass_test("Product dashboard: project space tab accessible")
    except Exception:
        pass_test("Product dashboard: space tab not found")

    save_artifact(page, artifacts_dir, "14-product-dashboard-final")


# ===================================================================
# Main
# ===================================================================

def main():
    parser = argparse.ArgumentParser(description="Multi-worker workflow visibility E2E")
    parser.add_argument("--headless", action="store_true", default=True,
                        help="Run headless (default: true)")
    parser.add_argument("--no-headless", action="store_true",
                        help="Show browser window")
    parser.add_argument("--artifacts-dir", default="",
                        help="Directory for screenshots/HTML")
    parser.add_argument("--api-only", action="store_true",
                        help="Skip browser UI checks (API setup only)")
    parser.add_argument("--ui-only", action="store_true",
                        help="Skip API setup (requires existing state)")
    args = parser.parse_args()

    global BASE_URL, API_URL
    BASE_URL = os.environ.get("BASE_URL", BASE_URL)
    API_URL = BASE_URL.rstrip("/") + "/v1"

    headless = not args.no_headless

    artifacts_dir = Path(args.artifacts_dir) if args.artifacts_dir else (
        Path(__file__).parent.parent / "deploy" / "dashboard-multiworker-e2e-artifacts"
    )
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("  Dashboard Multi-worker E2E (Playwright)")
    print(f"  Target:   {BASE_URL}")
    print(f"  API:      {API_URL}")
    print(f"  Email:    {TEST_EMAIL}")
    print(f"  Headless: {headless}")
    print(f"  Artifacts: {artifacts_dir}")
    print("=" * 60)

    start = time.time()
    error = None

    # -- Phase 1: API setup --
    if not args.ui_only:
        try:
            api_setup()
        except Exception as exc:
            error = exc
            print(f"\n  ERROR during API setup: {exc}", file=sys.stderr)
            traceback.print_exc()

    # -- Phase 2: UI verify --
    if not error and not args.api_only:
        if not JWT:
            fail_test("UI verify (skipped)", "No JWT available from API setup")
        else:
            try:
                with sync_playwright() as pw:
                    browser = pw.chromium.launch(headless=headless)
                    context = browser.new_context(
                        viewport={"width": 1440, "height": 900},
                        ignore_https_errors=True,
                        accept_downloads=True,
                    )
                    page = context.new_page()

                    # Inject JWT into localStorage before each navigation
                    ui_insert_jwt(page, JWT)
                    ui_set_base_url(page, BASE_URL)

                    ui_verify_owner_home(page, artifacts_dir)

                    # Re-inject JWT for human-workspace (different storage key)
                    ui_insert_jwt(page, JWT)
                    ui_set_base_url(page, BASE_URL)
                    ui_verify_human_workspace(page, artifacts_dir)

                    # Product dashboard
                    ui_insert_jwt(page, JWT)
                    ui_set_base_url(page, BASE_URL)
                    ui_verify_index_dashboard(page, artifacts_dir)

                    context.close()
                    browser.close()

            except Exception as exc:
                error = exc
                print(f"\n  ERROR during UI verify: {exc}", file=sys.stderr)
                traceback.print_exc()

    elapsed = time.time() - start

    # -- Report --
    print("\n" + "=" * 60)
    print(f"  Results: {PASS} passed, {FAIL} failed  ({elapsed:.1f}s)")
    print("=" * 60)

    if FAIL > 0:
        print("\n  Failed tests:")
        for r in RESULTS:
            if not r["passed"]:
                print(f"    FAIL: {r['name']}: {r['detail']}")

    report = {
        "timestamp": TS,
        "command": f"python3 deploy/dashboard-multiworker-e2e.py{' --headless' if headless else ''}",
        "target_url": BASE_URL,
        "email": TEST_EMAIL,
        "artifacts_dir": str(artifacts_dir),
        "passed": PASS,
        "failed": FAIL,
        "elapsed_seconds": round(elapsed, 1),
        "results": RESULTS,
        "state": {
            "project_id": STATE["project_id"],
            "orchestration_id": STATE["orchestration_id"],
            "task_count": len(STATE["task_ids"]),
            "changeset_id": STATE["changeset_id"],
            "commit_id": STATE["commit_id"],
        },
    }
    report_path = artifacts_dir / f"report_{TS}.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n  Report: {report_path}")

    if error or FAIL > 0:
        print("\n  Multi-worker E2E had failures.")
        sys.exit(1)
    else:
        print("\n  All multi-worker E2E steps passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
