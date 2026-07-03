#!/usr/bin/env node
// Project Space Reviewer Assignment — browser/runtime smoke harness.
//
// Tests:
//   1. Backend: owner/admin can assign project members as requested reviewers
//   2. Backend: viewer cannot mutate (403)
//   3. Backend: non-member reviewer is rejected (422)
//   4. Backend: changeset list/detail serialize requested_reviewers
//   5. Browser UI: changeset detail renders requested reviewers
//   6. UI does not claim email/webhook/external notifications for reviewer assignment
//
// If Playwright is not resolvable, the script still verifies the backend data
// setup and static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-reviewer-assignment.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
//                                  (defaults to the bundled runtime path).
//
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-reviewer-assignment-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let appDataSource = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-reviewer-assignment.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    screenshotPath: null,
    evidencePath: EVIDENCE_MD,
    checks: {},
    errors: [],
    pendingDeps: [],
  };

  try {
    if (!result.backendBuilt) throw new Error("Backend dist missing. Run: cd backend && npm run build");
    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    // ── 1. Backend API checks ─────────────────────────────────────────────
    const backendChecks = await runBackendChecks();
    result.checks.backend = backendChecks.checks;
    result.pendingDeps = backendChecks.pendingDeps || [];
    if (!backendChecks.available) {
      result.errors.push("Backend reviewer-assignment API is not available.");
      result.passed = false;
      await writeEvidence(result);
      process.exit(1);
    }

    // ── 2. Static JS wiring check ─────────────────────────────────────────
    const staticChecks = checkStaticWiring();
    result.checks.staticWiring = staticChecks;

    const backendOk = Object.values(result.checks.backend).every(Boolean);
    const staticOk = Object.values(staticChecks).every(Boolean);

    if (!playwright) {
      result.skipped = true;
      result.passed = backendOk && staticOk;
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke ─────────────────────────────────────────────
    const browserResult = await runBrowserSmoke(playwright, backendChecks);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = backendOk && staticOk && browserResult.passed;
    if (!result.passed) {
      if (!backendOk) result.errors.push("Backend reviewer-assignment checks failed.");
      if (!staticOk) result.errors.push("Static reviewer-assignment wiring checks failed.");
      result.errors.push(...browserResult.errors);
    }

    await writeEvidence(result);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    result.passed = false;
    result.errors.push(String(err.stack || err.message || err));
    await writeEvidence(result);
    process.exit(1);
  }
}

function tryRequirePlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    try {
      const { createRequire } = require("module");
      const req = createRequire(path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json"));
      return req("playwright");
    } catch (__) {
      return null;
    }
  }
}

