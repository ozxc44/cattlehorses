#!/usr/bin/env node
// Project Space Owner Transfer — backend/API + Settings browser smoke.

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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-owner-transfer-smoke");
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
    command: "node scripts/smoke-project-space-owner-transfer.js",
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
    result.checks.backend = seeded.backendChecks;
    result.checks.staticWiring = checkStaticWiring();

    const backendOk = allTrue(result.checks.backend);
    const staticOk = allTrue(result.checks.staticWiring);

    if (!playwright) {
      result.skipped = true;
      result.passed = backendOk && staticOk;
      result.residual.push("Real-browser rendering skipped because Playwright is unavailable.");
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = backendOk && staticOk && browserResult.passed;
    if (!result.passed) {
      if (!backendOk) result.errors.push("Backend owner-transfer checks failed.");
      if (!staticOk) result.errors.push("Static owner-transfer wiring checks failed.");
      if (!browserResult.passed) result.errors.push(...browserResult.errors);
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
  process.env.JWT_SECRET = "project-space-owner-transfer-smoke-secret";
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
  const owner = await register(baseUrl, `owner-transfer-owner-${ts}`, "Owner Transfer Owner");
  const nextOwner = await register(baseUrl, `owner-transfer-next-${ts}`, "Owner Transfer Next");
  const admin = await register(baseUrl, `owner-transfer-admin-${ts}`, "Owner Transfer Admin");
  const viewer = await register(baseUrl, `owner-transfer-viewer-${ts}`, "Owner Transfer Viewer");
  const outsider = await register(baseUrl, `owner-transfer-outsider-${ts}`, "Owner Transfer Outsider");

  const projectName = "Owner Transfer Smoke Project";
  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: projectName,
    description: "Project Space owner transfer smoke",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  await mustAddMember(baseUrl, projectId, owner.token, nextOwner.userId, "member");
  await mustAddMember(baseUrl, projectId, owner.token, admin.userId, "admin");
  await mustAddMember(baseUrl, projectId, owner.token, viewer.userId, "viewer");

  const mismatch = await transferOwner(baseUrl, projectId, owner.token, nextOwner.userId, "Wrong Project");
  const outsiderTarget = await transferOwner(baseUrl, projectId, owner.token, outsider.userId, projectName);
  const adminAttempt = await transferOwner(baseUrl, projectId, admin.token, nextOwner.userId, projectName);
  const viewerAttempt = await transferOwner(baseUrl, projectId, viewer.token, nextOwner.userId, projectName);
  const auditBefore = await listAudit(baseUrl, projectId, owner.token);

  return {
    baseUrl,
    projectId,
    projectName,
    owner,
    nextOwner,
    admin,
    viewer,
    outsider,
    backendChecks: {
      projectCreated: !!projectId,
      mismatchRejected: mismatch.status === 422,
      outsiderTargetRejected: outsiderTarget.status === 404,
      adminRejected: adminAttempt.status === 403,
      viewerRejected: viewerAttempt.status === 403,
      rejectedAttemptsNoOwnerTransferAudit:
        collection(auditBefore.data).filter((row) => row.action === "owner_transferred").length === 0,
    },
  };
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, screenshotPath: null, checks: {}, errors: [] };
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  const storageKey = "zz_human_workspace_simple_v1";
  const settingsUrl =
    `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=settings`;

  async function waitTab(dataTab) {
    const primary = await page.$(`.tab-item[data-tab="${dataTab}"]`);
    if (primary) {
      await page.waitForSelector(`.tab-item[data-tab="${dataTab}"].active`, { timeout: 10000 });
    } else {
      await page.waitForFunction(
        (t) => {
          const btn = document.querySelector("#tabMoreBtn");
          return btn && btn.classList.contains("has-active") &&
            new URL(window.location.href).searchParams.get("tab") === t;
        },
        dataTab,
        { timeout: 10000 }
      );
    }
  }

  try {
    await setSession(page, storageKey, seeded.baseUrl, seeded.projectId, seeded.admin.token);
    await page.goto(settingsUrl, { waitUntil: "networkidle" });
    await waitTab("settings");
    result.checks.adminSettingsRendered = true;
    result.checks.adminTransferButtonHidden = (await page.$("#settingsOwnerTransferBtn")) === null;
    result.checks.adminOwnerOnlyNotice = ((await page.textContent("#settingsOwnerTransferSection")) || "").includes("只有当前项目 Owner");

    await setSession(page, storageKey, seeded.baseUrl, seeded.projectId, seeded.owner.token);
    await page.goto(settingsUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#settingsOwnerTransferTargetInput", { timeout: 10000 });
    await page.waitForSelector("#settingsOwnerTransferConfirmInput", { timeout: 10000 });
    result.checks.ownerTransferControlsVisible = true;

    await page.selectOption("#settingsOwnerTransferTargetInput", seeded.nextOwner.userId);
    await page.fill("#settingsOwnerTransferConfirmInput", seeded.projectName);
    await page.waitForFunction(() => {
      const button = document.querySelector("#settingsOwnerTransferBtn");
      return button && !button.disabled;
    });
    await page.click("#settingsOwnerTransferBtn");
    await page.waitForSelector("#settingsOwnerTransferMessage.success.show", { timeout: 10000 });
    result.checks.transferSuccessVisible = true;

    const projectAfter = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}`, seeded.nextOwner.token);
    const membersAfter = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/members`, seeded.nextOwner.token);
    const rows = collection(membersAfter.data);
    const ownerRows = rows.filter((row) => row.role === "owner");
    const oldOwnerRow = rows.find((row) => row.user_id === seeded.owner.userId);
    const nextOwnerRow = rows.find((row) => row.user_id === seeded.nextOwner.userId);
    result.checks.projectOwnerUpdated =
      projectAfter.status === 200 && projectAfter.data.owner_id === seeded.nextOwner.userId;
    result.checks.singleOwnerRole =
      membersAfter.status === 200 &&
      ownerRows.length === 1 &&
      nextOwnerRow &&
      nextOwnerRow.role === "owner" &&
      oldOwnerRow &&
      oldOwnerRow.role === "admin";

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#settingsOwnerTransferSection", { timeout: 10000 });
    result.checks.oldOwnerNowAdminControlHidden = (await page.$("#settingsOwnerTransferBtn")) === null;

    const activityUrl =
      `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=activity`;
    await setSession(page, storageKey, seeded.baseUrl, seeded.projectId, seeded.nextOwner.token);
    await page.goto(activityUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#auditActionFilter", { timeout: 10000 });
    await page.selectOption("#auditActionFilter", "owner_transferred");
    await page.waitForTimeout(500);
    const activityText = await page.textContent("body");
    result.checks.auditFilterShowsOwnerTransfer =
      /转移Owner/.test(activityText || "") && /Owner Transfer Next/.test(activityText || "");

    const audit = await listAudit(seeded.baseUrl, seeded.projectId, seeded.nextOwner.token);
    const transferEvent = collection(audit.data).find((row) => row.action === "owner_transferred");
    result.checks.auditEventRecorded =
      audit.status === 200 &&
      transferEvent &&
      transferEvent.actor_user_id === seeded.owner.userId &&
      transferEvent.target_user_id === seeded.nextOwner.userId;

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    result.passed = allTrue(result.checks);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
  }
  return result;
}

