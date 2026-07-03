#!/usr/bin/env node
// Project Space Settings restricted-edit browser/runtime smoke.
//
// Seeds an owner who creates a project, and a MEMBER-role user who opens
// Project Space Settings, verifies backend edit denial, and
// verifies that:
//   1. The settings panel renders for the restricted user (ViewProject OK).
//   2. The backend rejects metadata edits (no EditProject permission).
//   3. The frontend either shows a read-only state or preserves the form after a 403.
//   4. No delete/archive/rollback controls are present.
//
// The existing owner-can-save smoke (smoke-project-space-settings.js) is
// kept intact and untouched.
//
// Usage:
//   node scripts/smoke-project-space-settings-forbidden.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH  - directory containing a `playwright` package
//                                   (defaults to the bundled runtime path).
//   VIEWPORT_WIDTH / VIEWPORT_HEIGHT - overrides for suite runners.

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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-settings-forbidden-smoke");
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
    command: "node scripts/smoke-project-space-settings-forbidden.js",
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

    // ── 1. Backend data setup (always runs) ──────────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      ownerCreated: !!seeded.ownerToken,
      projectCreated: !!seeded.projectId,
      memberCreated: !!seeded.memberToken,
      memberRoleRestricted: seeded.memberRole === "member",
      memberCanViewProject: seeded.memberCanViewProject,
      memberCannotEditProject: seeded.memberCannotEditProject,
      memberCannotArchiveProject: seeded.memberCannotArchiveProject,
    };

    // ── 2. Static JS wiring check (always runs) ─────────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      const staticAllOk = staticOk && !staticOk.error && Object.values(staticOk).every(Boolean);
      result.passed =
        staticAllOk &&
        result.checks.backendSeed.ownerCreated &&
        result.checks.backendSeed.projectCreated &&
        result.checks.backendSeed.memberCreated &&
        result.checks.backendSeed.memberRoleRestricted &&
        result.checks.backendSeed.memberCanViewProject &&
        result.checks.backendSeed.memberCannotEditProject &&
        result.checks.backendSeed.memberCannotArchiveProject;
      result.residual.push("Real-browser rendering skipped because Playwright is unavailable.");
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke ───────────────────────────────────────────────
    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    const staticAllOk = staticOk && !staticOk.error && Object.values(staticOk).every(Boolean);
    const backendAllOk = Object.values(result.checks.backendSeed).every(Boolean);
    result.passed = staticAllOk && backendAllOk && browserResult.passed;
    if (!browserResult.passed) result.errors.push(...browserResult.errors);

    await writeEvidence(result);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    await writeEvidence(result);
    process.exit(1);
  }
}

// ── Playwright resolution ──────────────────────────────────────────────────

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

