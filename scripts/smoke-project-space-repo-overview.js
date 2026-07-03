#!/usr/bin/env node
// Project Space Repository Overview — API and browser smoke harness.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-repo-overview-smoke");
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
    command: "node scripts/smoke-project-space-repo-overview.js",
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
    result.checks.backendSummary = await probeBackendSummary(seeded);

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backendSummary);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backendSummary) &&
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
  process.env.JWT_SECRET = "project-space-repo-overview-smoke-secret";
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

  const owner = await register(baseUrl, "repo-overview-owner");
  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Repo Overview Smoke Project",
    description: "Seeded repository landing page evidence",
    visibility: "public",
    topics: ["typescript", "local-agent"],
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  const projectId = projectRes.data.id;

  const readme = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Repo Overview Smoke\n\nThis README is rendered in the repository overview.",
    message: "Seed overview README",
  });
  if (readme.status !== 201) throw new Error(`README create failed: ${readme.status} ${JSON.stringify(readme.data)}`);

  const src = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/index.ts",
    content: "export const repoOverview = true;\n",
    message: "Seed source",
  });
  if (src.status !== 201) throw new Error(`Source create failed: ${src.status} ${JSON.stringify(src.data)}`);

  const docs = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "docs/guide.md",
    content: "# Guide\n\nNested docs file.",
    message: "Seed docs",
  });
  if (docs.status !== 201) throw new Error(`Docs create failed: ${docs.status} ${JSON.stringify(docs.data)}`);

  // Batch105 — seed LICENSE file with MIT content for license detection smoke.
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

  const license = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "LICENSE",
    content: licenseContent,
    message: "Seed MIT license for smoke",
  });
  if (license.status !== 201) throw new Error(`LICENSE create failed: ${license.status} ${JSON.stringify(license.data)}`);

  // Batch105 — seed diverse source files for deterministic language breakdown.
  const appjs = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/app.js",
    content: "const app = { name: 'overview' };\n",
    message: "Seed JS source for language breakdown",
  });
  if (appjs.status !== 201) throw new Error(`app.js create failed: ${appjs.status} ${JSON.stringify(appjs.data)}`);

  const stylecss = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/style.css",
    content: ".overview { display: flex; }\n",
    message: "Seed CSS source for language breakdown",
  });
  if (stylecss.status !== 201) throw new Error(`style.css create failed: ${stylecss.status} ${JSON.stringify(stylecss.data)}`);

  const pkgjson = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "package.json",
    content: JSON.stringify({ name: "overview-smoke", version: "1.0.0" }),
    message: "Seed package.json for language breakdown",
  });
  if (pkgjson.status !== 201) throw new Error(`package.json create failed: ${pkgjson.status} ${JSON.stringify(pkgjson.data)}`);

  // Batch105 — create a no-license project (no LICENSE file, for false-positive guard).
  const noLicenseRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "No License Smoke Project",
    description: "Project without license for smoke",
    visibility: "public",
    topics: ["smoke-test"],
  });
  if (noLicenseRes.status !== 201) throw new Error(`No-license project create failed: ${noLicenseRes.status} ${JSON.stringify(noLicenseRes.data)}`);
  const noLicenseProjectId = noLicenseRes.data.id;

  const nlReadme = await api(baseUrl, "POST", `/v1/projects/${noLicenseProjectId}/files`, owner.token, {
    path: "README.md",
    content: "# No License Project\n\nThis project has no license.",
    message: "Seed no-license README",
  });
  if (nlReadme.status !== 201) throw new Error(`No-license README create failed: ${nlReadme.status} ${JSON.stringify(nlReadme.data)}`);

  const nlCode = await api(baseUrl, "POST", `/v1/projects/${noLicenseProjectId}/files`, owner.token, {
    path: "src/index.ts",
    content: "export const noLicense = true;\n",
    message: "Seed no-license source",
  });
  if (nlCode.status !== 201) throw new Error(`No-license source create failed: ${nlCode.status} ${JSON.stringify(nlCode.data)}`);

  // Wait 1.1s so the changeset merge's createdAt has a distinct second-level
  // timestamp from the file POST revisions, making sort order deterministic.
  await new Promise((r) => setTimeout(r, 1100));

  const changeset = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, owner.token, {
    title: "Repo overview change",
    file_ops: [
      {
        op: "upsert",
        path: "src/feature.ts",
        content: "export const feature = 'overview';\n",
      },
    ],
  });
  if (changeset.status !== 201) throw new Error(`Changeset create failed: ${changeset.status} ${JSON.stringify(changeset.data)}`);
  const review = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changeset.data.id}/review`, owner.token, {
    decision: "approved",
    notes: "Repo overview smoke approval",
  });
  if (review.status !== 200) throw new Error(`Changeset review failed: ${review.status} ${JSON.stringify(review.data)}`);
  const merge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${changeset.data.id}/merge`, owner.token);
  if (merge.status !== 200) throw new Error(`Changeset merge failed: ${merge.status} ${JSON.stringify(merge.data)}`);

  return {
    baseUrl,
    projectId,
    token: owner.token,
    commitId: merge.data.commit && merge.data.commit.id,
    noLicenseProjectId,
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
  const overviewStart = html.indexOf("function renderOverview()");
  const overviewEnd = html.indexOf("function resetFileHistory", overviewStart);
  const overviewSource = overviewStart >= 0 && overviewEnd > overviewStart ? html.slice(overviewStart, overviewEnd) : html;
  return {
    overviewTabPresent: html.includes('data-tab="overview"') && html.includes('id="overviewPanel"'),
    overviewAllowlisted: html.includes('"overview", "files"') && html.includes('legacyRepoAliases'),
    overviewRendererPresent: html.includes("function renderOverview()") && html.includes("data-repo-overview"),
    overviewLinksWired: html.includes("data-overview-tab") && html.includes("els.overviewPanel.addEventListener"),
    topicsRendererPresent: html.includes("data-repo-overview-topics") && html.includes("overviewTopicEditBtn"),
    topicsPatchWired: html.includes('api("PATCH", "/v1/projects/" + pid, { topics: finalTopics })'),
    noFakeRepoProviderControls: !/data-(star|fork|watch)|clone url|github remote|gitea remote/i.test(overviewSource),
  };
}

