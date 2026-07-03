#!/usr/bin/env node
// Project Space File History — browser/runtime smoke harness.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-file-history-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

const V1 = "# File History Smoke\n\noriginal revision";
const V2 = "# File History Smoke\n\nmiddle revision";
const V3 = "# File History Smoke\n\nlatest live revision";

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-file-history.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    screenshotPath: null,
    evidencePath: EVIDENCE_MD,
    checks: {},
    errors: [],
    residual: [],
  };

  try {
    if (!result.backendBuilt) throw new Error("Backend dist missing. Run: cd backend && npm run build");
    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    const seeded = await setupBackendData();
    result.checks.staticWiring = checkStaticWiring();
    result.checks.backendRevisions = await probeBackendRevisions(seeded);

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backendRevisions);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backendRevisions) &&
      browserResult.passed;
    if (!browserResult.passed) result.errors.push(...browserResult.errors);

    await writeEvidence(result);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    result.passed = false;
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
  process.env.JWT_SECRET = "project-space-file-history-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  process.chdir(path.join(ROOT, "backend"));
  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;
  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const owner = await register(baseUrl, "file-history-owner");
  const viewer = await register(baseUrl, "file-history-viewer");
  const outsider = await register(baseUrl, "file-history-outsider");

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "File History Smoke Project",
    description: "Browser smoke for Project Space file history",
    visibility: "private",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  const projectId = projectRes.data.id;

  const addViewer = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error(`Add viewer failed: ${addViewer.status} ${JSON.stringify(addViewer.data)}`);

  const file1 = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "history.md",
    content: V1,
    message: "Initial file history revision",
  });
  if (file1.status !== 201) throw new Error(`File create failed: ${file1.status} ${JSON.stringify(file1.data)}`);

  const file2 = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "history.md",
    content: V2,
    base_revision_id: file1.data.current_revision_id,
    message: "Middle file history revision",
  });
  if (file2.status !== 200) throw new Error(`File update v2 failed: ${file2.status} ${JSON.stringify(file2.data)}`);

  const file3 = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "history.md",
    content: V3,
    base_revision_id: file2.data.current_revision_id,
    message: "Latest file history revision",
  });
  if (file3.status !== 200) throw new Error(`File update v3 failed: ${file3.status} ${JSON.stringify(file3.data)}`);

  return {
    baseUrl,
    projectId,
    fileId: file1.data.id,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    firstRevisionId: file1.data.current_revision_id,
    latestRevisionId: file3.data.current_revision_id,
  };
}

async function register(baseUrl, prefix) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: "SmokeTest123!",
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { token: res.data.access_token, userId: res.data.user.id };
}

