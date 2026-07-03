#!/usr/bin/env node
// Project Space File Finder — browser smoke harness.
//
// Starts the built backend with SERVE_DASHBOARD=1, seeds a project with a small
// set of nested files, then opens /project-space.html in Chromium via Playwright
// to verify the Gitea/open-source-style repository file finder:
//
//   - `t` (outside text inputs) and Ctrl/Cmd+P open the finder.
//   - The finder filters the repository file paths already loaded by Project Space.
//   - Enter (or click) on the highlighted result navigates to the existing file
//     preview/raw view.
//   - Escape closes the finder and the preview safely.
//   - Empty state is honest (no matching local files → no results).
//   - `t` does NOT open the finder while typing in an input.
//   - No fake OSS/provider controls (clone, stars, forks, PR/Issue creation) are
//     introduced by the finder.
//
// If Playwright is not resolvable, the script still seeds data and runs static
// wiring checks, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-file-finder.js
//   VIEWPORT_WIDTH=390 VIEWPORT_HEIGHT=844 node scripts/smoke-project-space-file-finder.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package.
//   VIEWPORT_WIDTH, VIEWPORT_HEIGHT - viewport dimensions (overridable).
//
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");

const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);
const ARTIFACT_DIR = path.join(
  ROOT,
  "dashboard-e2e-artifacts",
  "project-space-file-finder-smoke-" + VIEWPORT_WIDTH + "x" + VIEWPORT_HEIGHT
);
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;

let server = null;
let browser = null;
let context = null;
let page = null;

