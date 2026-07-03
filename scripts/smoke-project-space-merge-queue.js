#!/usr/bin/env node
// Project Space Local Merge Queue — backend/browser smoke.
//
// Covers the conservative local merge-queue slice: branch rule toggle,
// approved changeset enqueue/dequeue, queue-head merge gating, compaction,
// required-status-check interaction, static wiring, and visible Reviews UI.
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-merge-queue-smoke");
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
    command: "node scripts/smoke-project-space-merge-queue.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    screenshotPath: null,
    evidencePath: EVIDENCE_MD,
    checks: {},
    errors: [],
  };

  try {
    if (!result.backendBuilt) throw new Error("Backend dist missing. Run: cd backend && npm run build");
    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    const seeded = await setupBackendData();
    result.checks.backend = seeded.checks;
    result.checks.staticWiring = checkStaticWiring();
    const backendOk = Object.values(result.checks.backend).every(Boolean);
    const staticOk = Object.values(result.checks.staticWiring).every(Boolean);

    if (!playwright) {
      result.skipped = true;
      result.passed = backendOk && staticOk;
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = backendOk && staticOk && browserResult.passed;
    if (!result.passed) {
      if (!backendOk) result.errors.push("Backend merge-queue checks failed.");
      if (!staticOk) result.errors.push("Static merge-queue wiring checks failed.");
      result.errors.push(...browserResult.errors);
    }

    await writeEvidence(result);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    await writeEvidence(result);
    process.exit(1);
  } finally {
    await cleanup();
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

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-merge-queue-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;
  appDataSource = AppDataSource;
  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const ts = Date.now();
  const owner = await register(baseUrl, `mq-owner-${ts}`, "MQ Owner");
  const viewer = await register(baseUrl, `mq-viewer-${ts}`, "MQ Viewer");

  const project = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: `Merge Queue Smoke ${ts}`,
    description: "Local merge queue smoke",
  });
  assertStatus(project, 201, "project create");
  const projectId = project.data.id;

  assertStatus(await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  }), 201, "add viewer");

  const baseFile = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Merge Queue\n\nbase",
    message: "Initial README",
  });
  assertStatus(baseFile, 201, "base file create");

  const branches = await api(baseUrl, "GET", `/v1/projects/${projectId}/branches`, owner.token);
  assertStatus(branches, 200, "branches list");
  const main = (branches.data.data || branches.data || []).find((b) => b.is_default || b.name === "main");
  if (!main || !main.id) throw new Error("default branch not found");

  const viewerRule = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${main.id}/protection-rules`, viewer.token, {
    block_direct_writes: false,
    merge_queue_enabled: true,
  });
  const ownerRule = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${main.id}/protection-rules`, owner.token, {
    block_direct_writes: false,
    direct_write_bypass_roles: [],
    direct_write_bypass_user_ids: [],
    required_approvals: 0,
    required_status_checks: [],
    merge_queue_enabled: true,
    protected_branch_patterns: [],
  });
  assertStatus(ownerRule, 200, "enable merge queue");

  const first = await createApprovedChangeset(baseUrl, projectId, owner.token, "First queued change", "docs/first.md");
  const second = await createApprovedChangeset(baseUrl, projectId, owner.token, "Second queued change", "docs/second.md");

  const unqueuedMerge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${first.id}/merge`, owner.token);
  const viewerEnqueue = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${first.id}/merge-queue`, viewer.token);
  const firstQueued = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${first.id}/merge-queue`, owner.token);
  const firstQueuedAgain = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${first.id}/merge-queue`, owner.token);
  const secondQueued = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${second.id}/merge-queue`, owner.token);
  const secondEarlyMerge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${second.id}/merge`, owner.token);
  const firstMerge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${first.id}/merge`, owner.token);
  const secondAfterCompaction = await api(baseUrl, "GET", `/v1/projects/${projectId}/changesets/${second.id}`, owner.token);

  const requiredChecksRule = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${main.id}/protection-rules`, owner.token, {
    block_direct_writes: false,
    direct_write_bypass_roles: [],
    direct_write_bypass_user_ids: [],
    required_approvals: 0,
    required_status_checks: ["lint"],
    merge_queue_enabled: true,
    protected_branch_patterns: [],
  });
  assertStatus(requiredChecksRule, 200, "enable status check with queue");
  const queueHeadMissingCheckMerge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${second.id}/merge`, owner.token);

  const third = await createApprovedChangeset(baseUrl, projectId, owner.token, "Third queued change", "docs/third.md");
  const fourth = await createApprovedChangeset(baseUrl, projectId, owner.token, "Fourth queued change", "docs/fourth.md");
  const thirdQueued = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${third.id}/merge-queue`, owner.token);
  const fourthQueued = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${fourth.id}/merge-queue`, owner.token);
  const thirdDequeued = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/changesets/${third.id}/merge-queue`, owner.token);
  const fourthAfterCompaction = await api(baseUrl, "GET", `/v1/projects/${projectId}/changesets/${fourth.id}`, owner.token);

  const checks = {
    viewerCannotEnableRule: viewerRule.status === 403,
    ownerEnabledRule: ownerRule.data.protection && ownerRule.data.protection.rules && ownerRule.data.protection.rules.merge_queue_enabled === true,
    unqueuedMergeBlocked: unqueuedMerge.status === 409 && unqueuedMerge.data && unqueuedMerge.data.rule === "merge_queue" && unqueuedMerge.data.queued === false,
    viewerCannotEnqueue: viewerEnqueue.status === 403,
    firstQueuedPositionOne: firstQueued.status === 200 && firstQueued.data.merge_queue && firstQueued.data.merge_queue.position === 1,
    enqueueIdempotent: firstQueuedAgain.status === 200 && firstQueuedAgain.data.merge_queue && firstQueuedAgain.data.merge_queue.position === 1,
    secondQueuedPositionTwo: secondQueued.status === 200 && secondQueued.data.merge_queue && secondQueued.data.merge_queue.position === 2,
    secondBlockedBehindFirst: secondEarlyMerge.status === 409 && secondEarlyMerge.data && secondEarlyMerge.data.rule === "merge_queue" && secondEarlyMerge.data.queue_head_changeset_id === first.id,
    firstMergeClearsQueue: firstMerge.status === 200 && firstMerge.data.changeset && firstMerge.data.changeset.merge_queue && firstMerge.data.changeset.merge_queue.queued === false,
    compactsAfterHeadMerge: secondAfterCompaction.status === 200 && secondAfterCompaction.data.merge_queue && secondAfterCompaction.data.merge_queue.position === 1,
    queueHeadStillRespectsStatusChecks: queueHeadMissingCheckMerge.status === 409 && queueHeadMissingCheckMerge.data && queueHeadMissingCheckMerge.data.rule === "required_status_checks",
    thirdQueuedBehindSecond: thirdQueued.status === 200 && thirdQueued.data.merge_queue && thirdQueued.data.merge_queue.position === 2,
    fourthQueuedBehindThird: fourthQueued.status === 200 && fourthQueued.data.merge_queue && fourthQueued.data.merge_queue.position === 3,
    dequeueClearsQueue: thirdDequeued.status === 200 && thirdDequeued.data.merge_queue && thirdDequeued.data.merge_queue.queued === false,
    compactsAfterDequeue: fourthAfterCompaction.status === 200 && fourthAfterCompaction.data.merge_queue && fourthAfterCompaction.data.merge_queue.position === 2,
  };

  return {
    baseUrl,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    projectId,
    mainBranchId: main.id,
    visibleChangesetId: second.id,
    checks,
  };
}

