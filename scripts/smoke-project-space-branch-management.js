#!/usr/bin/env node
// Project Space Branch Management — backend/API + branch popover browser smoke.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-branch-management-smoke");
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
    command: "node scripts/smoke-project-space-branch-management.js",
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
      if (!backendOk) result.errors.push("Backend branch-management checks failed.");
      if (!staticOk) result.errors.push("Static branch-management wiring checks failed.");
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
  process.env.JWT_SECRET = "project-space-branch-management-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;
  appDataSource = AppDataSource;
  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const ts = Date.now();
  const owner = await register(baseUrl, `branch-mgmt-owner-${ts}`, "Branch Owner");
  const viewer = await register(baseUrl, `branch-mgmt-viewer-${ts}`, "Branch Viewer");
  const outsider = await register(baseUrl, `branch-mgmt-outsider-${ts}`, "Branch Outsider");
  const project = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: `Branch Management Smoke ${ts}`,
    description: "Branch management smoke",
  });
  assertStatus(project, 201, "project create");
  const projectId = project.data.id;

  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Branch Management Smoke\n",
    message: "seed readme",
  });

  const branches = await api(baseUrl, "GET", `/v1/projects/${projectId}/branches`, owner.token);
  const main = branches.data.data.find((branch) => branch.name === "main");
  const created = await api(baseUrl, "POST", `/v1/projects/${projectId}/branches`, owner.token, {
    name: "feature/smoke",
    source_branch: "main",
  });
  const renamed = created.status === 201
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${created.data.id}`, owner.token, {
        name: "feature/smoke-renamed",
      })
    : { status: 0, data: null };
  const defaultCandidate = await api(baseUrl, "POST", `/v1/projects/${projectId}/branches`, owner.token, {
    name: "release/default-candidate",
    source_branch: "main",
  });
  const viewerSetDefault = defaultCandidate.status === 201
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/default`, viewer.token)
    : { status: 0 };
  const ownerSetDefault = defaultCandidate.status === 201
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/default`, owner.token)
    : { status: 0, data: null };
  const protectDefault = defaultCandidate.status === 201
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}/protection`, owner.token, {
        is_protected: false,
      })
    : { status: 0 };
  const viewerProtect = renamed.status === 200
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`, viewer.token, {
        is_protected: true,
      })
    : { status: 0 };
  const ownerProtect = renamed.status === 200
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`, owner.token, {
        is_protected: true,
      })
    : { status: 0, data: null };
  const protectedRename = renamed.status === 200
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${renamed.data.id}`, owner.token, {
        name: "feature/smoke-protected-rename",
      })
    : { status: 0 };
  const protectedDelete = renamed.status === 200
    ? await api(baseUrl, "DELETE", `/v1/projects/${projectId}/branches/${renamed.data.id}`, owner.token)
    : { status: 0 };
  const ownerUnprotect = renamed.status === 200
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${renamed.data.id}/protection`, owner.token, {
        is_protected: false,
      })
    : { status: 0, data: null };
  const viewerCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/branches`, viewer.token, {
    name: "viewer/denied",
  });
  const defaultRename = defaultCandidate.status === 201
    ? await api(baseUrl, "PATCH", `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}`, owner.token, {
        name: "release/default-renamed",
      })
    : { status: 0 };
  const protectDelete = defaultCandidate.status === 201
    ? await api(baseUrl, "DELETE", `/v1/projects/${projectId}/branches/${defaultCandidate.data.id}`, owner.token)
    : { status: 0 };
  const deleteBranch = renamed.status === 200
    ? await api(baseUrl, "DELETE", `/v1/projects/${projectId}/branches/${renamed.data.id}`, owner.token)
    : { status: 0 };
  const outsiderRead = await api(baseUrl, "GET", `/v1/projects/${projectId}/branches`, outsider.token);
  const audit = await api(baseUrl, "GET", `/v1/projects/${projectId}/audit-events?limit=100`, owner.token);
  const actions = (audit.data.data || []).map((event) => event.action);

  return {
    baseUrl,
    projectId,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    browserBranchName: "feature/browser-smoke",
    defaultBranchName: "release/default-candidate",
    checks: {
      branchesApiReachable:
        branches.status === 200 &&
        !!main &&
        main.is_default === true &&
        main.is_protected === false &&
        main.protection &&
        main.protection.is_protected === true,
      ownerCanCreate: created.status === 201 && created.data.name === "feature/smoke",
      ownerCanRename: renamed.status === 200 && renamed.data.name === "feature/smoke-renamed",
      viewerCannotSetDefault: viewerSetDefault.status === 403,
      ownerCanSetDefault: ownerSetDefault.status === 200 && ownerSetDefault.data.is_default === true,
      defaultBranchCannotToggleProtection: protectDefault.status === 409,
      viewerCannotToggleProtection: viewerProtect.status === 403,
      ownerCanProtect:
        ownerProtect.status === 200 &&
        ownerProtect.data.is_protected === true &&
        ownerProtect.data.protection &&
        ownerProtect.data.protection.is_protected === true,
      protectedBranchCannotRename: protectedRename.status === 409,
      protectedBranchCannotDelete: protectedDelete.status === 409,
      ownerCanUnprotect:
        ownerUnprotect.status === 200 &&
        ownerUnprotect.data.is_protected === false &&
        ownerUnprotect.data.protection &&
        ownerUnprotect.data.protection.is_protected === false,
      ownerCanDeleteNonDefault: deleteBranch.status === 204,
      defaultBranchCannotRename: defaultRename.status === 409,
      defaultBranchProtected: protectDelete.status === 409,
      viewerCannotCreate: viewerCreate.status === 403,
      outsiderCannotRead: outsiderRead.status === 403,
      auditCreateRenameDelete:
        actions.includes("branch_created") &&
        actions.includes("branch_renamed") &&
        actions.includes("branch_deleted"),
      auditDefaultAndProtection:
        actions.includes("branch_default_set") &&
        actions.filter((action) => action === "branch_protection_changed").length >= 2,
    },
  };
}

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  return {
    createEndpointWired: html.includes('"/branches"') && html.includes("createBranch()"),
    renameEndpointWired: html.includes('"PATCH"') && html.includes("renameBranch("),
    deleteEndpointWired: html.includes('"DELETE"') && html.includes("deleteBranch("),
    defaultEndpointWired: html.includes('"/default"') && html.includes("setDefaultBranch("),
    protectionEndpointWired: html.includes('"/protection"') && html.includes("setBranchProtection("),
    defaultProtectionVisible: html.includes("b.is_default") && html.includes("data-branch-default-id"),
    noFakeBranchControls: !/force push|force-push|rollback branch|compare branch|bypass list|pattern rule/i.test(html),
  };
}

async function runBrowserSmoke(playwright, seeded) {
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  const page = await context.newPage();
  const errors = [];
  const checks = {};

  const storageKey = "zz_human_workspace_simple_v1";
  await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(
    ({ key, token, projectId, baseUrl }) => {
      window.localStorage.setItem("zz_agent_jwt", token);
      window.localStorage.setItem(key, JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    },
    { key: storageKey, token: seeded.ownerToken, projectId: seeded.projectId, baseUrl: seeded.baseUrl }
  );
  await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${seeded.projectId}&tab=files`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
  await page.waitForSelector("#fileListContainer", { timeout: 10000 });
  await page.waitForFunction(() => {
    const control = document.getElementById("branchControl");
    const pill = document.getElementById("branchPill");
    return !!control && !!pill && control.style.display !== "none" && pill.textContent.trim().length > 0;
  }, null, { timeout: 10000 });
  await page.click("#branchPill");
  await page.waitForSelector("#branchPopover:not(.hidden)", { timeout: 5000 });
  checks.ownerCreateVisible = await page.locator("#branchCreateInput").isVisible();
  checks.ownerCreateButtonVisible = await page.locator("#branchCreateBtn").isVisible();
  checks.ownerNoDefaultDelete = (await page.locator(`[data-branch-delete-name="${seeded.defaultBranchName}"]`).count()) === 0;
  checks.ownerPolicyButtonsVisible =
    (await page.locator("[data-branch-default-id]").count()) > 0 &&
    (await page.locator("[data-branch-protection-id]").count()) > 0;
  checks.defaultAndProtectedBadgesVisible =
    documentTextIncludes(await page.locator("#branchPopover").innerText(), "默认") &&
    documentTextIncludes(await page.locator("#branchPopover").innerText(), "保护");

  await page.fill("#branchCreateInput", seeded.browserBranchName);
  await page.click("#branchCreateBtn");
  await page.waitForFunction(
    (name) => document.body.innerText.includes(name),
    seeded.browserBranchName,
    { timeout: 8000 }
  );
  checks.browserCreateWorks = await page.locator(`[data-branch-value="${seeded.browserBranchName}"]`).count() > 0;
  await page.click(`[data-branch-protection-name="${seeded.browserBranchName}"]`);
  await page.waitForFunction(
    (name) => {
      const deleteButton = document.querySelector(`[data-branch-delete-name="${name}"]`);
      const protectionButton = document.querySelector(`[data-branch-protection-name="${name}"]`);
      return !deleteButton && protectionButton && protectionButton.textContent.includes("Unprotect");
    },
    seeded.browserBranchName,
    { timeout: 8000 }
  );
  checks.browserProtectHidesDelete = (await page.locator(`[data-branch-delete-name="${seeded.browserBranchName}"]`).count()) === 0;

  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  await page.evaluate((token) => {
    window.localStorage.setItem("zz_agent_jwt", token);
  }, seeded.viewerToken);
  await page.evaluate(
    ({ key, token, projectId, baseUrl }) => {
      window.localStorage.setItem("zz_agent_jwt", token);
      window.localStorage.setItem(key, JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl }));
    },
    { key: storageKey, token: seeded.viewerToken, projectId: seeded.projectId, baseUrl: seeded.baseUrl }
  );
  await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${seeded.projectId}&tab=files`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
  await page.waitForSelector("#fileListContainer", { timeout: 10000 });
  await page.waitForFunction(() => {
    const control = document.getElementById("branchControl");
    const pill = document.getElementById("branchPill");
    return !!control && !!pill && control.style.display !== "none" && pill.textContent.trim().length > 0;
  }, null, { timeout: 10000 });
  await page.click("#branchPill");
  await page.waitForSelector("#branchPopover:not(.hidden)", { timeout: 5000 });
  checks.viewerCreateHidden = (await page.locator("#branchCreateInput").count()) === 0;
  checks.viewerMutationButtonsHidden =
    (await page.locator("[data-branch-rename-id]").count()) === 0 &&
    (await page.locator("[data-branch-delete-id]").count()) === 0 &&
    (await page.locator("[data-branch-default-id]").count()) === 0 &&
    (await page.locator("[data-branch-protection-id]").count()) === 0;

  const passed = Object.values(checks).every(Boolean);
  if (!passed) errors.push("Browser branch-management checks failed.");
  return { passed, checks, errors, screenshotPath: SCREENSHOT_PATH };
}

function documentTextIncludes(text, needle) {
  return String(text || "").includes(needle);
}

async function register(baseUrl, prefix, displayName) {
  const response = await api(baseUrl, "POST", "/v1/auth/register", undefined, {
    email: `${prefix}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: "BranchManagementSmoke123!",
    display_name: displayName,
  });
  assertStatus(response, 201, "register");
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  return { status: response.status, data };
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status}: ${JSON.stringify(response.data)}`);
  }
}

async function writeEvidence(result) {
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Branch Management Smoke",
    "",
    `- **Verdict:** ${result.passed ? "PASS" : "FAIL"}`,
    `- **Browser:** ${result.browserAvailable ? "available" : "unavailable"}`,
    `- **Screenshot:** ${result.screenshotPath || "n/a"}`,
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ];
  if (result.errors.length) {
    lines.push("", "## Errors", "", ...result.errors.map((error) => `- ${error}`));
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

async function cleanup() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (appDataSource && appDataSource.isInitialized) {
    await appDataSource.destroy().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
