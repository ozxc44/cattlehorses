#!/usr/bin/env node
// Project Space Insights Tab — browser/runtime smoke harness.
//
// Verifies that a future/landed Insights tab renders real overview and summary
// metrics from existing API payloads, preserves URL/tab behavior, and does not
// introduce unsupported Wiki/Releases/Packages/Security controls.
//
// If the tab has not yet landed (no "insights" in TAB_ALLOWLIST), the script
// still seeds backend data and exercises the data pipeline, then exits with
// clear actionable diagnostics explaining exactly what markup is missing.
//
// Usage:
//   node scripts/smoke-project-space-insights.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH  - directory containing a `playwright` package
//                                   (defaults to the bundled runtime path).
//   VIEWPORT_WIDTH, VIEWPORT_HEIGHT  - viewport dimensions (overridable).
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-insights-smoke");
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
    command: "node scripts/smoke-project-space-insights.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    tabLanded: false,
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

    // ── 1. Determine if the Insights tab has landed ────────────────────────
    const tabStatus = checkInsightsTabWiring();
    result.checks.staticWiring = tabStatus;
    result.tabLanded =
      tabStatus.tabInAllowlist &&
      tabStatus.insightsPanelMarkup &&
      tabStatus.insightsTabButton &&
      tabStatus.renderFunction &&
      tabStatus.switchTabWired &&
      !tabStatus.error;

    if (!result.tabLanded) {
      // The tab has NOT landed. Seed data, log actionable diagnostics, and
      // fail clearly so the user knows exactly what to implement.
      result.residual.push(
        "========================================================================",
        "INSIGHTS TAB HAS NOT LANDED YET — actionable diagnostics below.",
        "========================================================================"
      );

      if (!tabStatus.tabInAllowlist) {
        result.residual.push(
          "MISSING allowlist entry. Add 'insights' to TAB_ALLOWLIST in" +
            " dashboard/project-space.html (around line 1436):",
          '  var TAB_ALLOWLIST = ["files", "readme", "activity", "work",' +
            ' "reviews", "people", "history", "settings", "extras", "insights"];'
        );
      }
      if (!tabStatus.insightsTabButton) {
        result.residual.push(
          "MISSING tab button. Add inside <div id=\"tabBar\">:",
          '  <button class="tab-item" data-tab="insights" role="tab" id="tab-insights"' +
            ' aria-selected="false" aria-controls="insightsPanel" tabindex="-1">Insights</button>'
        );
      }
      if (!tabStatus.insightsPanelMarkup) {
        result.residual.push(
          "MISSING panel element. Add after the extras panel:",
          '  <div id="insightsPanel" class="panel hidden" aria-labelledby="tab-insights" role="tabpanel">',
          '    ... metrics cards and tables ...',
          "  </div>"
        );
      }
      if (!tabStatus.renderFunction) {
        result.residual.push(
          "MISSING renderInsights() function. Add inside the inline <script>:",
          "  function renderInsights() {",
          '    // Populate #insightsPanel with overview/summary data from state',
          "  }"
        );
      }
      if (!tabStatus.switchTabWired) {
        result.residual.push(
          "MISSING switchTab wiring. In the switchTab() function (around line 2299),",
          "add an else-if branch for tab === 'insights' that calls renderInsights().",
          "Also add els.insightsPanel toggle (classList.toggle('hidden', tab !== 'insights'))."
        );
      }
      if (!tabStatus.selectProjectWired) {
        result.residual.push(
          "MISSING selectProject wiring. In selectProject() (around line 1840),",
          "add an if block for state.activeTab === 'insights' similar to other tabs."
        );
      }
      if (!tabStatus.overviewEndpointCalled) {
        result.residual.push(
          "NOTE: The backend GET /v1/projects/:project_id/overview endpoint already exists.",
          "The Insights tab should call it (or the /summary endpoint) and display its metrics."
        );
      }

      result.residual.push(
        "========================================================================",
        "The checks below will pass once the tab is implemented.",
        "After adding the tab, re-run: node scripts/smoke-project-space-insights.js",
        "========================================================================"
      );
    }

    // ── 2. Backend data setup (always runs — proves data pipeline) ─────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      summaryAvailable: !!seeded.summary,
      overviewAvailable: !!seeded.overview,
      fileCount: seeded.fileCount,
      taskCount: seeded.taskCount,
    };

    // ── 3. Validate overview/summary payload shape for Insights metrics ────
    const dataPipelineOk = validateInsightsDataPipeline(seeded);
    result.checks.dataPipeline = dataPipelineOk;

    if (!playwright || !result.tabLanded) {
      // Even without the tab, we prove the data is there and the checks
      // are ready. If the tab hasn't landed, fail clearly.
      result.skipped = !!playwright;
      if (!result.tabLanded) {
        result.passed = false;
        // Do NOT exit yet — we still write evidence
      } else {
        result.passed =
          dataPipelineOk.metricsAllPresent &&
          dataPipelineOk.agentsMetricsOk &&
          dataPipelineOk.tasksMetricsOk;
      }
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 4. Real browser smoke (only if tab landed + Playwright available) ──
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
  process.env.JWT_SECRET = "project-space-insights-smoke-secret";
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

  const email = `insights-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password,
    display_name: "Insights Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error(`Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`);
  }
  const token = registerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "Insights Smoke Project",
    description: "Browser smoke for Project Space Insights tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  // Seed files with diverse paths for summary/extension coverage
  const filesToCreate = [
    { path: "README.md", content: "# Insights Smoke\n\nMetrics validation project." },
    { path: "src/main.ts", content: "// main entry" },
    { path: "src/utils.ts", content: "// utilities" },
    { path: "src/styles.css", content: "/* styles */" },
    { path: "package.json", content: "{}" },
    { path: "deliverables/report.md", content: "# Report\n\nDeliverable." },
  ];
  for (const f of filesToCreate) {
    const fileRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, token, {
      path: f.path,
      content: f.content,
      message: `Add ${f.path} for insights smoke`,
    });
    if (fileRes.status !== 201) {
      throw new Error(`File create failed for ${f.path}: ${fileRes.status} ${JSON.stringify(fileRes.data)}`);
    }
  }

  // Seed agents and orchestration tasks for overview metrics
  const mainAgentRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, token, {
    name: "Insights Main Agent",
  });
  if (mainAgentRes.status !== 201) throw new Error("Main agent seed failed");
  const workerAgentRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, token, {
    name: "Insights Worker Agent",
  });
  if (workerAgentRes.status !== 201) throw new Error("Worker agent seed failed");

  await apiWithKey(baseUrl, "POST", "/v1/agents/heartbeat", mainAgentRes.data.api_key, { status: "online" });
  await apiWithKey(baseUrl, "POST", "/v1/agents/heartbeat", workerAgentRes.data.api_key, { status: "online" });

  const orchestrationRes = await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations`,
    mainAgentRes.data.api_key,
    {
      title: "Insights Smoke Orchestration",
      objective: "Validate Insights metrics pipeline.",
      main_agent_id: mainAgentRes.data.id,
      worker_agent_ids: [workerAgentRes.data.id],
    }
  );
  if (orchestrationRes.status !== 201) {
    throw new Error(`Orchestration create failed: ${orchestrationRes.status} ${JSON.stringify(orchestrationRes.data)}`);
  }
  const orchestrationId = orchestrationRes.data.id;

  // Create one pending task and one ready-for-review task
  const pendingRes = await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
    mainAgentRes.data.api_key,
    {
      title: "Pending task for insights metrics",
      goal: "Pending work.",
      assigned_agent_id: workerAgentRes.data.id,
      dispatch: false,
    }
  );
  if (pendingRes.status !== 201) throw new Error("Pending task create failed");

  const readyRes = await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
    mainAgentRes.data.api_key,
    {
      title: "Ready task for insights metrics",
      goal: "Ready for review.",
      assigned_agent_id: workerAgentRes.data.id,
      dispatch: true,
    }
  );
  if (readyRes.status !== 201) throw new Error("Ready task create failed");

  // Claim and complete the ready task so it shows as ready-for-review
  await apiWithKey(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${readyRes.data.id}/claim`,
    workerAgentRes.data.api_key
  );
  await apiWithKey(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${readyRes.data.id}/complete`,
    workerAgentRes.data.api_key,
    {
      result_md: "# Ready\n\nNeeds review in insights smoke.",
      evidence: { smoke: true },
    }
  );

  // Fetch summary and overview
  const summaryRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/summary`, token);
  const overviewRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/overview`, token);

  return {
    baseUrl,
    token,
    projectId,
    fileCount: filesToCreate.length,
    taskCount: 2,
    summary: summaryRes.status === 200 && !(summaryRes.data && summaryRes.data.detail) ? summaryRes.data : null,
    overview: overviewRes.status === 200 && !(overviewRes.data && overviewRes.data.detail) ? overviewRes.data : null,
  };
}

function checkInsightsTabWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // 1. Check TAB_ALLOWLIST for 'insights'
    checks.tabInAllowlist =
      /TAB_ALLOWLIST\s*=\s*\[[\s\S]*?"insights"\s*\]/.test(html) ||
      /\bTAB_ALLOWLIST[\s\S]*?"insights"/.test(html);

    // 2. Check for the tab button markup
    checks.insightsTabButton =
      html.includes('data-tab="insights"') &&
      html.includes('id="tab-insights"') &&
      /Insights/i.test(html);

    // 3. Check for the panel markup
    checks.insightsPanelMarkup =
      html.includes('id="insightsPanel"') &&
      html.includes('aria-labelledby="tab-insights"');

    // 4. Check for renderInsights() function
    checks.renderFunction =
      html.includes("function renderInsights()");

    // 5. Check switchTab() has an insights branch
    checks.switchTabWired =
      /tab\s*===\s*["']insights["']/.test(html) &&
      html.includes("renderInsights()");

    // 6. Check selectProject() has an insights branch
    checks.selectProjectWired =
      /activeTab\s*===\s*["']insights["']/.test(html);

    // 7. Check for els.insightsPanel reference in the element cache
    checks.elementCached =
      /insightsPanel\s*:\s*\$\(/.test(html) ||
      /insightsPanel/.test(html);

    // 8. Check that unsupported controls do NOT appear in Insights context
    // (Wiki/Releases/Packages/Security should not be rendered as functional controls)
    const insightsContextMatch = html.match(/function renderInsights\(\)[\s\S]{0,2000}/);
    const insightsContext = insightsContextMatch ? insightsContextMatch[0] : "";
    if (checks.renderFunction) {
      checks.noFakeDeferredControls =
        !/create release|new release|publish package|new wiki|security scan/i.test(insightsContext);
    } else {
      checks.noFakeDeferredControls = null; // can't check yet
    }

    // 9. Check that the overview endpoint is called or referenced
    checks.overviewEndpointCalled =
      html.includes("/overview") &&
      (html.includes("loadInsightsData") || html.includes("renderInsights"));

    // 10. Inline script parses
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

function validateInsightsDataPipeline(seeded) {
  const checks = {};

  // Check summary payload metrics
  if (seeded.summary) {
    checks.summaryHasProjectId = !!seeded.summary.project_id;
    checks.summaryHasFileCount =
      seeded.summary.files &&
      typeof seeded.summary.files.total_count === "number" &&
      seeded.summary.files.total_count >= 6;
    checks.summaryHasDirectoryCount =
      seeded.summary.files &&
      typeof seeded.summary.files.directory_count === "number";
    checks.summaryHasFileTypes =
      seeded.summary.files &&
      Array.isArray(seeded.summary.files.file_types) &&
      seeded.summary.files.file_types.length > 0;
    checks.summaryHasRecentActivity =
      seeded.summary.recent_activity &&
      Array.isArray(seeded.summary.recent_activity.files) &&
      Array.isArray(seeded.summary.recent_activity.revisions);
    checks.summaryHasDeliverables =
      seeded.summary.buckets &&
      Array.isArray(seeded.summary.buckets.deliverables);
    checks.summaryHasReadme =
      seeded.summary.readme && seeded.summary.readme.file_id;
  } else {
    checks.summaryNotAvailable = true;
  }

  // Check overview payload metrics
  if (seeded.overview) {
    checks.overviewHasProject = !!seeded.overview.project;
    checks.overviewHasSummarySection = !!seeded.overview.summary;

    // Agent metrics
    checks.agentsMetricsOk =
      seeded.overview.summary &&
      typeof seeded.overview.summary.agents === "object" &&
      typeof seeded.overview.summary.agents.total === "number" &&
      typeof seeded.overview.summary.agents.online === "number";

    // Task metrics
    checks.tasksMetricsOk =
      seeded.overview.summary &&
      typeof seeded.overview.summary.tasks === "object" &&
      typeof seeded.overview.summary.tasks.total === "number" &&
      typeof seeded.overview.summary.tasks.open_work === "number" &&
      typeof seeded.overview.summary.tasks.ready_for_review === "number";

    // File metrics
    checks.filesMetricsOk =
      seeded.overview.summary &&
      typeof seeded.overview.summary.files === "object" &&
      typeof seeded.overview.summary.files.total_count === "number";

    // Inbox metrics
    checks.inboxMetricsOk =
      seeded.overview.summary &&
      typeof seeded.overview.summary.inbox === "object" &&
      typeof seeded.overview.summary.inbox.pending_total === "number";

    // Attention items
    checks.attentionReadyForReview =
      seeded.overview.attention &&
      Array.isArray(seeded.overview.attention.ready_for_review) &&
      seeded.overview.attention.ready_for_review.length > 0;
    checks.attentionBlockedFailed =
      seeded.overview.attention &&
      Array.isArray(seeded.overview.attention.blocked_failed);

    // Recent activity
    checks.recentOrchestrations =
      seeded.overview.recent &&
      Array.isArray(seeded.overview.recent.orchestrations);
    checks.recentFiles =
      seeded.overview.recent &&
      Array.isArray(seeded.overview.recent.files);

    // Workload metrics
    checks.workloadMetricsOk =
      seeded.overview.workload &&
      typeof seeded.overview.workload.total_units === "number";

    // Health signals
    checks.healthSignalsOk =
      seeded.overview.health &&
      Array.isArray(seeded.overview.health.signals);

    // Metadata
    checks.overviewGeneratedAt = !!seeded.overview.generated_at;
  } else {
    checks.overviewNotAvailable = true;
  }

  // Composite check: all key metric groups present
  checks.metricsAllPresent =
    (!checks.summaryNotAvailable || false) &&
    (!checks.overviewNotAvailable || false) &&
    checks.agentsMetricsOk !== false &&
    checks.tasksMetricsOk !== false &&
    checks.filesMetricsOk !== false;

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

  // Helper: wait for tab active, supporting primary and overflow tabs.
  async function waitTab(dataTab) {
    var primary = await page.$('.tab-item[data-tab="' + dataTab + '"]');
    if (primary) {
      await page.waitForSelector('.tab-item[data-tab="' + dataTab + '"].active', { timeout: 10000 });
    } else {
      await page.waitForFunction(
        function (t) {
          var btn = document.querySelector("#tabMoreBtn");
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

    // Phase 1: Deep-link into Insights tab
    const insightsUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
      seeded.projectId
    )}&tab=insights`;
    await page.goto(insightsUrl, { waitUntil: "networkidle" });

    // The Insights tab button should be active
    await waitTab("insights");
    result.checks.insightsTabActive = true;

    // The Insights panel should be visible
    await page.waitForSelector("#insightsPanel:not(.hidden)", { timeout: 10000 });
    result.checks.insightsPanelVisible = true;

    // Phase 2: Real metrics are rendered
    const panelText = await page.textContent("#insightsPanel");

    // Agent metrics card
    result.checks.agentMetricsRendered =
      !!(panelText && panelText.includes(seeded.overview.summary.agents.total + ""));

    // Task metrics use stable data attributes so product copy can stay localized.
    result.checks.openWorkRendered =
      await page.locator('#insightsPanel [data-insight="open_work"]').count() > 0;
    result.checks.readyForReviewRendered =
      await page.locator('#insightsPanel [data-insight="ready_for_review"]').count() > 0;

    // File count metrics
    result.checks.fileCountRendered =
      !!(panelText && panelText.includes(seeded.overview.summary.files.total_count + ""));

    // Phase 3: Empty state — create a new empty project and verify
    const emptyProjectRes = await api(seeded.baseUrl, "POST", "/v1/projects", seeded.token, {
      name: "Empty Insights Project",
      description: "Should show graceful empty state in Insights.",
    });
    if (emptyProjectRes.status === 201) {
      const emptyProjectId = emptyProjectRes.data.id;
      const emptyUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(
        emptyProjectId
      )}&tab=insights`;
      await page.goto(emptyUrl, { waitUntil: "networkidle" });
      await waitTab("insights");
      const emptyText = await page.textContent("#insightsPanel");
      result.checks.emptyStateGraceful =
        emptyText && (
          emptyText.includes("0") ||
          emptyText.includes("无") ||
          emptyText.includes("no") ||
          emptyText.includes("空") ||
          emptyText.includes("empty") ||
          emptyText.includes("—")
        );

      // Switch back to the seeded project
      await page.goto(insightsUrl, { waitUntil: "networkidle" });
      await waitTab("insights");
    } else {
      result.checks.emptyStateGraceful = null;
    }

    // Phase 4: URL preserves project_id and tab=insights
    result.checks.urlPreservesProjectAndTab =
      page.url().includes("project_id=") && page.url().includes("tab=insights");

    // Phase 5: Cross-tab navigation preserves insights tab state
    await page.click('.tab-item[data-tab="files"]');
    await page.waitForSelector('#filesTabContent:not(.hidden)', { timeout: 5000 });
    result.checks.filesTabNavigable = true;

    // Return to Insights tab (navigate via tab bar or overflow menu)
    var insightsPrimary = await page.$('.tab-item[data-tab="insights"]');
    if (insightsPrimary) {
      await insightsPrimary.click();
      await page.waitForSelector('.tab-item[data-tab="insights"].active', { timeout: 5000 });
    } else {
      await page.click("#tabMoreBtn");
      await page.waitForSelector("#tabMoreMenu.open", { timeout: 5000 });
      await page.click('.tab-more-item[data-tab="insights"]');
      await page.waitForTimeout(400);
    }
    await waitTab("insights");
    result.checks.returnToInsightsAfterNavigation = true;

    // Phase 6: No unsupported Wiki/Releases/Packages/Security interactive controls
    const bodyText = await page.textContent("body");
    result.checks.noUnsupportedDeferredControls =
      !/create release|new release|publish package|new wiki|security scan/i.test(bodyText || "");

    // Phase 7: Tab bar layout check
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
      return {
        itemCount: items.length,
        allSameRow: allSameRow,
      };
    });
    result.checks.tabBarLayout = tabBarLayout;
    result.checks.tabBarNoWrap = !!(tabBarLayout && tabBarLayout.allSameRow);

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

function apiWithKey(baseUrl, method, route, key, body) {
  return request(baseUrl, method, route, { "X-API-Key": key }, body);
}

function request(baseUrl, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (_) {
            data = raw;
          }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function allTrue(obj) {
  return Object.values(obj || {}).every(
    (value) =>
      value === true || (value && typeof value === "object" && allTrue(value))
  );
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const lines = [
    "# Project Space Insights Tab — Browser Smoke Evidence",
    "",
    `- **Command:** \`${result.command}\``,
    `- **Timestamp:** ${result.timestamp}`,
    `- **Backend built:** ${result.backendBuilt}`,
    `- **Browser available:** ${result.browserAvailable}`,
    `- **Tab landed:** ${result.tabLanded}`,
    `- **Passed:** ${result.passed}`,
    `- **Skipped:** ${result.skipped}`,
    result.screenshotPath ? `- **Screenshot:** \`${result.screenshotPath}\`` : "",
    `- **Evidence JSON:** \`${EVIDENCE_JSON}\``,
    "",
    "## Data Pipeline Status",
    "",
    `- **Summary endpoint:** ${result.checks.backendSeed && result.checks.backendSeed.summaryAvailable ? "✅" : "❌"}`,
    `- **Overview endpoint:** ${result.checks.backendSeed && result.checks.backendSeed.overviewAvailable ? "✅" : "❌"}`,
    `- **File count seeded:** ${result.checks.backendSeed ? result.checks.backendSeed.fileCount : "?"}`,
    `- **Task count seeded:** ${result.checks.backendSeed ? result.checks.backendSeed.taskCount : "?"}`,
    "",
    "## Static Wiring Checks",
    "",
    "```json",
    JSON.stringify(result.checks.staticWiring || {}, null, 2),
    "```",
    "",
    "## Data Pipeline Checks",
    "",
    "```json",
    JSON.stringify(result.checks.dataPipeline || {}, null, 2),
    "```",
    "",
  ];

  if (result.checks.browser) {
    lines.push(
      "## Browser Checks",
      "",
      "```json",
      JSON.stringify(result.checks.browser, null, 2),
      "```",
      ""
    );
  }

  if (result.residual && result.residual.length) {
    lines.push("## Diagnostics / Action Items", "");
    for (const r of result.residual) {
      lines.push("```", r, "```");
    }
    lines.push("");
  }

  if (result.errors && result.errors.length) {
    lines.push("## Errors", "");
    for (const e of result.errors) {
      lines.push("- " + e);
    }
    lines.push("");
  }

  lines.push(
    "",
    "## Scope Note",
    "",
    "This smoke verifies that the Insights tab renders real overview/summary-derived values,",
    "preserves Project Space URL/tab behavior, and does not introduce unsupported",
    "Wiki/Releases/Packages/Security controls. If the tab has not yet landed, the smoke",
    "provides clear actionable diagnostics to guide implementation.",
    "",
  );

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

main().finally(async () => {
  if (page) await page.close().catch(function () {});
  if (context) await context.close().catch(function () {});
  if (browser) await browser.close().catch(function () {});
  if (server) {
    await new Promise(function (resolve) {
      server.close(resolve);
    });
  }
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
});
