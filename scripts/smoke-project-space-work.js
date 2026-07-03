#!/usr/bin/env node
// Project Space Work — browser/runtime smoke harness.
//
// Seeds a real project with orchestration tasks in multiple lifecycle states,
// opens /project-space.html?tab=work in Chromium, and verifies Work list,
// filters, detail drawer, and the `tab=issues` alias.
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-work-smoke");
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

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const result = {
    command: "node scripts/smoke-project-space-work.js",
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
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      taskCount: seeded.taskIds.length >= 4,
      readyForReviewTask: !!seeded.readyTaskId,
      completedTask: !!seeded.doneTaskId,
      dispatchedTask: !!seeded.dispatchedTaskId,
      savedQueryCreated: !!seeded.savedQueryId,
    };
    result.checks.staticWiring = checkStaticWiring();

    if (!playwright) {
      result.skipped = true;
      result.passed = result.checks.backendSeed.taskCount && allTrue(result.checks.staticWiring);
      result.residual.push("Real-browser rendering not exercised because Playwright is unavailable.");
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
      return createRequire(path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json"))("playwright");
    } catch (__) {
      return null;
    }
  }
}

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-work-smoke-secret";
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

  const owner = await register(baseUrl, "work-smoke-owner");
  const project = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Work Smoke Project",
    description: "Browser smoke for Project Space Work",
  });
  if (project.status !== 201) throw new Error(`Project create failed: ${project.status}`);
  const projectId = project.data.id;

  const mainAgent = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, owner.token, { name: "Work Main Agent" });
  const workerAgent = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, owner.token, { name: "Work Worker Agent" });
  if (mainAgent.status !== 201 || workerAgent.status !== 201) throw new Error("Agent seed failed");
  await apiWithKey(baseUrl, "POST", "/v1/agents/heartbeat", mainAgent.data.api_key, { status: "online" });
  await apiWithKey(baseUrl, "POST", "/v1/agents/heartbeat", workerAgent.data.api_key, { status: "online" });

  const orchestration = await apiWithKey(baseUrl, "POST", `/v1/projects/${projectId}/orchestrations`, mainAgent.data.api_key, {
    title: "Work Smoke Orchestration",
    objective: "Exercise Work list filters and detail drawer.",
    main_agent_id: mainAgent.data.id,
    worker_agent_ids: [workerAgent.data.id],
  });
  if (orchestration.status !== 201) throw new Error(`Orchestration create failed: ${orchestration.status}`);
  const orchestrationId = orchestration.data.id;

  const pending = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, "Work pending task", false);
  const dispatched = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, "Work dispatched task", true);
  const ready = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, "Work ready for review task", true);
  const done = await createTask(baseUrl, projectId, orchestrationId, mainAgent.data.api_key, workerAgent.data.id, "Work approved task", true);

  await apiWithKey(baseUrl, "PATCH", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${ready.data.id}/claim`, workerAgent.data.api_key);
  await apiWithKey(baseUrl, "POST", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${ready.data.id}/complete`, workerAgent.data.api_key, {
    result_md: "# Ready\n\nNeeds PM review.",
    evidence: { smoke: true },
  });
  await apiWithKey(baseUrl, "PATCH", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${done.data.id}/claim`, workerAgent.data.api_key);
  await apiWithKey(baseUrl, "POST", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${done.data.id}/complete`, workerAgent.data.api_key, {
    result_md: "# Done\n\nApproved path.",
    evidence: { smoke: true },
  });
  await apiWithKey(baseUrl, "PATCH", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${done.data.id}/review`, mainAgent.data.api_key, {
    decision: "approved",
    notes: "Approved in Work smoke.",
  });

  const savedQuery = await api(baseUrl, "POST", `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
    name: "待评审工作",
    description: "Smoke seeded saved Work filter",
    query: { saved_view: "review" },
  });
  if (savedQuery.status !== 201) throw new Error(`Saved query seed failed: ${savedQuery.status} ${JSON.stringify(savedQuery.data)}`);

  return {
    baseUrl,
    token: owner.token,
    projectId,
    savedQueryId: savedQuery.data.id,
    readyTaskId: ready.data.id,
    doneTaskId: done.data.id,
    dispatchedTaskId: dispatched.data.id,
    taskIds: [pending.data.id, dispatched.data.id, ready.data.id, done.data.id],
  };
}

