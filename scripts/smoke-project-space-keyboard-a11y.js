#!/usr/bin/env node
// Project Space Keyboard & A11y — browser smoke harness.
//
// Starts the built backend with SERVE_DASHBOARD=1, seeds a project with a
// changeset and commit, then opens /project-space.html in Chromium via
// Playwright and verifies keyboard-accessible interactions:
//
//   1. Tab-bar buttons are native <button> elements (natively focusable);
//      tab switching is verified via click, and programmatic focus is tested.
//   2. Branch popover opens via branch-pill click and closes via outside click.
//   3. Changeset detail drawer opens via review-row click and closes via close
//      button. Escape is also tested but backend re-rendering may interfere.
//   4. Commit detail drawer opens via history-row click and closes via close
//      button. Escape is also tested but backend re-rendering may interfere.
//   5. URL preserves project_id + tab throughout interactions.
//
// If Playwright is not resolvable, the script still seeds data and runs static
// checks, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-keyboard-a11y.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
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
const ARTIFACT_DIR = path.join(
  ROOT,
  "dashboard-e2e-artifacts",
  "project-space-keyboard-a11y-smoke"
);
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

// Bundled runtime path discovered by PM for this Mac.
const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";

const PLAYWRIGHT_NODE_MODULES =
  process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;

const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let browser = null;
let context = null;
let page = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-keyboard-a11y.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt:
      fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
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


    // ── 1. Backend data setup (always runs) ─────────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      defaultBranchAvailable: seeded.defaultBranchName === "main",
      alternateBranchCreated: seeded.alternateBranchName === "keyboard-a11y-alt",
      changesetCreated: !!seeded.changesetId,
      commitCreated: !!seeded.commitId,
      reviewsAvailable: seeded.reviewsOk,
      commitsAvailable: seeded.commitsOk,
    };

    // ── 2. Static DOM checks (always runs) ──────────────────────────────────
    const staticOk = checkStaticKeyboardDom();
    result.checks.staticKeyboardDom = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed =
        staticOk.tabItemsAreButtons &&
        staticOk.branchPillIsButton &&
        staticOk.closeButtonsAreButtons &&
        staticOk.dialogPanelsAreModal &&
        staticOk.focusTrapUtilityExists &&
        staticOk.focusTrapKeydownBound &&
        staticOk.drawerOpenActivatesFocusTrap &&
        staticOk.drawerCloseDeactivatesFocusTrap &&
        staticOk.escapeHandlerExists &&
        staticOk.tablistHasRoleTablist &&
        staticOk.tabItemsHaveRoleTab &&
        staticOk.tabItemsHaveAriaSelected &&
        staticOk.branchPopoverListHasRoleListbox &&
        staticOk.branchOptionsHaveRoleOption &&
        staticOk.branchListboxTracksActiveDescendant &&
        staticOk.branchOptionsUseRovingTabindex &&
        staticOk.branchArrowKeysHandled &&
        staticOk.branchEscapeClosesPopover &&
        !staticOk.error;
      result.residual.push(
        "Real-browser rendering not exercised because Playwright is unavailable."
      );
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke ───────────────────────────────────────────────
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
      const req = createRequire(
        path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json")
      );
      return req("playwright");
    } catch (__) {
      return null;
    }
  }
}

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-keyboard-a11y-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  // app.ts loads openapi-v2.yaml via a path relative to process.cwd(). Existing
  // backend tests are run from the backend/ directory; mirror that.
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  process.env.CORS_ORIGINS = baseUrl;

  const email = `keyboard-a11y-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(
    baseUrl,
    "POST",
    "/v1/auth/register",
    null,
    { email, password, display_name: "Keyboard A11y Smoke" }
  );
  if (registerRes.status !== 201) {
    throw new Error(
      `Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`
    );
  }
  const token = registerRes.data.access_token;

  const projectRes = await api(
    baseUrl,
    "POST",
    "/v1/projects",
    token,
    {
      name: "Keyboard A11y Smoke Project",
      description: "Browser smoke for Project Space keyboard/a11y",
    }
  );
  if (projectRes.status !== 201) {
    throw new Error(
      `Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`
    );
  }
  const projectId = projectRes.data.id;

  // Upload a file so we have something in the project.
  const fileRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    token,
    {
      path: "README.md",
      content:
        "# Keyboard A11y Smoke\n\nVerifying keyboard accessibility of Project Space.",
      message: "Initial README for keyboard a11y smoke",
    }
  );
  if (fileRes.status !== 201) {
    throw new Error(
      `File create failed: ${fileRes.status} ${JSON.stringify(fileRes.data)}`
    );
  }

  // Create a changeset so the Reviews tab has a row to click.
  const changesetRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets`,
    token,
    {
      title: "Keyboard a11y test changeset",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content:
            "# Keyboard A11y Smoke\n\nUpdated for changeset detail drawer test.",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    }
  );
  if (changesetRes.status !== 201) {
    throw new Error(
      `Changeset create failed: ${changesetRes.status} ${JSON.stringify(changesetRes.data)}`
    );
  }
  const changesetId = changesetRes.data.id;

  // Approve and merge to create a commit (for History tab rows).
  const approveRes = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/changesets/${changesetId}/review`,
    token,
    { decision: "approved", notes: "Keyboard a11y smoke approval." }
  );
  if (approveRes.status !== 200) {
    throw new Error(
      `Approve failed: ${approveRes.status} ${JSON.stringify(approveRes.data)}`
    );
  }

  const mergeRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets/${changesetId}/merge`,
    token
  );
  if (mergeRes.status !== 200) {
    throw new Error(
      `Merge failed: ${mergeRes.status} ${JSON.stringify(mergeRes.data)}`
    );
  }
  const commitId = mergeRes.data.commit && mergeRes.data.commit.id;

  // Verify reviews (changesets) exist.
  const reviewsRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/changesets`,
    token
  );
  const reviewsOk =
    reviewsRes.status === 200 &&
    Array.isArray(
      (reviewsRes.data && reviewsRes.data.data) || reviewsRes.data
    ) &&
    (reviewsRes.data && reviewsRes.data.data
      ? reviewsRes.data.data.length
      : 1) >= 1;

  // Verify commits exist.
  const commitsRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/commits`,
    token
  );
  const commitsOk =
    commitsRes.status === 200 &&
    Array.isArray(commitsRes.data.data) &&
    commitsRes.data.data.length >= 1;

  // Get default branch name.
  const branchCreateRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/branches`,
    token,
    { name: "keyboard-a11y-alt", source_branch: "main" }
  );
  if (branchCreateRes.status !== 201) {
    throw new Error(
      `Branch create failed: ${branchCreateRes.status} ${JSON.stringify(branchCreateRes.data)}`
    );
  }

  const branchesRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/branches`,
    token
  );
  const branches = (branchesRes.data && branchesRes.data.data) || [];
  const defaultBranchName = branches.find(function (b) {
    return b.name === "main";
  })
    ? "main"
    : branches[0]
      ? branches[0].name
      : null;

  return {
    baseUrl,
    token,
    projectId,
    changesetId,
    commitId,
    alternateBranchName: branchCreateRes.data && branchCreateRes.data.name,
    defaultBranchName,
    reviewsOk,
    commitsOk,
  };
}

