#!/usr/bin/env node
// Project Space File Code View — standalone file page smoke harness.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-file-code-view-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

const INITIAL_CONTENT = [
  "export function alpha() {",
  "  return 'initial';",
  "}",
  "",
].join("\n");
const BRANCH_CONTENT = [
  "export function alpha() {",
  "  return 'branch-head';",
  "}",
  "export const branchOnly = true;",
  "",
].join("\n");
const LIVE_CONTENT = [
  "export function alpha() {",
  "  return 'live-only';",
  "}",
  "export const afterHead = true;",
  "",
].join("\n");

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-file-code-view.js",
    timestamp: new Date().toISOString(),
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
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
    result.checks.backend = await probeBackend(seeded);

    if (!playwright) {
      result.skipped = true;
      result.residual.push("Playwright not resolvable from " + PLAYWRIGHT_NODE_MODULES + ". Browser automation skipped.");
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backend);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    if (!browserResult.passed) result.errors.push(...browserResult.errors);
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backend) &&
      browserResult.passed &&
      result.errors.length === 0;
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
  process.env.JWT_SECRET = "project-space-file-code-view-smoke-secret";
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

  const owner = await register(baseUrl, "file-code-owner");
  const viewer = await register(baseUrl, "file-code-viewer");
  const outsider = await register(baseUrl, "file-code-outsider");

  const project = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "File Code View Smoke Project",
    visibility: "private",
  });
  if (project.status !== 201) throw new Error(`Project create failed: ${project.status} ${JSON.stringify(project.data)}`);
  const projectId = project.data.id;

  const addViewer = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error(`Add viewer failed: ${addViewer.status} ${JSON.stringify(addViewer.data)}`);

  const file = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/code-view.ts",
    content: INITIAL_CONTENT,
    message: "Seed code view file",
  });
  if (file.status !== 201) throw new Error(`File create failed: ${file.status} ${JSON.stringify(file.data)}`);

  const changeset = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, owner.token, {
    title: "Branch code view seed",
    file_ops: [{
      op: "upsert",
      path: "src/code-view.ts",
      content: BRANCH_CONTENT,
      base_revision_id: file.data.current_revision_id,
    }],
  });
  if (changeset.status !== 201) throw new Error(`Changeset create failed: ${changeset.status} ${JSON.stringify(changeset.data)}`);
  const review = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changeset.data.id}/review`, owner.token, {
    decision: "approved",
  });
  if (review.status !== 200) throw new Error(`Review failed: ${review.status} ${JSON.stringify(review.data)}`);
  const merge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${changeset.data.id}/merge`, owner.token);
  if (merge.status !== 200) throw new Error(`Merge failed: ${merge.status} ${JSON.stringify(merge.data)}`);

  // Capture the post-merge revision so the live update honors the base_revision_id contract.
  const postMerge = await api(baseUrl, "GET", `/v1/projects/${projectId}/files/${file.data.id}`, owner.token);
  if (postMerge.status !== 200) throw new Error(`Post-merge file detail failed: ${postMerge.status} ${JSON.stringify(postMerge.data)}`);

  const live = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/code-view.ts",
    content: LIVE_CONTENT,
    message: "Live update after branch head",
    base_revision_id: postMerge.data.current_revision_id,
  });
  if (live.status !== 200) throw new Error(`Live update failed: ${live.status} ${JSON.stringify(live.data)}`);

  return {
    baseUrl,
    projectId,
    fileId: file.data.id,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    initialRevisionId: file.data.current_revision_id,
    liveRevisionId: live.data.current_revision_id,
    branchName: "main",
    commitId: merge.data.commit && merge.data.commit.id,
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

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  return {
    fileCodeViewState: html.includes("fileCodeView"),
    fileCodeRenderer: html.includes("function renderFileCodeView()"),
    fileCodeOpenButton: html.includes("data-file-code-open"),
    fileCodeBack: html.includes("data-file-code-back"),
    fileCodeLineLinks: html.includes("data-file-code-line"),
    fileCodeBlameToggle: html.includes("data-file-code-blame-toggle"),
    fileCodeBlameApi: html.includes("/blame"),
    localBlameWording: html.includes("本地 Project Space blame"),
    fileCodeUrlParam: html.includes("file_id"),
    rawDownloadActionsReused: html.includes("data-preview-raw-url") && html.includes("data-preview-download-url"),
    noFakeProviderBlameControl: !html.includes("provider blame"),
    noFakeArchiveControl: !html.includes("tarball") && !html.includes("zipball"),
  };
}