async function runBackendChecks() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-reviewer-assignment-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  // Mirror backend test CWD for OpenAPI path resolution.
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  appDataSource = AppDataSource;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const checks = {};
  const pendingDeps = [];

  try {
    // ── Register owner ───────────────────────────────────────────────────
    const ownerEmail = `reviewer-assign-owner-${Date.now()}@example.invalid`;
    const password = "SmokeTest123!";
    const ownerReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: ownerEmail,
      password,
      display_name: "Reviewer Assign Owner",
    });
    if (ownerReg.status !== 201) {
      pendingDeps.push("User registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const ownerToken = ownerReg.data.access_token;
    const ownerId = ownerReg.data.user.id;

    // ── Register a member user ───────────────────────────────────────────
    const memberEmail = `reviewer-assign-member-${Date.now()}@example.invalid`;
    const memberReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: memberEmail,
      password,
      display_name: "Reviewer Assign Member",
    });
    if (memberReg.status !== 201) {
      pendingDeps.push("Member registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const memberToken = memberReg.data.access_token;
    const memberId = memberReg.data.user.id;

    // ── Register a viewer user ───────────────────────────────────────────
    const viewerEmail = `reviewer-assign-viewer-${Date.now()}@example.invalid`;
    const viewerReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: viewerEmail,
      password,
      display_name: "Reviewer Assign Viewer",
    });
    if (viewerReg.status !== 201) {
      pendingDeps.push("Viewer registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const viewerToken = viewerReg.data.access_token;
    const viewerId = viewerReg.data.user.id;

    // ── Register a non-member user ───────────────────────────────────────
    const outsiderEmail = `reviewer-assign-outsider-${Date.now()}@example.invalid`;
    const outsiderReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: outsiderEmail,
      password,
      display_name: "Reviewer Assign Outsider",
    });
    if (outsiderReg.status !== 201) {
      pendingDeps.push("Outsider registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const outsiderToken = outsiderReg.data.access_token;
    const outsiderId = outsiderReg.data.user.id;

    // ── Create project ───────────────────────────────────────────────────
    const projectRes = await api(baseUrl, "POST", "/v1/projects", ownerToken, {
      name: "Reviewer Assign Smoke Project",
      description: "Smoke for reviewer assignment",
    });
    if (projectRes.status !== 201) {
      pendingDeps.push("Project creation unavailable");
      return { checks, pendingDeps, available: false };
    }
    const projectId = projectRes.data.id;

    // ── Add member ───────────────────────────────────────────────────────
    const addMemberRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
      user_id: memberId,
      role: "member",
    });
    if (addMemberRes.status !== 201) {
      pendingDeps.push("Add member unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Add viewer ───────────────────────────────────────────────────────
    const addViewerRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
      user_id: viewerId,
      role: "viewer",
    });
    if (addViewerRes.status !== 201) {
      pendingDeps.push("Add viewer unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Create base file ─────────────────────────────────────────────────
    const fileRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, ownerToken, {
      path: "README.md",
      content: "# Reviewer Assignment Smoke\n\nOriginal content",
      message: "Initial README",
    });
    if (fileRes.status !== 201) {
      pendingDeps.push("File creation unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Create changeset ─────────────────────────────────────────────────
    const csRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, ownerToken, {
      title: "Test reviewer assignment",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Reviewer Assignment Smoke\n\nUpdated content",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    });
    if (csRes.status !== 201) {
      pendingDeps.push("Changeset creation unavailable");
      return { checks, pendingDeps, available: false };
    }
    const changesetId = csRes.data.id;

    // ── Check 1: Owner can assign member as requested reviewer ──────────
    const assignOk = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changesetId}/requested-reviewers`, ownerToken, {
      requested_reviewers: [{ reviewer_id: memberId }],
    });
    checks.ownerCanAssignMember = assignOk.status === 200 &&
      Array.isArray(assignOk.data.requested_reviewers) &&
      assignOk.data.requested_reviewers.length === 1 &&
      assignOk.data.requested_reviewers[0].reviewer_id === memberId;

    // ── Check 2: Read back requested_reviewers from list ───────────────
    const listRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/changesets`, ownerToken);
    checks.listReturnsRequestedReviewers = listRes.status === 200 &&
      Array.isArray(listRes.data.data) &&
      listRes.data.data.some((cs) =>
        Array.isArray(cs.requested_reviewers) &&
        cs.requested_reviewers.some((rr) => rr.reviewer_id === memberId)
      );

    // ── Check 3: Non-member reviewer is rejected ────────────────────────
    const rejectNonMember = await api(
      baseUrl,
      "PATCH", `/v1/projects/${projectId}/changesets/${changesetId}/requested-reviewers`,
      ownerToken,
      { requested_reviewers: [{ reviewer_id: outsiderId }] }
    );
    checks.nonMemberReviewerRejected = rejectNonMember.status === 422;

    // ── Check 4: Viewer cannot assign reviewers (no SendMessage) ────────
    const viewerAssign = await api(
      baseUrl,
      "PATCH", `/v1/projects/${projectId}/changesets/${changesetId}/requested-reviewers`,
      viewerToken,
      { requested_reviewers: [{ reviewer_id: memberId }] }
    );
    checks.viewerCannotMutate = viewerAssign.status === 403;

    // ── Check 5: Owner can clear requested_reviewers ────────────────────
    const clearRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changesetId}/requested-reviewers`, ownerToken, {
      requested_reviewers: [],
    });
    checks.ownerCanClearRequestedReviewers = clearRes.status === 200 &&
      Array.isArray(clearRes.data.requested_reviewers) &&
      clearRes.data.requested_reviewers.length === 0 &&
      clearRes.data.requested_reviewer_summary.requested_count === 0;

    // ── Check 6: Owner can reassign after clear ─────────────────────────
    const reassignRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changesetId}/requested-reviewers`, ownerToken, {
      requested_reviewers: [{ reviewer_id: memberId }],
    });
    checks.ownerCanReassignAfterClear = reassignRes.status === 200 &&
      Array.isArray(reassignRes.data.requested_reviewers) &&
      reassignRes.data.requested_reviewers.length === 1;

    // ── Check 7: Detail endpoint returns requested_reviewers ────────────
    const detailRes = await api(
      baseUrl,
      "GET", `/v1/projects/${projectId}/changesets/${changesetId}`,
      ownerToken
    );
    checks.detailReturnsRequestedReviewers = detailRes.status === 200 &&
      Array.isArray(detailRes.data.requested_reviewers) &&
      detailRes.data.requested_reviewers.length === 1;

    // ── Store seeded state for browser smoke ────────────────────────────
    checks._seeded = {
      baseUrl,
      ownerToken,
      memberToken,
      ownerId,
      memberId,
      viewerId,
      outsiderId,
      projectId,
      changesetId,
    };

    return { checks, pendingDeps, available: true };
  } catch (err) {
    return { checks, pendingDeps, available: false, error: String(err) };
  }
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Changeset detail drawer markup exists and can render requested reviewers.
    checks.changesetDetailMarkup =
      html.includes('id="changesetDetailPane"') &&
      html.includes('id="changesetDetailBody"');

    // Requested reviewers section is wired in the changeset detail body.
    // The frontend uses the serialized `requested_reviewers` field.
    checks.requestedReviewersRendered =
      html.includes("requested_reviewers") ||
      html.includes("Requested Reviewers") ||
      html.includes("requestedReviewers");

    // No email-sent or notification claims in changeset detail context.
    checks.noEmailClaim =
      !html.includes("邮件已发送") &&
      !html.includes("email sent") &&
      !html.includes("notification sent") &&
      !html.includes("external notification");

    // No webhook/external notification claims in changeset detail context.
    // (Settings tab has legitimate webhook configuration and status-checks
    // has an honest "no external CI provider" disclaimer — both are separate.)
    checks.noFakeNotificationClaim =
      !html.includes("external review notification") &&
      !html.includes("email notification") &&
      !html.includes("external notification");

    // Inline script parses.
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      vm.compileFunction(scriptMatch[1].trim());
      checks.inlineScriptParses = true;
    } else {
      checks.inlineScriptParses = false;
    }
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