async function probeBackendSummary(seeded) {
  const summary = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/summary`, seeded.token);
  const branches = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/branches`, seeded.token);
  const detail = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}`, seeded.token);

  // Batch105 — fetch no-license project summary for false-positive guard.
  const noLicenseSummary = seeded.noLicenseProjectId
    ? await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.noLicenseProjectId}/summary`, seeded.token)
    : null;

  const fileTypes = summary.data?.files?.file_types || [];
  const defaultBranch = (branches.data?.data || []).find((branch) => branch.name === "main" || branch.is_default);
  return {
    summaryAvailable: summary.status === 200,
    projectDetailAvailable: detail.status === 200 && detail.data?.name === "Repo Overview Smoke Project",
    summaryTopicsAvailable: Array.isArray(summary.data?.topics) && summary.data.topics.includes("typescript") && summary.data.topics.includes("local-agent"),
    detailTopicsAvailable: Array.isArray(detail.data?.topics) && detail.data.topics.includes("typescript") && detail.data.topics.includes("local-agent"),
    branchAvailable: branches.status === 200 && !!defaultBranch && !!defaultBranch.head_commit_id,
    fileTotalsReal: summary.data?.files?.total_count >= 7 && summary.data?.files?.directory_count >= 2,
    readmeDetected: summary.data?.readme?.path === "README.md",
    recentRevisionPresent: (summary.data?.recent_activity?.revisions || []).some((row) => row.path === "src/feature.ts"),
    fileTypesPresent: fileTypes.some((row) => row.extension === ".ts") && fileTypes.some((row) => row.extension === ".md"),

    // Batch105 — license detection contract
    licenseContractExists: typeof summary.data?.license !== 'undefined',
    licenseDetected: summary.data?.license?.key === 'mit' && summary.data?.license?.name === 'MIT License' && summary.data?.license?.path === 'LICENSE',

    // Batch105 — extended file types for language breakdown coverage
    fileTypesExtended: fileTypes.some((row) => row.extension === ".js") && fileTypes.some((row) => row.extension === ".css") && fileTypes.some((row) => row.extension === ".json"),

    // Batch105 — no-license project false-positive guard
    noLicenseContractExists: noLicenseSummary ? typeof noLicenseSummary.data?.license !== 'undefined' : false,
    noLicenseAbsent: noLicenseSummary ? noLicenseSummary.data?.license === null : false,
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
    { key: storageKey, token: seeded.token, projectId: seeded.projectId, baseUrl: seeded.baseUrl },
  );

  await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-repo-overview]', { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector("[data-repo-overview]");
    return el && (el.textContent || "").includes("Repo Overview Smoke");
  }, { timeout: 10000 });

  const overviewText = await page.textContent("#overviewPanel");
  checks.defaultOverviewTabActive = await page.$eval("#tab-overview", (el) => el.getAttribute("aria-selected") === "true");
  checks.repoHeaderRendersProject = overviewText.includes("Repo Overview Smoke Project") && overviewText.includes("Public");
  checks.topicChipsRender = overviewText.includes("typescript") && overviewText.includes("local-agent");
  checks.branchAndHeadRender = overviewText.includes("Branch: main") && overviewText.includes("HEAD:");
  checks.statsRender = overviewText.includes("Files") && overviewText.includes("Directories") && overviewText.includes("Size") && overviewText.includes("README.md");
  checks.readmeRenders = overviewText.includes("This README is rendered in the repository overview");
  checks.recentChangesRender = overviewText.includes("Repo overview change") || overviewText.includes("src/feature.ts");
  checks.fileTypesRender = overviewText.includes(".ts") && overviewText.includes(".md");
  checks.realModuleLinksRender =
    overviewText.includes("Reviews") &&
    overviewText.includes("History") &&
    overviewText.includes("Wiki") &&
    overviewText.includes("Security");
  checks.noFakeRepoControlsVisible = !/stars|forks|watchers|clone url|github remote|gitea remote|远程 clone/i.test(overviewText);

  // Batch105 — license badge/label in rendered overview
  // Assertion: the overview must contain a "License:" label with the detected
  // license name. Fails until the UI lane adds license rendering.
  checks.licenseBadgeRenders = overviewText.includes("License:") && overviewText.includes("MIT License");

  // Batch105 — language breakdown coverage with diverse file types
  // Assertion: the file type rows must show all seeded extensions.
  checks.languageBreakdownRenders = overviewText.includes(".js") && overviewText.includes(".css") && overviewText.includes(".json");

  // Batch105 — no-false-license check: navigate to the no-license project,
  // verify no license badge or "MIT License" text appears, then return.
  if (seeded.noLicenseProjectId) {
    await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.noLicenseProjectId)}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-repo-overview]', { timeout: 10000 });
    await page.waitForFunction((projectName) => {
      const el = document.querySelector("[data-repo-overview]");
      return el && (el.textContent || "").includes(projectName);
    }, "No License Smoke Project", { timeout: 10000 });
    const noLicenseText = await page.textContent("#overviewPanel");
    checks.noLicenseNoBadge = !noLicenseText.includes("MIT License") && !noLicenseText.includes("License:");
    // Navigate back to main project for the screenshot
    await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-repo-overview]', { timeout: 10000 });
    await page.waitForFunction(() => {
      const el = document.querySelector("[data-repo-overview]");
      return el && (el.textContent || "").includes("Repo Overview Smoke");
    }, { timeout: 10000 });
  } else {
    checks.noLicenseNoBadge = true; // no no-license project to test — skip (won't happen)
  }

  await page.click("#overviewTopicEditBtn");
  await page.waitForSelector("#overviewTopicAddInput", { timeout: 10000 });
  await page.fill("#overviewTopicAddInput", "smoke-topic");
  await page.click("#overviewTopicAddBtn");
  await page.click("#overviewTopicSaveBtn");
  await page.waitForFunction(() => {
    const panel = document.querySelector("#overviewPanel");
    return panel && (panel.textContent || "").includes("smoke-topic") && !document.querySelector("#overviewTopicAddInput");
  }, { timeout: 10000 });
  const updatedProject = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}`, seeded.token);
  const updatedOverviewText = await page.textContent("#overviewPanel");
  checks.topicEditPersists = updatedProject.status === 200 && Array.isArray(updatedProject.data?.topics) && updatedProject.data.topics.includes("smoke-topic");
  checks.topicEditRerenders = updatedOverviewText.includes("smoke-topic");

  await page.click('[data-overview-tab="files"]');
  await page.waitForSelector("#filesTabContent:not(.hidden)", { timeout: 10000 });
  checks.codeLinkOpensFiles = await page.$eval("#tab-files", (el) => el.getAttribute("aria-selected") === "true");

  await page.click("#tab-overview");
  await page.click('[data-overview-tab="history"]');
  await page.waitForSelector("#historyPanel:not(.hidden)", { timeout: 10000 });
  checks.historyLinkOpensHistory = await page.$eval("#tab-history", (el) => el.getAttribute("aria-selected") === "true");

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
    "# Project Space Repository Overview Smoke Evidence",
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
