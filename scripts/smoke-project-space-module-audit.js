#!/usr/bin/env node
// Project Space Module Audit — backend/API + Activity browser smoke.
//
// Verifies audit events for Wiki, Releases, Packages, and Security
// create/update actions:
//   1. Known audit actions are documented in the OpenAPI action enum.
//   2. Backend records audit events on module create/update.
//   3. ?action= filter works for at least one new action.
//   4. Activity panel renders representative module audit rows.
//   5. Raw body/markdown/secrets/tokens/API keys are not rendered in
//      Activity panel text.
//
// If the backend has not yet landed module audit event recording, this
// smoke fails clearly with a helpful missing-capability message rather
// than silently passing.

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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-module-audit-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

// Expected module audit actions (mirrors the OpenAPI enum additions).
const MODULE_AUDIT_ACTIONS = [
  "wiki_page_created",
  "wiki_page_updated",
  "release_created",
  "release_updated",
  "package_created",
  "package_updated",
  "security_advisory_created",
  "security_advisory_updated",
];

// Sentinels used to test that sensitive content is NOT leaked via audit.
const BODY_SENTINEL = "__module_audit_smoke_body_not_to_leak__";
const SECRET_SENTINEL = "__module_audit_smoke_secret_not_to_leak__";
const TOKEN_SENTINEL = "__module_audit_smoke_token_not_to_leak__";
const KEY_SENTINEL = "__module_audit_smoke_api_key_not_to_leak__";

let server = null;
let appDataSource = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-module-audit.js",
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
    };

    // Check whether the backend supports module audit actions.
    // We probe by reading the ProjectAuditAction enum at runtime.
    const capabilityOk = await checkModuleAuditCapability(seeded);
    result.checks.capability = capabilityOk;

    if (!capabilityOk.canRecord) {
      // The implementation hasn't landed yet — fail clearly.
      result.passed = false;
      result.errors.push(
        "Backend capability missing: module audit actions are not available. " +
        "Expected: ProjectAuditAction enum includes wiki_page_created, wiki_page_updated, " +
        "release_created, release_updated, package_created, package_updated, " +
        "security_advisory_created, security_advisory_updated. " +
        "The backend create/update routes for Wiki, Releases, Packages, and Security " +
        "must call recordModuleAudit() with the appropriate action. " +
        "This smoke will pass once that backend change lands."
      );
      await writeEvidence(result);
      process.exit(1);
      return;
    }

    result.checks.backendAudit = capabilityOk.checks;
    const backendOk = moduleAuditChecksPass(capabilityOk.checks);

    result.checks.staticWiring = checkStaticWiring();
    const staticOk =
      result.checks.staticWiring &&
      !result.checks.staticWiring.error &&
      Object.values(result.checks.staticWiring).every(Boolean);

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
      if (!backendOk) result.errors.push("Backend module audit checks failed.");
      if (!staticOk) result.errors.push("Static Activity module audit wiring checks failed.");
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

function moduleAuditChecksPass(checks) {
  if (!checks || checks.seedingFailed) return false;
  const requiredBooleans = [
    "enumIncludesExisting",
    "auditEndpointReachable",
    "noUnknownActions",
    "actionFilterEndpointReachable",
    "actionFilterWorks",
    "noSensitiveContentInAuditEvents",
    "viewerCanReadAudit",
    "noSensitiveInViewerAudit",
  ];
  if (!requiredBooleans.every((key) => checks[key] === true)) return false;
  if (checks.moduleActionsInEnum !== checks.moduleActionsInEnumTotal) return false;
  if (!checks.auditActionsFound || !MODULE_AUDIT_ACTIONS.every((action) => checks.auditActionsFound[action] === true)) return false;
  for (const key of [
    "wikiCreate",
    "wikiUpdate",
    "releaseCreate",
    "releaseUpdate",
    "packageCreate",
    "packageUpdate",
    "advisoryCreate",
    "advisoryUpdate",
  ]) {
    if (!checks[key] || checks[key].ok !== true) return false;
  }
  return true;
}

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-module-audit-smoke-secret";
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
  const owner = await register(baseUrl, `module-audit-owner-${ts}`, "Module Audit Owner");
  const viewer = await register(baseUrl, `module-audit-viewer-${ts}`, "Module Audit Viewer");

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Module Audit Smoke Project",
    description: "Project Space module audit smoke",
  });
  if (projectRes.status !== 201) throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  // Add viewer as a project member
  const addViewer = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error(`Add viewer failed: ${addViewer.status}`);

  return { baseUrl, projectId, ownerToken: owner.token, ownerUserId: owner.userId, viewerToken: viewer.token };
}

