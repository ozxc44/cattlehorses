#!/usr/bin/env node
// Project Space Code Search — API and browser smoke harness.
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const OPENAPI = path.join(ROOT, "openapi-v2.yaml");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-code-search-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

const CONTENT_TOKEN = "LOCAL_CODE_SEARCH_TOKEN";
const BRANCH_ONLY_TOKEN = "BRANCH_CODE_SEARCH_TOKEN";
const LIVE_ONLY_TOKEN = "LIVE_CODE_SEARCH_TOKEN";

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-code-search.js",
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
    result.checks.backendSearch = await probeBackendSearch(seeded);

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed = allChecksPassed(result.checks.staticWiring) && allChecksPassed(result.checks.backendSearch);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed =
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.backendSearch) &&
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
  process.env.JWT_SECRET = "project-space-code-search-smoke-secret";
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

  const owner = await register(baseUrl, "code-search-owner");
  const viewer = await register(baseUrl, "code-search-viewer");
  const outsider = await register(baseUrl, "code-search-outsider");

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Code Search Smoke Project",
    description: "Browser smoke for local Project Space code search",
    visibility: "private",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  const projectId = projectRes.data.id;

  const addViewer = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error(`Add viewer failed: ${addViewer.status} ${JSON.stringify(addViewer.data)}`);

  const utilityFile = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/search-utils.ts",
    content: [
      "export function projectSpaceNeedle() {",
      `  return "${CONTENT_TOKEN}";`,
      "}",
      "",
    ].join("\n"),
    message: "Seed code search content",
  });
  if (utilityFile.status !== 201) throw new Error(`Utility file create failed: ${utilityFile.status} ${JSON.stringify(utilityFile.data)}`);

  const readmeFile = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Code Search Smoke\n\nSeed repository for local code search.",
    message: "Seed readme",
  });
  if (readmeFile.status !== 201) throw new Error(`README create failed: ${readmeFile.status} ${JSON.stringify(readmeFile.data)}`);

  const changeset = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, owner.token, {
    title: "Branch search seed",
    file_ops: [
      {
        op: "upsert",
        path: "src/branch-only.ts",
        content: `export const branchOnly = "${BRANCH_ONLY_TOKEN}";\n`,
      },
      {
        op: "upsert",
        path: "README.md",
        content: "# Code Search Smoke\n\nBranch snapshot readme.",
        base_revision_id: readmeFile.data.current_revision_id,
      },
    ],
  });
  if (changeset.status !== 201) throw new Error(`Changeset create failed: ${changeset.status} ${JSON.stringify(changeset.data)}`);

  const review = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/changesets/${changeset.data.id}/review`, owner.token, {
    decision: "approved",
    notes: "Approve branch search seed",
  });
  if (review.status !== 200) throw new Error(`Changeset review failed: ${review.status} ${JSON.stringify(review.data)}`);

  const merge = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets/${changeset.data.id}/merge`, owner.token);
  if (merge.status !== 200) throw new Error(`Changeset merge failed: ${merge.status} ${JSON.stringify(merge.data)}`);

  const liveOnlyFile = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "src/live-only.ts",
    content: `export const liveOnly = "${LIVE_ONLY_TOKEN}";\n`,
    message: "Post-commit live-only file",
  });
  if (liveOnlyFile.status !== 201) throw new Error(`Live-only file create failed: ${liveOnlyFile.status} ${JSON.stringify(liveOnlyFile.data)}`);

  const branches = await api(baseUrl, "GET", `/v1/projects/${projectId}/branches`, owner.token);
  const main = ((branches.data && branches.data.data) || []).find((branch) => branch.name === "main");

  return {
    baseUrl,
    projectId,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    utilityFileId: utilityFile.data.id,
    branchName: main ? main.name : "main",
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
  const openapi = fs.readFileSync(OPENAPI, "utf8");
  return {
    searchButtonPresent: html.includes('id="contentSearchBtn"'),
    searchEndpointWired: html.includes('"/files/search" + qs') && html.includes('"?q=" + encodeURIComponent(query)'),
    searchResultsRendererPresent: html.includes("function renderCodeSearchResults()") && html.includes("code-search-result"),
    searchResultClickOpensPreview: html.includes("state.codeSearchActive") && html.includes("searchResult") && html.includes("openPreview(file)"),
    openapiPathDocumented: openapi.includes("/v1/projects/{pid}/files/search:"),
    noExternalSearchClaim: !/semantic search|vector search|external search service|algolia|elasticsearch/i.test(html),
  };
}

