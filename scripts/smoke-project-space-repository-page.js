#!/usr/bin/env node
// Dedicated Repository Page (dashboard/repository.html) — API + browser smoke.
//
// Verifies the read-only MVP repository page:
//   - Loads auth/project context from zz_human_workspace_simple_v1.
//   - Renders a first viewport (name, description, visibility, topics, license,
//     language summary, branch selector, archive download, Open-in-Work cross-link).
//   - Renders Overview (README or honest empty), Files (tree + preview),
//     Compare (branch diff), History (commits + verification), Tags (list).
//   - Contains no fake OSS controls (no star/fork/watch/clone/etc.).
//
// Usage:
//   node scripts/smoke-project-space-repository-page.js
//   VIEWPORT_WIDTH=390 VIEWPORT_HEIGHT=844 node scripts/smoke-project-space-repository-page.js
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const REPOSITORY_HTML = path.join(ROOT, "dashboard", "repository.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-repository-page-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-repository-page.js",
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
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backend);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backend) &&
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

// ---------------------------------------------------------------------------
// Backend seeding
// ---------------------------------------------------------------------------
async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-repository-page-smoke-secret";
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

  const owner = await register(baseUrl, "repo-page-owner");

  // Main project — full data (README, license, topics, languages, branches,
  // commits, tags, and a divergent comparison branch).
  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Repository Page Smoke",
    description: "Dedicated repository page MVP evidence project.",
    visibility: "public",
    topics: ["typescript", "docs"],
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  const projectId = projectRes.data.id;

  // Seed diverse files (README, source in multiple languages, nested dirs,
  // MIT LICENSE) via a changeset so a commit is recorded.
  const licenseContent = [
    "MIT License",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
    "",
  ].join("\n");

  const merge1 = await createAndMergeChangeset(baseUrl, projectId, owner.token, [
    { op: "upsert", path: "README.md", content: "# Repository Page Smoke\n\nRendered README for the dedicated repository page.\n\n- one\n- two\n" },
    { op: "upsert", path: "src/index.ts", content: "export const repoPage = true;\n" },
    { op: "upsert", path: "src/app.js", content: "const app = { name: 'repo-page' };\n" },
    { op: "upsert", path: "src/style.css", content: ".repo { display: block; }\n" },
    { op: "upsert", path: "docs/guide.md", content: "# Guide\n\nNested docs file.\n" },
    { op: "upsert", path: "package.json", content: JSON.stringify({ name: "repo-page-smoke", version: "1.0.0" }) },
    { op: "upsert", path: "LICENSE", content: licenseContent },
  ], "Seed repository page files");

  const firstCommitId = merge1.commit && merge1.commit.id;

  // Create a comparison branch off main, then advance main with new files so
  // base=feature head=main shows added files.
  const branchRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/branches`, owner.token, {
    name: "feature/repo-page",
    source_branch: "main",
  });
  if (branchRes.status !== 201) throw new Error(`Branch create failed: ${branchRes.status} ${JSON.stringify(branchRes.data)}`);
  const compareBranchName = branchRes.data.name;

  const merge2 = await createAndMergeChangeset(baseUrl, projectId, owner.token, [
    { op: "upsert", path: "features.md", content: "# Features\n\nAdded after the branch cut.\n" },
    { op: "upsert", path: "CHANGELOG.md", content: "# Changelog\n\nInitial changelog.\n" },
  ], "Divergent changes on main after branch cut");
  const secondCommitId = merge2.commit && merge2.commit.id;

  // Create a release → produces a tag pointing at the latest commit.
  const releaseRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, owner.token, {
    title: "Version One",
    tag_name: "v1.0.0",
    body: "# Version One\n\nRelease-backed tag.",
    draft: false,
    prerelease: false,
    target_commit_id: secondCommitId || firstCommitId,
  });
  if (releaseRes.status !== 201) throw new Error(`Release create failed: ${releaseRes.status} ${JSON.stringify(releaseRes.data)}`);

  // Second project — no README, to verify the honest empty state on Overview.
  const noReadmeRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "No Readme Smoke",
    description: "Project without a README for the empty-state check.",
    visibility: "private",
    topics: ["empty-state"],
  });
  if (noReadmeRes.status !== 201) throw new Error(`No-readme project create failed: ${noReadmeRes.status} ${JSON.stringify(noReadmeRes.data)}`);
  const noReadmeProjectId = noReadmeRes.data.id;
  await createAndMergeChangeset(baseUrl, noReadmeProjectId, owner.token, [
    { op: "upsert", path: "src/index.ts", content: "export const noReadme = true;\n" },
  ], "Seed no-readme source");

  return {
    baseUrl,
    projectId,
    noReadmeProjectId,
    token: owner.token,
    compareBranchName,
    firstCommitId,
    secondCommitId,
  };
}

async function createAndMergeChangeset(baseUrl, projectId, token, fileOps, title) {
  const cs = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, token, {
    title: title,
    status: "submitted",
    file_ops: fileOps,
  });
  if (cs.status !== 201) throw new Error(`Changeset create failed (${title}): ${cs.status} ${JSON.stringify(cs.data)}`);
  const review = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${cs.data.id}/review`, token, {
    decision: "approved",
    notes: "repository page smoke",
  });
  if (review.status !== 200) throw new Error(`Changeset review failed (${title}): ${review.status} ${JSON.stringify(review.data)}`);
  const merge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${cs.data.id}/merge`, token);
  if (merge.status !== 200) throw new Error(`Changeset merge failed (${title}): ${merge.status} ${JSON.stringify(merge.data)}`);
  return merge.data;
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

// ---------------------------------------------------------------------------
// Static wiring checks (read repository.html source)
// ---------------------------------------------------------------------------
function checkStaticWiring() {
  const html = fs.readFileSync(REPOSITORY_HTML, "utf8");
  return {
    pageShellPresent:
      html.includes('id="repoHeader"') &&
      html.includes('id="repoSubnav"') &&
      html.includes('id="repoContent"'),
    storageKeyWired: html.includes("zz_human_workspace_simple_v1"),
    urlProjectIdWired: html.includes('params.get("project_id")'),
    allViewsPresent:
      VIEWS().every((v) => html.includes('data-view="' + v + '"') && html.includes('data-repo-view="' + v + '"')),
    repoHeaderElements:
      html.includes('data-repo-name') &&
      html.includes('data-repo-visibility') &&
      html.includes('data-repo-topics') &&
      html.includes('data-repo-license') &&
      html.includes('data-repo-languages'),
    branchSelectorWired: html.includes("data-repo-branch-select") && html.includes("/branches"),
    archiveLinkWired: html.includes("data-repo-archive") && html.includes("/archive.zip"),
    openInWorkCrosslink:
      html.includes("Open in Work") && html.includes('data-repo-crosslink="work"') && html.includes("project-space.html"),
    readmeEndpointWired: html.includes("/readme"),
    compareEndpointWired: html.includes("/branches/compare"),
    commitsEndpointWired: html.includes("/commits"),
    tagsEndpointWired: html.includes("/tags"),
    languagesEndpointWired: html.includes("/languages"),
    markdownRendererPresent: html.includes("function simpleMarkdown"),
    noFakeProviderControls: !FORBIDDEN_SOURCE_REGEX.test(html),
  };
}

function VIEWS() { return ["overview", "files", "compare", "history", "tags"]; }

// Targeted word-boundary scan for forbidden visible-control labels. Avoids
// broad substrings that would match required page words such as "Repository".
const FORBIDDEN_SOURCE_REGEX =
  /\b(stars?|forks?|watchers?|watching|clones?|sponsor)\b|pull request|new issue|new pr|git clone|ssh:\/\/|github remote|gitea remote|\bgitlab\b|\bgithub\b|\bgitea\b|spdx cert|osi approved|osi cert|\bgpg\b|signed commit|\bsignature\b|vulnerability scan|\bdeploy button\b|external ci|github actions|gitea actions/i;

// ---------------------------------------------------------------------------
// Backend probe
// ---------------------------------------------------------------------------
async function probeBackend(seeded) {
  const pid = encodeURIComponent(seeded.projectId);
  const token = seeded.token;
  const [detail, summary, readme, branches, compare, commits, tags, languages] = await Promise.all([
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/summary`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/readme`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/branches`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/branches/compare?base=${encodeURIComponent(seeded.compareBranchName)}&head=main`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/commits`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/tags?limit=100`, token),
    api(seeded.baseUrl, "GET", `/v1/projects/${pid}/languages`, token),
  ]);

  const branchList = (branches.data && branches.data.data) || [];
  const commitList = (commits.data && commits.data.data) || [];
  const tagList = (tags.data && tags.data.data) || [];
  const langs = (languages.data && languages.data.languages) || {};

  return {
    detailAvailable: detail.status === 200 && detail.data.name === "Repository Page Smoke",
    detailVisibility: detail.data.visibility === "public",
    summaryTopics: Array.isArray(summary.data.topics) && summary.data.topics.includes("typescript") && summary.data.topics.includes("docs"),
    summaryLicense: summary.data.license && summary.data.license.key === "mit" && summary.data.license.name === "MIT License",
    summaryFileTypes: Array.isArray(summary.data.files.file_types) && summary.data.files.file_types.length > 0,
    readmeAvailable: readme.status === 200 && /Repository Page Smoke/.test(readme.data.content || ""),
    branchesPresent: branchList.some((b) => b.name === "main" && b.is_default) && branchList.some((b) => b.name === seeded.compareBranchName),
    compareSummary: !!compare.data.data.summary && (compare.data.data.summary.added || 0) > 0,
    compareFiles: Array.isArray(compare.data.data.files) && compare.data.data.files.length > 0,
    commitsPresent: commitList.length >= 2,
    tagsPresent: tagList.some((t) => t.tag_name === "v1.0.0"),
    languagesPresent: Object.keys(langs).length > 0 && Object.keys(langs).some((k) => /TypeScript|JavaScript/i.test(k)),
  };
}

// ---------------------------------------------------------------------------
// Browser smoke
// ---------------------------------------------------------------------------
async function runBrowserSmoke(playwright, seeded) {
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  const errors = [];
  const checks = {};
  const failedResponses = [];

  // Track failed responses so we can audit them precisely. Playwright reports
  // HTTP 304 cache revalidations as non-OK even though the browser can use the
  // cached asset successfully, so only statuses that represent a failed load are
  // recorded here. The dedicated README endpoint intentionally returns 404 for
  // projects without a README (the page renders an honest empty state), so a
  // /readme 404 is allowed below. Any other failed request is a real bug.
  page.on("response", (response) => {
    const status = response.status();
    if (!response.ok() && status !== 304) failedResponses.push({ url: response.url(), status });
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    // Chromium logs resource-load failures (e.g. the expected README 404) as
    // generic console errors with no URL. These are network noise, not JS bugs;
    // unexpected failures are caught by the failedResponses audit instead.
    if (/Failed to load resource/i.test(t)) return;
    errors.push(`console:${t}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror:${err.message}`));

  const storageKey = "zz_human_workspace_simple_v1";
  await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ key, token, projectId, baseUrl }) => {
      window.localStorage.setItem("zz_agent_jwt", token);
      window.localStorage.setItem(key, JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    },
    { key: storageKey, token: seeded.token, projectId: seeded.projectId, baseUrl: seeded.baseUrl },
  );

  // ── Default landing = overview ──
  await page.goto(`${seeded.baseUrl}/repository.html?project_id=${encodeURIComponent(seeded.projectId)}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-repo-header]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#repoName");
    return el && (el.textContent || "").includes("Repository Page Smoke");
  }, { timeout: 10000 });

  const headerText = await page.textContent("#repoHeader");
  checks.headerRendersName = headerText.includes("Repository Page Smoke");
  checks.headerRendersDescription = headerText.includes("Dedicated repository page MVP evidence project");
  checks.headerRendersVisibility = headerText.includes("Public");
  checks.headerRendersTopics = headerText.includes("typescript") && headerText.includes("docs");
  checks.headerRendersLicense = headerText.includes("MIT License");

  // Language bar rendered with at least one segment.
  checks.languageBarRenders = (await page.$$('[data-repo-lang-bar] .lang-seg')).length > 0;

  // Branch selector populated with main.
  const branchOptions = await page.$$eval("#branchSelect option", (opts) => opts.map((o) => o.textContent.trim()));
  checks.branchSelectorPopulated = branchOptions.some((o) => /main/.test(o)) && branchOptions.some((o) => /feature\/repo-page/.test(o));

  // Archive link points at the real archive endpoint.
  const archiveHref = await page.getAttribute("#archiveLink", "href");
  checks.archiveLinkReal = /\/v1\/projects\/[^/]+\/archive\.zip/.test(archiveHref || "");

  // Open in Work cross-link targets project-space work tab.
  const workHref = await page.getAttribute('#workLink[data-repo-crosslink="work"]', "href");
  checks.openInWorkCrosslink = /project-space\.html\?project_id=[^&]+&tab=work/.test(workHref || "");

  // Sub-nav has all five tabs.
  const tabViews = await page.$$eval(".subnav-tab", (tabs) => tabs.map((t) => t.getAttribute("data-view")));
  checks.subnavHasAllViews = ["overview", "files", "compare", "history", "tags"].every((v) => tabViews.includes(v));

  // Default overview tab is active.
  checks.defaultOverviewActive = await page.$eval('.subnav-tab[data-view="overview"]', (el) => el.getAttribute("aria-selected") === "true");

  // Overview renders README (markdown → HTML).
  await page.waitForFunction(() => {
    const el = document.querySelector("#overviewReadme");
    return el && (el.textContent || "").includes("Rendered README for the dedicated repository page");
  }, { timeout: 10000 });
  const readmeText = await page.textContent("#overviewReadme");
  checks.overviewReadmeRenders = readmeText.includes("Rendered README for the dedicated repository page");
  checks.overviewSidebarRenders = (await page.textContent("#overviewSidebar")).includes("Files");

  // ── Files view ──
  await page.click('.subnav-tab[data-view="files"]');
  await page.waitForSelector('#filesTree .tree-row', { timeout: 10000 });
  const filesText = await page.textContent("#view-files");
  checks.filesTreeRendersDirs = filesText.includes("src") && filesText.includes("docs");
  // Root-level direct files (index.ts lives inside src/, so it is checked after navigation).
  checks.filesTreeRendersFiles = filesText.includes("README.md") && filesText.includes("package.json");

  // Navigate into src/ directory. Wait for the listing content (not just the
  // breadcrumb, which is set synchronously before the fetch resolves).
  await page.click('#filesTree .tree-row[data-dir="src"]');
  await page.waitForFunction(() => /index\.ts/.test(document.querySelector("#filesTree").textContent || ""), { timeout: 10000 });
  const srcText = await page.textContent("#filesTree");
  checks.filesDirNavigation = srcText.includes("index.ts") && srcText.includes("app.js");

  // Open a file preview (target index.ts so the rendered content is deterministic).
  await page.click('#filesTree .tree-row[data-path="src/index.ts"]');
  await page.waitForSelector('#filesPreview .file-preview-content, #filesPreview .file-preview-rendered', { timeout: 10000 });
  const previewText = await page.textContent("#filesPreview");
  checks.filePreviewOpens = previewText.length > 0 && /export const/.test(previewText);

  // ── Compare view ──
  await page.click('.subnav-tab[data-view="compare"]');
  await page.waitForSelector('#compareResult', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#compareResult");
    return el && (el.textContent || "").length > 20 && !/spinner/.test(el.innerHTML);
  }, { timeout: 10000 });
  // Ensure base/head default to distinct branches with a real diff.
  await page.selectOption("#compareBase", seeded.compareBranchName);
  await page.selectOption("#compareHead", "main");
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-repo-compare-summary]");
    return el && /Files changed/.test(el.textContent || "");
  }, { timeout: 10000 });
  const compareText = await page.textContent("#compareResult");
  checks.compareSummaryRenders = compareText.includes("Files changed") && compareText.includes("Added");
  checks.compareDiffRenders = (await page.$$("#compareResult .op-pill")).length > 0;
  checks.compareDiffShowsAdded = compareText.includes("features.md") || compareText.includes("CHANGELOG.md");

  // ── History view ──
  await page.click('.subnav-tab[data-view="history"]');
  await page.waitForSelector('#historyList .commit-item', { timeout: 10000 });
  const historyText = await page.textContent("#historyList");
  checks.historyRendersCommits = historyText.includes("Seed repository page files") || historyText.includes("Divergent changes on main after branch cut");
  checks.historyRendersVerification = (await page.$$("#historyList .verify-pill")).length > 0;

  // ── Tags view ──
  await page.click('.subnav-tab[data-view="tags"]');
  await page.waitForSelector('#tagsList .tag-item', { timeout: 10000 });
  const tagsText = await page.textContent("#tagsList");
  checks.tagsRendersTag = tagsText.includes("v1.0.0") && tagsText.includes("Version One");

  // ── Honest empty state: project without a README ──
  await page.goto(`${seeded.baseUrl}/repository.html?project_id=${encodeURIComponent(seeded.noReadmeProjectId)}&view=overview`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-repo-header]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#overviewReadme");
    return el && /No README/.test(el.textContent || "");
  }, { timeout: 10000 });
  checks.overviewNoReadmeEmptyState = /No README found/.test(await page.textContent("#overviewReadme"));

  // ── No fake OSS controls anywhere in rendered chrome ──
  // Scope to the persistent chrome (header, toolbar, sub-nav, footer) plus
  // every view title so that honest README content cannot trip the check.
  const chromeText = await page.evaluate(() => {
    const sels = ["#repoHeader", "#repoToolbar", "#repoSubnav", ".repo-footer"];
    const parts = [];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) parts.push(el.textContent || "");
    }
    // Also scan view titles (cheap, controlled text).
    document.querySelectorAll(".view-title, .brand").forEach((el) => parts.push(el.textContent || ""));
    return parts.join(" ");
  });
  checks.noFakeRepoControlsVisible = !/\b(stars?|forks?|watchers?|watching|clones?)\b|pull request|new issue|git clone|ssh:\/\/|github|gitea|spdx|osi approved|\bgpg\b|signed commit|external ci|github actions|gitea actions/i.test(chromeText);

  // Screenshot the main project overview for the evidence record.
  await page.goto(`${seeded.baseUrl}/repository.html?project_id=${encodeURIComponent(seeded.projectId)}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-repo-header]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("#overviewReadme");
    return el && (el.textContent || "").includes("Rendered README");
  }, { timeout: 10000 });
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  // Audit failed requests: only the dedicated README endpoint is allowed to 404
  // (it returns 404 for projects without a README, which the page handles with
  // an honest empty state). Every other request must succeed.
  const unexpectedFailures = failedResponses.filter((f) => !/\/v1\/projects\/[^/]+\/readme(\?|$)/.test(f.url));
  checks.noUnexpectedFailedRequests = unexpectedFailures.length === 0;
  if (unexpectedFailures.length) {
    errors.push("Unexpected failed requests: " + unexpectedFailures.map((f) => `${f.status} ${f.url}`).join("; "));
  }

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
    "# Dedicated Repository Page Smoke Evidence",
    "",
    `- Passed: ${result.passed}`,
    `- Skipped: ${result.skipped}`,
    `- Browser available: ${result.browserAvailable}`,
    `- Backend built: ${result.backendBuilt}`,
    `- Viewport: ${result.viewport.width}x${result.viewport.height}`,
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