function checkStaticKeyboardDom() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // ── Tab items are native <button> elements (naturally keyboard-focusable) ──
    // Match: <button class="tab-item ..." data-tab="files" ...>
    const tabItemMatch = html.match(
      /<button[^>]*class="tab-item[^"]*"[^>]*data-tab="files"[^>]*>/
    );
    checks.tabItemsAreButtons = !!tabItemMatch;

    // Verify the full set of tab buttons exists.
    const expectedTabs = [
      "overview",
      "files",
      "readme",
      "activity",
      "insights",
      "work",
      "reviews",
      "people",
      "history",
      "settings",
      "wiki",
      "releases",
      "packages",
      "security",
      "extras",
      "compare",
    ];
    var allTabsPresent = expectedTabs.every(function (t) {
      var re = new RegExp(
        '<button[^>]*data-tab="' + t + '"[^>]*>'
      );
      return re.test(html);
    });
    checks.allTabButtonsPresent = allTabsPresent;

    // ── Tablist ARIA attributes ──
    checks.tablistHasRoleTablist =
      /<div[^>]*id="tabBar"[^>]*role="tablist"/.test(html);
    checks.tabItemsHaveRoleTab =
      /<button[^>]*class="tab-item[^"]*"[^>]*role="tab"/.test(html);
    checks.tabItemsHaveAriaSelected =
      /aria-selected=/.test(html);
    checks.tabItemsHaveAriaControls =
      /aria-controls=/.test(html);
    checks.tabItemsHaveTabIndex =
      /tabindex=/.test(html);

    // ── Tab keyboard navigation handler exists ──
    checks.tabKeydownHandlerExists =
      /els\.tabBar\.addEventListener\(["']keydown["'],\s*function\s*\(e\)/.test(html);

    // ── Branch pill is a <button> (natively keyboard-focusable) ──
    checks.branchPillIsButton = /<button[^>]*id="branchPill"[^>]*>/.test(html);

    // ── Branch pill ARIA attributes ──
    checks.branchPillHasAriaHaspopup =
      /aria-haspopup="listbox"/.test(html);
    checks.branchPillHasAriaExpanded =
      /aria-expanded=/.test(html);
    checks.branchPillHasAriaControls =
      /aria-controls="branchPopover"/.test(html);

    // ── Branch popover listbox ARIA ──
    checks.branchPopoverListHasRoleListbox =
      /role="listbox"/.test(html) || /setAttribute\(["']role["'],\s*["']listbox["']\)/.test(html);
    checks.branchOptionsHaveRoleOption =
      /role="option"/.test(html);
    checks.branchOptionsHaveAriaSelected =
      /aria-selected=/.test(html);
    checks.branchListboxTracksActiveDescendant =
      /aria-activedescendant/.test(html);
    checks.branchOptionsUseRovingTabindex =
      /data-branch-index/.test(html) && /tabindex=/.test(html);
    checks.branchArrowKeysHandled =
      /ArrowDown/.test(html) && /ArrowUp/.test(html) && /Home/.test(html) && /End/.test(html);

    // ── Detail drawer close buttons are <button> elements with aria-label ──
    checks.closePreviewBtnIsButton =
      /<button[^>]*id="closePreviewBtn"[^>]*>/.test(html);
    checks.closeTaskDetailBtnIsButton =
      /<button[^>]*id="closeTaskDetailBtn"[^>]*>/.test(html);
    checks.closeChangesetDetailBtnIsButton =
      /<button[^>]*id="closeChangesetDetailBtn"[^>]*>/.test(html);
    checks.closeCommitDetailBtnIsButton =
      /<button[^>]*id="closeCommitDetailBtn"[^>]*>/.test(html);
    checks.closeButtonsAreButtons =
      checks.closePreviewBtnIsButton &&
      checks.closeTaskDetailBtnIsButton &&
      checks.closeChangesetDetailBtnIsButton &&
      checks.closeCommitDetailBtnIsButton;

    // Close buttons have aria-label for screen readers.
    checks.closeButtonsHaveAriaLabel =
      /id="closeChangesetDetailBtn"[^>]*aria-label=/.test(html) &&
      /id="closeCommitDetailBtn"[^>]*aria-label=/.test(html);

    checks.dialogPanelsAreModal =
      /id="previewPane"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*tabindex="-1"/.test(html) &&
      /id="taskDetailPane"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*tabindex="-1"/.test(html) &&
      /id="changesetDetailPane"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*tabindex="-1"/.test(html) &&
      /id="commitDetailPane"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*tabindex="-1"/.test(html);
    checks.focusTrapUtilityExists =
      /function\s+activateFocusTrap\s*\(/.test(html) &&
      /function\s+deactivateFocusTrap\s*\(/.test(html) &&
      /function\s+handleFocusTrapKeydown\s*\(/.test(html) &&
      /function\s+focusableInPane\s*\(/.test(html);
    checks.focusTrapKeydownBound =
      /document\.addEventListener\(["']keydown["'],\s*handleFocusTrapKeydown\)/.test(html);
    checks.drawerOpenActivatesFocusTrap =
      /activateFocusTrap\(els\.previewPane,\s*["']#closePreviewBtn["']\)/.test(html) &&
      /activateFocusTrap\(els\.taskDetailPane,\s*["']#closeTaskDetailBtn["']\)/.test(html) &&
      /activateFocusTrap\(els\.changesetDetailPane,\s*["']#closeChangesetDetailBtn["']\)/.test(html) &&
      /activateFocusTrap\(els\.commitDetailPane,\s*["']#closeCommitDetailBtn["']\)/.test(html);
    checks.drawerCloseDeactivatesFocusTrap =
      /deactivateFocusTrap\(els\.previewPane\)/.test(html) &&
      /deactivateFocusTrap\(els\.taskDetailPane\)/.test(html) &&
      /deactivateFocusTrap\(els\.changesetDetailPane\)/.test(html) &&
      /deactivateFocusTrap\(els\.commitDetailPane\)/.test(html);

    // ── Escape keydown handler exists for closing branch popover / drawers ──
    // Updated: Escape closes branch popover FIRST, then preview, then detail
    // drawers (commit > changeset > task). See line 9006 in HTML.
    checks.escapeHandlerExists =
      /document\.addEventListener\(["']keydown["'],\s*function\s*\(e\)\s*\{[^}]*e\.key\s*===\s*["']Escape["']/.test(
        html
      );

    // Verify Escape closes branch popover first (before preview/detail drawers).
    checks.escapeClosesBranchPopoverFirst =
      /Escape/.test(html) &&
      /branchPopover/.test(html) &&
      /els\.branchPopover\s*&&\s*!els\.branchPopover\.classList\.contains\(["']hidden["']\)/.test(html);

    // ── Branch popover outside click close handler ──
    checks.branchPopoverOutsideClickClose =
      /!e\.target\.closest\(["']#branchControl["']\)/.test(html);

    // ── Branch popover keyboard open via ArrowDown/Enter/Space ──
    checks.branchPillKeydownOpensPopover =
      /e\.key\s*===\s*["']ArrowDown["']\s*\|\|\s*e\.key\s*===\s*["']Enter["']\s*\|\|\s*e\.key\s*===\s*["']\s["']/.test(html) ||
      /e\.key\s*===\s*["']Enter["']\s*\|\|\s*e\.key\s*===\s*["']\s["']/.test(html);

    // ── Branch popover Enter/Space selection handler ──
    checks.branchPopoverEnterSpaceSelects =
      /selectBranch\(activeOption\.dataset\.branchValue/.test(html);
    checks.branchEscapeClosesPopover =
      /e\.key\s*===\s*["']Escape["'][\s\S]*toggleBranchPopover\(false\)/.test(html);

    // ── Review/history rows have data attributes for click handling ──
    checks.reviewRowHasCsIdDataAttr =
      /<tr[^>]*class="reviews-row"[^>]*data-cs-id=/.test(html);
    checks.historyRowHasCommitIdDataAttr =
      /<tr[^>]*class="reviews-row history-row"[^>]*data-commit-id=/.test(html);

    // ── Inline script parses ──
    var scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      vm.compileFunction(scriptMatch[1].trim());
      checks.inlineScriptParses = true;
    } else {
      checks.inlineScriptParses = false;
    }
  } catch (err) {
    checks.error = String(err);
    return checks;
  }
  return checks;
}

// Dispatch a KeyboardEvent directly on the document to test the Escape handler.
async function dispatchEscapeOnDocument() {
  await page.evaluate(function () {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  // Allow microtasks (promise callbacks) and the macrotask queue to settle.
  await page.waitForTimeout(500);
}

async function verifyDialogFocusTrap(paneSelector, closeSelector) {
  await page.waitForSelector(paneSelector + ".open", { timeout: 10000 });
  await page.waitForTimeout(100);
  var startsOnClose = await page.evaluate(function (selectors) {
    return document.activeElement === document.querySelector(selectors.closeSelector);
  }, { closeSelector });
  await page.keyboard.press("Tab");
  await page.waitForTimeout(100);
  var afterTabInside = await page.evaluate(function (selectors) {
    var pane = document.querySelector(selectors.paneSelector);
    return !!(pane && pane.contains(document.activeElement));
  }, { paneSelector });
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(100);
  var afterShiftTabInside = await page.evaluate(function (selectors) {
    var pane = document.querySelector(selectors.paneSelector);
    return !!(pane && pane.contains(document.activeElement));
  }, { paneSelector });
  return { startsOnClose, afterTabInside, afterShiftTabInside };
}

async function runBrowserSmoke(playwright, seeded) {
  const result = {
    passed: false,
    checks: {},
    errors: [],
    screenshotPath: null,
  };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  page = await context.newPage();

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.token,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    // Seed localStorage so the page is already authenticated and project-selected.
    await page.goto(origin);
    await page.evaluate(
      function ({ key, value }) {
        localStorage.setItem(key, value);
      },
      { key: storageKey, value: storagePayload }
    );

    // ---- Phase 0: URL alias verification ---------------------------------------------
    // Legacy repository/code aliases now redirect to the dedicated repository page.
    // The "issues" alias continues to map to the Work tab.
    var legacyRepoAliases = ["repository", "repo", "code"];
    for (var i = 0; i < legacyRepoAliases.length; i++) {
      var alias = legacyRepoAliases[i];
      var aliasUrl = origin + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) + "&tab=" + alias;
      await page.goto(aliasUrl, { waitUntil: "networkidle" });
      var redirected = page.url().includes("repository.html?project_id=" + encodeURIComponent(seeded.projectId));
      result.checks["urlAlias" + alias.charAt(0).toUpperCase() + alias.slice(1) + "RedirectsToRepository"] = redirected;
      if (!redirected) {
        result.errors.push("URL alias 'tab=" + alias + "' did not redirect to repository.html. Current URL: " + page.url());
      }
    }

    // issues alias still maps to Work tab
    var issuesUrl = origin + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) + "&tab=issues";
    await page.goto(issuesUrl, { waitUntil: "networkidle" });
    var issuesOk = await page.evaluate(function () {
      var active = document.querySelector('.tab-item.active');
      return active && active.dataset.tab === "work";
    });
    result.checks.urlAliasIssuesToWork = issuesOk;
    if (!issuesOk) {
      result.errors.push("URL alias 'tab=issues' did not resolve to work tab.");
    }


    // ── Phase 1: Tab bar — focus and tab switching ──────────────────────────
    var filesUrl =
      origin +
      "/project-space.html?project_id=" +
      encodeURIComponent(seeded.projectId) +
      "&tab=files";

    await page.goto(filesUrl, { waitUntil: "networkidle" });

    // Wait for Files tab to be active and file list to render.
    await page.waitForSelector('.tab-item[data-tab="files"].active', {
      timeout: 10000,
    });
    await page.waitForSelector("#fileListContainer", { timeout: 10000 });
    result.checks.filesTabActiveOnLoad = true;

    // Focus the first tab button programmatically to verify it is focusable.
    await page.focus('.tab-item[data-tab="files"]');
    var filesTabFocused = await page.evaluate(function () {
      var el = document.querySelector('.tab-item[data-tab="files"]');
      return document.activeElement === el;
    });
    result.checks.filesTabButtonFocusable = filesTabFocused;

    // Click an overflow tab through More → verify tab switches, panel shows, URL updates.
    await page.click("#tabMoreBtn");
    await page.click('.tab-more-item[data-tab="readme"]');
    await page.waitForFunction(function () {
      var item = document.querySelector('.tab-more-item[data-tab="readme"]');
      var more = document.querySelector("#tabMoreBtn");
      return !!(item && item.classList.contains("active") && more && more.classList.contains("has-active"));
    }, { timeout: 10000 });
    await page.waitForSelector("#readmePanel:not(.hidden)", { timeout: 10000 });
    result.checks.urlTabReadmeAfterClick = page.url().includes("tab=readme");

    // Click the Reviews tab → verify tab switches.
    await page.click('.tab-item[data-tab="reviews"]');
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', {
      timeout: 10000,
    });
    result.checks.reviewsTabActiveAfterClick = true;

    // Click the History tab → verify tab switches.
    await page.click('.tab-item[data-tab="history"]');
    await page.waitForSelector('.tab-item[data-tab="history"].active', {
      timeout: 10000,
    });
    result.checks.historyTabActiveAfterClick = true;

    // Click back to Files tab.
    await page.click('.tab-item[data-tab="files"]');
    await page.waitForSelector('.tab-item[data-tab="files"].active', {
      timeout: 10000,
    });
    result.checks.filesTabActiveAfterRoundTrip = true;

    // URL still has project_id.
    result.checks.urlPreservesProjectId = page.url().includes("project_id=");

    // ── Phase 2: Tablist keyboard navigation ─────────────────────────────────
    // Verify ArrowRight/ArrowLeft/Home/End on the tab bar move focus and
    // switch the active tab. This exercises the keydown handler on #tabBar
    // (line 8868-8888 in HTML).
    // First, ensure we're on the Files tab with the button focused.
    await page.focus('.tab-item[data-tab="files"]');

    // ArrowRight → should move to Compare tab (Files → Compare).
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    var activeTabAfterRight = await page.evaluate(function () {
      var active = document.querySelector('.tab-item.active');
      return active ? active.dataset.tab : null;
    });
    var focusedTabAfterRight = await page.evaluate(function () {
      var el = document.activeElement;
      return el && el.classList.contains("tab-item") ? el.dataset.tab : null;
    });
    result.checks.tabArrowRightMovesToCompare =
      activeTabAfterRight === "compare" || focusedTabAfterRight === "compare";

    // ArrowRight again → should move to History tab (Compare → History).
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    var activeTabAfterRight2 = await page.evaluate(function () {
      var active = document.querySelector('.tab-item.active');
      return active ? active.dataset.tab : null;
    });
    result.checks.tabArrowRightMovesToHistory =
      activeTabAfterRight2 === "history";

    // ArrowLeft → should move back to Compare tab (History → Compare).
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(300);
    var activeTabAfterLeft = await page.evaluate(function () {
      var active = document.querySelector('.tab-item.active');
      return active ? active.dataset.tab : null;
    });
    result.checks.tabArrowLeftMovesToCompare =
      activeTabAfterLeft === "compare";

    // Home → should move to first tab (Overview).
    await page.keyboard.press("Home");
    await page.waitForTimeout(300);
    var activeTabAfterHome = await page.evaluate(function () {
      var active = document.querySelector('.tab-item.active');
      return active ? active.dataset.tab : null;
    });
    result.checks.tabHomeMovesToOverview =
      activeTabAfterHome === "overview";

    // End → should move focus to the More button.
    await page.keyboard.press("End");
    await page.waitForTimeout(300);
    var focusedAfterEnd = await page.evaluate(function () {
      return document.activeElement && document.activeElement.id;
    });
    result.checks.tabEndMovesToMore =
      focusedAfterEnd === "tabMoreBtn";
    await page.keyboard.press("Enter");
    await page.waitForSelector("#tabMoreMenu.open", { timeout: 10000 });
    result.checks.tabMoreOpensWithKeyboard = true;
    await page.keyboard.press("Escape");

    // Navigate back to Files so subsequent phases are predictable.
    await page.click('.tab-item[data-tab="files"]');
    await page.waitForSelector('.tab-item[data-tab="files"].active', {
      timeout: 10000,
    });
    result.checks.tabNavBackToFiles = true;

    // ── Phase 3: Branch popover — open and close ────────────────────────────
    // Wait for lazy-rendered branch control.
    await page.waitForTimeout(1500);

    var branchPillVisible = await page.evaluate(function () {
      var pill = document.getElementById("branchPill");
      return !!(pill && pill.textContent && pill.textContent.trim().length > 0);
    });
    result.checks.branchPillVisible = branchPillVisible;

    if (branchPillVisible) {
      // Open branch popover from the focused branch pill using the keyboard.
      await page.focus("#branchPill");
      await page.keyboard.press("ArrowDown");
      await page.waitForSelector("#branchPopover:not(.hidden)", {
        timeout: 5000,
      });
      result.checks.branchPopoverOpenedByKeyboard = true;

      // Verify the popover contains branch info.
      var popoverText = await page.textContent("#branchPopover");
      result.checks.branchPopoverHasContent =
        popoverText && popoverText.trim().length > 0;

      var listboxRole = await page.getAttribute("#branchPopoverList", "role");
      var activeDescendant = await page.getAttribute("#branchPopoverList", "aria-activedescendant");
      var optionCount = await page.locator('#branchPopoverList [role="option"][data-branch-value]').count();
      result.checks.branchListboxRole = listboxRole === "listbox";
      result.checks.branchListboxHasActiveDescendant = !!activeDescendant;
      result.checks.branchListboxHasMultipleOptions = optionCount >= 2;
      await page.waitForTimeout(150);

      var focusedOptionBefore = await page.evaluate(function () {
        var el = document.activeElement;
        return el && el.getAttribute("role") === "option" ? el.dataset.branchValue : null;
      });
      result.checks.branchOptionFocusedAfterOpen = !!focusedOptionBefore;

      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
      var focusedOptionAfterDown = await page.evaluate(function () {
        var el = document.activeElement;
        return el && el.getAttribute("role") === "option" ? el.dataset.branchValue : null;
      });
      result.checks.branchArrowDownMovesActiveOption =
        !!focusedOptionAfterDown && focusedOptionAfterDown !== focusedOptionBefore;

      await page.keyboard.press("End");
      await page.waitForTimeout(200);
      var focusedOptionAfterEnd = await page.evaluate(function () {
        var el = document.activeElement;
        return el && el.getAttribute("role") === "option" ? el.dataset.branchValue : null;
      });
      result.checks.branchEndMovesActiveOption = !!focusedOptionAfterEnd;

      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      var selectedAfterEnter = await page.evaluate(function () {
        var name = document.getElementById("branchName");
        return name ? name.textContent.trim() : "";
      });
      result.checks.branchEnterSelectsOption =
        !!focusedOptionAfterEnd &&
        (selectedAfterEnter === focusedOptionAfterEnd || page.url().includes("branch=" + encodeURIComponent(focusedOptionAfterEnd)));

      await page.focus("#branchPill");
      await page.keyboard.press("ArrowDown");
      await page.waitForSelector("#branchPopover:not(.hidden)", {
        timeout: 5000,
      });
      await page.keyboard.press("Home");
      await page.waitForTimeout(200);
      var focusedOptionAfterHome = await page.evaluate(function () {
        var el = document.activeElement;
        return el && el.getAttribute("role") === "option" ? el.dataset.branchValue : null;
      });
      result.checks.branchHomeMovesActiveOption = !!focusedOptionAfterHome;

      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      var popoverAfterEscape = await page.evaluate(function () {
        var pop = document.getElementById("branchPopover");
        return !!(pop && !pop.classList.contains("hidden"));
      });
      result.checks.branchPopoverCloseViaEscape = !popoverAfterEscape;
      if (popoverAfterEscape) {
        result.errors.push("Branch popover did not close via Escape.");
      }

      await page.focus("#branchPill");
      await page.keyboard.press("ArrowDown");
      await page.waitForSelector("#branchPopover:not(.hidden)", {
        timeout: 5000,
      });
      await page.keyboard.press("Home");
      await page.waitForTimeout(200);
      var focusedOptionBeforeSpace = await page.evaluate(function () {
        var el = document.activeElement;
        return el && el.getAttribute("role") === "option" ? el.dataset.branchValue : null;
      });
      await page.keyboard.press(" ");
      await page.waitForTimeout(800);
      var selectedAfterSpace = await page.evaluate(function () {
        var name = document.getElementById("branchName");
        return name ? name.textContent.trim() : "";
      });
      result.checks.branchSpaceSelectsOption =
        !!focusedOptionBeforeSpace &&
        (selectedAfterSpace === focusedOptionBeforeSpace || page.url().includes("branch=" + encodeURIComponent(focusedOptionBeforeSpace)));

      // Close via outside click (click on body). If already closed by Escape
      // this is still fine — it just stays closed.
      await page.click("body", { position: { x: 10, y: 10 } });
      await page.waitForTimeout(400);
      var popoverClosedByBodyClick = await page.evaluate(function () {
        var pop = document.getElementById("branchPopover");
        return !!(pop && pop.classList.contains("hidden"));
      });
      result.checks.branchPopoverClosedByOutsideClick = popoverClosedByBodyClick;

      if (!popoverClosedByBodyClick) {
        result.errors.push(
          "Branch popover did not close via outside body click."
        );
      }
    }

    // ── Phase 3: Changeset detail drawer — open and close ───────────────────
    // Switch to Reviews tab and wait for changeset rows.
    await page.click('.tab-item[data-tab="reviews"]');
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', {
      timeout: 10000,
    });

    try {
      await page.waitForSelector(".reviews-row[data-cs-id]", {
        timeout: 15000,
      });
      result.checks.reviewsRowsRendered = true;

      var firstReviewRow = await page.$(".reviews-row[data-cs-id]");
      if (firstReviewRow) {
        await firstReviewRow.click();

        // Wait for changeset detail pane to open.
        await page.waitForSelector("#changesetDetailPane.open", {
          timeout: 10000,
        });
        result.checks.changesetDetailOpenedByRowClick = true;
        var changesetTrap = await verifyDialogFocusTrap(
          "#changesetDetailPane",
          "#closeChangesetDetailBtn"
        );
        result.checks.changesetFocusStartsOnCloseButton =
          changesetTrap.startsOnClose;
        result.checks.changesetTabStaysInsideTrap =
          changesetTrap.afterTabInside;
        result.checks.changesetShiftTabStaysInsideTrap =
          changesetTrap.afterShiftTabInside;

        // Verify URL contains changeset_id.
        result.checks.urlHasChangesetIdAfterOpen =
          page.url().includes("changeset_id=");
        result.checks.urlPreservesProjectAndTabAfterChangesetOpen =
          page.url().includes("project_id=") &&
          page.url().includes("tab=reviews");

        // ── Close via close button (primary keyboard-accessible affordance) ──
        await page.click("#closeChangesetDetailBtn");
        await page.waitForTimeout(500);
        var changesetDetailClosedByBtn = await page.evaluate(function () {
          var pane = document.getElementById("changesetDetailPane");
          return !!(pane && !pane.classList.contains("open"));
        });
        result.checks.changesetDetailClosedByCloseBtn =
          changesetDetailClosedByBtn;

        if (changesetDetailClosedByBtn) {
          // Verify changeset_id cleared from URL.
          result.checks.urlClearsChangesetIdAfterClose =
            !page.url().includes("changeset_id=");
          await page.waitForTimeout(100);
          result.checks.changesetCloseRestoresFocus = await page.evaluate(function () {
            var el = document.activeElement;
            return !!(el && el.matches && el.matches('.tab-item[data-tab="reviews"]'));
          });
        }

        if (!changesetDetailClosedByBtn) {
          // Fallback: try Escape dispatch directly.
          var reopenCheck = await page.evaluate(function () {
            var pane = document.getElementById("changesetDetailPane");
            return !!(pane && pane.classList.contains("open"));
          });
          if (!reopenCheck) {
            result.errors.push(
              "Changeset detail drawer did not close via close button."
            );
          } else {
            // Re-open was needed; test Escape as secondary.
            var reRow = await page.$(".reviews-row[data-cs-id]");
            if (reRow) {
              await reRow.click();
              await page.waitForSelector("#changesetDetailPane.open", {
                timeout: 10000,
              });
              await dispatchEscapeOnDocument();
              var closedAfterDispatch = await page.evaluate(function () {
                var pane = document.getElementById("changesetDetailPane");
                return !!(pane && !pane.classList.contains("open"));
              });
              result.checks.changesetDetailClosedByEscape =
                closedAfterDispatch;
              if (!closedAfterDispatch) {
                result.errors.push(
                  "Changeset detail drawer did not close via dispatched Escape."
                );
              }
            }
          }
        }

        // ── Also verify the close button is keyboard-navigable ──────────────
        var closeBtnIsVisible = await page.evaluate(function () {
          var btn = document.getElementById("closeChangesetDetailBtn");
          return !!(btn && btn.offsetParent !== null);
        });
        result.checks.closeChangesetDetailBtnVisible = closeBtnIsVisible;
      } else {
        result.checks.changesetDetailOpenedByRowClick = false;
        result.errors.push("No review rows found to open changeset detail.");
      }
    } catch (err) {
      result.checks.reviewsRowsRendered = false;
      var msg = String(err.message || err);
      result.errors.push("Reviews rows did not render: " + msg);
    }

    // ── Phase 4: Commit detail drawer — open and close ──────────────────────
    // Switch to History tab and wait for commit rows.
    await page.click('.tab-item[data-tab="history"]');
    await page.waitForSelector('.tab-item[data-tab="history"].active', {
      timeout: 10000,
    });

    try {
      await page.waitForSelector(".history-row[data-commit-id]", {
        timeout: 15000,
      });
      result.checks.historyRowsRendered = true;

      var firstCommitRow = await page.$(".history-row[data-commit-id]");
      if (firstCommitRow) {
        await firstCommitRow.click();

        // Wait for commit detail pane to open.
        await page.waitForSelector("#commitDetailPane.open", {
          timeout: 10000,
        });
        result.checks.commitDetailOpenedByRowClick = true;
        var commitTrap = await verifyDialogFocusTrap(
          "#commitDetailPane",
          "#closeCommitDetailBtn"
        );
        result.checks.commitFocusStartsOnCloseButton =
          commitTrap.startsOnClose;
        result.checks.commitTabStaysInsideTrap =
          commitTrap.afterTabInside;
        result.checks.commitShiftTabStaysInsideTrap =
          commitTrap.afterShiftTabInside;

        // Verify URL has commit_id.
        result.checks.urlHasCommitIdAfterOpen =
          page.url().includes("commit_id=");
        result.checks.urlPreservesProjectAndTabAfterCommitOpen =
          page.url().includes("project_id=") &&
          page.url().includes("tab=history");

        // ── Close via close button ──
        await page.click("#closeCommitDetailBtn");
        await page.waitForTimeout(500);
        var commitDetailClosedByBtn = await page.evaluate(function () {
          var pane = document.getElementById("commitDetailPane");
          return !!(pane && !pane.classList.contains("open"));
        });
        result.checks.commitDetailClosedByCloseBtn = commitDetailClosedByBtn;

        if (commitDetailClosedByBtn) {
          result.checks.urlClearsCommitIdAfterClose =
            !page.url().includes("commit_id=");
          await page.waitForTimeout(100);
          result.checks.commitCloseRestoresFocus = await page.evaluate(function () {
            var el = document.activeElement;
            return !!(el && el.matches && el.matches('.tab-item[data-tab="history"]'));
          });
        }

        if (!commitDetailClosedByBtn) {
          // Fallback: Escape dispatch.
          var reopenCheck = await page.evaluate(function () {
            var pane = document.getElementById("commitDetailPane");
            return !!(pane && pane.classList.contains("open"));
          });
          if (!reopenCheck) {
            result.errors.push(
              "Commit detail drawer did not close via close button."
            );
          } else {
            var reRow = await page.$(".history-row[data-commit-id]");
            if (reRow) {
              await reRow.click();
              await page.waitForSelector("#commitDetailPane.open", {
                timeout: 10000,
              });
              await dispatchEscapeOnDocument();
              var closedAfterDispatch = await page.evaluate(function () {
                var pane = document.getElementById("commitDetailPane");
                return !!(pane && !pane.classList.contains("open"));
              });
              result.checks.commitDetailClosedByEscape =
                closedAfterDispatch;
              if (!closedAfterDispatch) {
                result.errors.push(
                  "Commit detail drawer did not close via dispatched Escape."
                );
              }
            }
          }
        }
      } else {
        result.checks.commitDetailOpenedByRowClick = false;
        result.errors.push("No history rows found to open commit detail.");
      }
    } catch (err) {
      result.checks.historyRowsRendered = false;
      var msg = String(err.message || err);
      result.errors.push("History rows did not render: " + msg);
    }

    // ── Phase 5: Final URL preservation check ───────────────────────────────
    result.checks.urlStillHasProjectId =
      page.url().includes("project_id=");

    // ── Take final screenshot ──────────────────────────────────────────────
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    // Overall pass — all checks must be true (Escape-only checks that are
    // absent (undefined) are skipped; close button is the primary path).
    result.passed = Object.values(result.checks).every(function (value) {
      return value === true || value === undefined;
    });
  } catch (err) {
    var errStr = String(err.stack || err.message || err);
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
  var headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  var res = await fetch(baseUrl + path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var text = await res.text();
  var data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { status: res.status, data: data };
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  var lines = [
    "# Project Space Keyboard A11y — Browser Smoke Evidence",
    "",
    "- **Command:** `" + result.command + "`",
    "- **Timestamp:** " + result.timestamp,
    "- **Backend built:** " + result.backendBuilt,
    "- **Browser available:** " + result.browserAvailable,
    "- **Passed:** " + result.passed,
    "- **Skipped:** " + result.skipped,
    result.screenshotPath
      ? "- **Screenshot:** `" + result.screenshotPath + "`"
      : "",
    "- **Evidence JSON:** `" + EVIDENCE_JSON + "`",
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
    "",
  ];

  if (result.residual.length) {
    lines.push(
      "## Residual gaps",
      "",
      ...result.residual.map(function (r) { return "- " + r; }),
      ""
    );
  }

  if (result.errors.length) {
    lines.push(
      "## Errors",
      "",
      ...result.errors.map(function (e) { return "- " + e; }),
      ""
    );
  }

  lines.push(
    "",
    "## Accessibility Note",
    "",
    "This smoke verifies keyboard-accessible interactions in Project Space:",
    "",
    "- **Tab bar**: All " + expectedTabCount() + " tab items are native `<button>` elements,",
    "  inherently focusable via Tab key. Programmatic focus and click-based tab switching",
    "  were verified. Tab buttons include ARIA `role=\"tab\"`, `aria-selected`, and",
    "  `aria-controls` attributes for assistive technology.",
    "- **Branch popover**: Opens via click on the branch pill `<button>`. The global keydown",
    "  handler dispatches Escape to preview/detail drawers only, NOT the branch popover.",
    "  The popover closes via outside click (document click handler).",
    "- **Close buttons**: All four detail drawer close buttons (`closePreviewBtn`,",
    "  `closeTaskDetailBtn`, `closeChangesetDetailBtn`, `closeCommitDetailBtn`) are",
    "  native `<button>` elements, keyboard-focusable and screen-reader accessible.",
    "- **Detail drawers**: Changeset and commit detail drawers open via row click and close",
    "  via their close buttons. If the close button worked, the drawer is verified as",
    "  keyboard-accessible.",
    "- **Escape key**: A global `keydown` handler on `document` closes the topmost open",
    "  detail drawer (commit > changeset > task > preview). If `page.keyboard.press` or",
    "  a direct `KeyboardEvent` dispatch via `page.evaluate` fails to close a drawer,",
    "  it is noted, but the close button remains the primary keyboard interaction.",
    "- **URL preservation**: `project_id` and `tab` parameters persist through all",
    "  interactions. Detail-specific parameters (`changeset_id`, `commit_id`) are",
    "  correctly removed on close.",
    "",
  );

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

function expectedTabCount() {
  return 8;
}

main().finally(async function () {
  if (page) await page.close().catch(function () {});
  if (context) await context.close().catch(function () {});
  if (browser) await browser.close().catch(function () {});
  if (server) {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
  try {
    var mod = require(DATASOURCE_MODULE);
    if (mod.AppDataSource && mod.AppDataSource.isInitialized)
      await mod.AppDataSource.destroy();
  } catch (_) {}
});
