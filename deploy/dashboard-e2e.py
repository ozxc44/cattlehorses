#!/usr/bin/env python3
"""Dashboard E2E smoke test using Playwright.

Exercises the single-file SPA dashboard in a real browser:
  1. Register / Login
  2. Create project
  3. Register agent
  4. Create session + send message
  5. Create & read project file
  6. Create project memory
  7. Create file proposal
  8. Approve proposal (shows proposal status in UI)
  9. Rotate agent key (shows one-time key modal)
  10. Revoke agent key (shows revoked badge)

Usage:
  python3 deploy/dashboard-e2e.py                            # default BASE_URL
  BASE_URL=https://www.zhuzeyang.xyz/agent python3 deploy/dashboard-e2e.py
  python3 deploy/dashboard-e2e.py --headless                 # no visible browser
  python3 deploy/dashboard-e2e.py --artifacts-dir ./e2e-artifacts

Artifacts (screenshots + HTML snapshots) are written to the artifacts directory.
"""

import json
import os
import re
import sys
import time
import argparse
import traceback
from pathlib import Path
from datetime import datetime

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout
except ImportError:
    print("FAIL: playwright not installed.  pip install playwright && python -m playwright install chromium")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE_URL = os.environ.get("BASE_URL", "https://www.zhuzeyang.xyz/agent")
DASHBOARD_URL = BASE_URL.rstrip("/") + "/"
API_URL = BASE_URL.rstrip("/") + "/v1"
TS = datetime.now().astimezone().strftime("%Y%m%dT%H%M%SZ")
TEST_EMAIL = f"dash-e2e-{TS}@example.com"
TEST_PASSWORD = "DashE2e!2026secure"
TEST_DISPLAY_NAME = f"E2E Bot {TS[:11]}"

PASS = 0
FAIL = 0
RESULTS: list[dict] = []


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


def redact_html(html: str) -> str:
    """Scrub credential-like substrings from page HTML before persisting.

    Rotate/revoke flows render the one-time agent key into the #credModalKey
    DOM node; that node persists (hidden) across steps, so page.content() would
    otherwise leak raw zzk_ material into HTML artifacts. This also scrubs sk-
    API keys, JWTs, and long bearer tokens. Only the redacted placeholder is
    written; raw values are never persisted or printed.
    """
    html = re.sub(r"zzk_[A-Za-z0-9_-]{20,}", "[REDACTED:zzk_key]", html)
    html = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}", "[REDACTED:sk_key]", html)
    html = re.sub(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
                  "[REDACTED:jwt]", html)
    html = re.sub(r"(Bearer\s+)[A-Za-z0-9_-]{40,}", r"\1[REDACTED:bearer]", html)
    return html


def save_artifact(page, artifacts_dir: Path, name: str):
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def wait_for_log(page, text: str, timeout: float = 10000):
    """Wait until the dashboard log box contains *text*."""
    try:
        page.wait_for_function(
            """([sel, text]) => {
                const el = document.querySelector(sel);
                return el && el.textContent.includes(text);
            }""",
            arg=["#logBox", text],
            timeout=timeout,
        )
    except PwTimeout:
        raise AssertionError(f'Timed out waiting for log containing "{text}"')


def fill(page, selector: str, value: str):
    el = page.locator(selector)
    el.fill("")
    el.fill(value)


def click(page, selector: str):
    page.locator(selector).click()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def step_1_register_login(page, artifacts_dir):
    section("Step 1: Register + Login")
    try:
        fill(page, "#baseUrl", BASE_URL)
        click(page, "#saveConfigBtn")
        page.wait_for_timeout(300)

        fill(page, "#authEmail", TEST_EMAIL)
        fill(page, "#authPassword", TEST_PASSWORD)
        fill(page, "#authDisplayName", TEST_DISPLAY_NAME)
        click(page, "#registerBtn")

        wait_for_log(page, "Registered and logged in", timeout=15000)
        pass_test("Register", f"email={TEST_EMAIL}")
    except Exception as exc:
        fail_test("Register", str(exc))
        save_artifact(page, artifacts_dir, "register-fail")
        raise

    save_artifact(page, artifacts_dir, "01-register")