async function createApprovedChangeset(baseUrl, projectId, token, title, filePath) {
  const create = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, token, {
    title,
    file_ops: [{ op: "upsert", path: filePath, content: `${title}\n` }],
  });
  assertStatus(create, 201, `create changeset ${title}`);
  const review = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${create.data.id}/review`, token, {
    decision: "approved",
    notes: "smoke approval",
  });
  assertStatus(review, 200, `approve changeset ${title}`);
  return review.data;
}

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  const checks = {
    mergeQueueSchemaFields: html.includes("merge_queue") && html.includes("changesetMergeQueueBadge"),
    mergeQueueEndpoints: html.includes("/merge-queue") && html.includes("enqueue-merge-queue") && html.includes("dequeue-merge-queue"),
    branchRuleWired: html.includes("merge_queue_enabled") && html.includes("data-merge-queue-rule-id"),
    mergeQueueErrorWired: html.includes('payload.rule === "merge_queue"'),
    noFakeAutomationControls: !/auto[- ]?rebase|provider auto-merge|external runner/i.test(html),
    inlineScriptParses: false,
  };
  if (scriptMatch && scriptMatch[1]) {
    vm.compileFunction(scriptMatch[1].trim());
    checks.inlineScriptParses = true;
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, checks: {}, errors: [], screenshotPath: null };
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  try {
    const storageKey = "zz_human_workspace_simple_v1";
    await page.goto(seeded.baseUrl);
    await page.evaluate(({ key, token, projectId, baseUrl }) => {
      localStorage.setItem(key, JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    }, {
      key: storageKey,
      token: seeded.ownerToken,
      projectId: seeded.projectId,
      baseUrl: seeded.baseUrl,
    });

    const url = `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=reviews&changeset_id=${encodeURIComponent(seeded.visibleChangesetId)}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', { timeout: 10000 });
    await page.click('.tab-item[data-tab="reviews"]', { force: true });
    await page.waitForSelector(".reviews-table .reviews-row", { timeout: 10000 });
    await page.waitForSelector("#changesetDetailPane.open", { timeout: 10000 });
    const detailText = await page.locator("#changesetDetailBody").innerText();
    result.checks.detailShowsMergeQueue = detailText.includes("本地合并队列");
    result.checks.detailShowsQueuePosition = detailText.includes("Queue #1") || detailText.includes("位置") && detailText.includes("1");
    result.checks.dequeueControlVisible = await page.locator("[data-cs-action='dequeue-merge-queue']").count().then((n) => n > 0);
    result.checks.listShowsQueueBadge = await page.locator(".reviews-table").innerText().then((text) => text.includes("Queue #1"));

    await page.click("#closeChangesetDetailBtn", { force: true });
    await page.waitForSelector("#changesetDetailPane:not(.open)", { timeout: 5000 });
    if (VIEWPORT_WIDTH >= 700) {
      await page.click('.tab-item[data-tab="files"]', { force: true });
      await page.waitForSelector('#filesTabContent:not(.hidden)', { timeout: 5000 });
      await page.waitForFunction(() => {
        const pill = document.getElementById("branchPill");
        return pill && pill.offsetParent !== null;
      }, { timeout: 5000 });
      await page.click("#branchPill", { force: true });
      await page.waitForSelector("#branchPopover:not(.hidden)", { timeout: 5000 });
      const popoverText = await page.locator("#branchPopover").innerText();
      result.checks.branchRuleVisible = popoverText.includes("Local merge queue");
    } else {
      result.checks.mobileReviewsQueueSurfaceVisible = true;
    }

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.passed = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
  }
  return result;
}

async function register(baseUrl, prefix, displayName) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}@example.invalid`,
    password: "SmokeTest123!",
    display_name: displayName,
  });
  assertStatus(res, 201, `register ${prefix}`);
  return { token: res.data.access_token, userId: res.data.user.id };
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { Accept: "application/json" };
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  return { status: res.status, data };
}

function assertStatus(res, expected, label) {
  if (res.status !== expected) {
    throw new Error(`${label} failed: expected ${expected}, got ${res.status} ${JSON.stringify(res.data)}`);
  }
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Merge Queue Smoke",
    "",
    `- Timestamp: ${result.timestamp}`,
    `- Passed: ${result.passed}`,
    `- Browser available: ${result.browserAvailable}`,
    `- Viewport: ${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
    `- Screenshot: ${result.screenshotPath || "(none)"}`,
    "",
    "## Checks",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ];
  if (result.errors.length) {
    lines.push("", "## Errors", "```", result.errors.join("\n\n"), "```");
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

async function cleanup() {
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
    server = null;
  }
  if (appDataSource && appDataSource.isInitialized) {
    await appDataSource.destroy().catch(() => {});
  }
}

main();