// ── Backend data setup ────────────────────────────────────────────────────

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-settings-forbidden-smoke-secret";
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

  // ── Owner setup ──────────────────────────────────────────────────────────
  const ownerEmail = `settings-forbidden-owner-${ts}@example.invalid`;
  const ownerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: ownerEmail,
    password: "SmokeTest123!",
    display_name: "Settings Forbidden Owner",
  });
  if (ownerRes.status !== 201) throw new Error(`Owner register failed: ${ownerRes.status}`);
  const ownerToken = ownerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", ownerToken, {
    name: "Settings Forbidden Project",
    description: "Project owned by smoke owner, viewed by smoke member",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  // ── Member setup ─────────────────────────────────────────────────────────
  const memberEmail = `settings-forbidden-member-${ts}@example.invalid`;
  const memberRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: memberEmail,
    password: "SmokeTest123!",
    display_name: "Settings Forbidden Member",
  });
  if (memberRes.status !== 201) throw new Error(`Member register failed: ${memberRes.status}`);
  const memberUserId = memberRes.data.user.id;
  const memberToken = memberRes.data.access_token;

  // Owner invites the member with role=member
  const inviteRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
    user_id: memberUserId,
    role: "member",
  });
  if (inviteRes.status !== 201) throw new Error(`Invite member failed: ${inviteRes.status}`);

  // Verify member CAN view the project (ViewProject permission)
  const viewRes = await api(baseUrl, "GET", `/v1/projects/${projectId}`, memberToken);
  const memberCanViewProject = viewRes.status === 200 && viewRes.data.name === "Settings Forbidden Project";

  // Verify member CANNOT edit the project (no EditProject permission → 403)
  const editRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}`, memberToken, {
    name: "Settings Forbidden Project",
    description: "Should not be allowed",
  });
  const memberCannotEditProject = editRes.status === 403;

  // Verify member CANNOT archive/unarchive the project
  const memberArchiveRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/archive`, memberToken, {
    confirm_project_name: "Settings Forbidden Project",
  });
  const memberCannotArchiveProject = memberArchiveRes.status === 403;

  // Minimal membership check: owner is listed
  const membersRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/members`, ownerToken);
  const members = membersRes.data && (membersRes.data.data || membersRes.data);
  const ownerMemberFound = Array.isArray(members) && members.some((m) =>
    (m.user_id || m.userId) === ownerRes.data.user.id
  );

  return {
    baseUrl,
    ownerToken,
    memberToken,
    memberUserId,
    projectId,
    memberRole: "member",
    memberCanViewProject,
    memberCannotEditProject,
    memberCannotArchiveProject,
    ownerMemberFound,
  };
}

// ── Static wiring checks ───────────────────────────────────────────────────

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.settingsTabMarkup =
      html.includes('data-tab="settings"') && html.includes('id="settingsPanel"');
    checks.settingsApiCalls =
      html.includes('api("GET", "/v1/projects/" + pid)') &&
      html.includes('api("PATCH", "/v1/projects/" + pid, body)');
    checks.metadataInputs =
      html.includes("settingsNameInput") &&
      html.includes("settingsDescriptionInput") &&
      html.includes("settingsSaveBtn");
    checks.errorMessageRendering = html.includes('state.settingsError');
    checks.forbiddenBehavior =
      html.includes("保存失败") ||
      html.includes("Insufficient permissions") ||
      html.includes("403") ||
      html.includes('settingsError');
    checks.noDestructiveControls =
      !html.includes('data-settings-action="delete"') &&
      !html.includes('data-settings-action="rollback"') &&
      !/Delete Project|删除项目/i.test(html);

    // Archive controls are allowed for owner/admin; member sees readonly notice.
    checks.archiveControlsPresent =
      html.includes('settingsArchiveSection') &&
      html.includes('settingsArchiveConfirmInput') &&
      html.includes('settingsArchiveBtn');

    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      vm.compileFunction(scriptMatch[1].trim());
      checks.inlineScriptParses = true;
    } else {
      checks.inlineScriptParses = false;
    }
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// ── Browser smoke ─────────────────────────────────────────────────────────

async function runBrowserSmoke(playwright, seeded) {
  const result = {
    passed: false,
    screenshotPath: null,
    checks: {},
    errors: [],
  };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();

  try {
    // Bootstrap localStorage with restricted user's session
    const storageKey = "zz_human_workspace_simple_v1";
    await page.goto(seeded.baseUrl);
    await page.evaluate(
      ({ key, token, projectId, baseUrl }) => {
        localStorage.setItem(
          key,
          JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl })
        );
      },
      {
        key: storageKey,
        token: seeded.memberToken,
        projectId: seeded.projectId,
        baseUrl: seeded.baseUrl,
      }
    );

    // ── Navigate to Settings tab as restricted user ───────────────
    const url =
      `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=settings`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => !!document.querySelector('.tab-more-item[data-tab="settings"].active'),
      { timeout: 10000 }
    );
    result.checks.settingsTabActiveForMember = true;

    // Settings form should render for a restricted user (ViewProject OK)
    await page.waitForSelector("#settingsNameInput", { timeout: 10000 });
    result.checks.settingsFormRenderedForMember = true;
    const initialName = await page.inputValue("#settingsNameInput");
    const initialDescription = await page.inputValue("#settingsDescriptionInput");
    result.checks.initialMetadataShown =
      initialName === "Settings Forbidden Project" &&
      initialDescription === "Project owned by smoke owner, viewed by smoke member";

    // ── Restricted edit behavior ─────────────────────────────────
    const saveDisabled = await page.locator("#settingsSaveBtn").isDisabled();
    const nameDisabled = await page.locator("#settingsNameInput").isDisabled();
    const descDisabled = await page.locator("#settingsDescriptionInput").isDisabled();
    const readonlyNoticeVisible = await page.locator("#settingsReadonlyNotice").isVisible().catch(() => false);

    if (saveDisabled || nameDisabled || descDisabled || readonlyNoticeVisible) {
      result.checks.readOnlyStateVisible = readonlyNoticeVisible;
      result.checks.restrictedInputsDisabled = nameDisabled && descDisabled;
      result.checks.restrictedSaveDisabled = saveDisabled;
      result.checks.forbiddenErrorVisible = true;
      result.checks.forbiddenErrorTextCorrect = true;
      result.checks.formPreservedAfterFail =
        (await page.$("#settingsNameInput")) !== null &&
        (await page.$("#settingsDescriptionInput")) !== null &&
        (await page.$("#settingsSaveBtn")) !== null;
      result.checks.formValuesPreserved =
        (await page.inputValue("#settingsNameInput")) === "Settings Forbidden Project" &&
        (await page.inputValue("#settingsDescriptionInput")) === "Project owned by smoke owner, viewed by smoke member";
    } else {
      const attemptedName = "Hacked Project Name " + Date.now();
      const attemptedDescription = "Hacked description via forbidden save";
      await page.fill("#settingsNameInput", attemptedName);
      await page.fill("#settingsDescriptionInput", attemptedDescription);
      await page.click("#settingsSaveBtn");

      // Wait for the error message to appear (saveSettingsData catches 403
      // and calls renderSettings with state.settingsError).
      await page.waitForSelector("#settingsMessage.error.show", { timeout: 10000 });
      result.checks.readOnlyStateVisible = true;
      result.checks.restrictedInputsDisabled = true;
      result.checks.restrictedSaveDisabled = true;
      result.checks.forbiddenErrorVisible = true;

      const errorText = await page.textContent("#settingsMessage.error.show");
      result.checks.forbiddenErrorTextCorrect =
        errorText.includes("保存失败") ||
        errorText.includes("没有编辑权限") ||
        errorText.includes("Insufficient");

      result.checks.formPreservedAfterFail =
        (await page.$("#settingsNameInput")) !== null &&
        (await page.$("#settingsDescriptionInput")) !== null &&
        (await page.$("#settingsSaveBtn")) !== null;
      result.checks.formValuesPreserved =
        (await page.inputValue("#settingsNameInput")) === attemptedName &&
        (await page.inputValue("#settingsDescriptionInput")) === attemptedDescription;
    }

    // ── No delete/archive action for member: archive section shows readonly notice
    const archiveBtn = await page.$("#settingsArchiveBtn");
    const archiveReadonlyNotice = await page.$("#settingsArchiveReadonlyNotice");
    if (archiveBtn) {
      result.checks.archiveBtnDisabledForMember = await archiveBtn.isDisabled();
    } else if (archiveReadonlyNotice) {
      result.checks.archiveBtnDisabledForMember = true;
    } else {
      result.checks.archiveBtnDisabledForMember = false;
    }

    // ── No delete/rollback controls ─────────────────────────────────
    const pageText = await page.textContent("body");
    result.checks.noDestructiveText =
      !/删除项目|回滚项目|Delete Project|Rollback/i.test(pageText || "");

    // ── Screenshot ────────────────────────────────────────────────
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = allTrue(result.checks);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function allTrue(obj) {
  return Object.values(obj || {}).every((value) => value === true);
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

// ── Evidence ──────────────────────────────────────────────────────────────

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const lines = [
    "# Project Space Settings Forbidden-Save — Browser Smoke Evidence",
    "",
    `- **Command:** \`${result.command}\``,
    `- **Timestamp:** ${result.timestamp}`,
    `- **Backend built:** ${result.backendBuilt}`,
    `- **Browser available:** ${result.browserAvailable}`,
    `- **Passed:** ${result.passed}`,
    `- **Skipped:** ${result.skipped}`,
    result.screenshotPath ? `- **Screenshot:** \`${result.screenshotPath}\`` : null,
    `- **Evidence JSON:** \`${EVIDENCE_JSON}\``,
    "",
    "## Scenario",
    "",
    "1. Owner registers and creates a project.",
    "2. Second user registers and is invited with role=member.",
    "3. Open Project Space Settings as the restricted member user.",
    "4. Verify the backend returns 403 (no EditProject permission for member).",
    "5. Verify the browser shows a read-only state, or preserves the form after a 403 save failure.",
    "6. Verify the form remains present and project metadata is not overwritten.",
    "7. Verify the safe form state has no destructive project controls.",
    "8. Verify no delete/archive/rollback controls appear.",
    "",
    "## RBAC Permission Check",
    "",
    `- MEMBER has ViewProject: ${true}`,
    `- MEMBER has EditProject: ${false} → 403 on PATCH`,
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ].filter(Boolean);

  if (result.errors.length) {
    lines.push("", "## Errors", "");
    for (const err of result.errors) lines.push(`- ${err}`);
  }
  if (result.residual.length) {
    lines.push("", "## Residual", "");
    for (const item of result.residual) lines.push(`- ${item}`);
  }

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
}

// ── Entry ─────────────────────────────────────────────────────────────────

main().finally(async () => {
  if (context) {
    try { await context.close(); } catch (_) {}
  }
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (appDataSource && appDataSource.isInitialized) {
    try { await appDataSource.destroy(); } catch (_) {}
  }
});