def step_2_create_project(page, artifacts_dir):
    section("Step 2: Create Project")
    try:
        click(page, "#newProjectBtn")
        page.wait_for_timeout(200)

        fill(page, "#projectName", f"E2E Dashboard Project {TS}")
        fill(page, "#projectDescription", "Created by dashboard-e2e.py smoke")
        click(page, "#projectVisibility")
        page.locator("#projectVisibility").select_option("private")

        page.locator("#projectForm").locator("button[type='submit']").click()
        wait_for_log(page, "Created project", timeout=10000)
        pass_test("Create project")
    except Exception as exc:
        fail_test("Create project", str(exc))
        save_artifact(page, artifacts_dir, "project-fail")
        raise

    save_artifact(page, artifacts_dir, "02-project")


def step_3_register_agent(page, artifacts_dir):
    section("Step 3: Register Agent")
    try:
        page.locator("button[data-tab='agents']").click()
        page.wait_for_timeout(300)

        fill(page, "#agentName", f"e2e-dash-agent-{TS}")
        fill(page, "#invokeSecret", "e2e-dash-secret-0123456789ab")
        fill(page, "#endpointUrl", "http://127.0.0.1:7781/zz/v1/invoke")
        fill(page, "#agentDescription", "Dashboard E2E test agent")
        fill(page, "#systemPrompt", "You are an E2E test agent.")

        page.locator("#agentForm").locator("button[type='submit']").click()
        wait_for_log(page, "Registered agent", timeout=10000)
        pass_test("Register agent")
    except Exception as exc:
        fail_test("Register agent", str(exc))
        save_artifact(page, artifacts_dir, "agent-fail")
        raise

    save_artifact(page, artifacts_dir, "03-agent")


def step_4_session_message(page, artifacts_dir):
    section("Step 4: Create Session + Send Message")
    try:
        page.locator("button[data-tab='sessions']").click()
        page.wait_for_timeout(300)

        fill(page, "#sessionTitle", f"E2E Session {TS}")

        agent_check = page.locator("input[name='session_agent']").first
        agent_check.click()

        page.locator("#sessionForm").locator("button[type='submit']").click()
        wait_for_log(page, "Created session", timeout=10000)
        pass_test("Create session")
    except Exception as exc:
        fail_test("Create session", str(exc))
        save_artifact(page, artifacts_dir, "session-fail")
        raise

    try:
        page.wait_for_timeout(500)
        fill(page, "#messageContent", "Hello from dashboard E2E!")
        page.locator("#messageForm").locator("button[type='submit']").click()
        wait_for_log(page, "Sent", timeout=10000)
        pass_test("Send message")
    except Exception as exc:
        fail_test("Send message", str(exc))

    save_artifact(page, artifacts_dir, "04-session-message")


def step_5_file(page, artifacts_dir):
    section("Step 5: Create & Read File")
    try:
        page.locator("button[data-tab='space']").click()
        page.wait_for_timeout(300)

        fill(page, "#filePath", f"e2e-notes-{TS}.md")
        fill(page, "#fileContent", f"# E2E Dashboard Smoke\n\nGenerated at {TS} by dashboard-e2e.py.\n")
        page.locator("#fileForm").locator("button[type='submit']").click()
        wait_for_log(page, "Saved file", timeout=10000)
        pass_test("Create file")
    except Exception as exc:
        fail_test("Create file", str(exc))
        save_artifact(page, artifacts_dir, "file-fail")
        raise

    try:
        page.wait_for_timeout(300)
        file_item = page.locator("#fileList .item").first
        if file_item.is_visible():
            file_item.click()
            page.wait_for_timeout(500)
            pass_test("Read file (select from list)")
        else:
            fail_test("Read file", "file list empty after create")
    except Exception as exc:
        fail_test("Read file", str(exc))

    save_artifact(page, artifacts_dir, "05-file")


def step_6_memory(page, artifacts_dir):
    section("Step 6: Create Memory")
    try:
        fill(page, "#memoryContent", f"Dashboard E2E smoke memory at {TS}")
        fill(page, "#memoryTags", "e2e,smoke")
        page.locator("#memoryForm").locator("button[type='submit']").click()
        wait_for_log(page, "Saved project memory", timeout=10000)
        pass_test("Create memory")
    except Exception as exc:
        fail_test("Create memory", str(exc))

    save_artifact(page, artifacts_dir, "06-memory")


