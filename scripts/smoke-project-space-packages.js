#!/usr/bin/env node
// Project Space Packages Tab — browser/runtime smoke harness.
//
// Verifies the real Project Space Packages implementation: backend API,
// browser UI, owner/admin edit controls, member/viewer read-only gating,
// Extras placement, and the absence of fake upload/download/delete/publish
// or security controls.
//
// Follows the evidence style of smoke-project-space-wiki.js and
// smoke-project-space-releases.js.
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-packages-smoke");
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
    command: "node scripts/smoke-project-space-packages.js",
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
    result.checks.backendPackagesApi = await probeBackendPackagesApi(seeded);
    result.checks.staticWiring = checkStaticWiring();

    if (!playwright) {
      result.skipped = true;
      result.residual.push(`Playwright not resolvable from ${PLAYWRIGHT_NODE_MODULES}. Browser automation skipped.`);
      result.passed =
        allChecksPassed(result.checks.backendPackagesApi) &&
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
  process.env.JWT_SECRET = "project-space-packages-smoke-secret";
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
  const owner = await register(baseUrl, "pkg-owner", password);
  const member = await register(baseUrl, "pkg-member", password);
  const viewer = await register(baseUrl, "pkg-viewer", password);

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Packages Smoke Project",
    description: "Browser smoke for Project Space Packages tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: "member" });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: "viewer" });

  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Packages Smoke\n\nProject used to verify the Packages tab.",
    message: "Initial README for packages smoke",
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

async function probeBackendPackagesApi(seeded) {
  const checks = {};
  const { baseUrl, ownerToken, memberToken, viewerToken, projectId } = seeded;

  // Create a package.
  const createRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, ownerToken, {
    name: "my-package",
    version: "1.0.0",
    description: "A smoke test package",
    repository_url: "https://example.com/my-package",
  });
  checks.packageApiCreate = { status: createRes.status, ok: createRes.status === 201, id: createRes.data && createRes.data.id };
  const packageId = createRes.data && createRes.data.id;

  // Create a second package (for list verification).
  const create2Res = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, ownerToken, {
    name: "another-package",
    version: "0.1.0",
    description: "Another package for list verification",
  });
  checks.packageApiCreateSecond = { status: create2Res.status, ok: create2Res.status === 201, id: create2Res.data && create2Res.data.id };
  const package2Id = create2Res.data && create2Res.data.id;

  // Duplicate name/version rejection.
  const dupRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, ownerToken, {
    name: "my-package",
    version: "1.0.0",
    description: "Duplicate",
  });
  checks.packageApiDuplicateRejected = dupRes.status === 409;

  // Duplicate name with different version should be allowed.
  const dupVersionRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, ownerToken, {
    name: "my-package",
    version: "2.0.0",
    description: "New version",
  });
  checks.packageApiDifferentVersionOk = dupVersionRes.status === 201;

  // List packages (should be readable by member).
  const listRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/packages`, memberToken);
  checks.packageApiListReadable = { status: listRes.status, ok: listRes.status === 200 && Array.isArray(listRes.data.data) && listRes.data.data.length >= 2 };
  checks.packageApiListOmitsBody = listRes.status === 200 && listRes.data.data.every((item) => item.description === undefined || item.body === undefined);

  // Read a single package (viewer should be able to read).
  if (packageId) {
    const readRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/packages/${packageId}`, viewerToken);
    checks.packageApiViewerCanRead = { status: readRes.status, ok: readRes.status === 200 && readRes.data.name === "my-package" };
  } else {
    checks.packageApiViewerCanRead = { status: null, ok: false, reason: "package creation failed" };
  }

  // Update a package (owner).
  if (packageId) {
    const updateRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/packages/${packageId}`, ownerToken, {
      description: "Updated description",
      repository_url: "https://example.com/my-package-updated",
    });
    checks.packageApiUpdate = { status: updateRes.status, ok: updateRes.status === 200 && updateRes.data.description === "Updated description" };
  } else {
    checks.packageApiUpdate = { status: null, ok: false, reason: "package creation failed" };
  }

  // Member cannot create.
  const memberCreate = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages`, memberToken, {
    name: "member-pkg",
    version: "1.0.0",
    description: "Should be rejected",
  });
  checks.packageApiMemberCannotCreate = memberCreate.status === 403;

  // Viewer cannot update.
  if (packageId) {
    const viewerUpdate = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/packages/${packageId}`, viewerToken, {
      description: "Should be rejected",
    });
    checks.packageApiViewerCannotUpdate = viewerUpdate.status === 403;
  } else {
    checks.packageApiViewerCannotUpdate = { status: null, ok: false, reason: "package creation failed" };
  }

  // No fake upload/delete/publish endpoints.
  // These should return 404 (feature not implemented) rather than pretending to work.
  const uploadRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages/${packageId || "0"}/upload`, ownerToken, {});
  checks.packageApiNoFakeUpload = uploadRes.status === 404;

  const deleteRes = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/packages/${packageId || "0"}`, ownerToken);
  checks.packageApiNoFakeDelete = deleteRes.status === 404;

  const publishRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages/${packageId || "0"}/publish`, ownerToken, {});
  checks.packageApiNoFakePublish = publishRes.status === 404;

  const securityRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/packages/${packageId || "0"}/security-scan`, ownerToken, {});
  checks.packageApiNoFakeSecurityScan = securityRes.status === 404;

  // Normalize true/false values for all-ok checks.
  if (typeof checks.packageApiDuplicateRejected === "boolean") {
    checks.packageApiDuplicateRejected = { ok: checks.packageApiDuplicateRejected };
  }
  if (typeof checks.packageApiDifferentVersionOk === "boolean") {
    checks.packageApiDifferentVersionOk = { ok: checks.packageApiDifferentVersionOk };
  }

  return checks;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.packagesTabMarkup = html.includes('data-tab="packages"') && html.includes('id="tab-packages"') && html.includes(">Packages</button>");
    checks.packagesPanelMarkup = html.includes('id="packagesPanel"') && html.includes('aria-labelledby="tab-packages"');
    checks.packagesAllowlisted = /TAB_ALLOWLIST[\s\S]*"packages"/.test(html);
    checks.packagesRenderFunction = html.includes("function renderPackages()") && html.includes("function renderPackageForm");
    checks.packagesUsesPackageName = html.includes("package-name") && html.includes("package-version");
    checks.packagesNoFakeControls = !/upload package|download package/i.test(html);

    // Extras integration: Packages and Security should now be implemented.
    // Automated scanning should remain deferred.
    checks.extrasPackagesImplemented = html.includes('{ tab: "packages"') && html.includes('name: "Packages"');
    checks.extrasSecurityImplemented = html.includes('{ tab: "security"') && html.includes('name: "Security"');
    const extrasDeferredMatch = html.match(/var deferred\s*=\s*\[([\s\S]*?)\];/);
    if (extrasDeferredMatch) {
      const deferredBlock = extrasDeferredMatch[1];
      checks.extrasAutomatedScanningDeferred = deferredBlock.includes('name: "Automated scanning"');
      checks.extrasSecurityNotDeferred = !deferredBlock.includes('name: "Security"');
      checks.extrasPackagesNotDeferred = !deferredBlock.includes('name: "Packages"');
    } else {
      checks.extrasAutomatedScanningDeferred = false;
      checks.extrasSecurityNotDeferred = false;
      checks.extrasPackagesNotDeferred = false;
    }

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
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const packagesUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=packages`;

    // ── Owner: deep-link into Packages tab and verify create/edit UI ──────────
    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    await page.goto(packagesUrl, { waitUntil: "networkidle" });
    await waitTab("packages");
    await page.waitForSelector("#packageCreateBtn", { timeout: 10000 });

    result.checks.packagesTabActive = !!(await page.$('.tab-item[data-tab="packages"].active')) ||
      (await page.evaluate(() => {
        const btn = document.querySelector("#tabMoreBtn");
        return !!(btn && btn.classList.contains("has-active"));
      }));
    result.checks.packagesPanelVisible = !!(await page.$("#packagesPanel:not(.hidden)"));
    result.checks.ownerSeesCreate = !!(await page.$("#packageCreateBtn"));

    // Create a package via the UI form.
    await page.click("#packageCreateBtn");
    await page.fill("#packageNameInput", "browser-package");
    await page.fill("#packageVersionInput", "2.0.0");
    await page.fill("#packageDescriptionInput", "Package created by browser smoke");
    await page.fill("#packageRepoUrlInput", "https://example.com/browser-pkg");
    await page.click("#packageSaveBtn");
    await page.waitForSelector(".package-detail", { timeout: 10000 });

    const detailText = await page.textContent("#packagesPanel");
    result.checks.ownerCreatedPackageVisible =
      !!detailText && detailText.includes("browser-package") && detailText.includes("2.0.0") && detailText.includes("Package created by browser smoke");

    result.checks.ownerSeesEdit = !!(await page.$("#packageEditBtn"));

    // Edit the package via the UI form.
    await page.click("#packageEditBtn");
    await page.fill("#packageDescriptionInput", "Updated by browser smoke");
    await page.click("#packageSaveBtn");
    await page.waitForSelector(".package-detail", { timeout: 10000 });

    const updatedText = await page.textContent("#packagesPanel");
    result.checks.ownerUpdatedPackageVisible = !!updatedText && updatedText.includes("Updated by browser smoke");

    // No fake upload/download/delete/security controls in packages panel.
    const panelText = await page.textContent("#packagesPanel");
    result.checks.noFakeControlsInPanel =
      !/upload package|download package|delete package|publish package|security scan/i.test(panelText || "");

    // ── Viewer: cannot see create/edit controls ───────────────────────────────
    await setStoredSession(origin, storageKey, seeded.viewerToken, seeded.projectId);
    await page.goto(packagesUrl, { waitUntil: "networkidle" });
    await waitTab("packages");

    result.checks.viewerCannotCreate = !(await page.$("#packageCreateBtn"));
    const viewerRows = await page.$$("#packagesPanel .package-row");
    if (viewerRows.length > 0) {
      await viewerRows[0].click();
      await page.waitForSelector(".package-detail", { timeout: 10000 });
    }
    result.checks.viewerCannotEdit = !(await page.$("#packageEditBtn"));

    // ── Member: cannot see create button, can read list ───────────────────────
    await setStoredSession(origin, storageKey, seeded.memberToken, seeded.projectId);
    await page.goto(packagesUrl, { waitUntil: "networkidle" });
    await waitTab("packages");

    result.checks.memberCannotCreate = !(await page.$("#packageCreateBtn"));
    result.checks.memberCanReadList = (await page.$$("#packagesPanel .package-row")).length > 0;

    // ── Extras consistency ────────────────────────────────────────────────────
    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    const extrasUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=extras`;
    await page.goto(extrasUrl, { waitUntil: "networkidle" });
    await waitTab("extras");

    const extrasText = await page.textContent("#extrasPanel");
    result.checks.extrasPackagesImplemented = !!extrasText && extrasText.includes("已实现的模块") && extrasText.includes("Packages");
    const deferredNames = await page.$$eval("#extrasPanel .extras-deferred .extras-deferred-name", (els) => els.map((el) => el.textContent.trim()));
    result.checks.extrasPackagesNotDeferred = !deferredNames.includes("Packages");
    result.checks.extrasSecurityImplemented = !!extrasText && extrasText.includes("Security");
    result.checks.extrasSecurityNotDeferred = !deferredNames.includes("Security");
    result.checks.extrasAutomatedScanningDeferred = deferredNames.includes("Automated scanning");

    // No fake package/security action buttons in Extras either.
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
    "# Project Space Packages Tab — Browser Smoke Evidence",
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
    "This smoke verifies the implemented Project Space Packages tab, including ",
    "backend create/list/read/update, duplicate name/version rejection, owner ",
    "edit controls, member/viewer read-only gating, Extras placement, and the ",
    "absence of fake upload/download/delete/publish/security controls.",
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
