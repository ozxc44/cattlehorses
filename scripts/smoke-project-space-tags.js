#!/usr/bin/env node
// Project Space Tags Tab — browser/runtime smoke harness.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-tags-smoke");
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
    command: "node scripts/smoke-project-space-tags.js",
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
    result.checks.backendTagsApi = await probeBackendTagsApi(seeded);

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backendTagsApi);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backendTagsApi) &&
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
  process.env.JWT_SECRET = "project-space-tags-smoke-secret";
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

  const password = "SmokeTest123!";
  const owner = await register(baseUrl, "tags-owner", password);
  const member = await register(baseUrl, "tags-member", password);
  const viewer = await register(baseUrl, "tags-viewer", password);

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Tags Smoke Project",
    description: "Browser smoke for Project Space Tags tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: "member" });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: "viewer" });

  const seedChangeset = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, owner.token, {
    title: "Seed tag target commit",
    status: "submitted",
    file_ops: [
      { op: "upsert", path: "README.md", content: "# Tags Smoke\n\nProject used to verify the Tags tab." },
    ],
  });
  if (seedChangeset.status !== 201) {
    throw new Error(`Seed changeset failed: ${seedChangeset.status} ${JSON.stringify(seedChangeset.data)}`);
  }
  const seedReview = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/review`, owner.token, {
    decision: "approved",
  });
  if (seedReview.status !== 200) {
    throw new Error(`Seed changeset review failed: ${seedReview.status} ${JSON.stringify(seedReview.data)}`);
  }
  const seedMerge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${seedChangeset.data.id}/merge`, owner.token);
  if (seedMerge.status !== 200 || !seedMerge.data?.commit?.id) {
    throw new Error(`Seed changeset merge failed: ${seedMerge.status} ${JSON.stringify(seedMerge.data)}`);
  }
  const targetCommitId = seedMerge.data.commit.id;

  const releaseRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, owner.token, {
    title: "Version One",
    tag_name: " V1.0.0 ",
    body: "# Version One\n\nRelease-backed tag.",
    draft: false,
    prerelease: false,
    target_commit_id: targetCommitId,
  });
  if (releaseRes.status !== 201) {
    throw new Error(`Release create failed: ${releaseRes.status} ${JSON.stringify(releaseRes.data)}`);
  }

  return {
    baseUrl,
    projectId,
    ownerToken: owner.token,
    memberToken: member.token,
    viewerToken: viewer.token,
    releaseId: releaseRes.data.id,
    targetCommitId,
    tagName: releaseRes.data.tag_name,
  };
}

async function register(baseUrl, prefix, password) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password,
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { token: res.data.access_token, userId: res.data.user.id };
}

async function probeBackendTagsApi(seeded) {
  const checks = {};
  const tokens = [seeded.ownerToken, seeded.memberToken, seeded.viewerToken];
  for (let i = 0; i < tokens.length; i += 1) {
    const res = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/tags`, tokens[i]);
    checks[`role${i}CanReadTags`] = res.status === 200 && Array.isArray(res.data?.data);
    const tag = res.data?.data?.find((item) => item.tag_name === seeded.tagName);
    checks[`role${i}SeesReleaseTag`] =
      !!tag &&
      tag.release_id === seeded.releaseId &&
      tag.target_commit_id === seeded.targetCommitId &&
      tag.target_commit?.id === seeded.targetCommitId &&
      tag.target_commit?.message === "Seed tag target commit";
  }
  const anon = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/tags`, null);
  checks.anonymousCannotReadTags = anon.status === 401;
  const post = await api(seeded.baseUrl, "POST", `/v1/projects/${seeded.projectId}/tags`, seeded.ownerToken, { tag_name: "v9" });
  checks.noFakeCreateTagEndpoint = post.status === 404;
  return checks;
}

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  return {
    tagsTabMarkup: html.includes('data-tab="tags"') && html.includes('id="tagsPanel"'),
    tagsAllowlisted: /TAB_ALLOWLIST[\s\S]*"tags"/.test(html),
    tagsEndpointWired: html.includes('"/v1/projects/" + pid + "/tags"'),
    openReleaseWired: html.includes("data-tag-release-id") && html.includes('switchTab("releases")'),
    noFakeTagMutationControls: !/delete tag|删除标签|create tag|创建标签|push tag|signed tag|tarball|zipball/i.test(html),
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

  await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=tags`, { waitUntil: "networkidle" });
  await page.waitForSelector("#tagsPanel:not(.hidden)", { timeout: 10000 });
  await page.waitForSelector("#tagsPanel .tag-row", { timeout: 10000 });
  const text = await page.textContent("#tagsPanel");
  checks.tagsPanelVisible = !!(await page.$("#tagsPanel:not(.hidden)"));
  checks.tagNameVisible = text.includes(seeded.tagName);
  checks.releaseTitleVisible = text.includes("Version One");
  checks.commitMessageVisible = text.includes("Seed tag target commit");
  checks.noMutationButtonsVisible = !/删除标签|创建标签|push tag|signed tag/i.test(text);

  await page.click(`#tagsPanel [data-tag-release-id="${seeded.releaseId}"]`);
  await page.waitForSelector("#releasesPanel:not(.hidden)", { timeout: 10000 });
  await page.waitForFunction(
    ({ tagName }) => {
      const panel = document.querySelector("#releasesPanel");
      const text = panel ? panel.textContent || "" : "";
      return text.includes("Version One") && text.includes(tagName);
    },
    { tagName: seeded.tagName },
    { timeout: 10000 },
  );
  const releaseText = await page.textContent("#releasesPanel");
  checks.openReleaseFromTag = releaseText.includes("Version One") && releaseText.includes(seeded.tagName);

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  return {
    checks,
    errors,
    screenshotPath: SCREENSHOT_PATH,
    passed: allChecksPassed(checks) && errors.length === 0,
  };
}

async function api(baseUrl, method, endpoint, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: res.status, data };
}

function allChecksPassed(obj) {
  return Object.values(obj || {}).every((value) => value === true || value === null);
}

async function writeEvidence(result) {
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Tags Smoke",
    "",
    `- passed: ${result.passed}`,
    `- skipped: ${result.skipped}`,
    `- browserAvailable: ${result.browserAvailable}`,
    `- screenshot: ${result.screenshotPath || "n/a"}`,
    "",
    "## Checks",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ];
  if (result.errors.length) {
    lines.push("", "## Errors", "```text", result.errors.join("\n"), "```");
  }
  if (result.residual.length) {
    lines.push("", "## Residual", ...result.residual.map((item) => `- ${item}`));
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

async function cleanup() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
}

main();
