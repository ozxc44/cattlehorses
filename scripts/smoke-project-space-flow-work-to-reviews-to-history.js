#!/usr/bin/env node
// Project Space Work → Reviews → History Flow Smoke
//
// A companion flow smoke that tests the open-source-style flow from
// work/context → review/merge → commit history in a single continuous
// browser session.
//
// Seeds a project with a changeset, opens Project Space, verifies the Work
// tab is navigable and labels do not block the flow, then walks through
// Reviews detail/approve/merge, then verifies the resulting commit is
// visible in History.
//
// If Playwright is not resolvable, still verifies backend data setup and
// static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-flow-work-to-reviews-to-history.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
//                                  (defaults to the bundled runtime path).
//   VIEWPORT_WIDTH, VIEWPORT_HEIGHT - viewport dimensions (overridable).
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-flow-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");
const REVIEWS_MERGED_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot-reviews-merged.png");

// Bundled runtime path discovered by PM for this Mac.
const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";

const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;

// Viewport dimensions — overridable via env (used by mobile suite runner).
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let browser = null;
let context = null;
let page = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-flow-work-to-reviews-to-history.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    screenshotPath: null,
    evidencePath: null,
    checks: {},
    errors: [],
    residual: [],
  };

  try {
    if (!result.backendBuilt) {
      throw new Error(
        "Backend dist missing. Run: cd backend && npm run build"
      );
    }

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    if (!playwright) {
      result.residual.push(
        "Playwright not resolvable from this process or from " +
          PLAYWRIGHT_NODE_MODULES +
          ". Browser automation skipped."
      );
    }

    // ── 1. Backend data setup (always runs) ───────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      orchestrationCreated: !!seeded.orchestrationId,
      taskCreated: !!seeded.taskId,
      changesetCreated: !!seeded.changesetId,
      diffAvailable: seeded.diffOk,
      taskLinksChangeset: seeded.taskLinksChangeset,
      taskHasNoCommitBeforeMerge: seeded.taskHasNoCommitBeforeMerge,
    };

    // ── 2. Static JS wiring check (always runs) ───────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed = staticOk && seeded.diffOk;
      result.residual.push(
        "Real-browser rendering not exercised because Playwright is unavailable."
      );
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke — flow from Work → Reviews → History ───────
    const browserResult = await runBrowserSmoke(playwright, seeded);
    // Flatten grouped checks into top-level for evidence consistency.
    Object.assign(result.checks, browserResult.checks);
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = browserResult.passed;
    if (!browserResult.passed) {
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
      const req = createRequire(
        path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json")
      );
      return req("playwright");
    } catch (__) {
      return null;
    }
  }
}

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-flow-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  // app.ts loads openapi-v2.yaml via a path relative to process.cwd(). Existing
  // backend tests are run from the backend/ directory; mirror that so the
  // relative path resolves to the repo root.
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Allow CORS from the ephemeral origin.
  process.env.CORS_ORIGINS = baseUrl;

  const email = `flow-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password,
    display_name: "Flow Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error(
      `Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`
    );
  }
  const token = registerRes.data.access_token;
  const userId = registerRes.data.user.id;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "Flow Smoke Project",
    description: "Browser smoke for Work → Reviews → History flow",
  });
  if (projectRes.status !== 201) {
    throw new Error(
      `Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`
    );
  }
  const projectId = projectRes.data.id;

  const baseFileRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    token,
    {
      path: "README.md",
      content: "# Flow Smoke\n\noriginal content",
      message: "Initial README",
    }
  );
  if (baseFileRes.status !== 201) {
    throw new Error(
      `Base file create failed: ${baseFileRes.status} ${JSON.stringify(baseFileRes.data)}`
    );
  }

  const mainAgentRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, token, {
    name: "Flow Main Agent",
  });
  if (mainAgentRes.status !== 201) {
    throw new Error(
      `Main agent create failed: ${mainAgentRes.status} ${JSON.stringify(mainAgentRes.data)}`
    );
  }

  const workerAgentRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, token, {
    name: "Flow Worker Agent",
  });
  if (workerAgentRes.status !== 201) {
    throw new Error(
      `Worker agent create failed: ${workerAgentRes.status} ${JSON.stringify(workerAgentRes.data)}`
    );
  }

  await heartbeatAgent(baseUrl, mainAgentRes.data.api_key);
  await heartbeatAgent(baseUrl, workerAgentRes.data.api_key);

  const orchestrationRes = await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations`,
    mainAgentRes.data.api_key,
    {
      title: "Flow Smoke Orchestration",
      objective: "Create a linked work item that moves through review and history.",
      main_agent_id: mainAgentRes.data.id,
      worker_agent_ids: [workerAgentRes.data.id],
    }
  );
  if (orchestrationRes.status !== 201) {
    throw new Error(
      `Orchestration create failed: ${orchestrationRes.status} ${JSON.stringify(orchestrationRes.data)}`
    );
  }

  const taskRes = await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations/${orchestrationRes.data.id}/tasks`,
    mainAgentRes.data.api_key,
    {
      title: "Flow linked work task",
      goal: "Change README and verify that the task links to the review and merged commit.",
      assigned_agent_id: workerAgentRes.data.id,
      dispatch: false,
    }
  );
  if (taskRes.status !== 201) {
    throw new Error(
      `Task create failed: ${taskRes.status} ${JSON.stringify(taskRes.data)}`
    );
  }

  const changesetRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets`,
    token,
    {
      title: "Update README via flow smoke",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Flow Smoke\n\nupdated content via flow smoke",
          base_revision_id: baseFileRes.data.current_revision_id,
        },
      ],
      orchestration_id: orchestrationRes.data.id,
      task_id: taskRes.data.id,
    }
  );
  if (changesetRes.status !== 201) {
    throw new Error(
      `Changeset create failed: ${changesetRes.status} ${JSON.stringify(changesetRes.data)}`
    );
  }
  const changesetId = changesetRes.data.id;

  // Verify the diff is available before proceeding.
  const diffRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/changesets/${changesetId}/diff`,
    token
  );
  const diffOk =
    diffRes.status === 200 &&
    Array.isArray(diffRes.data.files) &&
    diffRes.data.files.length === 1 &&
    diffRes.data.files[0].old_content === "# Flow Smoke\n\noriginal content" &&
    diffRes.data.files[0].new_content === "# Flow Smoke\n\nupdated content via flow smoke";

  const taskDetailBeforeMerge = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/orchestration-tasks/${taskRes.data.id}`,
    token
  );
  const taskLinksChangeset =
    taskDetailBeforeMerge.status === 200 &&
    Array.isArray(taskDetailBeforeMerge.data.related_changesets) &&
    taskDetailBeforeMerge.data.related_changesets.some((cs) => cs.id === changesetId);
  const taskHasNoCommitBeforeMerge =
    taskDetailBeforeMerge.status === 200 &&
    Array.isArray(taskDetailBeforeMerge.data.related_commits) &&
    taskDetailBeforeMerge.data.related_commits.length === 0;

  return {
    baseUrl,
    token,
    userId,
    projectId,
    orchestrationId: orchestrationRes.data.id,
    taskId: taskRes.data.id,
    changesetId,
    diffOk,
    taskLinksChangeset,
    taskHasNoCommitBeforeMerge,
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Work tab markup exists.
    checks.workTabMarkup =
      html.includes('data-tab="work"') && html.includes('id="workPanel"');

    // Work filter buttons exist.
    checks.workFilterButtons = html.includes("data-work-filter");

    // Reviews tab markup exists.
    checks.reviewsTabMarkup =
      html.includes('data-tab="reviews"') && html.includes('id="reviewsPanel"');

    // Changeset detail drawer markup exists.
    checks.changesetDetailMarkup =
      html.includes('id="changesetDetailPane"') &&
      html.includes('id="changesetDetailTitle"') &&
      html.includes('id="changesetDetailBody"');

    // Review action controls exist in source.
    checks.reviewActionControls =
      html.includes('data-cs-action="approve"') &&
      html.includes('data-cs-action="request_changes"') &&
      html.includes('data-cs-action="merge"');

    // Cross-links between Work, Reviews, and History exist in source.
    checks.linkedTaskReviewHistoryWired =
      html.includes("related_changesets") &&
      html.includes("related_commits") &&
      html.includes("data-linked-task-id") &&
      html.includes("data-linked-changeset-id") &&
      html.includes("data-linked-commit-id");

    // Diff rendering uses old/new content.
    checks.diffRenderingWired =
      html.includes("op.old_content") && html.includes("op.new_content");

    // History tab markup exists.
    checks.historyTabMarkup =
      html.includes('data-tab="history"') && html.includes('id="historyPanel"');

    // Commit detail drawer markup exists.
    checks.commitDetailMarkup =
      html.includes('id="commitDetailPane"') &&
      html.includes('id="commitDetailTitle"') &&
      html.includes('id="commitDetailBody"');

    // History table wired.
    checks.historyTableWired =
      html.includes("history-table") && html.includes("history-row");

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
    return checks;
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = {
    passed: false,
    checks: {},
    errors: [],
    screenshotPath: null,
  };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  page = await context.newPage();

  // Helper: click a tab whether it is a primary tab item or an overflow item.
  async function switchTab(tab) {
    const primary = await page.$(`.tab-item[data-tab="${tab}"]`);
    if (primary) {
      await primary.click();
    } else {
      await page.click("#tabMoreBtn");
      await page.waitForSelector("#tabMoreMenu.open", { timeout: 5000 });
      await page.click(`.tab-more-item[data-tab="${tab}"]`);
    }
    await page.waitForFunction(
      (t) => !!document.querySelector(`.tab-item[data-tab="${t}"].active, .tab-more-item[data-tab="${t}"].active`),
      tab,
      { timeout: 10000 }
    );
  }

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.token,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    // Seed localStorage so the page is already authenticated and project-selected.
    await page.goto(origin);
    await page.evaluate(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: storageKey, value: storagePayload }
    );

    // ── Phase 1: Work tab — verify navigable and labels do not block ─────
    const workUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
      seeded.projectId
    )}&tab=work&task_id=${encodeURIComponent(seeded.taskId)}`;

    await page.goto(workUrl, { waitUntil: "networkidle" });

    // Work tab becomes active.
    await page.waitForSelector('.tab-item[data-tab="work"].active', {
      timeout: 10000,
    });
    result.checks.workTabActive = true;

    // Work panel is visible (not hidden).
    await page.waitForSelector('#workPanel:not(.hidden)', { timeout: 10000 });
    result.checks.workPanelVisible = true;

    // Work panel renders and opens the linked task detail.
    await page.waitForSelector(".work-panel", { timeout: 10000 });
    result.checks.workPanelRendered = true;

    // The initial auto-login path can skip data loading while busy. If the
    // deep-link drawer is not already open, click Work to trigger loadWorkData().
    // On mobile the open drawer is full-width and intentionally intercepts tab
    // clicks, so avoid a redundant click once the desired state is reached.
    if ((await page.locator("#taskDetailPane.open").count()) === 0) {
      await switchTab("work");
    }
    await page.waitForSelector("#taskDetailPane.open", { timeout: 10000 });
    result.checks.taskDetailOpenedFromWorkDeepLink = true;

    const taskBodyBeforeMerge = await page.textContent("#taskDetailBody");
    result.checks.taskShowsLinkedChangeset =
      taskBodyBeforeMerge.includes("关联评审与提交") &&
      taskBodyBeforeMerge.includes("Update README via flow smoke");
    result.checks.taskCommitAbsentBeforeMerge =
      !taskBodyBeforeMerge.includes("合并提交");

    await page.waitForSelector(
      `#taskDetailBody [data-linked-changeset-id="${seeded.changesetId}"]`,
      { timeout: 5000 }
    );
    result.checks.taskChangesetLinkVisible = true;

    // Labels/pills in the Work tab do not block navigation.
    // Verify the tab-bar buttons are all reachable (primary + overflow).
    const primaryTabButtons = await page.$$(".tab-bar .tab-item");
    const overflowTabButtons = await page.$$(".tab-more-item");
    result.checks.tabBarButtonsReachable =
      primaryTabButtons.length >= 4 && overflowTabButtons.length >= 5;

    // ── Phase 2: Reviews tab — detail, approve, merge ────────────────────
    await page.click(`#taskDetailBody [data-linked-changeset-id="${seeded.changesetId}"]`);

    // Reviews tab becomes active.
    await page.waitForFunction(
      () => !!document.querySelector('.tab-item[data-tab="reviews"].active, .tab-more-item[data-tab="reviews"].active'),
      { timeout: 10000 }
    );
    await page.waitForFunction(
      (changesetId) =>
        new URL(window.location.href).searchParams.get("changeset_id") === changesetId,
      seeded.changesetId,
      { timeout: 5000 }
    );
    result.checks.taskLinkNavigatedToReviews = true;

    // Reviews list rendered.
    await page.waitForSelector(".reviews-table .reviews-row", {
      timeout: 10000,
    });
    result.checks.reviewsListRendered = true;

    // Changeset detail drawer opened (deep-linked via changeset_id in URL).
    await page.waitForSelector("#changesetDetailPane.open", { timeout: 10000 });
    result.checks.changesetDetailOpened = true;

    // Title visible.
    const title = await page.textContent("#changesetDetailTitle");
    result.checks.detailTitle =
      title && title.includes("Update README via flow smoke");

    // Status pill visible.
    const statusPill = await page
      .locator("#changesetDetailBody .pill")
      .first();
    const statusText = await statusPill.textContent();
    result.checks.detailStatusVisible = !!statusText;

    // Diff old/new content visible in the detail body.
    const bodyText = await page.textContent("#changesetDetailBody");
    result.checks.diffOldContent = bodyText.includes("original content");
    result.checks.diffNewContent = bodyText.includes("updated content via flow smoke");
    result.checks.changesetTaskLinkVisible =
      bodyText.includes("查看关联任务") &&
      (await page.locator("#changesetDetailBody [data-linked-task-id]").count()) === 1;

    // Review action controls present.
    await page.waitForSelector("[data-cs-action='approve']", { timeout: 5000 });
    await page.waitForSelector("[data-cs-action='request_changes']", {
      timeout: 5000,
    });
    result.checks.reviewActionControlsVisible = true;

    // Approve the changeset.
    await page.click("[data-cs-action='approve']");
    await page.waitForFunction(
      () => {
        const body = document.querySelector("#changesetDetailBody");
        return body && body.textContent.includes("已批准");
      },
      { timeout: 10000 }
    );
    result.checks.approveStateReflected = true;

    // Merge control appears after approval.
    await page.waitForSelector("[data-cs-action='merge']", { timeout: 10000 });
    result.checks.mergeControlVisible = true;

    // Merge the changeset — accept the confirmation dialog.
    page.on("dialog", (dialog) => dialog.accept());
    await page.click("[data-cs-action='merge']");
    await page.waitForFunction(
      () => {
        const body = document.querySelector("#changesetDetailBody");
        return body && body.textContent.includes("已合并");
      },
      { timeout: 10000 }
    );
    result.checks.mergedStateReflected = true;

    // Snapshot: reviews detail pane showing merged state.
    await page.screenshot({
      path: REVIEWS_MERGED_SCREENSHOT_PATH,
      fullPage: true,
    });
    result.checks.reviewsMergeScreenshotCaptured = fs.existsSync(
      REVIEWS_MERGED_SCREENSHOT_PATH
    );

    // ── Phase 3: History tab — verify merged commit visible ──────────────
    await page.waitForSelector("#changesetDetailBody [data-linked-commit-id]", {
      timeout: 10000,
    });
    result.checks.changesetCommitLinkVisible = true;

    const mergedCommitId = await page
      .locator("#changesetDetailBody [data-linked-commit-id]")
      .first()
      .getAttribute("data-linked-commit-id");
    result.checks.mergedCommitIdCaptured = !!mergedCommitId;

    await page.click("#changesetDetailBody [data-linked-commit-id]");
    await page.waitForFunction(
      () => !!document.querySelector('.tab-item[data-tab="history"].active, .tab-more-item[data-tab="history"].active'),
      { timeout: 10000 }
    );
    result.checks.historyTabActive = true;
    await page.waitForFunction(
      (commitId) => new URL(window.location.href).searchParams.get("commit_id") === commitId,
      mergedCommitId,
      { timeout: 5000 }
    );
    result.checks.changesetLinkNavigatedToHistory = true;

    // Summary cards render.
    await page.waitForSelector(".activity-card", { timeout: 10000 });
    result.checks.historySummaryCardsRendered = true;

    // Commits table renders (the history table reuses reviews-table CSS but
    // carries the history-table class and history-row data).
    await page.waitForSelector(".history-table .history-row", {
      timeout: 10000,
    });
    result.checks.historyCommitsListRendered = true;

    // Row contains the merged changeset title.
    const rowText = await page.textContent(".history-row");
    result.checks.historyCommitMessageVisible =
      rowText && rowText.includes("Update README via flow smoke");

    await page.waitForSelector("#commitDetailPane.open", { timeout: 10000 });
    result.checks.commitDetailOpened = true;

    // Verify changed files are listed in commit detail.
    const commitBodyText = await page.textContent("#commitDetailBody");
    result.checks.changedFilesVisible =
      commitBodyText && commitBodyText.includes("README.md");
    result.checks.commitShowsLinkedReview =
      commitBodyText && commitBodyText.includes("查看关联评审");
    result.checks.commitShowsLinkedTask =
      commitBodyText && commitBodyText.includes("查看关联任务");

    await page.click("#commitDetailBody [data-linked-task-id]");
    await page.waitForFunction(
      () => !!document.querySelector('.tab-item[data-tab="work"].active, .tab-more-item[data-tab="work"].active'),
      { timeout: 10000 }
    );
    await page.waitForSelector("#taskDetailPane.open", { timeout: 10000 });
    await page.waitForFunction(
      (taskId) => new URL(window.location.href).searchParams.get("task_id") === taskId,
      seeded.taskId,
      { timeout: 5000 }
    );
    result.checks.commitLinkNavigatedBackToWork = true;

    await page.waitForSelector("#taskDetailBody [data-linked-commit-id]", {
      timeout: 10000,
    });
    const taskBodyAfterMerge = await page.textContent("#taskDetailBody");
    result.checks.taskShowsMergedCommitAfterRoundTrip =
      taskBodyAfterMerge.includes("关联评审与提交") &&
      (await page.locator("#taskDetailBody [data-linked-commit-id]").count()) >= 1;

    // Final screenshot capturing the full flow evidence (history commit detail).
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    // Capture a failure screenshot for diagnosis.
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
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
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function apiWithKey(baseUrl, method, path, apiKey, body) {
  const headers = { "Content-Type": "application/json", "X-API-Key": apiKey };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function heartbeatAgent(baseUrl, apiKey) {
  const res = await apiWithKey(baseUrl, "POST", "/v1/agents/heartbeat", apiKey, {
    status: "healthy",
    metrics: { load: 0 },
  });
  if (res.status !== 200) {
    throw new Error(`Agent heartbeat failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const md = [
    "# Project Space Work → Reviews → History — Flow Smoke Evidence",
    "",
    `- **Command:** \`${result.command}\``,
    `- **Timestamp:** ${result.timestamp}`,
    `- **Backend built:** ${result.backendBuilt}`,
    `- **Browser available:** ${result.browserAvailable}`,
    `- **Passed:** ${result.passed}`,
    `- **Skipped:** ${result.skipped}`,
    result.screenshotPath
      ? `- **Screenshot:** \`${result.screenshotPath}\``
      : "",
    fs.existsSync(REVIEWS_MERGED_SCREENSHOT_PATH)
      ? `- **Reviews merged screenshot:** \`${REVIEWS_MERGED_SCREENSHOT_PATH}\``
      : "",
    `- **Evidence JSON:** \`${EVIDENCE_JSON}\``,
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
    "",
  ];

  if (result.residual.length) {
    md.push("## Residual gaps", "", ...result.residual.map((r) => `- ${r}`), "");
  }

  if (result.errors.length) {
    md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  }

  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async () => {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
});