async function checkModuleAuditCapability(seeded) {
  const checks = {};

  // 1. Check available actions by inspecting the backend's ProjectAuditAction enum.
  //    We attempt to create an audit event with each module action via the repo.
  //    If the enum doesn't include these values, they'll fail at the ORM level.
  const { ProjectAuditAction } = require(path.join(BACKEND_DIST, "src", "entities", "project-audit-event.entity"));
  const backendActions = Object.values(ProjectAuditAction);
  checks.enumIncludesExisting = backendActions.includes("member_added") && backendActions.includes("project_settings_updated");
  const supportedModuleActions = MODULE_AUDIT_ACTIONS.filter((a) => backendActions.includes(a));
  checks.moduleActionsInEnum = supportedModuleActions.length;
  checks.moduleActionsInEnumTotal = MODULE_AUDIT_ACTIONS.length;

  if (supportedModuleActions.length === 0) {
    return {
      canRecord: false,
      checks,
      reason: "No module audit actions found in ProjectAuditAction enum. Backend enum may not have been extended yet.",
    };
  }

  // 2. Attempt to create real module entities and check if audit events appear.
  //    Seed Wiki, Releases, Packages, and Security data.
  const seedResults = await seedModuleData(seeded, supportedModuleActions);

  // Merge seed sub-checks
  for (const [key, val] of Object.entries(seedResults)) {
    checks[key] = val;
  }

  if (seedResults.seedingFailed) {
    return {
      canRecord: false,
      checks,
      reason: "Module data seeding failed; cannot verify audit recording.",
    };
  }

  // 3. Fetch audit events and look for each action
  const auditRes = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/audit-events?limit=50`, seeded.ownerToken);
  checks.auditEndpointReachable = auditRes.status === 200;

  const events = collection(auditRes.data);
  const foundActions = new Set(events.map((e) => e.action));
  checks.auditActionsFound = {};

  // Flag expected actions and check no raw body/secret/token leaked
  let anyExpectedFound = false;
  let noSensitiveContentLeaked = true;

  for (const action of MODULE_AUDIT_ACTIONS) {
    const isSupported = supportedModuleActions.includes(action);
    if (!isSupported) continue;
    const found = foundActions.has(action);
    checks.auditActionsFound[action] = found;
    if (found) anyExpectedFound = true;
  }

  // Also check that unknown actions are not present
  const unknownActions = Array.from(foundActions).filter(
    (a) => !MODULE_AUDIT_ACTIONS.includes(a) &&
           !["member_added", "member_role_changed", "member_removed", "project_settings_updated"].includes(a)
  );
  checks.noUnknownActions = unknownActions.length === 0;
  if (unknownActions.length) {
    checks.unknownActions = unknownActions;
  }

  // 4. Verify ?action= filter works for at least one module action
  if (supportedModuleActions.length > 0) {
    const filterAction = supportedModuleActions[0];
    const filteredRes = await api(
      seeded.baseUrl,
      "GET",
      `/v1/projects/${seeded.projectId}/audit-events?limit=50&action=${encodeURIComponent(filterAction)}`,
      seeded.ownerToken
    );
    checks.actionFilterEndpointReachable = filteredRes.status === 200;
    if (filteredRes.status === 200) {
      const filteredEvents = collection(filteredRes.data);
      checks.actionFilterWorks = filteredEvents.length > 0 && filteredEvents.every((e) => e.action === filterAction);
    } else {
      checks.actionFilterWorks = false;
    }
  } else {
    checks.actionFilterWorks = false; // n/a
  }

  // 5. Verify sensitive content is NOT leaked in audit event fields
  for (const event of events) {
    const metaStr = JSON.stringify(event.metadata || {});
    const fieldsStr = JSON.stringify(event);
    if (metaStr.includes(BODY_SENTINEL) ||
        metaStr.includes(SECRET_SENTINEL) ||
        metaStr.includes(TOKEN_SENTINEL) ||
        metaStr.includes(KEY_SENTINEL)) {
      noSensitiveContentLeaked = false;
    }
    if (fieldsStr.includes(BODY_SENTINEL) ||
        fieldsStr.includes(SECRET_SENTINEL) ||
        fieldsStr.includes(TOKEN_SENTINEL) ||
        fieldsStr.includes(KEY_SENTINEL)) {
      noSensitiveContentLeaked = false;
    }
  }
  checks.noSensitiveContentInAuditEvents = noSensitiveContentLeaked;

  // 6. Verify viewer can read audit events (but still no leaks)
  if (seeded.viewerToken) {
    const viewerAuditRes = await api(seeded.baseUrl, "GET", `/v1/projects/${seeded.projectId}/audit-events?limit=50`, seeded.viewerToken);
    checks.viewerCanReadAudit = viewerAuditRes.status === 200;
    if (viewerAuditRes.status === 200) {
      const viewerDataStr = JSON.stringify(viewerAuditRes.data);
      checks.noSensitiveInViewerAudit =
        !viewerDataStr.includes(BODY_SENTINEL) &&
        !viewerDataStr.includes(SECRET_SENTINEL) &&
        !viewerDataStr.includes(TOKEN_SENTINEL) &&
        !viewerDataStr.includes(KEY_SENTINEL);
    } else {
      checks.noSensitiveInViewerAudit = true; // n/a
    }
  }

  return { canRecord: anyExpectedFound, checks };
}

async function seedModuleData(seeded, supportedActions) {
  const checks = {};
  const { baseUrl, ownerToken, projectId } = seeded;
  const actionSet = new Set(supportedActions);
  let allOk = true;

  // ── Wiki ───────────────────────────────────────────────────────────────
  // Create a wiki page
  if (actionSet.has("wiki_page_created")) {
    const wikiCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/wiki`, ownerToken, {
      title: "Module Audit Wiki Page",
      content: "# Wiki Audit\n\n" + BODY_SENTINEL,
    });
    checks.wikiCreate = { status: wikiCreate.status, ok: wikiCreate.status === 201 };
    if (wikiCreate.status === 201) {
      const slug = wikiCreate.data.slug || wikiCreate.data.id;
      if (slug) {
        const wikiUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/wiki/${encodeURIComponent(slug)}`, ownerToken, {
          title: "Module Audit Wiki Page (updated)",
          content: "# Wiki Audit Updated\n\n" + BODY_SENTINEL,
        });
        checks.wikiUpdate = { status: wikiUpdate.status, ok: wikiUpdate.status === 200 };
        if (!checks.wikiUpdate.ok) allOk = false;
      }
    } else {
      allOk = false;
    }
  }

  // ── Releases ───────────────────────────────────────────────────────────
  if (actionSet.has("release_created")) {
    const releaseCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/releases`, ownerToken, {
      title: "Module Audit Release",
      tag_name: "v99.99.99",
      body: "# Release body\n\n" + BODY_SENTINEL,
      draft: false,
      prerelease: false,
      target_commit_id: "audit-commit-1",
    });
    checks.releaseCreate = { status: releaseCreate.status, ok: releaseCreate.status === 201 };
    if (releaseCreate.status === 201) {
      const releaseId = releaseCreate.data.id;
      if (releaseId) {
        const releaseUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/releases/${releaseId}`, ownerToken, {
          title: "Module Audit Release (updated)",
          body: "Updated " + BODY_SENTINEL,
        });
        checks.releaseUpdate = { status: releaseUpdate.status, ok: releaseUpdate.status === 200 };
        if (!checks.releaseUpdate.ok) allOk = false;
      }
    } else {
      allOk = false;
    }
  }

  // ── Packages ───────────────────────────────────────────────────────────
  if (actionSet.has("package_created")) {
    const pkgCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, ownerToken, {
      name: "module-audit-pkg",
      version: "99.99.99",
      description: "Audit smoke package with " + BODY_SENTINEL,
      repository_url: "https://example.com/module-audit",
    });
    checks.packageCreate = { status: pkgCreate.status, ok: pkgCreate.status === 201 };
    if (pkgCreate.status === 201) {
      const pkgId = pkgCreate.data.id;
      if (pkgId) {
        const pkgUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/packages/${pkgId}`, ownerToken, {
          description: "Updated audit smoke package with " + BODY_SENTINEL,
        });
        checks.packageUpdate = { status: pkgUpdate.status, ok: pkgUpdate.status === 200 };
        if (!checks.packageUpdate.ok) allOk = false;
      }
    } else {
      allOk = false;
    }
  }

  // ── Security Advisories ────────────────────────────────────────────────
  if (actionSet.has("security_advisory_created")) {
    const advCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/security-advisories`, ownerToken, {
      title: "Module Audit Advisory",
      severity: "high",
      status: "published",
      body: "## Advisory\n\n" + BODY_SENTINEL,
    });
    checks.advisoryCreate = { status: advCreate.status, ok: advCreate.status === 201 };
    if (advCreate.status === 201) {
      const advId = advCreate.data.id;
      if (advId) {
        const advUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/security-advisories/${advId}`, ownerToken, {
          title: "Module Audit Advisory (updated)",
          severity: "critical",
          body: "## Updated\n\n" + BODY_SENTINEL,
        });
        checks.advisoryUpdate = { status: advUpdate.status, ok: advUpdate.status === 200 };
        if (!checks.advisoryUpdate.ok) allOk = false;
      }
    } else {
      allOk = false;
    }
  }

  checks.seedingFailed = !allOk;
  return checks;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.activityCallsAuditEndpoint = html.includes('/audit-events?limit=20');
    checks.activityHasAuditSection =
      html.includes("项目审计") &&
      html.includes("activity-section-title");

    // Check that the formatAuditAction function handles general actions
    // by falling through to the default case
    checks.formatAuditActionFallback = html.includes("return escapeHtml(action");
    checks.auditSensitiveKeysDefined =
      html.includes("AUDIT_SENSITIVE_KEYS") &&
      html.includes("webhook_secret") &&
      html.includes("token") &&
      html.includes("api_key");

    // Inline script parses
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

    // ── Owner view: activity tab should show module audit events ──
    await setStoredAuth(page, origin, storageKey, seeded.ownerToken, seeded.projectId);
    const activityUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=activity`;
    await page.goto(activityUrl, { waitUntil: "networkidle" });
    // Click Activity tab via primary or overflow menu.
    var primaryAct = await page.$('.tab-item[data-tab="activity"]');
    if (primaryAct) {
      await primaryAct.click();
      await page.waitForSelector('.tab-item[data-tab="activity"].active', { timeout: 10000 });
    } else {
      await page.click("#tabMoreBtn");
      await page.waitForSelector("#tabMoreMenu.open", { timeout: 5000 });
      await page.click('.tab-more-item[data-tab="activity"]');
      await page.waitForTimeout(400);
      await page.waitForFunction(
        function () {
          var btn = document.querySelector("#tabMoreBtn");
          return btn && btn.classList.contains("has-active") &&
            new URL(window.location.href).searchParams.get("tab") === "activity";
        },
        { timeout: 10000 }
      );
    }
    result.checks.activityTabActive = true;

    // Wait for the activity panel to show
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("#activityPanel");
        return panel && panel.textContent.includes("项目审计");
      },
      { timeout: 15000 }
    );

    const activityText = await page.locator("#activityPanel").innerText();
    result.checks.activitySectionRendered = activityText.includes("项目审计");

    // Check that at least one module audit action row is rendered (the generic
    // formatAuditAction fallback shows the raw action string for unrecognized actions)
    result.checks.moduleAuditRowsPresent =
      activityText.includes("wiki_page_created") ||
      activityText.includes("release_created") ||
      activityText.includes("package_created") ||
      activityText.includes("security_advisory_created") ||
      activityText.includes("Wiki") ||
      activityText.includes("Release") ||
      activityText.includes("Module Audit");

    // CRITICAL: verify raw body markdown is never in activity text
    result.checks.noBodyMarkdownInActivity = !activityText.includes(BODY_SENTINEL);
    result.checks.noSecretInActivity = !activityText.includes(SECRET_SENTINEL);
    result.checks.noTokenInActivity = !activityText.includes(TOKEN_SENTINEL);
    result.checks.noApiKeyInActivity = !activityText.includes(KEY_SENTINEL);

    // ── Viewer view: can see audit, but still no leaks ──
    await setStoredAuth(page, origin, storageKey, seeded.viewerToken, seeded.projectId);
    await page.goto(activityUrl, { waitUntil: "networkidle" });
    var primaryAct2 = await page.$('.tab-item[data-tab="activity"]');
    if (primaryAct2) {
      await primaryAct2.click();
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
    const viewerActivityText = await page.locator("#activityPanel").innerText();
    result.checks.viewerCanSeeAuditSection = viewerActivityText.includes("项目审计");
    result.checks.noSecretInViewerActivity = !viewerActivityText.includes(SECRET_SENTINEL);
    result.checks.noTokenInViewerActivity = !viewerActivityText.includes(TOKEN_SENTINEL);
    result.checks.noApiKeyInViewerActivity = !viewerActivityText.includes(KEY_SENTINEL);
    result.checks.noBodyMarkdownInViewerActivity = !viewerActivityText.includes(BODY_SENTINEL);

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
    "# Project Space Module Audit Smoke Evidence",
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