function checkStaticWiring() {
  const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  let inlineScriptParses = false;
  if (scriptMatch) {
    try {
      new vm.Script(scriptMatch[1]);
      inlineScriptParses = true;
    } catch (_) {
      inlineScriptParses = false;
    }
  }
  return {
    inlineScriptParses,
    settingsOwnerTransferControls:
      html.includes("settingsOwnerTransferTargetInput") &&
      html.includes("settingsOwnerTransferConfirmInput") &&
      html.includes("settingsOwnerTransferBtn"),
    ownerTransferApiCall: html.includes('api("POST", "/v1/projects/" + pid + "/owner-transfer"'),
    ownerTransferAuditLabel: html.includes('a === "owner_transferred"') && html.includes('value: "owner_transferred"'),
    noProjectDeleteControl:
      !html.includes('data-settings-action="delete"') &&
      !html.includes('data-settings-action="archive"') &&
      !html.includes('id="settingsDeleteProjectBtn"') &&
      !html.includes('id="settingsArchiveProjectBtn"'),
  };
}

async function setSession(page, storageKey, baseUrl, projectId, token) {
  await page.goto(baseUrl);
  await page.evaluate(
    ({ key, jwt, selectedProjectId, apiBaseUrl }) => {
      localStorage.setItem(key, JSON.stringify({ jwt, selectedProjectId, baseUrl: apiBaseUrl }));
    },
    { key: storageKey, jwt: token, selectedProjectId: projectId, apiBaseUrl: baseUrl }
  );
}

async function mustAddMember(baseUrl, projectId, token, userId, role) {
  const response = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: userId, role });
  if (response.status !== 201) throw new Error(`Add member ${role} failed: ${response.status}`);
  return response;
}

function transferOwner(baseUrl, projectId, token, targetUserId, confirmProjectName) {
  return api(baseUrl, "POST", `/v1/projects/${projectId}/owner-transfer`, token, {
    target_user_id: targetUserId,
    confirm_project_name: confirmProjectName,
  });
}

function listAudit(baseUrl, projectId, token) {
  return api(baseUrl, "GET", `/v1/projects/${projectId}/audit-events`, token);
}

async function register(baseUrl, prefix, displayName) {
  const response = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: "SmokeTest123!",
    display_name: displayName,
  });
  if (response.status !== 201) throw new Error(`Register ${displayName} failed: ${response.status}`);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
    displayName,
  };
}

async function api(baseUrl, method, urlPath, token, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

function collection(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.members)) return payload.members;
  return [];
}

function allTrue(obj) {
  return Object.values(obj || {}).every((value) => value === true);
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Owner Transfer Smoke Evidence",
    "",
    `- Command: \`${result.command}\``,
    `- Passed: ${result.passed}`,
    `- Skipped: ${result.skipped}`,
    `- Browser available: ${result.browserAvailable}`,
    result.screenshotPath ? `- Screenshot: \`${result.screenshotPath}\`` : null,
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ].filter(Boolean);
  if (result.errors.length) {
    lines.push("", "## Errors", "", ...result.errors.map((err) => `- ${err}`));
  }
  if (result.residual.length) {
    lines.push("", "## Residual", "", ...result.residual.map((item) => `- ${item}`));
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
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

main();