const REQUIRED_BROWSER_CHECKS = [
  "filesTabLoaded",
  "finderOpensOnT",
  "finderInputFocused",
  "finderShowsFiles",
  "finderFiltersByQuery",
  "finderArrowNavigation",
  "finderEnterOpensPreview",
  "previewShowsSelectedFile",
  "finderClosesOnEscape",
  "finderOpensOnCtrlP",
  "tDoesNotOpenWhileTyping",
  "finderHonestEmptyState",
  "finderNoFakeControls",
  "screenshotCaptured",
];

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-file-finder.js",
    timestamp: new Date().toISOString(),
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
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
      filesSeeded: seeded.files.length >= 4,
    };

    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed = Object.keys(staticOk).every(function (k) { return staticOk[k] === true; });
      result.residual.push(
        "Real-browser rendering not exercised because Playwright is unavailable."
      );
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    if (browserResult.errors && browserResult.errors.length) {
      result.errors.push.apply(result.errors, browserResult.errors);
    }

    const browserRequiredOk = REQUIRED_BROWSER_CHECKS.every(function (k) {
      return (result.checks.browser || {})[k] === true;
    });
    result.passed = browserRequiredOk;

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
  process.env.JWT_SECRET = "project-space-file-finder-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, resolve); });
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port;
  process.env.CORS_ORIGINS = baseUrl;

  const email = "file-finder-smoke-" + Date.now() + "@example.invalid";
  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: email,
    password: "SmokeTest123!",
    display_name: "File Finder Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error("Register failed: " + registerRes.status + " " + JSON.stringify(registerRes.data));
  }
  const token = registerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "File Finder Smoke Project",
    description: "Browser smoke for Project Space file finder",
  });
  if (projectRes.status !== 201) {
    throw new Error("Project create failed: " + projectRes.status + " " + JSON.stringify(projectRes.data));
  }
  const projectId = projectRes.data.id;

  const filePaths = [
    "README.md",
    "package.json",
    "src/index.js",
    "src/app.ts",
    "src/components/Button.jsx",
    "src/components/Modal.jsx",
    "src/components/Table.jsx",
    "docs/guide.md",
    "tests/unit/app.test.js",
  ];
  const files = [];
  for (const filePath of filePaths) {
    const res = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", token, {
      path: filePath,
      content: "// " + path.basename(filePath) + "\n",
      message: "Seed " + filePath,
    });
    if (res.status === 201 || res.status === 200) {
      files.push({ path: filePath, id: res.data.id });
    }
  }

  return {
    baseUrl: baseUrl,
    token: token,
    projectId: projectId,
    files: files,
    targetPath: "src/components/Modal.jsx",
    targetFragment: "Modal",
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.finderPaneExists = html.indexOf('id="fileFinderPane"') !== -1;
    checks.finderInputExists = html.indexOf('id="fileFinderInput"') !== -1;
    checks.finderListExists = html.indexOf('id="fileFinderList"') !== -1;
    checks.finderEmptyExists = html.indexOf('id="fileFinderEmpty"') !== -1;
    checks.finderIsModalDialog =
      /id="fileFinderPane"[^>]*role="dialog"[^>]*aria-modal="true"/.test(html);
    checks.finderListIsListbox =
      /id="fileFinderList"[^>]*role="listbox"/.test(html);

    checks.openFileFinderFunction = html.indexOf("function openFileFinder(") !== -1;
    checks.closeFileFinderFunction = html.indexOf("function closeFileFinder(") !== -1;
    checks.collectFinderFilesFunction = html.indexOf("function collectFinderFiles(") !== -1;
    checks.filterFinderFilesFunction = html.indexOf("function filterFinderFiles(") !== -1;
    checks.renderFileFinderResultsFunction = html.indexOf("function renderFileFinderResults(") !== -1;
    checks.selectFinderFileFunction = html.indexOf("function selectFinderFile(") !== -1;

    checks.ctrlPWiring = html.indexOf('(e.key === "p" || e.key === "P")') !== -1;
    checks.tKeyWiring = html.indexOf('e.key === "t"') !== -1;
    checks.escapeClosesFinder =
      /state\.fileFinderActive[\s\S]{0,200}e\.key === "Escape"[\s\S]{0,200}closeFileFinder\(\)/.test(html);
    checks.enterSelectsFinder = html.indexOf("function commitFinderSelection(") !== -1;

    // The finder must reuse the existing preview path rather than adding new views.
    checks.selectFinderCallsOpenPreview =
      /function selectFinderFile\([\s\S]{0,500}openPreview\(file\)/.test(html);

    // The finder must not introduce standalone repository pages or remote controls.
    checks.noRepositoryHtmlPage = html.indexOf("repository.html") === -1;
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, checks: {}, errors: [], screenshotPath: null };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  page = await context.newPage();
  page.on("console", function (msg) {
    if (msg.type() === "error") result.errors.push("console:" + msg.text());
  });
  page.on("pageerror", function (err) {
    result.errors.push("pageerror:" + err.message);
  });

  try {
    const origin = seeded.baseUrl;
    const storagePayload = JSON.stringify({
      jwt: seeded.token,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    await page.goto(origin);
    await page.evaluate(function (payload) {
      localStorage.setItem("zz_human_workspace_simple_v1", payload);
    }, storagePayload);

    const filesUrl = origin +
      "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) +
      "&tab=files";
    await page.goto(filesUrl, { waitUntil: "networkidle" });

    // Files tab active and file rows present (files loaded into Project Space).
    await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
    await page.waitForSelector(".file-entry", { timeout: 15000 });
    result.checks.filesTabLoaded = true;

    // ── `t` opens the finder when not typing ────────────────────────────────
    await blurActiveElement(page);
    await page.keyboard.press("t");
    const openedOnT = await page.waitForSelector('#fileFinderPane.open', { timeout: 5000 })
      .then(function () { return true; }).catch(function () { return false; });
    result.checks.finderOpensOnT = !!openedOnT;

    const inputFocused = await page.evaluate(function () {
      var el = document.getElementById("fileFinderInput");
      return !!(el && document.activeElement === el);
    });
    result.checks.finderInputFocused = !!inputFocused;

    // ── Finder shows the loaded repository files (empty query) ──────────────
    // The finder opens immediately with whatever is loaded, then enriches with
    // the full file list via the existing Files API — wait for that to land.
    await page.waitForFunction(function () {
      return document.querySelectorAll('#fileFinderList .file-finder-option').length >= 4;
    }, { timeout: 10000 }).catch(function () {});
    const initialCount = await page.evaluate(function () {
      return document.querySelectorAll('#fileFinderList .file-finder-option').length;
    });
    result.checks.finderShowsFiles = initialCount >= 4;

    // ── Arrow navigation moves the highlighted option (many options shown) ──
    const activeBefore = await page.evaluate(function () {
      var el = document.querySelector('#fileFinderList .file-finder-option.active');
      return el ? el.getAttribute("data-finder-index") : null;
    });
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(50);
    const activeAfter = await page.evaluate(function () {
      var el = document.querySelector('#fileFinderList .file-finder-option.active');
      return el ? el.getAttribute("data-finder-index") : null;
    });
    result.checks.finderArrowNavigation =
      activeBefore !== null && activeAfter !== null && activeBefore !== activeAfter;

    // ── Filtering narrows results to the query ──────────────────────────────
    await page.fill("#fileFinderInput", "modal");
    await page.waitForTimeout(150);
    const filtered = await page.evaluate(function () {
      var opts = Array.prototype.slice.call(document.querySelectorAll('#fileFinderList .file-finder-option'));
      return {
        count: opts.length,
        names: opts.map(function (o) { return o.textContent.toLowerCase(); }),
        emptyHidden: document.getElementById("fileFinderEmpty").classList.contains("hidden"),
      };
    });
    result.checks.finderFiltersByQuery =
      filtered.count >= 1 &&
      filtered.count < initialCount &&
      filtered.names.every(function (n) { return n.indexOf("modal") !== -1; }) &&
      filtered.emptyHidden;

    // Reset to a single deterministic match for the open test.
    await page.fill("#fileFinderInput", seeded.targetFragment);
    await page.waitForTimeout(150);

    // ── Enter navigates to the existing file preview ────────────────────────
    await page.keyboard.press("Enter");
    const previewOpened = await page.waitForSelector('#previewPane[aria-hidden="false"]', { timeout: 10000 })
      .then(function () { return true; }).catch(function () { return false; });
    result.checks.finderEnterOpensPreview = !!previewOpened;

    const previewPath = await page.evaluate(function () {
      var el = document.getElementById("previewPath");
      return el ? el.textContent : "";
    });
    result.checks.previewShowsSelectedFile = previewPath.indexOf(seeded.targetFragment) !== -1;

    // Close the preview via Escape, then close any finder remainder.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── Escape closes the finder cleanly ────────────────────────────────────
    await blurActiveElement(page);
    await page.keyboard.press("t");
    await page.waitForSelector('#fileFinderPane.open', { timeout: 5000 });
    await page.keyboard.press("Escape");
    const closedOnEscape = await page.waitForSelector('#fileFinderPane:not(.open)', { timeout: 5000 })
      .then(function () { return true; }).catch(function () { return false; });
    result.checks.finderClosesOnEscape = !!closedOnEscape;

    // ── Ctrl/Cmd+P opens the finder (and suppresses print) ──────────────────
    await blurActiveElement(page);
    await page.keyboard.press("Control+p");
    const openedOnCtrlP = await page.waitForSelector('#fileFinderPane.open', { timeout: 5000 })
      .then(function () { return true; }).catch(function () { return false; });
    result.checks.finderOpensOnCtrlP = !!openedOnCtrlP;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── `t` must NOT open the finder while typing in an input ───────────────
    await page.focus("#searchInput");
    await page.keyboard.press("t");
    await page.waitForTimeout(150);
    const didNotOpenWhileTyping = await page.evaluate(function () {
      var pane = document.getElementById("fileFinderPane");
      return !(pane && pane.classList.contains("open"));
    });
    result.checks.tDoesNotOpenWhileTyping = !!didNotOpenWhileTyping;
    // searchInput should now contain the typed "t".
    const searchInputValue = await page.evaluate(function () {
      var el = document.getElementById("searchInput");
      return el ? el.value : "";
    });

    // ── Honest empty state: no matching local files ─────────────────────────
    await blurActiveElement(page);
    await page.keyboard.press("t");
    await page.waitForSelector('#fileFinderPane.open', { timeout: 5000 });
    await page.fill("#fileFinderInput", "zzzz-no-such-file-xyz");
    await page.waitForTimeout(150);
    const emptyState = await page.evaluate(function () {
      var list = document.getElementById("fileFinderList");
      var empty = document.getElementById("fileFinderEmpty");
      return {
        optionCount: document.querySelectorAll('#fileFinderList .file-finder-option').length,
        emptyVisible: empty && !empty.classList.contains("hidden") && empty.textContent.length > 0,
        listHidden: list.classList.contains("hidden"),
      };
    });
    result.checks.finderHonestEmptyState =
      emptyState.optionCount === 0 && emptyState.emptyVisible && emptyState.listHidden;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);

    // ── The finder introduces no fake OSS/provider controls ─────────────────
    const noFake = await page.evaluate(function () {
      var pane = document.getElementById("fileFinderPane");
      var text = pane ? pane.innerText.toLowerCase() : "";
      var forbidden = ["git clone", "clone url", "forks", "watchers", "pull request", "create issue", "milestone"];
      return forbidden.every(function (p) { return text.indexOf(p) === -1; });
    });
    result.checks.finderNoFakeControls = !!noFake;

    // searchInput carrying the typed "t" confirms `t` typed instead of opening.
    if (!searchInputValue || searchInputValue.indexOf("t") === -1) {
      result.checks.tDoesNotOpenWhileTyping = false;
    }

    // ── Screenshot ──────────────────────────────────────────────────────────
    await blurActiveElement(page);
    await page.keyboard.press("t");
    await page.waitForSelector('#fileFinderPane.open', { timeout: 5000 });
    await page.fill("#fileFinderInput", "component");
    await page.waitForTimeout(150);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    result.screenshotPath = SCREENSHOT_PATH;
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
  } finally {
    await cleanup();
  }

  result.passed = REQUIRED_BROWSER_CHECKS.every(function (k) { return result.checks[k] === true; });
  return result;
}

async function blurActiveElement(page) {
  await page.evaluate(function () {
    var el = document.activeElement;
    if (el && typeof el.blur === "function" && el !== document.body) {
      try { el.blur(); } catch (_) {}
    }
  });
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data: data };
}