async function probeBackendRevisions(seeded) {
  const owner = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions`, seeded.ownerToken);
  const viewer = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions`, seeded.viewerToken);
  const outsider = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions`, seeded.outsiderToken);
  const anonymous = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions`, null);
  const rows = owner.data?.data || [];
  const comparePath =
    `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions/compare` +
    `?base_revision_id=${encodeURIComponent(seeded.firstRevisionId)}` +
    `&head_revision_id=${encodeURIComponent(seeded.latestRevisionId)}`;
  const ownerCompare = await api(seeded.baseUrl, "GET", comparePath, seeded.ownerToken);
  const viewerCompare = await api(seeded.baseUrl, "GET", comparePath, seeded.viewerToken);
  const outsiderCompare = await api(seeded.baseUrl, "GET", comparePath, seeded.outsiderToken);
  const anonymousCompare = await api(seeded.baseUrl, "GET", comparePath, null);
  const missingCompareParams = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/revisions/compare`,
    seeded.ownerToken,
  );
  const diff = ownerCompare.data?.data || {};
  const summary = diff.summary || {};
  return {
    ownerCanRead: owner.status === 200 && rows.length === 3,
    viewerCanRead: viewer.status === 200 && viewer.data?.data?.length === 3,
    outsiderDenied: outsider.status === 403,
    anonymousDenied: anonymous.status === 401,
    oldestFirst: rows.map((r) => r.revision_number).join(",") === "1,2,3",
    historicalContentPreserved: rows[0]?.content === V1 && rows[1]?.content === V2 && rows[2]?.content === V3,
    metadataPresent: rows.every((r) => r.id && r.path === "history.md" && r.content_hash && r.content_type && r.created_at),
    ownerCanCompareRevisions:
      ownerCompare.status === 200 &&
      diff.file_id === seeded.fileId &&
      diff.base_revision?.id === seeded.firstRevisionId &&
      diff.head_revision?.id === seeded.latestRevisionId,
    viewerCanCompareRevisions: viewerCompare.status === 200 && viewerCompare.data?.data?.old_content === V1,
    outsiderCompareDenied: outsiderCompare.status === 403,
    anonymousCompareDenied: anonymousCompare.status === 401,
    missingCompareParamsRejected: missingCompareParams.status === 422,
    compareContentPreserved: diff.old_content === V1 && diff.new_content === V3,
    compareSummaryReal:
      summary.changed === true &&
      summary.old_lines === 3 &&
      summary.new_lines === 3 &&
      summary.lines_removed >= 1 &&
      summary.lines_added >= 1,
  };
}

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  return {
    historyMarkupPresent: html.includes('id="fileHistoryToggle"') && html.includes('id="fileHistoryPanel"'),
    revisionsEndpointWired: html.includes('"/files/" + encodeURIComponent(file.id) + "/revisions"'),
    historicalSelectionWired: html.includes("showHistoricalRevision(revision)") && html.includes("showLiveFileRevision()"),
    revisionCompareEndpointWired: html.includes('"/revisions/compare?base_revision_id="') && html.includes("compareFileRevisionWithCurrent"),
    revisionCompareButtonWired: html.includes("data-compare-revision-id") && html.includes("file-history-diff"),
    noFakeHistoryControls: !/rollback|revert|provider blame|回滚|恢复版本|还原版本/i.test(html),
  };
}

async function runBrowserSmoke(playwright, seeded) {
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  const errors = [];
  const checks = {};

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console:${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror:${err.message}`));

  const storageKey = "zz_human_workspace_simple_v1";
  await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ key, token, projectId, baseUrl }) => {
      window.localStorage.setItem("zz_agent_jwt", token);
      window.localStorage.setItem(key, JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    },
    { key: storageKey, token: seeded.ownerToken, projectId: seeded.projectId, baseUrl: seeded.baseUrl },
  );

  await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=files`, { waitUntil: "networkidle" });
  await page.waitForSelector(`.file-entry[data-file-id="${seeded.fileId}"]`, { timeout: 10000 });
  await page.click(`.file-entry[data-file-id="${seeded.fileId}"]`);
  await page.waitForSelector("#previewPane.open", { timeout: 10000 });
  await page.waitForSelector("#fileHistoryToggle", { state: "visible", timeout: 10000 });
  await page.waitForFunction((latest) => {
    const el = document.querySelector("#previewContent");
    return el && (el.textContent || "").includes(latest);
  }, V3, { timeout: 10000 });

  checks.previewShowsLatestContent = (await page.textContent("#previewContent")).includes(V3);
  await page.click("#fileHistoryToggle");
  await page.waitForSelector("#fileHistoryPanel.open .file-history-row", { timeout: 10000 });

  const historyText = await page.textContent("#fileHistoryPanel");
  checks.historyRowsVisible = (await page.$$("#fileHistoryPanel .file-history-row")).length === 3;
  checks.historyMessagesVisible =
    historyText.includes("Initial file history revision") &&
    historyText.includes("Middle file history revision") &&
    historyText.includes("Latest file history revision");
  checks.currentRevisionMarked = !!(await page.$(`#fileHistoryPanel .file-history-row.current[data-revision-id="${seeded.latestRevisionId}"]`));

  await page.click(`#fileHistoryPanel .file-history-row[data-revision-id="${seeded.firstRevisionId}"]`);
  await page.waitForSelector("#previewHistoryLabel:not(.hidden)", { timeout: 10000 });
  const historicalContent = await page.textContent("#previewContent");
  checks.oldRevisionShowsHistoricalContent = historicalContent.includes(V1);
  checks.oldRevisionDoesNotShowLatestContent = !historicalContent.includes("latest live revision");
  checks.historyBackVisible = !!(await page.$("#previewHistoryBackBtn"));

  await page.click("#previewHistoryBackBtn");
  await page.waitForFunction((latest) => {
    const el = document.querySelector("#previewContent");
    return el && (el.textContent || "").includes(latest);
  }, V3, { timeout: 10000 });
  checks.backRestoresLatestContent = (await page.textContent("#previewContent")).includes(V3);

  await page.click(`#fileHistoryPanel [data-compare-revision-id="${seeded.firstRevisionId}"]`);
  await page.waitForFunction(() => {
    const el = document.querySelector("#fileHistoryPanel .file-history-diff");
    return el && (el.textContent || "").includes("版本比较");
  }, { timeout: 10000 });
  const diffText = await page.textContent("#fileHistoryPanel .file-history-diff");
  checks.comparePanelVisible = diffText.includes("版本比较") && diffText.includes("只读比较，不会修改文件");
  checks.compareSummaryVisible = diffText.includes("新增行") && diffText.includes("删除行") && diffText.includes("变更行");
  checks.compareOldAndNewContentVisible =
    diffText.includes("original revision") &&
    diffText.includes("latest live revision") &&
    diffText.includes("旧 r1") &&
    diffText.includes("新 r3");

  const bodyText = await page.textContent("body");
  checks.noFakeControlsVisible = !/回滚|恢复版本|还原版本|provider blame|rollback|revert/i.test(bodyText);

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  return {
    passed: allChecksPassed(checks) && errors.length === 0,
    checks,
    errors,
    screenshotPath: SCREENSHOT_PATH,
  };
}

function allChecksPassed(checks) {
  return Object.values(checks || {}).every(Boolean);
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data };
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space File History Smoke Evidence",
    "",
    `- Passed: ${result.passed}`,
    `- Skipped: ${result.skipped}`,
    `- Browser available: ${result.browserAvailable}`,
    `- Backend built: ${result.backendBuilt}`,
    `- Screenshot: ${result.screenshotPath || "(none)"}`,
    "",
    "## Checks",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ];
  if (result.errors.length) {
    lines.push("", "## Errors", "```", result.errors.join("\n"), "```");
  }
  if (result.residual.length) {
    lines.push("", "## Residual", ...result.residual.map((r) => `- ${r}`));
  }
  fs.writeFileSync(EVIDENCE_MD, `${lines.join("\n")}\n`);
}

async function cleanup() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

main();