async function probeBackendSearch(seeded) {
  const ownerContent = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(CONTENT_TOKEN)}&limit=10`,
    seeded.ownerToken,
  );
  const viewerContent = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(CONTENT_TOKEN)}&limit=10`,
    seeded.viewerToken,
  );
  const outsiderContent = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(CONTENT_TOKEN)}&limit=10`,
    seeded.outsiderToken,
  );
  const anonymousContent = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(CONTENT_TOKEN)}&limit=10`,
    null,
  );
  const pathSearch = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent("search-utils")}`,
    seeded.ownerToken,
  );
  const noMatch = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent("NO_SUCH_CODE_SEARCH_TOKEN")}`,
    seeded.ownerToken,
  );
  const tooShort = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=x`,
    seeded.ownerToken,
  );
  const branchSearch = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(BRANCH_ONLY_TOKEN)}&branch=${encodeURIComponent(seeded.branchName)}`,
    seeded.ownerToken,
  );
  const branchLiveLeak = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(LIVE_ONLY_TOKEN)}&branch=${encodeURIComponent(seeded.branchName)}`,
    seeded.ownerToken,
  );
  const unknownBranch = await api(
    seeded.baseUrl,
    "GET",
    `/v1/projects/${seeded.projectId}/files/search?q=${encodeURIComponent(CONTENT_TOKEN)}&branch=missing-branch`,
    seeded.ownerToken,
  );

  const ownerRows = (ownerContent.data && ownerContent.data.data) || [];
  const ownerHit = ownerRows.find((row) => row.path === "src/search-utils.ts");
  const branchRows = (branchSearch.data && branchSearch.data.data) || [];
  const branchHit = branchRows.find((row) => row.path === "src/branch-only.ts");

  return {
    ownerContentSearchFindsFile:
      ownerContent.status === 200 &&
      ownerHit &&
      ownerHit.file_id === seeded.utilityFileId &&
      ownerHit.match_count >= 1,
    contentSnippetHasLineNumber:
      !!ownerHit &&
      Array.isArray(ownerHit.snippets) &&
      ownerHit.snippets.some((snippet) => snippet.line_number === 2 && snippet.text.includes(CONTENT_TOKEN)),
    viewerCanSearch: viewerContent.status === 200 && ((viewerContent.data && viewerContent.data.data) || []).length === 1,
    outsiderDenied: outsiderContent.status === 403,
    anonymousDenied: anonymousContent.status === 401,
    pathSearchWorks:
      pathSearch.status === 200 &&
      ((pathSearch.data && pathSearch.data.data) || []).some((row) => row.path === "src/search-utils.ts"),
    noMatchEmpty:
      noMatch.status === 200 &&
      Array.isArray(noMatch.data && noMatch.data.data) &&
      noMatch.data.data.length === 0,
    tooShortRejected: tooShort.status === 422,
    branchSearchUsesSnapshot:
      branchSearch.status === 200 &&
      !!branchHit &&
      branchHit.revision_id &&
      branchHit.branch &&
      branchHit.branch.name === seeded.branchName,
    branchSearchDoesNotLeakLiveOnlyFile:
      branchLiveLeak.status === 200 &&
      Array.isArray(branchLiveLeak.data && branchLiveLeak.data.data) &&
      branchLiveLeak.data.data.length === 0,
    unknownBranchRejected: unknownBranch.status === 404,
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
  await page.waitForSelector("#contentSearchBtn", { timeout: 10000 });
  await page.fill("#searchInput", CONTENT_TOKEN);
  await page.click("#contentSearchBtn");
  await page.waitForSelector("#codeSearchResults .code-search-result", { timeout: 10000 });

  const resultText = await page.textContent("#codeSearchResults");
  checks.searchPanelShowsContentResult =
    resultText.includes("src/search-utils.ts") &&
    resultText.includes(CONTENT_TOKEN) &&
    resultText.includes("L2") &&
    resultText.includes("次匹配");

  await page.click('#codeSearchResults .code-search-result[data-file-id]');
  await page.waitForSelector("#previewPane.open", { timeout: 10000 });
  await page.waitForFunction((token) => {
    const el = document.querySelector("#previewContent");
    return el && (el.textContent || "").includes(token);
  }, CONTENT_TOKEN, { timeout: 10000 });
  checks.clickingResultOpensPreview = (await page.textContent("#previewContent")).includes(CONTENT_TOKEN);
  await page.click("#closePreviewBtn");
  await page.waitForSelector("#previewPane:not(.open)", { timeout: 5000 });

  await page.fill("#searchInput", "search-utils");
  await page.click("#contentSearchBtn");
  await page.waitForSelector("#codeSearchResults .code-search-result", { timeout: 10000 });
  const pathText = await page.textContent("#codeSearchResults");
  checks.pathMatchRendersWithoutSnippet = pathText.includes("src/search-utils.ts") && pathText.includes("路径匹配");

  await page.fill("#searchInput", "NO_SUCH_CODE_SEARCH_TOKEN");
  await page.click("#contentSearchBtn");
  await page.waitForFunction(() => {
    const el = document.querySelector("#codeSearchResults");
    return el && (el.textContent || "").includes("没有匹配的文件内容");
  }, { timeout: 10000 });
  checks.noMatchEmptyStateVisible = (await page.textContent("#codeSearchResults")).includes("没有匹配的文件内容");

  const bodyText = await page.textContent("body");
  checks.noFakeSearchControlsVisible = !/语义搜索|向量搜索|外部搜索|semantic search|vector search|algolia|elasticsearch/i.test(bodyText);

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
    "# Project Space Code Search Smoke Evidence",
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
