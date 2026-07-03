#!/usr/bin/env node
// Project Space Releases Tab — browser/runtime smoke harness.
//
// Verifies the real Project Space Releases implementation: backend API,
// browser UI, owner/admin edit controls, member/viewer read-only gating,
// Extras placement, and safe markdown rendering for unsafe HTML input.
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-releases-smoke");
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
let page = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-releases.js",
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
    if (!result.backendBuilt) throw new Error("Backend dist missing. Run: cd backend && npm run build");

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      ownerCreated: !!seeded.ownerToken,
      memberCreated: !!seeded.memberToken,
      viewerCreated: !!seeded.viewerToken,
      projectCreated: !!seeded.projectId,
    };
    result.checks.backendReleasesApi = await probeBackendReleasesApi(seeded);
    result.checks.staticWiring = checkStaticWiring();

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed =
        allChecksPassed(result.checks.backendReleasesApi) &&
        allChecksPassed(result.checks.staticWiring);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = browserResult.passed;
    if (!browserResult.passed) result.errors.push(...browserResult.errors);

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

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-releases-smoke-secret";
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
  const owner = await register(baseUrl, "releases-owner", password);
  const member = await register(baseUrl, "releases-member", password);
  const viewer = await register(baseUrl, "releases-viewer", password);

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Releases Smoke Project",
    description: "Browser smoke for Project Space Releases tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: "member" });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: "viewer" });

  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Releases Smoke\n\nProject used to verify the Releases tab.",
    message: "Initial README for releases smoke",
  });

  return {
    baseUrl,
    ownerToken: owner.token,
    ownerUser: owner.user,
    memberToken: member.token,
    memberUser: member.user,
    viewerToken: viewer.token,
    viewerUser: viewer.user,
    projectId,
  };
}

async function register(baseUrl, prefix, password) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password,
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { token: res.data.access_token, user: res.data.user, userId: res.data.user.id };
}