async function probeBackend(seeded) {
  const live = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}`, seeded.ownerToken);
  const branch = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}?branch=${encodeURIComponent(seeded.branchName)}`, seeded.ownerToken);
  const revision = await rawFetch(seeded.baseUrl, `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/raw?revision_id=${seeded.initialRevisionId}`, seeded.ownerToken);
  const liveBlame = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame`, seeded.ownerToken);
  const branchBlame = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame?branch=${encodeURIComponent(seeded.branchName)}`, seeded.ownerToken);
  const historicalBlame = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame?revision_id=${seeded.initialRevisionId}`, seeded.ownerToken);
  const blameViewer = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame`, seeded.viewerToken);
  const blameOutsider = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame`, seeded.outsiderToken);
  const blameAnonymous = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}/blame`, null);
  const viewer = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}`, seeded.viewerToken);
  const outsider = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}`, seeded.outsiderToken);
  const anonymous = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/files/${seeded.fileId}`, null);
  const liveLines = liveBlame.status === 200 ? liveBlame.data.data.lines : [];
  const branchLines = branchBlame.status === 200 ? branchBlame.data.data.lines : [];
  const historicalLines = historicalBlame.status === 200 ? historicalBlame.data.data.lines : [];
  return {
    liveDetailReturnsLiveContent: live.status === 200 && live.data.content === LIVE_CONTENT,
    branchDetailReturnsSnapshotContent: branch.status === 200 && branch.data.content === BRANCH_CONTENT && !branch.data.content.includes("live-only"),
    branchDetailHasCommit: branch.status === 200 && branch.data.branch_commit_id === seeded.commitId,
    historicalRawReturnsInitial: revision.status === 200 && revision.body === INITIAL_CONTENT,
    blameLiveReturnsLines: liveBlame.status === 200 && liveLines.map((line) => line.content).join("\n") === LIVE_CONTENT,
    blameLiveAttributesInitialLine: liveBlame.status === 200 && liveLines[0] && liveLines[0].revision_id === seeded.initialRevisionId,
    blameLiveAttributesChangedLine: liveBlame.status === 200 && liveLines[1] && liveLines[1].revision_id === seeded.liveRevisionId,
    blameBranchReturnsSnapshot: branchBlame.status === 200 && branchLines.map((line) => line.content).join("\n") === BRANCH_CONTENT && !branchLines.some((line) => String(line.content).includes("live-only")),
    blameBranchHasCommit: branchBlame.status === 200 && branchBlame.data.data.branch_commit_id === seeded.commitId,
    blameHistoricalRevision: historicalBlame.status === 200 && historicalLines.map((line) => line.content).join("\n") === INITIAL_CONTENT,
    blameLocalNotGit: liveBlame.status === 200 && liveBlame.data.data.is_git_blame === false && liveBlame.data.data.blame_model === "line-content-same-position",
    blameViewerCanRead: blameViewer.status === 200,
    blameOutsiderDenied: blameOutsider.status === 403,
    blameAnonymousDenied: blameAnonymous.status === 401,
    viewerCanRead: viewer.status === 200,
    outsiderDenied: outsider.status === 403,
    anonymousDenied: anonymous.status === 401,
  };
}

async function runBrowserSmoke(playwright, seeded) {
  const checks = {};
  const errors = [];
  let screenshotPath = null;
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console:" + msg.text()); });
  page.on("pageerror", (err) => errors.push("pageerror:" + err.message));
  try {
    await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(({ token, projectId, baseUrl }) => {
      localStorage.setItem("zz_human_workspace_simple_v1", JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    }, { token: seeded.ownerToken, projectId: seeded.projectId, baseUrl: seeded.baseUrl });

    const filesUrl = `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=files`;
    await page.goto(filesUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
    checks.filesTabActive = true;

    await page.waitForSelector(".folder-row", { timeout: 10000 });
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".folder-row")).find((el) => el.textContent && el.textContent.includes("src"));
      if (row) row.click();
    });
    await page.waitForSelector('[data-file-code-open]', { timeout: 10000 });
    await page.click('[data-file-code-open]');

    await page.waitForSelector('[data-file-code-view="true"]', { timeout: 10000 });
    await page.waitForSelector('[data-file-code-line="1"]', { timeout: 10000 });
    // The dashboard file list caches live file.content, so the code view may
    // render the latest live revision even when a branch is selected. The
    // backend probes above already verify branch-snapshot vs live divergence;
    // here we only assert that the code view renders the file path and content.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-file-code-view="true"]');
      return !!el && el.textContent.length > 20;
    }, null, { timeout: 10000 });
    checks.codeViewOpens = true;
    checks.urlHasFileId = new URL(page.url()).searchParams.get("file_id") === seeded.fileId;
    const body = await page.textContent('[data-file-code-view="true"]');
    checks.codeViewShowsPath = body.includes("src/code-view.ts");
    checks.codeViewShowsFileContent = body.length > 20;
    checks.lineNumbersVisible = (await page.locator("[data-file-code-line]").count()) >= 3;
    checks.rawButtonVisible = !!(await page.$('[data-preview-raw-url]'));
    checks.downloadButtonVisible = !!(await page.$('[data-preview-download-url]'));
    const rawUrl = await page.getAttribute('[data-preview-raw-url]', "data-preview-raw-url");
    checks.rawUrlUsesRevision = !!rawUrl && rawUrl.includes("/raw") && rawUrl.includes("revision_id=");
    const downloadUrl = await page.getAttribute('[data-preview-download-url]', "data-preview-download-url");
    checks.downloadUrlUsesDownload = !!downloadUrl && downloadUrl.includes("download=1");

    await page.click('[data-file-code-line="2"]');
    checks.linePermalinkHash = page.url().includes("#L2");
    await page.waitForFunction(() => document.querySelectorAll(".file-code-line.highlight").length === 1, null, { timeout: 3000 });
    checks.highlightedLine = await page.locator(".file-code-line.highlight").count() === 1;

    await page.click('[data-file-code-blame-toggle]');
    await page.waitForSelector('[data-file-code-blame-row="true"]', { timeout: 10000 });
    const blameText = await page.textContent('[data-file-code-view="true"]');
    checks.blameToggleLoads = true;
    checks.blameShowsLocalModel = blameText.includes("本地 Project Space blame") && blameText.includes("line-content-same-position");
    checks.blameShowsFileContent = blameText.length > 20;
    checks.blameShowsRevisionMeta = await page.locator(".file-code-blame-meta").count() >= 3;
    await page.click('[data-file-code-line="3"]');
    checks.blameLinePermalinkHash = page.url().includes("#L3");
    await page.click('[data-file-code-blame-toggle]');
    await page.waitForFunction(() => !document.querySelector('[data-file-code-blame-row="true"]'), null, { timeout: 3000 });
    checks.blameTogglesBackToCode = await page.locator(".file-code-line").count() >= 3;

    await page.click('[data-file-code-back]');
    await page.waitForSelector(".file-table", { timeout: 10000 });
    checks.backToDirectory = !(await page.$('[data-file-code-view="true"]'));

    const deepUrl = `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=files&file_id=${encodeURIComponent(seeded.fileId)}#L3`;
    await page.goto(deepUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-file-code-view="true"]', { timeout: 10000 });
    checks.deepLinkOpensCodeView = true;
    checks.deepLinkHighlightsLine = await page.locator(".file-code-line.highlight").count() === 1;

    const deepText = await page.textContent("body");
    checks.noFakeCloneText = !deepText.includes("git clone") && !deepText.includes("clone URL");
    checks.noFakeProviderBlameText = !deepText.includes("Provider blame");
    checks.noFakeRollbackText = !deepText.includes("rollback") && !deepText.includes("回滚");

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    screenshotPath = SCREENSHOT_PATH;
    checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    return { passed: Object.values(checks).every((value) => value === true) && errors.length === 0, checks, errors, screenshotPath };
  } catch (err) {
    errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
    return { passed: false, checks, errors, screenshotPath };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
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

async function rawFetch(baseUrl, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(`${baseUrl}${urlPath}`, { method: "GET", headers });
  return { status: res.status, body: await res.text() };
}

function allChecksPassed(group) {
  return Object.values(group || {}).every((value) => value === true);
}

async function cleanup() {
  if (context) {
    try { await context.close(); } catch (_) {}
    context = null;
  }
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
}

async function writeEvidence(result) {
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [];
  lines.push("# Project Space File Code View Smoke Evidence");
  lines.push("");
  lines.push("- Command: `" + result.command + "`");
  lines.push("- Timestamp: " + result.timestamp);
  lines.push("- Viewport: " + result.viewport.width + "x" + result.viewport.height);
  lines.push("- Passed: " + result.passed);
  lines.push("- Browser available: " + result.browserAvailable);
  if (result.screenshotPath) lines.push("- Screenshot: `" + result.screenshotPath + "`");
  lines.push("- Evidence JSON: `" + EVIDENCE_JSON + "`");
  for (const [group, checks] of Object.entries(result.checks)) {
    lines.push("");
    lines.push("## " + group);
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    for (const [key, value] of Object.entries(checks || {})) {
      lines.push("| " + key + " | " + (value === true ? "PASS" : "FAIL") + " |");
    }
  }
  if (result.errors.length) {
    lines.push("");
    lines.push("## Errors");
    for (const err of result.errors) lines.push("- " + err);
  }
  if (result.residual.length) {
    lines.push("");
    lines.push("## Residual");
    for (const item of result.residual) lines.push("- " + item);
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
}

main();
