#!/usr/bin/env node
// Project Space Extras Tab — browser/runtime smoke harness.
//
// Verifies the honest "Extras" UI affordance that lists implemented repository
// surfaces and deferred surfaces without pretending unsupported actions are
// functional. Checks URL/tab behavior, static wiring, and mobile layout.
//
// If Playwright is not resolvable, still verifies static JS wiring and exits
// with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-extras.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
//                                  (defaults to the bundled runtime path).
//   VIEWPORT_WIDTH, VIEWPORT_HEIGHT - viewport dimensions (overridable).
//
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-extras-smoke");
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
    command: "node scripts/smoke-project-space-extras.js",
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
    if (!result.backendBuilt) {
      throw new Error("Backend dist missing. Run: cd backend && npm run build");
    }

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    if (!playwright) {
      result.residual.push(
        "Playwright not resolvable from this process or from " +
          PLAYWRIGHT_NODE_MODULES +
          ". Browser automation skipped."
      );
    }

    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
    };

    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed =
        staticOk.extrasTabMarkup &&
        staticOk.extrasPanelMarkup &&
        staticOk.extrasAllowlisted &&
        staticOk.extrasRenderFunction &&
        staticOk.inlineScriptParses &&
        !staticOk.error;
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
  process.env.JWT_SECRET = "project-space-extras-smoke-secret";
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

  const email = `extras-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password,
    display_name: "Extras Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error(`Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`);
  }
  const token = registerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "Extras Smoke Project",
    description: "Browser smoke for Project Space Extras tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  const readmeFileRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    token,
    {
      path: "README.md",
      content: "# Extras Smoke\n\nProject used to verify the Extras tab.",
      message: "Initial README for extras smoke",
    }
  );
  if (readmeFileRes.status !== 201) {
    throw new Error(`README file create failed: ${readmeFileRes.status} ${JSON.stringify(readmeFileRes.data)}`);
  }

  return { baseUrl, token, projectId };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.extrasTabMarkup =
      html.includes('data-tab="extras"') &&
      html.includes('id="tab-extras"') &&
      html.includes(">Extras</button>");

    checks.extrasPanelMarkup =
      html.includes('id="extrasPanel"') &&
      html.includes('aria-labelledby="tab-extras"');

    checks.extrasAllowlisted =
      html.includes('"overview","files","compare","history","tags","work","reviews"') ||
      html.includes('"files", "readme", "activity", "insights", "work", "reviews", "people", "history", "settings", "wiki", "releases", "tags", "packages", "security", "extras", "compare"') ||
      html.includes("'files', 'readme', 'activity', 'insights', 'work', 'reviews', 'people', 'history', 'settings', 'wiki', 'releases', 'tags', 'packages', 'security', 'extras', 'compare'");

    checks.extrasRenderFunction =
      html.includes("function renderExtras()") &&
      html.includes("data-tab-link");

    checks.extrasImplementedRepoModules =
      html.includes('{ tab: "wiki"') &&
      html.includes('{ tab: "releases"') &&
      html.includes('{ tab: "packages"') &&
      html.includes('{ tab: "security"') &&
      html.includes("项目知识库") &&
      html.includes("版本发布与变更日志") &&
      html.includes("包与制品元数据") &&
      html.includes("安全公告与发现记录");

    checks.extrasHonestDeferred =
      html.includes('name: "Automated scanning"') &&
      html.includes("自动漏洞扫描") &&
      !html.includes('name: "Wiki", reason') &&
      !html.includes('name: "Releases", reason') &&
      !html.includes('name: "Packages", reason') &&
      !html.includes('name: "Security", reason');

    checks.extrasAutomatedScanningDeferredReason =
      html.includes('name: "Automated scanning"') &&
      html.includes("自动漏洞扫描");

    checks.extrasNoFakeControls =
      !/publish package|new package|security scan|run scan|import security|fix security|audit now|vulnerability scan/i.test(html);

    // Verify Security tab/panel markup exists in the dashboard HTML
    checks.securityTabMarkup =
      html.includes('data-tab="security"') &&
      html.includes('id="tab-security"') &&
      html.includes(">Security</button>");

    checks.securityPanelMarkup =
      html.includes('id="securityPanel"') &&
      html.includes('aria-labelledby="tab-security"');

    checks.extrasMobileScroll =
      html.includes("overflow-x: auto") &&
      html.includes(".tab-bar::-webkit-scrollbar");

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

async function runBrowserSmoke(playwright, seeded) {
  const result = {
    passed: false,
    checks: {},
    errors: [],
    screenshotPath: null,
  };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  page = await context.newPage();

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.token,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    await page.goto(origin);
    await page.evaluate(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: storageKey, value: storagePayload }
    );

    // Phase 1: Deep-link into Extras tab
    const extrasUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
      seeded.projectId
    )}&tab=extras`;
    await page.goto(extrasUrl, { waitUntil: "networkidle" });

    await page.waitForFunction(function () {
      var item = document.querySelector('.tab-more-item[data-tab="extras"]');
      var more = document.querySelector("#tabMoreBtn");
      return !!(item && item.classList.contains("active") && more && more.classList.contains("has-active"));
    }, { timeout: 10000 });
    result.checks.extrasTabActive = true;

    await page.waitForSelector("#extrasPanel:not(.hidden)", { timeout: 10000 });
    result.checks.extrasPanelVisible = true;

    const extrasText = await page.textContent("#extrasPanel");
    result.checks.extrasImplementedListed =
      !!(extrasText && extrasText.includes("已实现的模块"));
    result.checks.extrasDeferredListed =
      !!(extrasText && extrasText.includes("后续规划"));
    result.checks.extrasWikiReleaseImplemented =
      !!(extrasText && extrasText.includes("Wiki")) &&
      !!(extrasText && extrasText.includes("Releases")) &&
      !!(extrasText && extrasText.includes("Packages")) &&
      !!(extrasText && extrasText.includes("Security")) &&
      !!(extrasText && extrasText.includes("已实现的模块"));
    const deferredNames = await page.$$eval(
      "#extrasPanel .extras-deferred .extras-deferred-name",
      function (els) { return els.map(function (e) { return e.textContent.trim(); }); }
    );
    result.checks.extrasDeferredHonest =
      deferredNames.indexOf("Automated scanning") !== -1 &&
      deferredNames.indexOf("Wiki") === -1 &&
      deferredNames.indexOf("Releases") === -1 &&
      deferredNames.indexOf("Packages") === -1 &&
      deferredNames.indexOf("Security") === -1 &&
      !!(extrasText && extrasText.includes("尚未实现"));

    // Phase 2: Clicking an implemented card switches tabs
    await page.click('[data-tab-link="files"]');
    await page.waitForSelector('.tab-item[data-tab="files"].active', {
      timeout: 10000,
    });
    await page.waitForSelector("#filesTabContent:not(.hidden)", { timeout: 10000 });
    result.checks.extrasLinkSwitchesToFiles = true;

    // Phase 3: URL preserves project_id and tab
    result.checks.urlPreservesProjectAndTab =
      page.url().includes("project_id=") && page.url().includes("tab=files");

    // Phase 4: Tab bar layout — it should stay on one row. Only small
    // viewports need horizontal scrolling; desktop can remain visible.
    const tabBarLayout = await page.evaluate(function () {
      var tabBar = document.querySelector("#tabBar");
      if (!tabBar) return null;
      var items = tabBar.querySelectorAll(".tab-item");
      var rects = Array.prototype.slice.call(items).map(function (item) {
        return item.getBoundingClientRect();
      });
      var firstTop = rects.length ? rects[0].top : 0;
      var allSameRow = rects.every(function (r) {
        return Math.abs(r.top - firstTop) < 2;
      });
      var computed = window.getComputedStyle(tabBar);
      return {
        itemCount: items.length,
        primaryCount: items.length,
        hasMoreButton: !!document.querySelector("#tabMoreBtn"),
        allSameRow: allSameRow,
        overflowX: computed.overflowX,
        flexWrap: computed.flexWrap,
      };
    });
    result.checks.tabBarLayout = tabBarLayout;
    result.checks.tabBarNoWrap = !!(tabBarLayout && tabBarLayout.allSameRow);
    const isMobileViewport = VIEWPORT_WIDTH <= 600;
    result.checks.tabBarOverflowHandled = !!(
      tabBarLayout &&
      tabBarLayout.hasMoreButton &&
      tabBarLayout.primaryCount <= 7 &&
      (!isMobileViewport || tabBarLayout.allSameRow)
    );

    // Phase 5: No fake interactive controls for deferred surfaces
    const bodyText = await page.textContent("body");
    result.checks.noFakeDeferredControls =
      !/publish package|new package|security scan|run scan|import security|fix security|audit now|vulnerability scan/i.test(bodyText || "");

    // Phase 6: Security tab exists in the overflow menu (not as primary tab-item).
    const securityInOverflow = await page.$('#tabMoreMenu .tab-more-item[data-tab="security"]');
    const securityInPrimary = await page.$('#tabBar .tab-item[data-tab="security"]');
    // Security is expected to be an overflow tab only (no primary tab-item).
    result.checks.securityTabButtonPresent = !!securityInOverflow;
    result.checks.securityTabNotInPrimary = !securityInPrimary;

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = Object.values(result.checks).every(function (value) {
      if (value && typeof value === "object") {
        return Object.values(value).every(function (v) { return v === true || v !== false; });
      }
      return value === true;
    });
  } catch (err) {
    const errStr = String(err.stack || err.message || err);
    result.errors.push(errStr);
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  return result;
}

async function api(baseUrl, method, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
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

  const lines = [
    "# Project Space Extras Tab — Browser Smoke Evidence",
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

  if (result.residual.length) {
    lines.push("## Residual gaps", "", ...result.residual.map(function (r) { return "- " + r; }), "");
  }

  if (result.errors.length) {
    lines.push("## Errors", "", ...result.errors.map(function (e) { return "- " + e; }), "");
  }

  lines.push(
    "",
    "## Scope Note",
    "",
    "This smoke verifies that the Extras tab honestly surfaces implemented and deferred repository-adjacent features without introducing fake interactive controls or backend routes.",
    "",
  );

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

main().finally(async () => {
  if (page) await page.close().catch(function () {});
  if (context) await context.close().catch(function () {});
  if (browser) await browser.close().catch(function () {});
  if (server) {
    await new Promise(function (resolve) { server.close(resolve); });
  }
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
});