async function cleanup() {
  if (context) {
    try { await context.close(); } catch (_) {}
    context = null;
  }
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
  if (server) {
    await new Promise(function (resolve) { server.close(resolve); });
    server = null;
  }
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const lines = [];
  lines.push("# Project Space File Finder — Browser Smoke Evidence");
  lines.push("");
  lines.push("- **Command:** `" + result.command + "`");
  lines.push("- **Timestamp:** " + result.timestamp);
  lines.push("- **Viewport:** " + result.viewport.width + "x" + result.viewport.height);
  lines.push("- **Backend built:** " + result.backendBuilt);
  lines.push("- **Browser available:** " + result.browserAvailable);
  lines.push("- **Passed:** " + result.passed);
  lines.push("- **Skipped:** " + result.skipped);
  if (result.screenshotPath) lines.push("- **Screenshot:** `" + result.screenshotPath + "`");
  lines.push("- **Evidence JSON:** `" + EVIDENCE_JSON + "`");
  lines.push("");

  lines.push("## Static wiring");
  lines.push("");
  const sw = result.checks.staticWiring || {};
  Object.keys(sw).forEach(function (k) {
    lines.push("- " + k + ": " + (sw[k] === true ? "PASS" : "**" + sw[k] + "**"));
  });
  lines.push("");

  lines.push("## Browser checks");
  lines.push("");
  const bc = result.checks.browser || {};
  REQUIRED_BROWSER_CHECKS.forEach(function (k) {
    lines.push("- " + k + ": " + (bc[k] === true ? "PASS" : "**FAIL**"));
  });
  lines.push("");

  if (result.errors && result.errors.length) {
    lines.push("## Errors");
    lines.push("");
    result.errors.slice(0, 20).forEach(function (e) { lines.push("- " + e); });
    lines.push("");
  }
  if (result.residual && result.residual.length) {
    lines.push("## Residual");
    lines.push("");
    result.residual.forEach(function (r) { lines.push("- " + r); });
    lines.push("");
  }

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

main().catch(function (err) {
  console.error(String(err && err.stack || err));
  cleanup().finally(function () { process.exit(1); });
});