async function createTask(baseUrl, projectId, orchestrationId, apiKey, workerId, title, dispatch) {
  const res = await apiWithKey(baseUrl, "POST", `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`, apiKey, {
    title,
    goal: `${title} goal content`,
    assigned_agent_id: workerId,
    acceptance_criteria: [
      `${title} renders in Work`,
      "Evidence is visible in Project Space",
    ],
    depends_on: title.includes("ready") ? ["work-smoke-dependency"] : [],
    dispatch,
  });
  if (res.status !== 201) throw new Error(`Task create failed: ${res.status} ${JSON.stringify(res.data)}`);
  return res;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
    checks.workTabMarkup = html.includes('data-tab="work"') && html.includes('id="workPanel"');
    checks.workApi = html.includes("/orchestration-tasks?limit=");
    checks.workFilters = html.includes("data-work-filter") && html.includes("work-filter-btn");
    checks.workDetailDrawer = html.includes('id="taskDetailPane"') && html.includes("openTaskDetail");
    checks.workLabels = html.includes("deriveWorkLabels") && html.includes("work-label");
    checks.workTimeline = html.includes("renderWorkTimeline") && html.includes("task-timeline");
    checks.issueAlias = html.includes('issues: "work"') || html.includes("issues: \"work\"");
    // Work table columns and status pills
    checks.workTableStatusColumn = html.includes("col-status") && html.includes("col-orch") && html.includes("col-agent") && html.includes("workStatusPillHtml(t.status)");
    // Task detail timeline section
    checks.workDetailTimelineSection = html.includes("本地时间线") && html.includes("buildWorkTimeline");
    // Grouped view wiring
    checks.workGroupedView = html.includes("data-work-view") && html.includes("work-view-switcher") && html.includes("work-view-btn");
    checks.workGroupedRendering = html.includes("renderWorkGrouped") && html.includes("renderWorkCard") && html.includes("work-grouped") && html.includes("work-group");
    // Saved views wiring
    checks.workSavedViews = html.includes("data-work-saved-views") && html.includes("data-saved-view") && html.includes("work-saved-chip");
    checks.workSavedViewDefs = html.includes("WORK_SAVED_VIEWS") && html.includes("my_open") && html.includes("has_artifacts") && html.includes("linked") && html.includes("blocked");
    checks.workSavedViewFunction = html.includes("workSavedViewCount") && html.includes("workFilteredTasks") && (html.includes("state.workSavedView") || html.includes("workSavedView"));
    // Work summary wiring
    checks.workSummary = html.includes("data-work-summary") && html.includes("computeWorkSummary") && html.includes("work-summary-card");
    checks.workSummaryLifecycleCounts = html.includes("summary.open") && html.includes("summary.review") && html.includes("summary.blocked") && html.includes("summary.done");
    checks.workSummaryLinkedCounts = html.includes("summary.hasArtifacts") && html.includes("summary.linkedReview") && html.includes("summary.linkedCommit");
    checks.workSummaryAssigneeCount = html.includes("summary.assigneeCount") && html.includes("Agent");
    // Batch summary section (Batch101) — stable selector, render helper, cards/labels, collapse toggle
    checks.workBatchSectionWiring =
      html.includes('data-work-batch-section') &&
      html.includes("renderWorkBatchSummaryHtml") &&
      html.includes("work-batch-summary-section") &&
      html.includes("work-batch-card") &&
      html.includes("batch-label") &&
      html.includes("batch-count") &&
      html.includes('data-toggle-batch-section');
    checks.workBatchSummaryConsumesApi =
      html.includes("state.workSummary") &&
      html.includes("workSummary.batches") &&
      html.includes("batch_label");
    // Aggregate timeline section (Batch101) — stable selector, render helper, items/labels/values
    checks.workTimelineSummaryWiring =
      html.includes('data-work-timeline-summary') &&
      html.includes("renderWorkTimelineSummaryHtml") &&
      html.includes("work-timeline-summary") &&
      html.includes("work-timeline-item") &&
      html.includes("tl-label") &&
      html.includes("tl-val");
    checks.workTimelineSummaryFallback =
      html.includes("state.workSummary.timeline") &&
      html.includes("state.workTasks.length");
    // No fake issue creation/milestone/external notification/provider controls
    checks.noFakeIssueCreateControls = !html.includes("create-issue-form") && !html.includes("data-new-issue") && !html.includes("newIssueForm");
    checks.noFakeMilestoneControls = !html.includes("data-milestone") && !html.includes("milestone-selector");
    checks.noFakeExternalNotification = !html.includes("notification-settings") && !html.includes("provider-controls") && !html.includes("external-webhook");
    // Saved-query persisted-filter wiring (Batch89)
    checks.savedQueryEndpointOrModule = html.includes("work-saved-queries") || html.includes("WORK_SAVED_QUERIES") || html.includes("workSavedQueries");
    checks.savedQueryManagementContainer = html.includes("data-work-custom-queries") || html.includes("work-custom-queries");
    checks.savedQueryCreateControls = html.includes("data-cq-add") && html.includes("data-cq-create-save") && html.includes("createSavedQuery");
    checks.savedQueryEditControls = html.includes("data-cq-manage") && html.includes("data-cq-manage-delete") && html.includes("renameSavedQuery") && html.includes("deleteSavedQuery");
    checks.savedQueryListItems = html.includes("data-cq-id") && html.includes("work-custom-query-chip");
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    checks.inlineScriptParses = !!scriptMatch && !!vm.compileFunction(scriptMatch[1].trim());
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// Prove the backend Batch101 contract (summary.batches / summary.timeline) is
// derived from the real seeded Work tasks. This gates the smoke pass so the
// API `summary.batches` path is asserted alongside the UI fallback path.
async function fetchBatchTimelineContract(seeded) {
  const checks = {};
  try {
    const res = await api(
      seeded.baseUrl,
      "GET",
      `/v1/projects/${seeded.projectId}/orchestration-tasks`,
      seeded.token
    );
    checks.summaryPresent = res.status === 200 && !!(res.data && res.data.summary);
    const summary = res.data && res.data.summary ? res.data.summary : null;
    checks.batchesArray = !!(summary && Array.isArray(summary.batches));
    const batches = summary && Array.isArray(summary.batches) ? summary.batches : [];
    checks.batchesNonEmpty = batches.length >= 1;
    const firstBatch = batches[0] || {};
    checks.batchHasLabel = typeof firstBatch.batch_label === "string" && firstBatch.batch_label.length > 0;
    checks.batchHasCount = typeof firstBatch.total === "number" && firstBatch.total > 0;
    checks.batchHasDateBounds =
      typeof firstBatch.first_created_at === "string" && typeof firstBatch.last_updated_at === "string";
    checks.batchLabelMatchesOrchestration = firstBatch.batch_label === "Work Smoke Orchestration";
    checks.timelineArray = !!(summary && Array.isArray(summary.timeline));
    const buckets = summary && Array.isArray(summary.timeline) ? summary.timeline : [];
    checks.timelineNonEmpty = buckets.length >= 1;
    const firstBucket = buckets[0] || {};
    checks.timelineBucketHasDate = typeof firstBucket.date === "string" && firstBucket.date.length > 0;
    checks.timelineBucketHasCounts =
      typeof firstBucket.created === "number" &&
      typeof firstBucket.updated === "number" &&
      typeof firstBucket.completed === "number" &&
      typeof firstBucket.review_ready === "number";
    checks.timelineTotalCreated =
      buckets.reduce(function (sum, b) { return sum + (b.created || 0); }, 0) >= seeded.taskIds.length;
    // Row labels include batch/batch_label keys derived from orchestration context.
    const rows = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    const firstRow = rows[0] || {};
    const labelKeys = Array.isArray(firstRow.labels) ? firstRow.labels.map(function (l) { return l.key; }) : [];
    checks.rowLabelsIncludeBatch = labelKeys.indexOf("batch") !== -1 && labelKeys.indexOf("batch_label") !== -1;
    const batchLabelVal = (firstRow.labels || []).find(function (l) { return l.key === "batch_label"; });
    checks.rowBatchLabelNonEmpty = !!(batchLabelVal && typeof batchLabelVal.value === "string" && batchLabelVal.value.length);
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
    const storageKey = "zz_human_workspace_simple_v1";
    await page.goto(seeded.baseUrl);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: storageKey,
      value: JSON.stringify({ jwt: seeded.token, selectedProjectId: seeded.projectId, baseUrl: seeded.baseUrl }),
    });

    await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${seeded.projectId}&tab=issues`, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="work"].active', { timeout: 10000 });
    result.checks.issueAliasActivatesWork = true;

    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    result.checks.workRowsRendered = (await page.$$(".work-table .work-row")).length >= 4;

    // ── Batch101 backend contract (summary.batches / summary.timeline) ──
    result.checks.apiContract = await fetchBatchTimelineContract(seeded);

    // ── Batch summary section (API summary.batches path) ──
    // The section renders above the table from summary.batches; each card shows a
    // non-empty local batch label (the orchestration title), a task count, and a
    // date range, all derived from real Work task rows.
    var batchLabelInfo = await page.evaluate(function () {
      var section = document.querySelector("[data-work-batch-section]");
      var card = document.querySelector(".work-batch-card .batch-label");
      var countEl = document.querySelector(".work-batch-card .batch-count");
      var rangeEl = document.querySelector(".work-batch-card .batch-range");
      var cards = document.querySelectorAll(".work-batch-card");
      return {
        sectionPresent: !!section,
        cardCount: cards.length,
        label: card ? ((card.textContent || "")).trim() : "",
        count: countEl ? ((countEl.textContent || "")).trim() : "",
        hasRange: !!rangeEl
      };
    });
    result.checks.batchSectionRenders = !!batchLabelInfo.sectionPresent;
    result.checks.batchCardCount = batchLabelInfo.cardCount >= 1;
    result.checks.batchCardHasLabel = !!(batchLabelInfo.label && batchLabelInfo.label.length);
    result.checks.batchCardHasCount = /^\d+$/.test(batchLabelInfo.count) && parseInt(batchLabelInfo.count, 10) >= 1;
    result.checks.batchCardCountMatchesTasks = parseInt(batchLabelInfo.count, 10) === seeded.taskIds.length;
    result.checks.batchCardLabelFromOrchestration = batchLabelInfo.label.indexOf("Work Smoke Orchestration") !== -1;

    // Collapse toggle lifecycle (does not disrupt table interactions).
    var batchHeader = await page.$('[data-toggle-batch-section]');
    if (batchHeader) {
      await batchHeader.click();
      await page.waitForTimeout(150);
      var collapsedAfterOpen = await page.evaluate(function () {
        var s = document.querySelector("[data-work-batch-section]");
        return s ? s.getAttribute("data-collapsed") === "true" : false;
      });
      await batchHeader.click();
      await page.waitForTimeout(150);
      var expandedAfterClose = await page.evaluate(function () {
        var s = document.querySelector("[data-work-batch-section]");
        return s ? s.getAttribute("data-collapsed") !== "true" : false;
      });
      result.checks.batchCollapseToggleWorks = collapsedAfterOpen && expandedAfterClose;
    } else {
      result.checks.batchCollapseToggleWorks = false;
    }

    // ── Batch101 aggregate timeline (real API array path) ──
    // The backend returns summary.timeline as an array of per-date buckets; the
    // Work renderer reduces it into aggregate created/updated/reviewed/completed
    // totals and renders the timeline summary directly from the real API (not only
    // the stripped-payload fallback exercised later). This is the Batch101C repair.
    var timelineApiInfo = await page.evaluate(function () {
      var section = document.querySelector("[data-work-timeline-summary]");
      var items = Array.from(document.querySelectorAll(".work-timeline-item"));
      var byLabel = {};
      items.forEach(function (it) {
        var l = it.querySelector(".tl-label");
        var v = it.querySelector(".tl-val");
        var label = l ? ((l.textContent || "")).trim() : "";
        var val = v ? parseInt((v.textContent || "0").trim(), 10) : 0;
        if (label) byLabel[label] = isNaN(val) ? 0 : val;
      });
      return {
        sectionPresent: !!section,
        itemCount: items.length,
        created: byLabel["已创建"] || 0,
        reviewed: byLabel["已评审"] || 0,
        completed: byLabel["已完成"] || 0,
        labels: Object.keys(byLabel)
      };
    });
    result.checks.timelineApiSectionRenders = !!timelineApiInfo.sectionPresent;
    result.checks.timelineApiHasItems = timelineApiInfo.itemCount >= 1;
    result.checks.timelineApiCreatedMatchesTasks = timelineApiInfo.created === seeded.taskIds.length;
    result.checks.timelineApiReviewedNonZero = timelineApiInfo.reviewed >= 1;
    result.checks.timelineApiCompletedNonZero = timelineApiInfo.completed >= 1;
    result.checks.timelineApiShowsCreatedBucket = timelineApiInfo.labels.indexOf("已创建") !== -1;

    const bodyText = await page.textContent("#workPanel");
    result.checks.batchSectionHeaderText = bodyText.indexOf("批量标签") !== -1;
    result.checks.pendingVisible = bodyText.includes("Work pending task");
    result.checks.readyVisible = bodyText.includes("Work ready for review task");
    result.checks.orientationVisible = bodyText.includes("Open work") && bodyText.includes("Ready for review");
    result.checks.workLabelsVisible =
      bodyText.includes("open") &&
      bodyText.includes("ready for review") &&
      bodyText.includes("acceptance");

    await page.click('[data-work-view="grouped"]');
    await page.waitForSelector(".work-grouped .work-card", { timeout: 10000 });
    const groupedText = await page.textContent("#workPanel");
    result.checks.groupedViewActivates =
      (await page.locator('[data-work-view="grouped"].active').count()) > 0 &&
      (await page.locator(".work-grouped").count()) > 0;
    result.checks.groupedHeadingsVisible =
      groupedText.includes("进行中") &&
      groupedText.includes("待评审") &&
      groupedText.includes("已完成");
    result.checks.groupedTasksVisible =
      groupedText.includes("Work pending task") &&
      groupedText.includes("Work ready for review task") &&
      groupedText.includes("Work approved task");
    result.checks.groupedCardsHavePills =
      await page.locator(".work-card .pill").count() >= 3;
    result.checks.groupedCardsHaveLabels =
      await page.locator(".work-card .work-label").count() >= 3;
    const readyCard = page.locator(".work-card", { hasText: "Work ready for review task" }).first();
    await readyCard.scrollIntoViewIfNeeded();
    // Click the card title (see firstCard note below): on a narrow viewport the
    // card body center can land on an embedded artifact link, which switches the
    // tab to Files instead of opening the task detail.
    await readyCard.locator(".work-card-title").click({ force: true });
    await page.waitForSelector("#taskDetailPane.open", { timeout: 10000 });
    const groupedDetailText = await page.textContent("#taskDetailBody");
    result.checks.groupedCardOpensDetail =
      groupedDetailText.includes("Work ready for review task") &&
      groupedDetailText.includes("本地时间线");
    await closeTaskDetailPane(page);
    await page.click('[data-work-view="table"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });

    await page.click('[data-work-filter="review"]');
    await page.waitForFunction(() => {
      const panel = document.querySelector("#workPanel");
      return panel && panel.textContent.includes("Work ready for review task");
    });
    const reviewText = await page.textContent("#workPanel");
    result.checks.reviewFilterKeepsReadyTask =
      reviewText.includes("Work ready for review task") && !reviewText.includes("Work pending task");

    await page.click('[data-work-filter="done"]');
    await page.waitForFunction(() => {
      const panel = document.querySelector("#workPanel");
      return panel && panel.textContent.includes("Work approved task");
    });
    const doneText = await page.textContent("#workPanel");
    result.checks.doneFilterKeepsApprovedTask =
      doneText.includes("Work approved task") && !doneText.includes("Work pending task");

    await page.click('[data-work-filter="all"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    const firstRow = page.locator(".work-table .work-row").first();
    await firstRow.scrollIntoViewIfNeeded();
    await firstRow.click({ force: true });
    await page.waitForTimeout(100);
    if (!(await page.locator("#taskDetailPane.open").count())) {
      await page.evaluate(() => {
        const row = document.querySelector(".work-table .work-row");
        if (row) row.click();
      });
    }
    await page.waitForSelector("#taskDetailPane.open", { timeout: 10000 });
    result.checks.taskDetailOpened = true;
    const detailText = await page.textContent("#taskDetailBody");
    result.checks.taskDetailShowsContext =
      detailText.includes("Work Smoke Orchestration") || detailText.includes("编排");
    // Task detail timeline section renders
    result.checks.detailTimelineLabels =
      detailText.includes("本地时间线") &&
      detailText.includes("Created");
    // Task detail status pill renders
    result.checks.detailStatusPill = await page.locator("#taskDetailBody .pill").count() > 0;
    result.checks.detailLabelsVisible =
      detailText.includes("acceptance") ||
      detailText.includes("artifacts") ||
      detailText.includes("agent");

    // Close task detail drawer so filter buttons are reachable
    await closeTaskDetailPane(page);
    // Check status pills in work table (switch back to "all" filter)
    await page.click('[data-work-filter="all"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    const pillInfo = await page.evaluate(() => {
      const rows = document.querySelectorAll(".work-row");
      const info = {};
      rows.forEach(function (row) {
        var title = (row.querySelector(".work-task-title") || row.querySelector(".col-task") || {}).textContent || "";
        var pill = row.querySelector(".col-status .pill");
        var orch = (row.querySelector(".col-orch") || {}).textContent || "";
        var agent = (row.querySelector(".col-agent") || {}).textContent || "";
        var labels = Array.from(row.querySelectorAll(".work-label")).map(function (label) {
          return (label.textContent || "").trim();
        });
        if (!pill) return;
        info[title.trim()] = {
          text: (pill.textContent || "").trim(),
          cls: pill.className || "",
          orch: orch.trim(),
          agent: agent.trim(),
          labels: labels,
        };
      });
      return info;
    });
    result.checks.workTablePillsRendered = Object.keys(pillInfo).length >= 4;
    // Verify status pill classes match expected lifecycle groups
    result.checks.pendingPillRendered = !!(pillInfo["Work pending task"]);
    result.checks.dispatchedPillRendered = !!(pillInfo["Work dispatched task"]);
    result.checks.readyPillGroupWarn = (pillInfo["Work ready for review task"] || {}).cls.indexOf("warn") !== -1;
    result.checks.approvedPillGroupGood = (pillInfo["Work approved task"] || {}).cls.indexOf("good") !== -1;
    // Work table orchestration and agent columns render
    result.checks.tableOrchColumnRendered = Object.values(pillInfo).some(function (p) { return p.orch.length > 0; });
    result.checks.tableAgentColumnRendered = Object.values(pillInfo).some(function (p) { return p.agent.length > 0; });
    result.checks.tableLabelsRendered = Object.values(pillInfo).some(function (p) {
      return Array.isArray(p.labels) && p.labels.some(function (label) { return label.indexOf("acceptance") !== -1; });
    });
    // Batch101C: the API task row exposes the batch title only through labels[]
    // (no top-level batch_label), so a "batch: <orchestration title>" chip on a
    // work row proves the labels[] lookup path in readBatchLabel().
    result.checks.workRowBatchLabelFromLabels = Object.values(pillInfo).some(function (p) {
      return Array.isArray(p.labels) && p.labels.some(function (label) {
        return label.indexOf("batch:") !== -1 && label.indexOf("Work Smoke Orchestration") !== -1;
      });
    });

    // ── Saved-view chips assertions ──
    const savedViewsContainer = await page.$('[data-work-saved-views]');
    result.checks.savedViewsRendered = !!savedViewsContainer;
    const savedChips = await page.$$('[data-saved-view]');
    result.checks.savedViewChipCount = savedChips.length >= 5;
    const allChipActive = await page.evaluate(function () {
      var chip = document.querySelector('[data-saved-view=""]');
      return chip && chip.classList.contains("active");
    });
    result.checks.allSavedViewActiveByDefault = !!allChipActive;
    // Click "阻塞/失败" saved view and verify it filters
    await page.click('[data-saved-view="blocked"]');
    await page.waitForTimeout(300);
    const blockedSavedText = await page.textContent("#workPanel");
    result.checks.blockedSavedViewFilters = !blockedSavedText.includes("Work pending task");
    // Click back to "全部" to clear saved view
    await page.click('[data-saved-view=""]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    const clearedText = await page.textContent("#workPanel");
    result.checks.clearSavedViewShowsAll = clearedText.includes("Work pending task");

    // ── Summary cards assertions ──
    const summaryContainer = await page.$('[data-work-summary]');
    result.checks.summaryRendered = !!summaryContainer;
    const summaryCards = await page.$$('.work-summary-card');
    result.checks.summaryCardCount = summaryCards.length >= 5;
    const summaryTotal = await page.evaluate(function () {
      var card = document.querySelector('.work-summary-card .summary-val');
      return card ? card.textContent : "";
    });
    result.checks.summaryTotalRendered = parseInt(summaryTotal, 10) >= 4;

    // ── Grouped view assertions ──
    const viewSwitcher = await page.$(".work-view-switcher");
    result.checks.viewSwitcherExists = !!viewSwitcher;
    const viewBtns = await page.$$("[data-work-view]");
    result.checks.viewSwitcherHasTwoButtons = viewBtns.length === 2;
    const tableBtnActive = await page.evaluate(function () {
      var btn = document.querySelector('[data-work-view="table"]');
      return btn && btn.classList.contains("active");
    });
    result.checks.tableViewActiveByDefault = !!tableBtnActive;

    // Switch to grouped view
    await page.click('[data-work-view="grouped"]');
    await page.waitForSelector(".work-grouped", { timeout: 5000 });
    result.checks.groupedViewRendered = true;

    // Check group headers and counts
    const groupInfo = await page.evaluate(function () {
      var groups = document.querySelectorAll(".work-group");
      var info = {};
      groups.forEach(function (g) {
        var key = g.dataset.groupKey || "";
        var title = (g.querySelector(".work-group-title") || {}).textContent || "";
        var count = (g.querySelector(".work-group-count") || {}).textContent || "";
        var bodyTasks = g.querySelectorAll(".work-card");
        var taskTitles = Array.from(bodyTasks).map(function (c) {
          return (c.querySelector(".work-card-title") || {}).textContent || "";
        });
        info[key] = { title: title.trim(), count: count, taskCount: bodyTasks.length, taskTitles: taskTitles };
      });
      return info;
    });
    result.checks.groupedGroupsFound = Object.keys(groupInfo).length >= 2;
    result.checks.groupOpenCount = !!(groupInfo.open && parseInt(groupInfo.open.count, 10) >= 1);
    result.checks.groupReviewCount = !!(groupInfo.review && parseInt(groupInfo.review.count, 10) >= 1);
    result.checks.groupDoneCount = !!(groupInfo.done && parseInt(groupInfo.done.count, 10) >= 1);
    result.checks.groupOpenContainsPending = groupInfo.open && groupInfo.open.taskTitles.some(function (t) { return t.indexOf("Work pending task") !== -1; });
    result.checks.groupOpenContainsDispatched = groupInfo.open && groupInfo.open.taskTitles.some(function (t) { return t.indexOf("Work dispatched task") !== -1; });
    result.checks.groupReviewContainsReady = groupInfo.review && groupInfo.review.taskTitles.some(function (t) { return t.indexOf("Work ready for review task") !== -1; });
    result.checks.groupDoneContainsApproved = groupInfo.done && groupInfo.done.taskTitles.some(function (t) { return t.indexOf("Work approved task") !== -1; });

    // Check grouped cards have status pills and work labels
    const cardPillInfo = await page.evaluate(function () {
      var cards = document.querySelectorAll(".work-card");
      var info = {};
      cards.forEach(function (card) {
        var title = (card.querySelector(".work-card-title") || {}).textContent || "";
        var pill = card.querySelector(".work-card-status .pill");
        var labels = Array.from(card.querySelectorAll(".work-label")).map(function (l) { return (l.textContent || "").trim(); });
        if (!pill) return;
        info[title.trim()] = {
          pillText: (pill.textContent || "").trim(),
          pillCls: pill.className || "",
          labels: labels,
        };
      });
      return info;
    });
    result.checks.groupedCardsHaveStatusPills = Object.keys(cardPillInfo).length >= 4;
    result.checks.groupedCardLabelsRendered = Object.values(cardPillInfo).some(function (c) {
      return Array.isArray(c.labels) && c.labels.some(function (l) { return l.indexOf("acceptance") !== -1; });
    });
    result.checks.groupedCardPendingPill = !!(cardPillInfo["Work pending task"]);
    result.checks.groupedCardReadyPillWarn = (cardPillInfo["Work ready for review task"] || {}).pillCls.indexOf("warn") !== -1;
    result.checks.groupedCardApprovedPillGood = (cardPillInfo["Work approved task"] || {}).pillCls.indexOf("good") !== -1;

    // Click a grouped card → open task detail drawer.
    // Click the card *title* rather than the card body: a card with artifacts
    // renders embedded `.work-artifact-link` spans, and on a narrow viewport the
    // card's geometric center lands on one of them. Clicking an artifact link
    // calls openArtifactPath() and switches the tab to Files (the work panel is
    // then hidden, so the view-switcher control resolves but is not visible).
    // The title is a block element at the top of the card and reliably opens
    // the task detail without hitting an artifact link.
    const firstCard = page.locator(".work-card").first();
    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.locator(".work-card-title").click({ force: true });
    await page.waitForTimeout(100);
    if (!(await page.locator("#taskDetailPane.open").count())) {
      await page.evaluate(function () {
        var card = document.querySelector(".work-card");
        if (card) card.click();
      });
    }
    await page.waitForSelector("#taskDetailPane.open", { timeout: 10000 });
    result.checks.groupedCardDetailOpened = true;
    const cardDetailText = await page.textContent("#taskDetailBody");
    result.checks.groupedCardDetailShowsContent = cardDetailText.includes("Work Smoke Orchestration") || cardDetailText.includes("编排");

    // Close detail and switch back to table view
    await closeTaskDetailPane(page);
    await page.click('[data-work-view="table"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });

    // Verify existing table filter assertions still pass after switching back
    const reboundPills = await page.evaluate(function () {
      var rows = document.querySelectorAll(".work-row");
      var info = {};
      rows.forEach(function (row) {
        var title = (row.querySelector(".work-task-title") || {}).textContent || "";
        var pill = row.querySelector(".col-status .pill");
        if (!pill) return;
        info[title.trim()] = {
          text: (pill.textContent || "").trim(),
          cls: pill.className || "",
        };
      });
      return info;
    });
    result.checks.tablePillsStillRenderAfterGroupedSwitch = Object.keys(reboundPills).length >= 4;
    result.checks.tablePendingPillAfterSwitch = !!(reboundPills["Work pending task"]);
    result.checks.tableReadyPillWarnAfterSwitch = (reboundPills["Work ready for review task"] || {}).cls.indexOf("warn") !== -1;
    result.checks.tableApprovedPillGoodAfterSwitch = (reboundPills["Work approved task"] || {}).cls.indexOf("good") !== -1;

    // ── Saved-view chip count after interactions ──
    const savedChips2 = await page.$$(".work-saved-chip");
    result.checks.savedViewChipsRender2 = savedChips2.length >= 4;
    const summaryText2 = await page.textContent("#workPanel");
    result.checks.summaryLifecycleVisible2 =
      summaryText2.includes("总计") &&
      (summaryText2.includes("进行中") || summaryText2.includes("待评审")) &&
      (summaryText2.includes("阻塞") || summaryText2.includes("完成"));

    // Summary linked counts visible (our smoke seeds have artifacts)
    result.checks.summaryLinkedCountsVisible2 =
      summaryText2.includes("有产物") || summaryText2.includes("已关联") || summaryText2.includes("Agent");

    // Apply "待评审" saved view → filter to ready tasks only
    await page.click('[data-saved-view="review"]');
    await page.waitForTimeout(300);
    const reviewViewText = await page.textContent("#workPanel");
    result.checks.reviewSavedViewShowsReviewTask =
      reviewViewText.includes("Work ready for review task") && !reviewViewText.includes("Work pending task");
    const reviewSummaryTotal = await page.evaluate(function () {
      var card = document.querySelector('.work-summary-card .summary-val');
      return card ? (card.textContent || "").trim() : "";
    });
    result.checks.reviewSavedViewSummaryUsesFilteredTotal = parseInt(reviewSummaryTotal, 10) === 1;
    const reviewChips = await page.$$(".work-saved-chip.active");
    result.checks.reviewSavedViewChipActive = reviewChips.length >= 1;

    // Apply "有产物" saved view → filter to tasks with artifacts
    await page.click('[data-saved-view="has_artifacts"]');
    await page.waitForTimeout(300);
    const artifactsViewText = await page.textContent("#workPanel");
    result.checks.artifactsSavedViewWorks =
      artifactsViewText.includes("Work approved task") || artifactsViewText.includes("Work ready for review task");
    const artifactsChips = await page.$$(".work-saved-chip.active");
    result.checks.artifactsSavedViewChipActive = artifactsChips.length >= 1;

    // Clear saved view → "全部" returns all tasks
    await page.click('[data-saved-view=""]');
    await page.waitForTimeout(300);
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    const clearedRows = await page.$$(".work-table .work-row");
    result.checks.savedViewClearedReturnsAll = clearedRows.length >= 4;

    // Table/grouped switching still works after saved views
    await page.click('[data-work-view="grouped"]');
    await page.waitForSelector(".work-grouped .work-card", { timeout: 10000 });
    const groupedAfterSavedView = await page.$$(".work-grouped .work-card");
    result.checks.groupedViewWorksAfterSavedView = groupedAfterSavedView.length >= 4;
    await page.click('[data-work-view="table"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
    const tableAfterSavedView = await page.$$(".work-table .work-row");
    result.checks.tableViewWorksAfterSavedView = tableAfterSavedView.length >= 4;

    // Verify no fake issue creation/milestone/external notification/provider controls
    const bodyHtml = await page.evaluate(function () {
      var panel = document.querySelector("#workPanel");
      return panel ? panel.innerHTML : "";
    });
    result.checks.noFakeCreateIssueControl = bodyHtml.indexOf("create-issue") === -1 && bodyHtml.indexOf("newIssue") === -1;
    result.checks.noFakeMilestoneControl = bodyHtml.indexOf("milestone") === -1;
    result.checks.noFakeExternalNotification = bodyHtml.indexOf("notification-settings") === -1;

    // ── Saved-query persisted-filter browser checks (Batch89) ──
    const savedQueryMgmt = await page.$('[data-work-custom-queries]');
    result.checks.savedQueryManagementRendered = !!savedQueryMgmt;
    const saveQueryBtn = await page.$('[data-cq-add]');
    result.checks.saveQueryButtonRendered = !!saveQueryBtn;
    if (savedQueryMgmt) {
      var queryItems = await page.$$('[data-cq-id]');
      result.checks.savedQueryItemsFound = queryItems.length >= 1;
      var seededQuery = await page.$('[data-cq-id="' + seeded.savedQueryId + '"]');
      result.checks.seededSavedQueryRendered = !!seededQuery;
      if (seededQuery) {
        await seededQuery.click();
        await page.waitForTimeout(300);
        await page.waitForSelector(".work-table .work-row", { timeout: 10000 });
        var seededRows = await page.$$(".work-table .work-row");
        var seededBody = await page.evaluate(function () {
          var panel = document.querySelector("#workPanel");
          return panel ? panel.innerText : "";
        });
        result.checks.seededSavedQueryFiltersReview = seededRows.length === 1 && seededBody.indexOf("Work ready for review task") !== -1;
      }
      if (saveQueryBtn) {
        await page.click('[data-saved-view="review"]');
        await page.waitForTimeout(200);
        var freshSaveQueryBtn = await page.$('[data-cq-add]');
        result.checks.saveQueryButtonRenderedAfterReview = !!freshSaveQueryBtn;
        if (!freshSaveQueryBtn) throw new Error("Saved-query create button disappeared after applying review saved view");
        await freshSaveQueryBtn.click();
        await page.waitForTimeout(200);
        var createInput = await page.$('[data-cq-create-input]');
        result.checks.saveQueryCreatePopoverRendered = !!createInput;
        if (createInput) {
          await createInput.fill("PM Review Query");
          await page.click('[data-cq-create-save]');
          await page.waitForTimeout(600);
          var queryItemsAfterCreate = await page.$$('[data-cq-id]');
          result.checks.saveQueryCreateWorks = queryItemsAfterCreate.length >= 2;
        }
        // Verify built-in views still work after save attempt
        var chipsAfterSave = await page.$$('[data-saved-view]');
        result.checks.savedViewsRenderAfterSaveAttempt = chipsAfterSave.length >= 5;
        // Verify grouped/table view still works
        await page.click('[data-work-view="grouped"]');
        await page.waitForSelector(".work-grouped .work-card", { timeout: 5000 }).catch(function () {});
        var gCardsAfterSave = await page.$$(".work-grouped .work-card");
        result.checks.groupedWorksAfterSaveAttempt = gCardsAfterSave.length >= 1;
        await page.click('[data-work-view="table"]');
        await page.waitForSelector(".work-table .work-row", { timeout: 5000 }).catch(function () {});
        var tRowsAfterSave = await page.$$(".work-table .work-row");
        result.checks.tableWorksAfterSaveAttempt = tRowsAfterSave.length >= 1;
      }
      // Test rename/delete controls handling
      var manageBtns = await page.$$('[data-cq-manage]');
      result.checks.savedQueryManageButtonsFound = manageBtns.length > 0;
      // Check read-only state for restricted mutation controls
      var mutationControls = await page.$$('[data-cq-add],[data-cq-manage]');
      result.checks.savedQueryMutationControlsPresentForOwner = mutationControls.length > 0;
    }

    // ── Batch101 aggregate timeline (UI fallback path) ──
    // The backend returns summary.timeline as an array of per-date buckets, while
    // the UI renderer reads a single aggregate object (timeline.created); in
    // normal API integration the timeline section therefore renders via the
    // documented UI fallback path (summary fields absent -> counts derived from
    // real task rows). Exercise that fallback deterministically: pre-fetch the
    // real task-list payload, strip summary.timeline and summary.batches, serve it
    // via route interception, reload the Work tab, and assert the timeline
    // section now renders with at least one non-zero local count from task rows.
    var realPayload = await api(
      seeded.baseUrl,
      "GET",
      `/v1/projects/${seeded.projectId}/orchestration-tasks`,
      seeded.token
    );
    var strippedPayload = JSON.parse(JSON.stringify(realPayload.data || {}));
    if (strippedPayload.summary) {
      delete strippedPayload.summary.timeline;
      delete strippedPayload.summary.batches;
    }
    await page.route(function (url) {
      return !!url.pathname && url.pathname.indexOf("/orchestration-tasks") !== -1 &&
        url.pathname.indexOf("/orchestration-tasks/") === -1;
    }, async function (route) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(strippedPayload)
      });
    });
    await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${seeded.projectId}&tab=issues`, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="work"].active', { timeout: 10000 });
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 });

    var timelineInfo = await page.evaluate(function () {
      var section = document.querySelector("[data-work-timeline-summary]");
      var items = Array.from(document.querySelectorAll(".work-timeline-item"));
      var vals = items.map(function (it) {
        var v = it.querySelector(".tl-val");
        return v ? parseInt((v.textContent || "0").trim(), 10) : 0;
      });
      var labels = items.map(function (it) {
        var l = it.querySelector(".tl-label");
        return l ? ((l.textContent || "")).trim() : "";
      });
      return {
        sectionPresent: !!section,
        itemCount: items.length,
        maxVal: vals.length ? Math.max.apply(null, vals) : 0,
        labels: labels
      };
    });
    result.checks.timelineSectionRendersViaFallback = !!timelineInfo.sectionPresent;
    result.checks.timelineHasBucketItems = timelineInfo.itemCount >= 1;
    result.checks.timelineHasLocalCountFromTasks = timelineInfo.maxVal >= 1;
    result.checks.timelineShowsCreatedBucket = timelineInfo.labels.indexOf("已创建") !== -1;

    // #7: grouped switching still works after the batch/timeline sections render.
    // (The existing smoke already proves table/grouped/saved-view switching
    // extensively on the real-API state with the batch section present; this is a
    // final confirmation that the new sections do not break view switching.)
    await page.click('[data-work-view="grouped"]');
    await page.waitForSelector(".work-grouped .work-card", { timeout: 10000 });
    result.checks.groupedViewWorksAfterBatchTimeline = (await page.$$(".work-grouped .work-card")).length >= 1;
    await page.click('[data-work-view="table"]');
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 }).catch(function () {});

    // #8: fake controls remain absent in the panel (including the batch/timeline sections).
    var panelHtmlFinal = await page.evaluate(function () {
      var panel = document.querySelector("#workPanel");
      return panel ? panel.innerHTML : "";
    });
    result.checks.noFakeIssueControlInBatchTimeline = panelHtmlFinal.indexOf("create-issue") === -1 && panelHtmlFinal.indexOf("newIssue") === -1;
    result.checks.noFakeMilestoneInBatchTimeline = panelHtmlFinal.indexOf("milestone") === -1;
    result.checks.noFakeNotificationInBatchTimeline = panelHtmlFinal.indexOf("notification-settings") === -1;
    result.checks.noFakeProviderControlsInBatchTimeline =
      panelHtmlFinal.indexOf("data-clone") === -1 &&
      panelHtmlFinal.indexOf("provider-sync") === -1 &&
      panelHtmlFinal.indexOf("external-webhook") === -1 &&
      panelHtmlFinal.indexOf("data-gitea") === -1 &&
      panelHtmlFinal.indexOf("data-github") === -1;

    // Best-effort restore of the real API path for the final screenshot. Not gated
    // (page.unroute() reliability varies by Playwright build); the batch section is
    // already proven by the earlier real-API assertions regardless.
    await page.unroute().catch(function () {});
    await page.goto(`${seeded.baseUrl}/project-space.html?project_id=${seeded.projectId}&tab=issues`, { waitUntil: "networkidle" }).catch(function () {});
    await page.waitForSelector(".work-table .work-row", { timeout: 10000 }).catch(function () {});

    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);
    result.passed = allTrue(result.checks);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
  }
  return result;
}