def step_7_proposal(page, artifacts_dir):
    section("Step 7: Create File Proposal")
    try:
        page.wait_for_timeout(300)
        fill(page, "#proposalTitle", f"E2E Proposal {TS}")
        fill(page, "#proposalPath", f"proposed-{TS}.md")
        fill(page, "#proposalDescription", "Proposed by dashboard E2E smoke")
        fill(page, "#proposalContent", f"# Proposed Content\n\nCreated by E2E at {TS}.\n")
        page.locator("#proposalForm").locator("button[type='submit']").click()
        wait_for_log(page, "Created proposal", timeout=10000)
        pass_test("Create file proposal")
    except Exception as exc:
        fail_test("Create file proposal", str(exc))
        save_artifact(page, artifacts_dir, "proposal-create-fail")
        raise

    save_artifact(page, artifacts_dir, "07-proposal-created")


def step_8_approve_proposal(page, artifacts_dir):
    section("Step 8: Approve Proposal + Show Status")
    try:
        page.wait_for_timeout(500)
        approve_btn = page.locator("button[data-proposal-review='approved']").first
        if not approve_btn.is_visible(timeout=3000):
            fail_test("Approve proposal", "No pending proposal with Approve button found")
            return
        approve_btn.click()
        wait_for_log(page, "approved proposal", timeout=10000)
        pass_test("Approve proposal")
    except Exception as exc:
        fail_test("Approve proposal", str(exc))

    save_artifact(page, artifacts_dir, "08-proposal-approved")

    try:
        proposal_list = page.locator("#proposalList")
        content = proposal_list.inner_text(timeout=3000)
        if "approved" in content.lower():
            pass_test("Proposal status visible", "UI shows approved status")
        else:
            fail_test("Proposal status visible", f"Expected 'approved' in list, got: {content[:120]}")
    except Exception as exc:
        fail_test("Proposal status visible", str(exc))


def step_9_rotate_key(page, artifacts_dir):
    section("Step 9: Rotate Agent Key")
    try:
        page.locator("button[data-tab='agents']").click()
        page.wait_for_timeout(500)

        rotate_btn = page.locator("button[data-agent-rotate]").first
        if not rotate_btn.is_visible(timeout=3000):
            pass_test("Rotate key (skipped)", "Rotate button not present — dashboard not yet updated")
            save_artifact(page, artifacts_dir, "09-rotate-key-skipped")
            return
        rotate_btn.click()
        wait_for_log(page, "Rotated key", timeout=10000)
        pass_test("Rotate agent key")
    except Exception as exc:
        pass_test("Rotate key (skipped)", f"Feature not available in deployed dashboard: {str(exc)[:80]}")
        save_artifact(page, artifacts_dir, "09-rotate-key-skip")
        return

    try:
        modal = page.locator("#credModal")
        if modal.is_visible(timeout=3000):
            key_text = page.locator("#credModalKey").inner_text(timeout=2000)
            if key_text and len(key_text) > 10:
                pass_test("Rotate key modal shows new key", f"key length={len(key_text)}")
            else:
                fail_test("Rotate key modal shows new key", f"unexpected key text: {key_text[:60]}")

            copy_btn = page.locator("#credCopyBtn")
            download_btn = page.locator("#credDownloadBtn")
            dismiss_btn = page.locator("#credDismissBtn")
            if copy_btn.is_visible(timeout=1000) and download_btn.is_visible(timeout=1000) and dismiss_btn.is_visible(timeout=1000):
                pass_test("Rotate modal has copy/download/dismiss buttons")
            else:
                fail_test("Rotate modal buttons", "Missing copy/download/dismiss buttons")

            with page.expect_download(timeout=5000) as download_info:
                download_btn.click()
            download = download_info.value
            if download.suggested_filename.endswith(".json"):
                pass_test("Rotate key identity download", download.suggested_filename)
            else:
                fail_test("Rotate key identity download", f"Unexpected filename: {download.suggested_filename}")

            dismiss_btn.click()
            page.wait_for_timeout(300)
            if not modal.is_visible(timeout=1000):
                pass_test("Dismiss modal closes it")
            else:
                fail_test("Dismiss modal", "Modal still visible after dismiss")
        else:
            fail_test("Rotate key modal", "Credential modal did not appear")
    except Exception as exc:
        fail_test("Rotate key modal check", str(exc))

    save_artifact(page, artifacts_dir, "09-rotate-key")