async function probeBackendReleasesApi(seeded) {
  const checks = {};
  const { baseUrl, ownerToken, memberToken, viewerToken, projectId } = seeded;

  const createRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, ownerToken, {
    title: "Version One",
    tag_name: " V1.0.0 ",
    body: "# Release\n\nInitial release.",
    draft: false,
    prerelease: false,
    target_commit_id: "commit-1",
  });
  checks.releaseApiCreate = { status: createRes.status, ok: createRes.status === 201, id: createRes.data && createRes.data.id };
  checks.releaseApiNormalizedTag = createRes.status === 201 && createRes.data.tag_name === "v1.0.0";
  checks.releaseApiPublished = createRes.status === 201 && !!createRes.data.published_at;
  const releaseId = createRes.data && createRes.data.id;

  const unsafeRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, ownerToken, {
    title: "Unsafe HTML",
    tag_name: "v1.0.1",
    body: "# Unsafe\n\n<script>window.__releaseXss = true</script>\n\n<img src=x onerror=\"window.__releaseImgXss = true\">",
    draft: false,
  });
  checks.releaseApiUnsafeSeeded = { status: unsafeRes.status, ok: unsafeRes.status === 201, id: unsafeRes.data && unsafeRes.data.id };

  const listRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/releases`, memberToken);
  checks.releaseApiListReadable = { status: listRes.status, ok: listRes.status === 200 && Array.isArray(listRes.data.data) && listRes.data.data.length >= 2 };
  checks.releaseApiListOmitsBody = listRes.status === 200 && listRes.data.data.every((item) => item.body === undefined);

  const readRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/releases/${releaseId}`, viewerToken);
  checks.releaseApiViewerCanRead = { status: readRes.status, ok: readRes.status === 200 && readRes.data.body.includes("Initial release") };

  const updateRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/releases/${releaseId}`, ownerToken, {
    title: "Version One Updated",
    body: "Updated body",
    prerelease: true,
  });
  checks.releaseApiUpdate = { status: updateRes.status, ok: updateRes.status === 200 && updateRes.data.prerelease === true };

  const memberCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, memberToken, {
    title: "No",
    tag_name: "v9",
    body: "",
  });
  const viewerUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/releases/${releaseId}`, viewerToken, { title: "No" });
  checks.releaseApiMemberCannotCreate = memberCreate.status === 403;
  checks.releaseApiViewerCannotUpdate = viewerUpdate.status === 403;

  const duplicateRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, ownerToken, {
    title: "Duplicate",
    tag_name: "V1.0.0!!!",
    body: "",
  });
  checks.releaseApiDuplicateTagRejected = duplicateRes.status === 409;

  return checks;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
    checks.releasesTabMarkup = html.includes('data-tab="releases"') && html.includes('id="tab-releases"') && html.includes(">Releases</button>");
    checks.releasesPanelMarkup = html.includes('id="releasesPanel"') && html.includes('aria-labelledby="tab-releases"');
    checks.releasesAllowlisted = /TAB_ALLOWLIST[\s\S]*"releases"/.test(html);
    checks.releasesRenderFunction = html.includes("function renderReleases()") && html.includes("function renderReleaseForm");
    checks.releasesUsesTagName = html.includes("tag_name") && !html.includes("tag: tag.trim()");
    checks.releasesNoPromptFlow = !html.includes('prompt("发布标题');
    checks.extrasReleasesImplemented = html.includes('{ tab: "releases"') && html.includes('name: "Releases"');
    checks.extrasPackagesSecurityImplementedScanningDeferred =
      html.includes('{ tab: "packages"') &&
      html.includes('{ tab: "security"') &&
      html.includes('name: "Packages"') &&
      html.includes('name: "Security"') &&
      html.includes('name: "Automated scanning"') &&
      !html.includes('name: "Releases", reason') &&
      !html.includes('name: "Packages", reason') &&
      !html.includes('name: "Security", reason');

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch) {
      new vm.Script(scriptMatch[1], { filename: "project-space.inline.js" });
      checks.inlineScriptParses = true;
    } else {
      checks.inlineScriptParses = false;
    }
  } catch (err) {
    checks.error = String(err.stack || err.message || err);
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, checks: {}, errors: [], screenshotPath: null };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  page = await context.newPage();

  async function waitTab(dataTab) {
    var primary = await page.$('.tab-item[data-tab="' + dataTab + '"]');
    if (primary) {
      await page.waitForSelector('.tab-item[data-tab="' + dataTab + '"].active', { timeout: 10000 });
    } else {
      await page.waitForFunction(
        function (t) {
          var btn = document.querySelector("#tabMoreBtn");
          return btn && btn.classList.contains("has-active") &&
            new URL(window.location.href).searchParams.get("tab") === t;
        },
        dataTab,
        { timeout: 10000 }
      );
    }
  }

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const releasesUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=releases`;

    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    await page.goto(releasesUrl, { waitUntil: "networkidle" });
    await waitTab("releases");
    await page.waitForSelector("#releaseCreateBtn", { timeout: 10000 });

    result.checks.releasesTabActive = !!(await page.$('.tab-item[data-tab="releases"].active')) ||
      (await page.evaluate(function () {
        var btn = document.querySelector("#tabMoreBtn");
        return !!(btn && btn.classList.contains("has-active"));
      }));
    result.checks.releasesPanelVisible = !!(await page.$("#releasesPanel:not(.hidden)"));
    result.checks.ownerSeesCreate = !!(await page.$("#releaseCreateBtn"));

    await page.click("#releaseCreateBtn");
    await page.fill("#releaseTitleInput", "Browser Release");
    await page.fill("#releaseTagInput", "V2.0.0 Browser");
    await page.fill("#releaseTargetCommitInput", "browser-commit");
    await page.fill("#releaseBodyInput", "# Browser Release\n\n<script>window.__releaseXss = true</script>\n\n<img src=x onerror=\"window.__releaseImgXss = true\">");
    await page.uncheck("#releaseDraftInput");
    await page.check("#releasePrereleaseInput");
    await page.click("#releaseSaveBtn");
    await page.waitForSelector(".release-detail", { timeout: 10000 });

    const detailText = await page.textContent("#releasesPanel");
    result.checks.ownerCreatedReleaseVisible =
      !!detailText && detailText.includes("Browser Release") && detailText.includes("v2.0.0-browser");
    result.checks.unsafeScriptNotExecuted = await page.evaluate(() => window.__releaseXss !== true && window.__releaseImgXss !== true);
    result.checks.unsafeHtmlEscaped = await page.evaluate(() => {
      const el = document.querySelector(".release-detail-body");
      if (!el) return false;
      return el.textContent.includes("<script>window.__releaseXss = true</script>") &&
        el.querySelector("script") === null &&
        el.querySelector("img") === null;
    });

    result.checks.ownerSeesEdit = !!(await page.$("#releaseEditBtn"));
    await page.click("#releaseEditBtn");
    await page.fill("#releaseTitleInput", "Browser Release Updated");
    await page.fill("#releaseBodyInput", "Updated release notes");
    await page.click("#releaseSaveBtn");
    await page.waitForSelector(".release-detail", { timeout: 10000 });
    const updatedText = await page.textContent("#releasesPanel");
    result.checks.ownerUpdatedReleaseVisible = !!updatedText && updatedText.includes("Browser Release Updated") && updatedText.includes("Updated release notes");

    await setStoredSession(origin, storageKey, seeded.viewerToken, seeded.projectId);
    await page.goto(releasesUrl, { waitUntil: "networkidle" });
    await waitTab("releases");
    result.checks.viewerCannotCreate = !(await page.$("#releaseCreateBtn"));
    const viewerRows = await page.$$("#releasesPanel .release-row");
    if (viewerRows.length > 0) {
      await viewerRows[0].click();
      await page.waitForSelector(".release-detail", { timeout: 10000 });
    }
    result.checks.viewerCannotEdit = !(await page.$("#releaseEditBtn"));

    await setStoredSession(origin, storageKey, seeded.memberToken, seeded.projectId);
    await page.goto(releasesUrl, { waitUntil: "networkidle" });
    await waitTab("releases");
    result.checks.memberCannotCreate = !(await page.$("#releaseCreateBtn"));
    result.checks.memberCanReadList = (await page.$$("#releasesPanel .release-row")).length > 0;

    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    const extrasUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=extras`;
    await page.goto(extrasUrl, { waitUntil: "networkidle" });
    await waitTab("extras");
    const extrasText = await page.textContent("#extrasPanel");
    result.checks.extrasReleasesImplemented = !!extrasText && extrasText.includes("已实现的模块") && extrasText.includes("Releases");
    const deferredNames = await page.$$eval("#extrasPanel .extras-deferred .extras-deferred-name", (els) => els.map((el) => el.textContent.trim()));
    result.checks.extrasReleasesNotDeferred = !deferredNames.includes("Releases");
    result.checks.extrasPackagesSecurityImplementedScanningDeferred =
      !!extrasText && extrasText.includes("Packages") &&
      !!extrasText && extrasText.includes("Security") &&
      !deferredNames.includes("Packages") &&
      !deferredNames.includes("Security") &&
      deferredNames.includes("Automated scanning");
    result.checks.noFakePackageSecurityActions = !/publish package|new package|security scan|run scan/i.test(extrasText || "");

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    result.passed = allChecksPassed(result.checks);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    context = null;
    browser = null;
  }

  return result;
}

async function setStoredSession(origin, storageKey, jwt, projectId) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: storageKey, value: JSON.stringify({ jwt, selectedProjectId: projectId, baseUrl: origin }) }
  );
}

function allChecksPassed(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.every(allChecksPassed);
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "ok")) return value.ok === true;
    return Object.values(value).every(allChecksPassed);
  }
  return true;
}

async function api(baseUrl, method, requestPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${requestPath}`, {
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

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const md = [
    "# Project Space Releases Tab — Browser Smoke Evidence",
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
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
    "",
  ];
  if (result.residual.length) md.push("## Residual gaps", "", ...result.residual.map((r) => `- ${r}`), "");
  if (result.errors.length) md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  md.push(
    "",
    "## Scope Note",
    "",
    "This smoke verifies the implemented Project Space Releases tab, including ",
    "backend create/list/read/update, owner edit controls, member/viewer read-only ",
    "gating, Extras placement, and safe markdown rendering for unsafe HTML input.",
    "",
  );
  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async () => {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
});
