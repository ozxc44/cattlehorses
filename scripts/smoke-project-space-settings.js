#!/usr/bin/env node
// Project Space Settings — browser/runtime smoke harness.
//
// Starts the built backend with SERVE_DASHBOARD=1, seeds a project, opens
// /project-space.html?project_id=...&tab=settings in Chromium, edits project
// metadata, saves it, reloads, and verifies the persisted values.
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-settings-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;

// Viewport dimensions — overridable via env (used by mobile suite runner).
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let appDataSource = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-settings.js",
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
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      projectReadable: seeded.projectReadable,
      projectPatchable: seeded.projectPatchable,
      archiveWorks: seeded.archiveWorks,
      unarchiveWorks: seeded.unarchiveWorks,
    };

    result.checks.staticWiring = checkStaticWiring();

    if (!playwright) {
      result.skipped = true;
      result.passed =
        result.checks.backendSeed.userCreated &&
        result.checks.backendSeed.projectCreated &&
        result.checks.backendSeed.projectReadable &&
        result.checks.backendSeed.projectPatchable &&
        allTrue(result.checks.staticWiring);
      result.residual.push("Real-browser rendering skipped because Playwright is unavailable.");
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
  process.env.JWT_SECRET = "project-space-settings-smoke-secret";
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

  const email = `settings-smoke-${Date.now()}@example.invalid`;
  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password: "SmokeTest123!",
    display_name: "Settings Smoke",
  });
  if (registerRes.status !== 201) throw new Error(`Register failed: ${registerRes.status}`);
  const token = registerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "Settings Smoke Project",
    description: "Initial settings description",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  const readRes = await api(baseUrl, "GET", `/v1/projects/${projectId}`, token);
  const projectReadable = readRes.status === 200 && readRes.data.name === "Settings Smoke Project";

  const patchRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}`, token, {
    name: "Settings Smoke Project",
    description: "Initial settings description",
  });
  const projectPatchable = patchRes.status === 200 && patchRes.data.id === projectId;

  const archiveRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/archive`, token, {
    confirm_project_name: "Settings Smoke Project",
  });
  const archiveWorks = archiveRes.status === 200 && archiveRes.data.status === "archived";

  const unarchiveRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/unarchive`, token, {
    confirm_project_name: "Settings Smoke Project",
  });
  const unarchiveWorks = unarchiveRes.status === 200 && unarchiveRes.data.status === "active";

  return { baseUrl, token, projectId, projectReadable, projectPatchable, archiveWorks, unarchiveWorks };
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
      settingsTabMarkup: html.includes('data-tab="settings"') && html.includes('id="settingsPanel"'),
      settingsApiCalls:
        html.includes('api("GET", "/v1/projects/" + pid)') &&
        html.includes('api("PATCH", "/v1/projects/" + pid, body)'),
      settingsDeepLinkWired: html.includes('"settings"') && html.includes("loadSettingsData"),
      metadataInputs:
        html.includes("settingsNameInput") &&
        html.includes("settingsDescriptionInput") &&
        html.includes("settingsVisibilityInput") &&
        html.includes("settingsWebhookUrlInput") &&
        html.includes("settingsWebhookSecretInput") &&
        html.includes("settingsWebhookEventsInput") &&
        html.includes("settingsSaveBtn"),
      advancedFieldsWired:
        html.includes("visibility: visibility") &&
        html.includes("webhook_url: webhookUrl") &&
        html.includes("body.webhook_secret = webhookSecret") &&
        html.includes("webhook_enabled_events: parseWebhookEvents(webhookEvents)"),
      noDestructiveSettingsControl:
      !html.includes('data-settings-action="delete"') &&
      !html.includes('data-settings-action="rollback"') &&
      !/Delete Project|删除项目/i.test(html),
    inlineScriptParses,
  };
}

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
        token: seeded.token,
        projectId: seeded.projectId,
        baseUrl: seeded.baseUrl,
      }
    );

    const url =
      `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=settings`;
    await page.goto(url, { waitUntil: "networkidle" });
    await waitTab("settings");
    result.checks.settingsTabActive = true;

    await page.waitForSelector("#settingsNameInput", { timeout: 10000 });
    result.checks.settingsFormRendered = true;
    const initialName = await page.inputValue("#settingsNameInput");
    const initialDescription = await page.inputValue("#settingsDescriptionInput");
    const initialVisibility = await page.inputValue("#settingsVisibilityInput");
    result.checks.initialMetadataRendered =
      initialName === "Settings Smoke Project" &&
      initialDescription === "Initial settings description" &&
      initialVisibility === "private";

    const updatedName = `Settings Smoke Updated ${Date.now()}`;
    const updatedDescription = "Updated from settings smoke";
    const updatedWebhookUrl = "https://example.invalid/project-space-smoke";
    const updatedWebhookSecret = "settings-smoke-secret";
    const updatedWebhookEvents = "task.completed, changeset.merged";
    await page.fill("#settingsNameInput", updatedName);
    await page.fill("#settingsDescriptionInput", updatedDescription);
    await page.selectOption("#settingsVisibilityInput", "public");
    await page.fill("#settingsWebhookUrlInput", updatedWebhookUrl);
    await page.fill("#settingsWebhookSecretInput", updatedWebhookSecret);
    await page.fill("#settingsWebhookEventsInput", updatedWebhookEvents);
    await page.click("#settingsSaveBtn");
    await page.waitForSelector("#settingsMessage.success.show", { timeout: 10000 });
    result.checks.saveSuccessVisible = true;

    const afterSave = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}`, seeded.token);
    result.checks.backendMetadataPersisted =
      afterSave.status === 200 &&
      afterSave.data.name === updatedName &&
      afterSave.data.description === updatedDescription &&
      afterSave.data.visibility === "public" &&
      afterSave.data.webhook_url === updatedWebhookUrl &&
      afterSave.data.has_webhook_secret === true &&
      !("webhook_secret" in afterSave.data) &&
      Array.isArray(afterSave.data.webhook_enabled_events) &&
      afterSave.data.webhook_enabled_events.includes("task.completed") &&
      afterSave.data.webhook_enabled_events.includes("changeset.merged");

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#settingsNameInput", { timeout: 10000 });
    result.checks.reloadMetadataRendered =
      (await page.inputValue("#settingsNameInput")) === updatedName &&
      (await page.inputValue("#settingsDescriptionInput")) === updatedDescription &&
      (await page.inputValue("#settingsVisibilityInput")) === "public" &&
      (await page.inputValue("#settingsWebhookUrlInput")) === updatedWebhookUrl &&
      (await page.inputValue("#settingsWebhookSecretInput")) === "" &&
      (await page.inputValue("#settingsWebhookEventsInput")).includes("task.completed") &&
      (await page.inputValue("#settingsWebhookEventsInput")).includes("changeset.merged");

    const pageText = await page.textContent("body");
    result.checks.noDestructiveText =
      !/删除项目|回滚项目|Delete Project|Rollback/i.test(pageText || "");
    result.checks.archiveControlVisible =
      /归档项目|解除归档项目|Archive Project|Unarchive Project/i.test(pageText || "");

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = allTrue(result.checks);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
  }
  return result;
}

function allTrue(obj) {
  return Object.values(obj || {}).every((value) => value === true);
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

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Settings Smoke Evidence",
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
    lines.push("", "## Errors", "");
    for (const err of result.errors) lines.push(`- ${err}`);
  }
  if (result.residual.length) {
    lines.push("", "## Residual", "");
    for (const item of result.residual) lines.push(`- ${item}`);
  }
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
}

async function cleanup() {
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
}

main();
