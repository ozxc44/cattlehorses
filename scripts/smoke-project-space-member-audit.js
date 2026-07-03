#!/usr/bin/env node
// Project Space Member Audit — backend/API + Activity browser smoke.

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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-member-audit-smoke");
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
    command: "node scripts/smoke-project-space-member-audit.js",
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
    if (!result.backendBuilt) {
      throw new Error("Backend dist missing. Run: cd backend && npm run build");
    }

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      ownerCreated: !!seeded.ownerToken,
      projectCreated: !!seeded.projectId,
      rejectedOwnerAddNoAudit: seeded.rejectedOwnerAddNoAudit,
      addAuditRecorded: seeded.addAuditRecorded,
      roleChangeAuditRecorded: seeded.roleChangeAuditRecorded,
      removeAuditRecorded: seeded.removeAuditRecorded,
      auditHasActorAndTarget: seeded.auditHasActorAndTarget,
      viewerCanReadAudit: seeded.viewerCanReadAudit,
      viewerCannotMutateMembers: seeded.viewerCannotMutateMembers,
      rejectedMutationNoAudit: seeded.rejectedMutationNoAudit,
      outsiderCannotReadAudit: seeded.outsiderCannotReadAudit,
    };

    result.checks.staticWiring = checkStaticWiring();
    const staticOk =
      result.checks.staticWiring &&
      !result.checks.staticWiring.error &&
      Object.values(result.checks.staticWiring).every(Boolean);
    const backendOk = Object.values(result.checks.backendSeed).every(Boolean);

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
      if (!backendOk) result.errors.push("Backend audit checks failed.");
      if (!staticOk) result.errors.push("Static Activity audit wiring checks failed.");
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
  process.env.JWT_SECRET = "project-space-member-audit-smoke-secret";
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
  const owner = await register(baseUrl, `audit-smoke-owner-${ts}`, "Audit Smoke Owner");
  const viewer = await register(baseUrl, `audit-smoke-viewer-${ts}`, "Audit Smoke Viewer");
  const target = await register(baseUrl, `audit-smoke-target-${ts}`, "Audit Smoke Target");
  const outsider = await register(baseUrl, `audit-smoke-outsider-${ts}`, "Audit Smoke Outsider");

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Member Audit Smoke Project",
    description: "Project Space member audit smoke",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  const rejectedOwnerAdd = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: outsider.userId,
    role: "owner",
  });
  const auditAfterRejectedAdd = await listAudit(baseUrl, projectId, owner.token);

  const addViewer = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error(`Add viewer failed: ${addViewer.status}`);

  const addTarget = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: target.userId,
    role: "member",
  });
  if (addTarget.status !== 201) throw new Error(`Add target failed: ${addTarget.status}`);

  const patchTarget = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${target.userId}`, owner.token, {
    role: "admin",
  });
  if (patchTarget.status !== 200) throw new Error(`Patch target failed: ${patchTarget.status}`);

  const deleteTarget = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/members/${target.userId}`, owner.token);
  if (deleteTarget.status !== 204) throw new Error(`Delete target failed: ${deleteTarget.status}`);

  const ownerAudit = await listAudit(baseUrl, projectId, owner.token);
  const rows = collection(ownerAudit.data);
  const targetRows = rows.filter((row) => row.target_user_id === target.userId);
  const addRow = targetRows.find((row) => row.action === "member_added");
  const changeRow = targetRows.find((row) => row.action === "member_role_changed");
  const removeRow = targetRows.find((row) => row.action === "member_removed");

  const viewerAudit = await listAudit(baseUrl, projectId, viewer.token);
  const beforeRejectedMutationTotal = collection(viewerAudit.data).length;
  const viewerPatch = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${viewer.userId}`, viewer.token, {
    role: "member",
  });
  const afterRejectedMutation = await listAudit(baseUrl, projectId, owner.token);
  const outsiderAudit = await listAudit(baseUrl, projectId, outsider.token);

  return {
    baseUrl,
    projectId,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    targetName: "Audit Smoke Target",
    rejectedOwnerAddNoAudit:
      rejectedOwnerAdd.status === 422 &&
      collection(auditAfterRejectedAdd.data).length === 0,
    addAuditRecorded: !!addRow && addRow.new_role === "member",
    roleChangeAuditRecorded:
      !!changeRow && changeRow.previous_role === "member" && changeRow.new_role === "admin",
    removeAuditRecorded:
      !!removeRow && removeRow.previous_role === "admin" && removeRow.new_role == null,
    auditHasActorAndTarget:
      !!changeRow &&
      changeRow.actor_user_id === owner.userId &&
      changeRow.actor_display_name === "Audit Smoke Owner" &&
      changeRow.target_display_name === "Audit Smoke Target",
    viewerCanReadAudit:
      viewerAudit.status === 200 && collection(viewerAudit.data).some((row) => row.action === "member_removed"),
    viewerCannotMutateMembers: viewerPatch.status === 403,
    rejectedMutationNoAudit: collection(afterRejectedMutation.data).length === beforeRejectedMutationTotal,
    outsiderCannotReadAudit: outsiderAudit.status === 403,
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
    checks.activityCallsAuditEndpoint = html.includes('/audit-events?limit=20');
    checks.memberAuditSection = html.includes('项目审计') && html.includes('renderAuditRow');
    checks.memberAuditActions = html.includes('member_added') && html.includes('member_role_changed') && html.includes('member_removed');
    checks.ownerTransferAuditActionLabeled = html.includes('owner_transferred') && html.includes('转移Owner');
    checks.noFakeEmailSentClaim = !/邀请邮件已发送|Invitation email sent|email sent/i.test(html);
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    checks.inlineScriptParses = !!scriptMatch && !!scriptMatch[1];
    if (checks.inlineScriptParses) vm.compileFunction(scriptMatch[1].trim());
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, checks: {}, errors: [], screenshotPath: null };
  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    await setStoredAuth(page, origin, storageKey, seeded.ownerToken, seeded.projectId);
    const activityUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=activity`;
    await page.goto(activityUrl, { waitUntil: "networkidle" });
    // Navigate to Activity tab via tab click or overflow menu.
    const primaryActivity = await page.$('.tab-item[data-tab="activity"]');
    if (primaryActivity) {
      await primaryActivity.click();
    } else {
      await page.click("#tabMoreBtn");
      await page.waitForSelector("#tabMoreMenu.open", { timeout: 5000 });
      await page.click('.tab-more-item[data-tab="activity"]');
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("#tabMoreBtn");
        return btn && btn.classList.contains("has-active") &&
          new URL(window.location.href).searchParams.get("tab") === "activity";
      },
      { timeout: 10000 }
    );
    result.checks.activityTabActive = true;
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("#activityPanel");
        return panel && panel.textContent.includes("项目审计") && panel.textContent.includes("修改角色");
      },
      { timeout: 15000 }
    );
    const activityText = await page.locator("#activityPanel").innerText();
    result.checks.memberAuditSectionRendered = activityText.includes("项目审计");
    result.checks.addAuditRendered = activityText.includes("添加成员");
    result.checks.roleChangeAuditRendered = activityText.includes("修改角色");
    result.checks.removeAuditRendered = activityText.includes("移除成员");
    result.checks.targetRendered = activityText.includes(seeded.targetName);

    await setStoredAuth(page, origin, storageKey, seeded.viewerToken, seeded.projectId);
    await page.goto(activityUrl, { waitUntil: "networkidle" });
    // Navigate to Activity tab via overflow menu (activity is in More menu).
    const primaryAct = await page.$('.tab-item[data-tab="activity"]');
    if (primaryAct) {
      await primaryAct.click();
    } else {
      await page.click("#tabMoreBtn");
      await page.waitForSelector("#tabMoreMenu.open", { timeout: 5000 });
      await page.click('.tab-more-item[data-tab="activity"]');
      await page.waitForTimeout(400);
    }
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("#activityPanel");
        return panel && panel.textContent.includes("项目审计");
      },
      { timeout: 15000 }
    );
    result.checks.viewerAuditVisible = (await page.locator("#activityPanel").innerText()).includes("移除成员");

    const peopleUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=people`;
    await page.goto(peopleUrl, { waitUntil: "networkidle" });
    await page.waitForSelector(".people-table", { timeout: 10000 });
    result.checks.viewerNoRoleSelect = (await page.locator(".people-role-select").count()) === 0;
    result.checks.viewerNoRemoveButton = (await page.locator(".people-remove-btn").count()) === 0;

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    result.passed = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
  }

  return result;
}

async function setStoredAuth(page, origin, storageKey, token, projectId) {
  await page.goto(origin);
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    {
      key: storageKey,
      value: JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl: origin }),
    }
  );
}

async function register(baseUrl, prefix, displayName) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: "SmokeTest123!",
    display_name: displayName,
  });
  if (res.status !== 201) throw new Error(`Register failed: ${res.status}`);
  return { token: res.data.access_token, userId: res.data.user.id };
}

function listAudit(baseUrl, projectId, token) {
  return api(baseUrl, "GET", `/v1/projects/${projectId}/audit-events`, token);
}

function collection(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

async function api(baseUrl, method, route, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${route}`, {
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
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const md = [
    "# Project Space Member Audit Smoke Evidence",
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
  if (result.residual.length) md.push("## Residual", "", ...result.residual.map((r) => `- ${r}`), "");
  if (result.errors.length) md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

async function cleanup() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
  if (appDataSource && appDataSource.isInitialized) {
    await appDataSource.destroy();
  }
}

main();
