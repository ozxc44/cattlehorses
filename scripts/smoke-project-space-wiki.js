#!/usr/bin/env node
// Project Space Wiki Tab — browser/runtime smoke harness.
//
// Verifies the real Project Space Wiki implementation: backend API, browser UI,
// role gating, Extras integration, and safe markdown rendering.
//
// Usage:
//   node scripts/smoke-project-space-wiki.js
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-wiki-smoke");
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
    command: "node scripts/smoke-project-space-wiki.js",
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

    // ── 1. Backend data setup (always runs) ─────────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.adminToken,
      projectCreated: !!seeded.projectId,
    };

    // ── 2. Backend Wiki API probe ───────────────────────────────────────────
    const apiChecks = await probeBackendWikiApi(seeded);
    result.checks.backendWikiApi = apiChecks;

    // ── 3. Static JS wiring check (always runs) ─────────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      // Without browser checks, pass only if backend API and static wiring both
      // indicate Wiki is fully wired.  This will fail until Wiki lands, which
      // is correct — the suite will report it as a required failure.
      result.passed =
        apiChecks.wikiApiCreateOk &&
        apiChecks.wikiApiReadOk &&
        apiChecks.wikiApiUpdateOk &&
        staticOk.wikiTabMarkup &&
        staticOk.wikiPanelMarkup &&
        staticOk.wikiAllowlisted &&
        staticOk.wikiRenderFunction &&
        !staticOk.error;
      result.residual.push(
        "Real-browser rendering not exercised because Playwright is unavailable."
      );
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 4. Real browser smoke ───────────────────────────────────────────────
    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = browserResult.passed;
    if (!browserResult.passed) {
      result.errors.push(...browserResult.errors);
    }

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
  process.env.JWT_SECRET = "project-space-wiki-smoke-secret";
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

  const adminEmail = `wiki-admin-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: adminEmail,
    password,
    display_name: "Wiki Smoke Admin",
  });
  if (registerRes.status !== 201) {
    throw new Error(`Register admin failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`);
  }
  const adminToken = registerRes.data.access_token;

  // Register additional roles: member (collaborator), viewer (read-only).
  const memberEmail = `wiki-member-${Date.now()}@example.invalid`;
  const viewerEmail = `wiki-viewer-${Date.now()}@example.invalid`;

  const memberRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: memberEmail,
    password,
    display_name: "Wiki Smoke Member",
  });
  const viewerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: viewerEmail,
    password,
    display_name: "Wiki Smoke Viewer",
  });

  const memberToken = memberRes.status === 201 ? memberRes.data.access_token : null;
  const viewerToken = viewerRes.status === 201 ? viewerRes.data.access_token : null;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", adminToken, {
    name: "Wiki Smoke Project",
    description: "Browser smoke for Project Space Wiki tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  // Seed a README so the project has at least one file.
  await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    adminToken,
    {
      path: "README.md",
      content: "# Wiki Smoke\n\nProject used to verify the Wiki tab.",
      message: "Initial README for wiki smoke",
    }
  );

  return {
    baseUrl,
    adminToken,
    memberToken,
    viewerToken,
    projectId,
  };
}

async function probeBackendWikiApi(seeded) {
  const checks = {};
  const { baseUrl, adminToken, projectId } = seeded;

  // Create a wiki page.
  const createRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/wiki`,
    adminToken,
    { title: "Home", content: "# Welcome\n\nThis is the wiki home page." }
  );
  const createOk = createRes.status === 201;
  checks.wikiApiCreate = {
    status: createRes.status,
    ok: createOk,
    pageId: createOk ? (createRes.data.id || null) : null,
  };

  const xssRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/wiki`,
    adminToken,
    {
      title: "Unsafe HTML",
      slug: "unsafe-html",
      content: "# Unsafe\n\n<script>window.__wikiXss = true</script>\n\n<img src=x onerror=\"window.__wikiImgXss = true\">",
    }
  );
  checks.wikiApiUnsafeContentSeeded = {
    status: xssRes.status,
    ok: xssRes.status === 201,
  };

  // Read wiki pages list.
  const listRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/wiki`,
    adminToken
  );
  checks.wikiApiList = {
    status: listRes.status,
    ok: listRes.status === 200,
    pageCount: (listRes.data && listRes.data.data && listRes.data.data.length) || 0,
  };

  // Read a single wiki page (if create succeeded).
  const pageSlug = createOk ? (createRes.data.slug || null) : null;
  if (pageSlug) {
    const readRes = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/wiki/${encodeURIComponent(pageSlug)}`,
      adminToken
    );
    checks.wikiApiRead = {
      status: readRes.status,
      ok: readRes.status === 200,
      slug: readRes.data && readRes.data.slug,
    };

    // Update the wiki page.
    const updateRes = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/wiki/${encodeURIComponent(pageSlug)}`,
      adminToken,
      { title: "Home (updated)", content: "# Updated\n\nUpdated content." }
    );
    checks.wikiApiUpdate = {
      status: updateRes.status,
      ok: updateRes.status === 200,
    };
  } else {
    checks.wikiApiRead = { status: null, ok: false, required: "wiki page slug needed" };
    checks.wikiApiUpdate = { status: null, ok: false, required: "wiki page slug needed" };
  }

  // Check permission gating: member and viewer should not be able to create
  // wiki pages (if API exists).  If the API returns 404 the API is absent, so
  // these checks are advisory.
  if (seeded.memberToken) {
    const memberCreateRes = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/wiki`,
      seeded.memberToken,
      { title: "Member page", content: "Should not be allowed." }
    );
    checks.wikiApiMemberCreateGated = {
      status: memberCreateRes.status,
      ok: memberCreateRes.status === 403 || memberCreateRes.status === 401,
    };
  }

  if (seeded.viewerToken) {
    const viewerCreateRes = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/wiki`,
      seeded.viewerToken,
      { title: "Viewer page", content: "Should not be allowed." }
    );
    checks.wikiApiViewerCreateGated = {
      status: viewerCreateRes.status,
      ok: viewerCreateRes.status === 403 || viewerCreateRes.status === 401,
    };
  }

  return checks;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Wiki tab button in the tab bar.
    checks.wikiTabMarkup =
      html.includes('data-tab="wiki"') &&
      html.includes('id="tab-wiki"') &&
      html.includes(">Wiki</button>");

    // Wiki panel container.
    checks.wikiPanelMarkup =
      html.includes('id="wikiPanel"') &&
      html.includes('aria-labelledby="tab-wiki"');

    // Wiki page list / detail containers.
    checks.wikiPageListMarkup =
      html.includes("wiki-page-list") ||
      html.includes("wikiList");

    checks.wikiPageDetailMarkup =
      html.includes("wiki-page-content") ||
      html.includes("wikiContent");

    // Wiki tab in the allowlist.
    const allowlistMatch = html.match(/TAB_ALLOWLIST\s*=\s*\[([^\]]*)\]/);
    checks.wikiAllowlisted = !!(
      allowlistMatch && allowlistMatch[1].includes('"wiki"')
    );

    // Wiki render function exists.
    checks.wikiRenderFunction =
      html.includes("function renderWiki()") ||
      html.includes("function renderWikiList()");

    // Permissions wiring: create/edit controls gated on role.
    checks.wikiRoleGate =
      html.includes("admin") && html.includes("wiki");

    // Check Extras tab lists Wiki as implemented (not deferred).
    // Once Wiki is implemented, the Extras list should move Wiki from
    // deferred to implemented.  This ensures integration consistency.
    const extrasImplementedSection = html.match(
      /已实现的模块[\s\S]*?<\/div>\s*<\/div>/i
    );
    const extrasDeferredSection = html.match(
      /后续规划[\s\S]*?<\/div>\s*<\/div>/i
    );

    if (extrasImplementedSection) {
      checks.wikiExtrasImplemented =
        extrasImplementedSection[0].includes('"Wiki"') ||
        extrasImplementedSection[0].includes('data-tab-link="wiki"');
    } else {
      checks.wikiExtrasImplemented = false;
    }

    if (extrasDeferredSection) {
      checks.wikiExtrasNotDeferred =
        !extrasDeferredSection[0].includes("Wiki");
    } else {
      checks.wikiExtrasNotDeferred = false;
    }

    // No fake/placeholder wiki controls in the main UI (outside Extras).
    const bodyWithoutExtras = html.replace(/extrasPanel[\s\S]*?<\/section>/, "");
    checks.wikiNoFakeControls =
      !/create wiki|new wiki|wiki editor/i.test(bodyWithoutExtras);

    // Inline script parses.
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
      jwt: seeded.adminToken,
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

    // Phase 1: Deep-link into Wiki tab — expect failure if tab doesn't exist.
    const wikiUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
      seeded.projectId
    )}&tab=wiki`;
    await page.goto(wikiUrl, { waitUntil: "networkidle" });

    var wikiExists = false;
    // Check primary tabs first, then overflow indicator
    var primaryWiki = await page.$('.tab-item[data-tab="wiki"]');
    if (primaryWiki) {
      wikiExists = !!(await page.$('.tab-item[data-tab="wiki"].active'));
    } else {
      wikiExists = await page.evaluate(function () {
        var btn = document.querySelector("#tabMoreBtn");
        return !!(btn && btn.classList.contains("has-active")) &&
          (window.location.search.indexOf("tab=wiki") !== -1);
      });
    }
    result.checks.wikiTabActive = wikiExists;

    if (wikiExists) {
      // Wiki tab is present — verify its panel renders.
      const wikiPanel = await page.$("#wikiPanel:not(.hidden)");
      result.checks.wikiPanelVisible = !!wikiPanel;

      // Page list renders.
      const pageList = await page.$("#wikiPageList, .wiki-page-list, .wiki-list");
      result.checks.wikiPageListRendered = !!pageList;

      if (pageList) {
        const listItems = await page.$$("#wikiPageList [data-page-id], .wiki-page-list .wiki-page-item, .wiki-list .wiki-page");
        result.checks.wikiPageListHasItems = listItems.length > 0;

        // Click first page to view detail.
        if (listItems.length > 0) {
          await listItems[0].click();
          await page.waitForTimeout(1000);
          const content = await page.$("#wikiContent, .wiki-page-content, #wikiPageContent");
          result.checks.wikiPageDetailRendered = !!content;
          const contentText = content ? await content.textContent() : "";
          result.checks.wikiPageContentVisible = !!(contentText && contentText.length > 0);
        }
      }

      const unsafeUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=wiki&wiki_slug=unsafe-html`;
      await page.goto(unsafeUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("#wikiPageContent, .wiki-page-content, #wikiContent", { timeout: 10000 });
      await page.waitForTimeout(250);
      result.checks.wikiUnsafeScriptNotExecuted = await page.evaluate(function () {
        return window.__wikiXss !== true && window.__wikiImgXss !== true;
      });
      result.checks.wikiUnsafeHtmlEscaped = await page.evaluate(function () {
        var el = document.querySelector("#wikiPageContent, .wiki-page-content, #wikiContent");
        if (!el) return false;
        return el.textContent.indexOf("<script>window.__wikiXss = true</script>") !== -1 &&
          el.querySelector("script") === null &&
          el.querySelector("img") === null;
      });

      // Role-based UI gating: verify admin sees create/edit controls.
      const createBtn = await page.$('[data-wiki-action="create"], #wikiCreateBtn, .wiki-create-btn');
      const editBtn = await page.$('[data-wiki-action="edit"], #wikiEditBtn, .wiki-edit-btn');
      result.checks.wikiAdminSeesCreate = !!createBtn;
      result.checks.wikiAdminSeesEdit = !!editBtn;

      // No destructive controls.
      const deleteBtn = await page.$('[data-wiki-action="delete"], #wikiDeleteBtn, .wiki-delete-btn');
      const removeBtn = await page.$('[data-wiki-action="remove"], #wikiRemoveBtn, .wiki-remove-btn');
      result.checks.wikiNoDestructiveControls = !deleteBtn && !removeBtn;
    }

    // Phase 2: Check viewer/member permissions — switch to viewer token.
    const viewerToken = seeded.viewerToken;
    if (viewerToken) {
      const viewerPayload = JSON.stringify({
        jwt: viewerToken,
        selectedProjectId: seeded.projectId,
        baseUrl: origin,
      });
      await page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: storageKey, value: viewerPayload }
      );
      await page.goto(wikiUrl, { waitUntil: "networkidle" });
      // Re-check presence of create/edit controls from viewer perspective.
      const viewerCreateBtn = await page.$('[data-wiki-action="create"], #wikiCreateBtn, .wiki-create-btn');
      const viewerEditBtn = await page.$('[data-wiki-action="edit"], #wikiEditBtn, .wiki-edit-btn');
      result.checks.wikiViewerCannotCreate = !viewerCreateBtn;
      result.checks.wikiViewerCannotEdit = !viewerEditBtn;
    }

    // Phase 3: Check member permissions.
    const memberToken = seeded.memberToken;
    if (memberToken) {
      const memberPayload = JSON.stringify({
        jwt: memberToken,
        selectedProjectId: seeded.projectId,
        baseUrl: origin,
      });
      await page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: storageKey, value: memberPayload }
      );
      await page.goto(wikiUrl, { waitUntil: "networkidle" });
      const memberCreateBtn = await page.$('[data-wiki-action="create"], #wikiCreateBtn, .wiki-create-btn');
      const memberEditBtn = await page.$('[data-wiki-action="edit"], #wikiEditBtn, .wiki-edit-btn');
      result.checks.wikiMemberCannotCreate = !memberCreateBtn;
      result.checks.wikiMemberCannotEdit = !memberEditBtn;
    }

    // Phase 4: Extras consistency — check Extras tab for Wiki status.
    if (wikiExists) {
      // Switch back to admin.
      await page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: storageKey, value: JSON.stringify({
          jwt: seeded.adminToken,
          selectedProjectId: seeded.projectId,
          baseUrl: origin,
        })}
      );
      const extrasUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=extras`;
      await page.goto(extrasUrl, { waitUntil: "networkidle" });
      await page.waitForFunction(function() { var btn = document.querySelector("#tabMoreBtn"); return btn && btn.classList.contains("has-active") && new URL(window.location.href).searchParams.get("tab") === "extras"; }, { timeout: 10000 });

      const extrasText = await page.textContent("#extrasPanel");
      result.checks.wikiExtrasImplemented =
        !!(extrasText && extrasText.includes("已实现的模块") && extrasText.includes("Wiki"));

      const deferredNames = await page.$$eval(
        "#extrasPanel .extras-deferred .extras-deferred-name",
        function (els) { return els.map(function (e) { return e.textContent.trim(); }); }
      );
      result.checks.wikiExtrasNotDeferred = !deferredNames.some(function (name) {
        return name === "Wiki";
      });

      // No fake releases/packages/security action buttons.
      result.checks.noFakeReleaseActions =
        !/create release|new release|publish package/i.test(extrasText || "");
    }

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
    await context.close();
    await browser.close();
  }

  return result;
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

  const md = [
    "# Project Space Wiki Tab — Browser Smoke Evidence",
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
    md.push("## Residual gaps", "", ...result.residual.map((r) => `- ${r}`), "");
  }

  if (result.errors.length) {
    md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  }

  md.push(
    "",
    "## Scope Note",
    "",
    "This smoke verifies the implemented Project Space Wiki tab, including backend ",
    "create/list/read/update, owner/admin edit controls, member/viewer read-only ",
    "gating, Extras placement, and safe markdown rendering for unsafe HTML input.",
    "",
  );

  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async () => {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
});