async function closeTaskDetailPane(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  if ((await page.locator("#taskDetailPane.open").count()) > 0) {
    await page.locator("#closeTaskDetailBtn").click({ force: true });
  }
  await page.waitForSelector("#taskDetailPane:not(.open)", { timeout: 5000 });
}

async function register(baseUrl, prefix) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Date.now()}@example.invalid`,
    password: "SmokeTest123!",
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error(`Register failed: ${res.status}`);
  return { token: res.data.access_token, userId: res.data.user.id };
}

function api(baseUrl, method, route, token, body) {
  return request(baseUrl, method, route, token ? { Authorization: `Bearer ${token}` } : {}, body);
}

function apiWithKey(baseUrl, method, route, key, body) {
  return request(baseUrl, method, route, { "X-API-Key": key }, body);
}

function request(baseUrl, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function allTrue(obj) {
  var entries = Object.entries(obj || {});
  return entries.every(function (entry) {
    var key = entry[0], value = entry[1];
    if (key.startsWith("_")) return true; // debug-only keys
    return value === true || (value && typeof value === "object" && allTrue(value));
  });
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_JSON;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  const lines = [
    "# Project Space Work Smoke Evidence",
    "",
    `- command: \`${result.command}\``,
    `- passed: ${result.passed}`,
    `- skipped: ${result.skipped}`,
    `- browserAvailable: ${result.browserAvailable}`,
    `- screenshot: ${result.screenshotPath || "n/a"}`,
    "",
    "## Checks",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ];
  if (result.errors.length) lines.push("", "## Errors", "```", result.errors.join("\n\n"), "```");
  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));
}

async function cleanup() {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  try {
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
}

main();
