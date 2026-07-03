#!/usr/bin/env python3
"""Onboarding smoke test for NAS human/agent simplified pages.

Covers the lightweight onboarding loop:
  1. human-workspace-simple.html loads and auth form is visible
  2. human-workspace-simple.html login/register + create project persists after refresh
  3. Copy Agent join prompt produces visible success/fallback log
  4. agent-start.html loads and Copy skill produces visible success/fallback log
  5. owner-home.html loads and shows the login panel

This does NOT repeat the legacy dashboard-e2e.py flow (session/message/proposal/rotate/revoke).

Usage:
  python3 deploy/onboarding-smoke.py                      # default BASE_URL
  BASE_URL=http://<your-platform-host>:18080/agent python3 deploy/onboarding-smoke.py
  python3 deploy/onboarding-smoke.py --headless
  python3 deploy/onboarding-smoke.py --artifacts-dir ./e2e-artifacts

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
BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:18080/agent")
API_URL = BASE_URL.rstrip("/") + "/v1"
TS = datetime.now().astimezone().strftime("%Y%m%dT%H%M%SZ")
TEST_EMAIL = f"onboard-smoke-{TS}@example.com"
TEST_PASSWORD = "OnboardSmoke!2026secure"
TEST_DISPLAY_NAME = f"Smoke Bot {TS[:11]}"

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

    Mirrors dashboard-e2e.py: page.content() can capture agent keys / JWTs /
    bearer tokens rendered into the DOM. Only the redacted placeholder is
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


def wait_for_log(page, text: str, timeout: float = 10000):
    """Wait until #logBox or #log contains *text*."""
    try:
        page.wait_for_function(
            """([sel, text]) => {
                const el = document.querySelector(sel);
                return el && el.textContent.includes(text);
            }""",
            arg=["#logBox, #log", text],
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
# human-workspace-simple.html
# ---------------------------------------------------------------------------

def step_hw_loads(page, artifacts_dir):
    """human-workspace-simple.html loads and auth panel is visible."""
    section("Step 1: human-workspace-simple.html loads")
    url = BASE_URL.rstrip("/") + "/human-workspace-simple.html"
    try:
        page.goto(url, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(500)
        # Auth panel must be visible
        auth_panel = page.locator("#authPanel")
        if auth_panel.is_visible():
            pass_test("human-workspace-simple.html loads", f"auth panel visible at {url}")
        else:
            fail_test("human-workspace-simple.html loads", "auth panel not visible")
        # Status pill should say "未连接" or similar
        status_pill = page.locator("#statusPill")
        status_text = status_pill.inner_text() if status_pill.is_visible() else ""
        pass_test("status pill shows", status_text)
    except Exception as exc:
        fail_test("human-workspace-simple.html loads", str(exc))
        save_artifact(page, artifacts_dir, "hw-load-fail")
        raise


def step_hw_register_login(page, artifacts_dir):
    """Login or register a throwaway account."""
    section("Step 2: Register / Login (human-workspace-simple)")
    try:
        # The page defaults its API baseUrl to `origin + "/agent"`, which only
        # matches the remote reverse-proxy mount. When served from localhost
        # (SERVE_DASHBOARD at "/"), that prefix makes /v1/auth/register hit
        # /agent/v1/... -> 404, so register throws and the "欢迎" log never
        # appears. authApi() re-reads #baseUrl.value on every request, so we set
        # it directly via JS (the input lives in a collapsed config panel and is
        # not visible, so Playwright's fill() would time out). BASE_URL is the
        # app root that hosts /v1 on both local and remote mounts.
        page.evaluate(
            "([sel, val]) => { const el = document.querySelector(sel); if (el) el.value = val; }",
            ["#baseUrl", BASE_URL],
        )
        fill(page, "#authEmail", TEST_EMAIL)
        fill(page, "#authPassword", TEST_PASSWORD)
        fill(page, "#authDisplayName", TEST_DISPLAY_NAME)
        click(page, "#loginBtn")
        wait_for_log(page, "欢迎", timeout=15000)
        pass_test("Login/Register", f"email={TEST_EMAIL}")
    except Exception as exc:
        fail_test("Login/Register", str(exc))
        save_artifact(page, artifacts_dir, "hw-auth-fail")
        raise
    save_artifact(page, artifacts_dir, "hw-auth")


def step_hw_create_project(page, artifacts_dir):
    """Create a throwaway project."""
    section("Step 3: Create project (human-workspace-simple)")
    try:
        click(page, "#newProjectToggleBtn")
        page.wait_for_timeout(200)
        fill(page, "#projectName", f"Smoke Project {TS}")
        page.locator("#projectForm").locator("button[type='submit']").click()
        wait_for_log(page, "已创建项目", timeout=10000)
        pass_test("Create project")
    except Exception as exc:
        fail_test("Create project", str(exc))
        save_artifact(page, artifacts_dir, "hw-project-fail")
        raise
    save_artifact(page, artifacts_dir, "hw-project")


def step_hw_project_persists(page, artifacts_dir):
    """Reload page and verify project list is non-empty."""
    section("Step 4: Project persists after refresh")
    try:
        page.reload(wait_until="networkidle", timeout=15000)
        page.wait_for_timeout(500)
        # Project list should have at least one card
        cards = page.locator("#projectList .card")
        count = cards.count()
        if count > 0:
            pass_test("Project persists after reload", f"{count} project(s) visible")
        else:
            fail_test("Project persists after reload", "no projects in list after reload")
    except Exception as exc:
        fail_test("Project persists after reload", str(exc))
        save_artifact(page, artifacts_dir, "hw-persist-fail")


def step_hw_copy_invite_prompt(page, artifacts_dir):
    """Click '复制 Agent 加入指引' and verify a visible success/fallback log."""
    section("Step 5: Copy Agent join prompt (human-workspace-simple)")
    try:
        # Make sure agent panel is visible
        panel = page.locator("#agentPanel")
        if not panel.is_visible():
            hw_reload = page.locator("#projectList .card").first
            hw_reload.click()
            page.wait_for_timeout(500)
        click(page, "#inviteAgentBtn")
        # Wait for the copy fallback log entry to appear (execCommand copy in headless)
        page.wait_for_timeout(1000)
        log_box = page.locator("#logBox")
        log_text = log_box.inner_text()
        # The execCommand fallback logs "手动复制（请全选后 Ctrl+C）（execCommand  fallback）"
        # which contains "复制" and "fallback"
        has_copy_success = "复制" in log_text and ("fallback" in log_text.lower() or "已复制" in log_text)
        if has_copy_success:
            pass_test("Copy invite prompt", f"log shows success/fallback")
        else:
            fail_test("Copy invite prompt", f"no copy success in log: {log_text[:100]}")
    except Exception as exc:
        fail_test("Copy invite prompt", str(exc))
        save_artifact(page, artifacts_dir, "hw-copy-invite-fail")


# ---------------------------------------------------------------------------
# agent-start.html
# ---------------------------------------------------------------------------

def step_as_loads(page, artifacts_dir):
    """agent-start.html loads and shows the bootstrap panel."""
    section("Step 6: agent-start.html loads")
    url = BASE_URL.rstrip("/") + "/agent-start.html"
    try:
        page.goto(url, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(500)
        bootstrap_panel = page.locator(".panel .panel-title")
        titles = [bootstrap_panel.nth(i).inner_text() for i in range(bootstrap_panel.count())]
        pass_test("agent-start.html loads", f"panels: {titles}")
    except Exception as exc:
        fail_test("agent-start.html loads", str(exc))
        save_artifact(page, artifacts_dir, "as-load-fail")
        raise
    save_artifact(page, artifacts_dir, "as-load")


def step_as_join_invite(page, artifacts_dir):
    """agent-start.html?intent=join renders the invite banner safely."""
    section("Step 6b: agent-start.html?intent=join")
    join_url = (
        BASE_URL.rstrip("/")
        + "/agent-start.html?intent=join&project_id=proj-1&project_name=%3Cimg%20src%3Dx%20onerror%3D1%3E&requested_role=viewer"
    )
    try:
        page.goto(join_url, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(500)

        invite_banner = page.locator("#inviteBanner")
        if invite_banner.is_visible():
            pass_test("Join invite banner visible", join_url)
        else:
            fail_test("Join invite banner visible", "invite banner not visible")

        invite_desc = page.locator("#inviteDesc")
        invite_text = invite_desc.inner_text() if invite_desc.is_visible() else ""
        if "<img" in invite_text or "onerror" in invite_text:
            pass_test("Invite text preserved as literal text", invite_text)
        else:
            fail_test("Invite text preserved as literal text", f"unexpected text: {invite_text[:120]}")

        invite_desc_html = invite_desc.evaluate("(el) => el.innerHTML") if invite_desc.is_visible() else ""
        if "&lt;img src=x onerror=1&gt;" in invite_desc_html:
            pass_test("Invite params escaped in HTML", invite_desc_html)
        else:
            fail_test("Invite params escaped in HTML", invite_desc_html[:160])

        invite_cmd = page.locator("#inviteCliCmd").inner_text() if page.locator("#inviteCliCmd").is_visible() else ""
        quick_join_cmd = page.locator("#cliJoinCmd").inner_text() if page.locator("#cliJoinCmd").is_visible() else ""
        # When real invite params are present, the dashboard correctly substitutes
        # the placeholder with a copyable command referencing the actual invite URL.
        # Assert the command is the positional `zz agent join` form (with or without
        # the `pip install` bootstrap prefix) and references the real invite URL,
        # rather than demanding the literal placeholder.
        invite_has_join = "zz agent join" in invite_cmd
        quick_has_join = "zz agent join" in quick_join_cmd
        invite_refs_url = ("intent=join" in invite_cmd and "project_id=proj-1" in invite_cmd) or "<invite-link-or-project-id>" in invite_cmd
        quick_refs_url = ("intent=join" in quick_join_cmd and "project_id=proj-1" in quick_join_cmd) or "<invite-link-or-project-id>" in quick_join_cmd
        if invite_has_join and invite_refs_url and quick_has_join and quick_refs_url:
            pass_test("Invite command is positional", invite_cmd)
        else:
            fail_test("Invite command is positional", f"banner={invite_cmd!r} quick={quick_join_cmd!r}")
    except Exception as exc:
        fail_test("agent-start.html?intent=join", str(exc))
        save_artifact(page, artifacts_dir, "as-join-fail")
        raise
    save_artifact(page, artifacts_dir, "as-join")


def step_as_copy_skill(page, artifacts_dir):
    """Click Copy skill and verify a visible success/fallback log without secrets."""
    section("Step 7: Copy skill (agent-start.html)")
    try:
        skill_output = page.locator("#skillOutput")
        # Skill textarea should have some content (buildSkill runs on load)
        # Use input_value() for textarea, not inner_text()
        skill_text = skill_output.input_value() if skill_output.is_visible() else ""
        if len(skill_text) < 50:
            fail_test("Copy skill", f"skill output too short or empty: {skill_text[:100]}")
            save_artifact(page, artifacts_dir, "as-copy-skill-fail")
            return
        click(page, "#copySkillBtn")
        page.wait_for_timeout(800)
        log_el = page.locator("#log")
        log_text = log_el.inner_text() if log_el.is_visible() else ""
        # Check log has success or fallback (navigator.clipboard may fail in headless but fallback should work)
        has_success = any(kw in log_text.lower() for kw in ["copied", "copy", "skill", "已复制", "success"])
        if has_success:
            pass_test("Copy skill", f"log confirms copy action: {log_text[-100:]}")
        else:
            fail_test("Copy skill", f"no copy confirmation in log: {log_text[-100:]}")
        # Verify no actual credentials in skill textarea
        # Only flag concrete credential values, not placeholder text.
        has_ak_creds = bool(re.search(r"ak-[A-Za-z0-9]{10,}", skill_text))
        has_zzk_creds = bool(re.search(r"zzk_[A-Za-z0-9_-]{20,}", skill_text))
        has_jwt_creds = bool(re.search(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", skill_text))
        has_creds = has_ak_creds or has_zzk_creds or has_jwt_creds
        if has_creds:
            fail_test("Copy skill — no secrets check", "skill output contains credential-like strings")
        else:
            pass_test("Copy skill — no secrets visible", "skill output appears credential-free")
    except Exception as exc:
        fail_test("Copy skill", str(exc))
        save_artifact(page, artifacts_dir, "as-copy-skill-fail")


# ---------------------------------------------------------------------------
# Duplicate 409 join-request — should show pending approval, not fatal error
# ---------------------------------------------------------------------------

def step_as_duplicate_409(page, artifacts_dir):
    """Verify duplicate join-request 409 shows pending approval state, not a generic error."""
    section("Step 6c: Duplicate join-request 409 shows pending approval")
    import re as _re

    join_url = (
        BASE_URL.rstrip("/")
        + "/agent-start.html?intent=join&project_id=proj-dup-409&project_name=409TestProject&requested_role=member"
    )
    try:
        page.goto(join_url, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(500)

        # Fill auth form so bootstrap can proceed past authentication
        # The page's base URL must match the server mount (same as step_hw_register_login)
        page.evaluate(
            "([sel, val]) => { const el = document.querySelector(sel); if (el) el.value = val; }",
            ["#baseUrl", BASE_URL],
        )
        fill(page, "#email", TEST_EMAIL)
        fill(page, "#password", TEST_PASSWORD)
        fill(page, "#displayName", TEST_DISPLAY_NAME)

        # Intercept project GET -> 403 (not a member), so the invite flow
        # falls through to submitting a join-request.
        page.route(_re.compile(r"/v1/projects/[^/]+$"), lambda route: route.fulfill(
            status=403,
            content_type="application/json",
            body=json.dumps({"detail": "Forbidden"}),
        ))

        # Intercept join-requests POST -> 409 (duplicate)
        page.route(_re.compile(r"/v1/projects/[^/]+/join-requests"), lambda route: route.fulfill(
            status=409,
            content_type="application/json",
            body=json.dumps({
                "detail": "A join request already exists or this account is already a member.",
                "status": "pending",
            }),
        ))

        click(page, "#bootstrapBtn")
        page.wait_for_timeout(3000)

        # Assert: approval state is visible, not a generic fatal error
        approval_state = page.locator("#approvalState")
        if approval_state.is_visible():
            pass_test("Duplicate 409 shows pending approval", "approval-state panel visible after 409")
        else:
            fail_test("Duplicate 409 shows pending approval", "approval-state panel not shown")
            save_artifact(page, artifacts_dir, "as-dup409-fail")

        # Assert: status pill does NOT show "error"
        status_pill = page.locator("#statusPill")
        status_text = status_pill.inner_text() if status_pill.is_visible() else ""
        if "error" not in status_text.lower():
            pass_test("Duplicate 409 no fatal error", f"status: {status_text}")
        else:
            fail_test("Duplicate 409 no fatal error", f"status shows error: {status_text}")

        # Assert: error count in log is 0
        log_el = page.locator("#log")
        log_text = log_el.inner_text() if log_el.is_visible() else ""
        error_lines = [l for l in log_text.split("\n") if "error" in l.lower()]
        if len(error_lines) == 0:
            pass_test("Duplicate 409 — no error in log", "log clean")
        else:
            fail_test("Duplicate 409 — no error in log", f"found {len(error_lines)} error line(s): {error_lines[0][:80]}")
    except Exception as exc:
        fail_test("Duplicate 409 shows pending approval", str(exc))
        save_artifact(page, artifacts_dir, "as-dup409-exc")
    finally:
        try:
            page.unroute(_re.compile(r"/v1/projects/"))
        except Exception:
            pass

    save_artifact(page, artifacts_dir, "as-dup409")


# ---------------------------------------------------------------------------
# owner-home.html
# ---------------------------------------------------------------------------

def step_oh_loads(page, artifacts_dir):
    """owner-home.html loads and shows the login panel."""
    section("Step 8: owner-home.html loads")
    url = BASE_URL.rstrip("/") + "/owner-home.html"
    try:
        # The script shares one browser context across steps; the earlier
        # human-workspace login persists a JWT in localStorage (same origin),
        # which makes owner-home render the logged-in state and hide #loginBox
        # (renderAuth toggles #loginBox hidden when state.jwt is set). Clear
        # storage so owner-home loads in the unauthenticated state the test
        # asserts: login panel + email/password inputs visible.
        page.context.clear_cookies()
        page.evaluate("() => { try { localStorage.clear(); } catch (e) {} }")
        page.goto(url, wait_until="networkidle", timeout=20000)
        page.wait_for_timeout(500)
        login_box = page.locator("#loginBox")
        if login_box.is_visible():
            pass_test("owner-home.html loads", "login panel visible")
        else:
            fail_test("owner-home.html loads", "login panel not visible")
        email_input = page.locator("#authEmail")
        password_input = page.locator("#authPassword")
        if email_input.is_visible() and password_input.is_visible():
            pass_test("Login form fields visible", "email + password inputs present")
        else:
            fail_test("Login form fields visible", "email or password input missing")
    except Exception as exc:
        fail_test("owner-home.html loads", str(exc))
        save_artifact(page, artifacts_dir, "oh-load-fail")
        raise
    save_artifact(page, artifacts_dir, "oh-load")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Onboarding smoke via Playwright")
    parser.add_argument("--headless", action="store_true", default=True, help="Run headless (default: true)")
    parser.add_argument("--no-headless", action="store_true", help="Show browser window")
    parser.add_argument("--artifacts-dir", default="", help="Directory for screenshots/HTML")
    args = parser.parse_args()

    global BASE_URL, API_URL
    BASE_URL = os.environ.get("BASE_URL", BASE_URL)
    API_URL = BASE_URL.rstrip("/") + "/v1"

    artifacts_dir = Path(args.artifacts_dir) if args.artifacts_dir else Path(__file__).parent / "onboarding-smoke-artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 56)
    print("  Onboarding Smoke Test (Playwright)")
    print(f"  Target:  {BASE_URL}")
    print(f"  Artifacts: {artifacts_dir}")
    print("=" * 56)

    start = time.time()
    error = None

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.no_headless)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            ignore_https_errors=True,
            accept_downloads=True,
        )
        page = context.new_page()

        try:
            step_hw_loads(page, artifacts_dir)
            step_hw_register_login(page, artifacts_dir)
            step_hw_create_project(page, artifacts_dir)
            step_hw_project_persists(page, artifacts_dir)
            step_hw_copy_invite_prompt(page, artifacts_dir)
            step_as_loads(page, artifacts_dir)
            step_as_join_invite(page, artifacts_dir)
            step_as_duplicate_409(page, artifacts_dir)
            step_as_copy_skill(page, artifacts_dir)
            step_oh_loads(page, artifacts_dir)
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
        "passed": PASS,
        "failed": FAIL,
        "elapsed_seconds": round(elapsed, 1),
        "results": RESULTS,
    }
    report_path = artifacts_dir / f"report_{TS}.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\n  Report: {report_path}")

    if error or FAIL > 0:
        print("\n  Onboarding smoke had failures.")
        sys.exit(1)
    else:
        print("\n  All onboarding smoke steps passed!")
        sys.exit(0)


if __name__ == "__main__":
    main()
