#!/usr/bin/env node
// Project Space Reviews — browser/runtime smoke harness.
//
// Starts the built backend with SERVE_DASHBOARD=1, seeds a real project with a
// changeset, opens /project-space.html?project_id=...&tab=reviews&changeset_id=...
// in a real Chromium via Playwright, and asserts that the Reviews surface
// renders list, detail, diff, review actions, merge state, and cross-tab
// navigation.
//
// If Playwright is not resolvable, the script still verifies the backend data
// setup and static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-reviews.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
//                                  (defaults to the bundled runtime path).
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-reviews-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

// Bundled runtime path discovered by PM for this Mac.
const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";

const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;

// Viewport dimensions — overridable via env (used by mobile suite runner).
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let browser = null;
let context = null;
let page = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-reviews.js",
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
      throw new Error(
        "Backend dist missing. Run: cd backend && npm run build"
      );
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

    // ── 1. Backend data setup (always runs) ───────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      changesetCreated: !!seeded.changesetId,
      diffAvailable: seeded.diffOk,
    };

    // ── 2. Static JS wiring check (always runs) ───────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed = staticOk && seeded.diffOk;
      result.residual.push(
        "Real-browser rendering not exercised because Playwright is unavailable."
      );
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke ─────────────────────────────────────────────
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
  process.env.JWT_SECRET = "project-space-reviews-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  // app.ts loads openapi-v2.yaml via a path relative to process.cwd(). Existing
  // backend tests are run from the backend/ directory; mirror that so the
  // relative path resolves to the repo root.
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  // Allow CORS from the ephemeral origin so same-origin-ish browser fetches
  // (which still send an Origin header) are accepted.
  process.env.CORS_ORIGINS = baseUrl;

  const email = `reviews-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password,
    display_name: "Reviews Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error(`Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`);
  }
  const token = registerRes.data.access_token;
  const userId = registerRes.data.user.id;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "Reviews Smoke Project",
    description: "Browser smoke for Project Space Reviews",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  const baseFileRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    token,
    {
      path: "README.md",
      content: "# Reviews Smoke\n\noriginal content",
      message: "Initial README",
    }
  );
  if (baseFileRes.status !== 201) {
    throw new Error(`Base file create failed: ${baseFileRes.status} ${JSON.stringify(baseFileRes.data)}`);
  }

  const markdownDesc =
    "# Changeset MD Preview Test\n\n" +
    "This is **strong text** and `inline code`.\n" +
    "- List item one\n" +
    "<script>alert('xss')</script>\n" +
    "<img src=x onerror=alert(1)>";

  const changesetRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets`,
    token,
    {
      title: "Update README",
      description: markdownDesc,
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Reviews Smoke\n\nupdated content",
          base_revision_id: baseFileRes.data.current_revision_id,
        },
      ],
    }
  );
  if (changesetRes.status !== 201) {
    throw new Error(`Changeset create failed: ${changesetRes.status} ${JSON.stringify(changesetRes.data)}`);
  }
  const changesetId = changesetRes.data.id;

  const diffRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/changesets/${changesetId}/diff`,
    token
  );
  const diffOk =
    diffRes.status === 200 &&
    Array.isArray(diffRes.data.files) &&
    diffRes.data.files.length === 1 &&
    diffRes.data.files[0].old_content === "# Reviews Smoke\n\noriginal content" &&
    diffRes.data.files[0].new_content === "# Reviews Smoke\n\nupdated content";

  return {
    baseUrl,
    token,
    userId,
    projectId,
    changesetId,
    diffOk,
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Reviews tab markup exists.
    checks.reviewsTabMarkup =
      html.includes('data-tab="reviews"') && html.includes('id="reviewsPanel"');

    // Changeset detail drawer markup exists.
    checks.changesetDetailMarkup =
      html.includes('id="changesetDetailPane"') &&
      html.includes('id="changesetDetailTitle"') &&
      html.includes('id="changesetDetailBody"');

    // Review action controls exist in source.
    checks.reviewActionControls =
      html.includes("data-cs-action=\"approve\"") &&
      html.includes("data-cs-action=\"request_changes\"") &&
      html.includes("data-cs-action=\"merge\"");

    // Diff rendering uses old/new content.
    checks.diffRenderingWired =
      html.includes("op.old_content") && html.includes("op.new_content");

    // Description section markup — safe Markdown preview container.
    checks.descriptionMarkup =
      html.includes("class=\"cs-description-markdown\"");

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
    return checks;
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
      baseUrl: origin, // same origin as the dashboard, no /agent prefix
    });

    // Seed localStorage so the page is already authenticated and project-selected.
    await page.goto(origin);
    await page.evaluate(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: storageKey, value: storagePayload }
    );

    const url =
      `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=reviews&changeset_id=${encodeURIComponent(seeded.changesetId)}`;

    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for the Reviews tab to become active and the project to be selected.
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', {
      timeout: 10000,
    });
    result.checks.reviewsTabActive = true;

    // The auto-login path selects the project while `state.busy` is true, so
    // the initial data load is skipped. Explicitly click the Reviews tab to
    // trigger loadReviewsData() and the changeset deep-link.
    // { force: true } is used because at narrow viewports the changeset
    // detail overlay may overlap the tab bar and intercept pointer events.
    await page.click('.tab-item[data-tab="reviews"]', { force: true });

    // Reviews list rendered.
    await page.waitForSelector(".reviews-table .reviews-row", {
      timeout: 10000,
    });
    result.checks.reviewsListRendered = true;

    // Changeset detail drawer opened.
    await page.waitForSelector("#changesetDetailPane.open", { timeout: 10000 });
    result.checks.changesetDetailOpened = true;

    // Title and status visible.
    const title = await page.textContent("#changesetDetailTitle");
    result.checks.detailTitle = title && title.includes("Update README");

    const statusPill = await page.locator("#changesetDetailBody .pill").first();
    const statusText = await statusPill.textContent();
    result.checks.detailStatusVisible = !!statusText;

    // Description section — safe Markdown preview.
    const descSection = await page.locator('div[data-changeset-description-section="true"]').count();
    result.checks.descriptionSectionVisible = descSection > 0;

    // Markdown rendering: heading, strong, inline code, list.
    result.checks.descriptionHasHeading = await page.locator(".cs-description-markdown h1").count() > 0;
    result.checks.descriptionHasStrong = await page.locator(".cs-description-markdown strong").count() > 0;
    result.checks.descriptionHasInlineCode = await page.locator(".cs-description-markdown code").count() > 0;
    result.checks.descriptionHasListItem = await page.locator(".cs-description-markdown li").count() > 0;

    // Unsafe HTML safety: no live <script>/<img> element or inline event handler.
    const unsafeDomState = await page.evaluate(function () {
      var c = document.querySelector(".cs-description-markdown");
      if (!c) {
        return {
          hasLiveScript: true,
          hasLiveImage: true,
          hasInlineEventHandler: true,
        };
      }
      var eventAttrs = Array.prototype.some.call(c.querySelectorAll("*"), function (node) {
        return Array.prototype.some.call(node.attributes || [], function (attr) {
          return /^on/i.test(attr.name);
        });
      });
      return {
        hasLiveScript: c.querySelector("script") !== null,
        hasLiveImage: c.querySelector("img") !== null,
        hasInlineEventHandler: eventAttrs,
      };
    });
    result.checks.descriptionNoLiveScript = !unsafeDomState.hasLiveScript;
    result.checks.descriptionNoLiveImage = !unsafeDomState.hasLiveImage;
    result.checks.descriptionNoInlineEventHandler = !unsafeDomState.hasInlineEventHandler;

    // Unsafe payload text appears escaped (visible as text, not executed).
    var descText = await page.textContent(".cs-description-markdown");
    result.checks.descriptionUnsafePayloadVisible = descText && descText.indexOf("<script>alert") !== -1;
    result.checks.descriptionUnsafeImagePayloadVisible = descText && descText.indexOf("<img src=x onerror=alert(1)>") !== -1;

    // Description text includes the heading title.
    result.checks.descriptionHeadingTextVisible = descText && descText.indexOf("Changeset MD Preview Test") !== -1;

    // Diff old/new content visible.
    const bodyText = await page.textContent("#changesetDetailBody");
    result.checks.diffOldContent = bodyText.includes("original content");
    result.checks.diffNewContent = bodyText.includes("updated content");

    // Review action controls present.
    await page.waitForSelector("[data-cs-action='approve']", { timeout: 5000 });
    await page.waitForSelector("[data-cs-action='request_changes']", {
      timeout: 5000,
    });
    result.checks.reviewActionControlsVisible = true;

    // Approve the changeset.
    await page.click("[data-cs-action='approve']");
    await page.waitForFunction(
      () => {
        const body = document.querySelector("#changesetDetailBody");
        return body && body.textContent.includes("已批准");
      },
      { timeout: 10000 }
    );
    result.checks.approveStateReflected = true;

    // Merge control appears after approval.
    await page.waitForSelector("[data-cs-action='merge']", { timeout: 10000 });
    result.checks.mergeControlVisible = true;

    // Merge the changeset.
    page.on("dialog", (dialog) => dialog.accept());
    await page.click("[data-cs-action='merge']");
    await page.waitForFunction(
      () => {
        const body = document.querySelector("#changesetDetailBody");
        return body && body.textContent.includes("已合并");
      },
      { timeout: 10000 }
    );
    result.checks.mergedStateReflected = true;

    // Cross-tab navigation: close the detail pane first. On mobile the pane is
    // full-width, so tab clicks behind it are not a valid user path.
    await page.click("#closeChangesetDetailBtn", { force: true });
    await page.waitForSelector("#changesetDetailPane:not(.open)", {
      timeout: 5000,
    });
    result.checks.detailClosedBeforeTabNavigation = true;

    await page.click('.tab-item[data-tab="files"]');
    await page.waitForSelector('#filesTabContent:not(.hidden)', {
      timeout: 5000,
    });
    result.checks.filesTabNavigable = true;

    // Cross-tab navigation: switch to Work tab and verify panel.
    await page.click('.tab-item[data-tab="work"]');
    await page.waitForSelector('#workPanel:not(.hidden)', { timeout: 5000 });
    result.checks.workTabNavigable = true;

    // Return to the target surface before capturing final evidence.
    await page.click('.tab-item[data-tab="reviews"]');
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', {
      timeout: 5000,
    });
    await page.waitForFunction(
      () => {
        const body = document.querySelector("#changesetDetailBody");
        return body && body.textContent.includes("已合并");
      },
      { timeout: 5000 }
    );

    // Final screenshot.
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = Object.values(result.checks).every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    // Capture a failure screenshot for diagnosis.
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

  const md = [
    "# Project Space Reviews — Browser Smoke Evidence",
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