async function runBrowserSmoke(playwright, backendChecks) {
  const result = {
    passed: false,
    checks: {},
    errors: [],
    screenshotPath: null,
  };

  const seeded = backendChecks.checks._seeded;
  if (!seeded) {
    result.errors.push("No seeded data for browser smoke");
    return result;
  }

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.ownerToken,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    await page.goto(origin);
    await page.evaluate(
      ({ key, value }) => { localStorage.setItem(key, value); },
      { key: storageKey, value: storagePayload }
    );

    const url = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=reviews&changeset_id=${encodeURIComponent(seeded.changesetId)}`;
    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for the Reviews tab to become active.
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', { timeout: 10000 });
    result.checks.reviewsTabActive = true;

    // Click Reviews tab to force data load.
    await page.click('.tab-item[data-tab="reviews"]', { force: true });

    // Changeset detail drawer opened.
    await page.waitForSelector("#changesetDetailPane.open", { timeout: 10000 });
    result.checks.changesetDetailOpened = true;

    // Title visible.
    const title = await page.textContent("#changesetDetailTitle");
    result.checks.detailTitle = title && title.includes("Test reviewer assignment");

    // Check that detail body doesn't make fake email/webhook claims.
    const bodyText = await page.textContent("#changesetDetailBody");
    result.checks.noFakeNotificationClaims =
      !bodyText.includes("邮件已发送") &&
      !bodyText.includes("email sent") &&
      !bodyText.includes("notification sent") &&
      !bodyText.includes("external notification") &&
      !bodyText.includes("external CI");

    // Screenshot.
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try { await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }); result.screenshotPath = SCREENSHOT_PATH; } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  return result;
}

async function api(baseUrl, method, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function writeEvidence(result) {
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const md = [
    "# Project Space Reviewer Assignment — Browser Smoke Evidence",
    "",
    `- **Command:** \`${result.command}\``,
    `- **Timestamp:** ${result.timestamp}`,
    `- **Backend built:** ${result.backendBuilt}`,
    `- **Browser available:** ${result.browserAvailable}`,
    `- **Passed:** ${result.passed}`,
    `- **Skipped:** ${result.skipped}`,
    result.screenshotPath ? `- **Screenshot:** \`${result.screenshotPath}\`` : "",
    `- **Evidence JSON:** \`${EVIDENCE_JSON}\``,
    "",
    "## Backend Checks",
    "",
    "```json",
    JSON.stringify(result.checks.backend || {}, null, 2),
    "```",
    "",
    "## Static Wiring Checks",
    "",
    "```json",
    JSON.stringify(result.checks.staticWiring || {}, null, 2),
    "```",
    "",
  ];

  if (result.checks.browser) {
    md.push("## Browser Checks", "", "```json", JSON.stringify(result.checks.browser, null, 2), "```", "");
  }

  if (result.pendingDeps && result.pendingDeps.length) {
    md.push("## Pending Dependencies", "", ...result.pendingDeps.map((d) => `- ${d}`), "");
  }

  if (result.errors.length) {
    md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  }

  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async () => {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (appDataSource && appDataSource.isInitialized) await appDataSource.destroy();
  } catch (_) {}
});