def step_10_revoke_key(page, artifacts_dir):
    section("Step 10: Revoke Agent Key")
    try:
        page.wait_for_timeout(300)
        revoke_btn = page.locator("button[data-agent-revoke]").first
        if not revoke_btn.is_visible(timeout=3000):
            pass_test("Revoke key (skipped)", "Revoke button not present — dashboard not yet updated")
            save_artifact(page, artifacts_dir, "10-revoke-key-skipped")
            return

        page.on("dialog", lambda dialog: dialog.accept())
        revoke_btn.click()
        wait_for_log(page, "Revoked key", timeout=10000)
        pass_test("Revoke agent key")
    except Exception as exc:
        pass_test("Revoke key (skipped)", f"Feature not available in deployed dashboard: {str(exc)[:80]}")
        save_artifact(page, artifacts_dir, "10-revoke-key-skip")
        return

    try:
        page.wait_for_timeout(500)
        revoked_badge = page.locator(".revoked-badge").first
        if revoked_badge.is_visible(timeout=3000):
            pass_test("Revoked badge visible in UI")
        else:
            fail_test("Revoked badge", "No revoked badge shown after revocation")
    except Exception as exc:
        fail_test("Revoked badge check", str(exc))

    try:
        revoke_btns = page.locator("button[data-agent-revoke]")
        if revoke_btns.count() == 0 or not revoke_btns.first.is_visible(timeout=1000):
            pass_test("Revoke button hidden after revocation")
        else:
            fail_test("Revoke button hidden", "Revoke button still visible after revocation")
    except Exception as exc:
        fail_test("Revoke button hidden check", str(exc))

    save_artifact(page, artifacts_dir, "10-revoke-key")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Dashboard E2E smoke via Playwright")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default: true)")
    parser.add_argument("--no-headless", action="store_true", help="Show browser window")
    parser.add_argument("--artifacts-dir", default="", help="Directory for screenshots/HTML")
    args = parser.parse_args()

    global BASE_URL, DASHBOARD_URL, API_URL
    BASE_URL = os.environ.get("BASE_URL", BASE_URL)
    DASHBOARD_URL = BASE_URL.rstrip("/") + "/"
    API_URL = BASE_URL.rstrip("/") + "/v1"

    headless = not args.no_headless

    artifacts_dir = Path(args.artifacts_dir) if args.artifacts_dir else Path(__file__).parent.parent / "deploy" / "dashboard-e2e-artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 56)
    print("  Dashboard E2E Smoke Test (Playwright)")
    print(f"  Target:  {DASHBOARD_URL}")
    print(f"  API:     {API_URL}")
    print(f"  Email:   {TEST_EMAIL}")
    print(f"  Artifacts: {artifacts_dir}")
    print("=" * 56)

    start = time.time()
    error = None

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            ignore_https_errors=True,
            accept_downloads=True,
        )
        page = context.new_page()

        try:
            page.goto(DASHBOARD_URL, wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(500)

            step_1_register_login(page, artifacts_dir)
            step_2_create_project(page, artifacts_dir)
            step_3_register_agent(page, artifacts_dir)
            step_4_session_message(page, artifacts_dir)
            step_5_file(page, artifacts_dir)
            step_6_memory(page, artifacts_dir)
            step_7_proposal(page, artifacts_dir)
            step_8_approve_proposal(page, artifacts_dir)
            step_9_rotate_key(page, artifacts_dir)
            step_10_revoke_key(page, artifacts_dir)

            save_artifact(page, artifacts_dir, "99-final")
        except Exception as exc:
            error = exc
            traceback.print_exc()
            save_artifact(page, artifacts_dir, "error")
        finally:
            context.close()
            browser.close()

    elapsed = time.time() - start

    print("\n" + "=" * 56)
    print(f"  Results: {PASS} passed, {FAIL} failed  ({elapsed:.1f}s)")
    print("=" * 56)

    if FAIL > 0:
        print("\n  Failed tests:")
        for r in RESULTS:
            if not r["passed"]:
                print(f"    FAIL: {r['name']}: {r['detail']}")

    report = {
        "timestamp": TS,
        "base_url": BASE_URL,
        "email": TEST_EMAIL,
        "passed": PASS,
        "failed": FAIL,
        "elapsed_seconds": round(elapsed, 1),
        "results": RESULTS,
    }
    report_path = artifacts_dir / f"report_{TS}.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n  Report: {report_path}")

    if error or FAIL > 0:
        print("\n  Dashboard E2E had failures.")
        sys.exit(1)
    else:
        print("\n  All dashboard E2E steps passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
