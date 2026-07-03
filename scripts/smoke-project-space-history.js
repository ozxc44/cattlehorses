#!/usr/bin/env node
// Project Space History / Commits — browser/runtime smoke harness.
//
// Starts the built backend with SERVE_DASHBOARD=1, seeds a real project with a
// changeset, approves and merges it to produce a commit, then opens
// /project-space.html?project_id=...&tab=history in Chromium via Playwright.
//
// If Playwright is not resolvable, the script still verifies backend data setup
// and static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-history.js
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
const ARTIFACT_SUBDIR = process.env.HISTORY_SMOKE_ARTIFACT_DIR || "project-space-history-smoke";
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", ARTIFACT_SUBDIR);
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");
const SNAPSHOT_CONTENT = "# History Smoke\n\nupdated content at commit";
const LIVE_CONTENT_AFTER_COMMIT = "# History Smoke\n\nlive content after commit";

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

function shortId(id) {
  return id ? id.slice(0, 8) : "";
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: process.env.HISTORY_SMOKE_COMMAND_LABEL || "node scripts/smoke-project-space-history.js",
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
      userCreated: !!seeded.token,
      projectCreated: !!seeded.projectId,
      commitCreated: !!seeded.commitId,
      branchesAvailable: seeded.branchesOk,
      commitsAvailable: seeded.commitsOk,
      commitSnapshotHasRevision: seeded.commitSnapshotHasRevision,
      liveUpdateAfterCommit: seeded.liveUpdateAfterCommit,
      revisionApiHasSnapshotContent: seeded.revisionApiHasSnapshotContent,
      revisionApiHasLiveContent: seeded.revisionApiHasLiveContent,
      commitVerificationVerified: seeded.commitVerificationVerified,
      commitVerificationLocalOnly: seeded.commitVerificationLocalOnly,
      commitVerificationNotCryptographic: seeded.commitVerificationNotCryptographic,
      rollbackCommitUnverified: seeded.rollbackCommitUnverified,
    };

    // ── 2. Static JS wiring check (always runs) ─────────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    if (!playwright) {
      result.skipped = true;
      result.passed = allChecksPassed(result.checks.backendSeed) && allChecksPassed(staticOk);
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
    result.passed =
      allChecksPassed(result.checks.backendSeed) &&
      allChecksPassed(result.checks.staticWiring) &&
      browserResult.passed;
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

function allChecksPassed(checks) {
  return Object.values(checks || {}).every((value) => value === true);
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
  process.env.JWT_SECRET = "project-space-history-smoke-secret";
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

  const email = `history-smoke-${Date.now()}@example.invalid`;
  const password = "SmokeTest123!";

  const registerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email,
    password,
    display_name: "History Smoke",
  });
  if (registerRes.status !== 201) {
    throw new Error(`Register failed: ${registerRes.status} ${JSON.stringify(registerRes.data)}`);
  }
  const token = registerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "History Smoke Project",
    description: "Browser smoke for Project Space History",
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
      content: "# History Smoke\n\noriginal content",
      message: "Initial README",
    }
  );
  if (baseFileRes.status !== 201) {
    throw new Error(`Base file create failed: ${baseFileRes.status} ${JSON.stringify(baseFileRes.data)}`);
  }

  const changesetRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets`,
    token,
    {
      title: "Update README",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: SNAPSHOT_CONTENT,
          base_revision_id: baseFileRes.data.current_revision_id,
        },
      ],
    }
  );
  if (changesetRes.status !== 201) {
    throw new Error(`Changeset create failed: ${changesetRes.status} ${JSON.stringify(changesetRes.data)}`);
  }
  const changesetId = changesetRes.data.id;

  const approveRes = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/changesets/${changesetId}/review`,
    token,
    { decision: "approved", notes: "Looks good." }
  );
  if (approveRes.status !== 200) {
    throw new Error(`Approve failed: ${approveRes.status} ${JSON.stringify(approveRes.data)}`);
  }

  const mergeRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/changesets/${changesetId}/merge`,
    token
  );
  if (mergeRes.status !== 200) {
    throw new Error(`Merge failed: ${mergeRes.status} ${JSON.stringify(mergeRes.data)}`);
  }
  const commitId = mergeRes.data.commit && mergeRes.data.commit.id;
  const mergeVerification = mergeRes.data.commit && mergeRes.data.commit.verification;
  if (!commitId) {
    throw new Error(`Merge did not return commit id: ${JSON.stringify(mergeRes.data)}`);
  }

  const commitDetailRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/commits/${commitId}`, token);
  if (commitDetailRes.status !== 200) {
    throw new Error(`Commit detail failed: ${commitDetailRes.status} ${JSON.stringify(commitDetailRes.data)}`);
  }
  const detailVerification = commitDetailRes.data.verification;
  const readmeSnapshot = commitDetailRes.data.snapshot && commitDetailRes.data.snapshot["README.md"];
  const readmeFileId = readmeSnapshot && readmeSnapshot.file_id;
  const snapshotRevisionId = readmeSnapshot && readmeSnapshot.revision_id;
  const commitSnapshotHasRevision = !!(readmeFileId && snapshotRevisionId);
  if (!commitSnapshotHasRevision) {
    throw new Error(`Commit snapshot missing README revision metadata: ${JSON.stringify(commitDetailRes.data.snapshot)}`);
  }

  const liveUpdateRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/files`,
    token,
    {
      path: "README.md",
      content: LIVE_CONTENT_AFTER_COMMIT,
      message: "Live README update after commit",
      base_revision_id: snapshotRevisionId,
    }
  );
  if (liveUpdateRes.status !== 200) {
    throw new Error(`Live file update failed: ${liveUpdateRes.status} ${JSON.stringify(liveUpdateRes.data)}`);
  }

  const rollbackRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/rollback`,
    token,
    {
      target_commit_id: commitId,
      message: "Rollback for commit verification smoke",
    }
  );
  if (rollbackRes.status !== 200) {
    throw new Error(`Rollback failed: ${rollbackRes.status} ${JSON.stringify(rollbackRes.data)}`);
  }
  const rollbackCommitId = rollbackRes.data.commit && rollbackRes.data.commit.id;
  const rollbackVerification = rollbackRes.data.commit && rollbackRes.data.commit.verification;

  const revisionsRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/files/${readmeFileId}/revisions`, token);
  if (revisionsRes.status !== 200 || !Array.isArray(revisionsRes.data.data)) {
    throw new Error(`Revision list failed: ${revisionsRes.status} ${JSON.stringify(revisionsRes.data)}`);
  }
  const snapshotRevision = revisionsRes.data.data.find((revision) => revision.id === snapshotRevisionId);
  const liveRevision = revisionsRes.data.data.find((revision) => revision.content === LIVE_CONTENT_AFTER_COMMIT);
  const revisionApiHasSnapshotContent = !!snapshotRevision && snapshotRevision.content === SNAPSHOT_CONTENT;
  const revisionApiHasLiveContent = !!liveRevision;

  const branchesRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/branches`, token);
  const branchesOk =
    branchesRes.status === 200 &&
    Array.isArray(branchesRes.data.data) &&
    branchesRes.data.data.length >= 1;

  const commitsRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/commits`, token);
  const commitsOk =
    commitsRes.status === 200 &&
    Array.isArray(commitsRes.data.data) &&
    commitsRes.data.data.length >= 1;

  return {
    baseUrl,
    token,
    projectId,
    changesetId,
    commitId,
    readmeFileId,
    snapshotRevisionId,
    snapshotContent: SNAPSHOT_CONTENT,
    liveContentAfterCommit: LIVE_CONTENT_AFTER_COMMIT,
    rollbackCommitId,
    commitSnapshotHasRevision,
    liveUpdateAfterCommit: liveUpdateRes.status === 200,
    revisionApiHasSnapshotContent,
    revisionApiHasLiveContent,
    commitVerificationVerified:
      mergeVerification &&
      mergeVerification.status === "verified" &&
      mergeVerification.verified === true &&
      detailVerification &&
      detailVerification.status === "verified",
    commitVerificationLocalOnly:
      mergeVerification &&
      mergeVerification.local_only === true &&
      detailVerification &&
      detailVerification.local_only === true,
    commitVerificationNotCryptographic:
      mergeVerification &&
      mergeVerification.cryptographic === false &&
      detailVerification &&
      detailVerification.cryptographic === false &&
      /not GPG\/SSH/i.test(String(detailVerification.description || mergeVerification.description || "")),
    rollbackCommitUnverified:
      rollbackVerification &&
      rollbackVerification.status === "unverified" &&
      rollbackVerification.verified === false &&
      rollbackVerification.source === "local_rollback",
    branchesOk,
    commitsOk,
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.historyTabMarkup =
      html.includes('data-tab="history"') && html.includes('id="historyPanel"');

    checks.commitDetailMarkup =
      html.includes('id="commitDetailPane"') &&
      html.includes('id="commitDetailTitle"') &&
      html.includes('id="commitDetailBody"');

    checks.historyTableWired =
      html.includes("history-table") && html.includes("history-row");

    checks.branchesApiCall = html.includes('/branches"');
    checks.commitsApiCall = html.includes('/commits"');

    checks.noRollbackButton =
      !html.includes("/rollback") &&
      !html.includes("data-cs-action=\"rollback\"");

    checks.snapshotPreviewWired =
      html.includes("openSnapshotPreview") &&
      html.includes("snapshot-file-row") &&
      html.includes("snapshot-preview") &&
      html.includes("encodeURIComponent(fileId)");

    checks.commitVerificationBadgeWired =
      html.includes("commitVerification") &&
      html.includes("commitVerifyBadge") &&
      html.includes("commit-verify-badge");

    checks.commitVerificationColumn =
      html.includes("col-verify") && html.includes("本地验证");

    checks.commitVerificationHonest =
      html.includes("非 GPG/SSH") &&
      !/require signed commits|key upload|sigstore|上传密钥|签名策略/i.test(html);

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
      baseUrl: origin,
    });

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
      )}&tab=history`;

    await page.goto(url, { waitUntil: "networkidle" });

    await page.waitForSelector('.tab-item[data-tab="history"].active', {
      timeout: 10000,
    });
    result.checks.historyTabActive = true;

    await page.click('.tab-item[data-tab="history"]');

    // Summary cards render.
    await page.waitForSelector(".activity-card", { timeout: 10000 });
    const branchCardText = await page.textContent(".activity-card");
    result.checks.branchCountRendered = branchCardText && branchCardText.includes("分支");

    // Commits table renders.
    await page.waitForSelector(".history-table .history-row", {
      timeout: 10000,
    });
    result.checks.commitsListRendered = true;

    const targetCommitRow = `.history-row[data-commit-id="${seeded.commitId}"]`;
    await page.waitForSelector(targetCommitRow, { timeout: 10000 });

    // Target row contains the merged changeset title.
    const rowText = await page.textContent(targetCommitRow);
    result.checks.commitMessageRendered = rowText && rowText.includes("Update README");
    result.checks.commitVerificationBadgeRendered = rowText && rowText.includes("本地验证");

    const historyText = await page.textContent("#historyPanel");
    result.checks.rollbackUnverifiedRendered = historyText && historyText.includes("未验证");

    // Open the target commit row, not whichever commit happens to sort first.
    await page.click(targetCommitRow);
    await page.waitForSelector("#commitDetailPane.open", { timeout: 10000 });
    result.checks.commitDetailOpened = true;

    const bodyText = await page.textContent("#commitDetailBody");
    result.checks.commitIdVisible = bodyText && bodyText.includes(seeded.commitId);
    result.checks.changedFilesVisible = bodyText && bodyText.includes("README.md");
    result.checks.commitVerificationDetailRendered =
      bodyText &&
      bodyText.includes("本地验证") &&
      (bodyText.includes("非 GPG/SSH") || bodyText.includes("不代表 GPG/SSH"));
    result.checks.commitVerificationNoFakeCrypto =
      bodyText && !/require signed commits|key upload|sigstore|上传密钥|签名策略/i.test(bodyText);

    // Snapshot preview: snapshot file row is clickable and opens historical revision.
    await page.waitForSelector(".snapshot-file-row.clickable", { timeout: 10000 });
    const snapshotRow = await page.locator(".snapshot-file-row.clickable").first();
    result.checks.snapshotRowClickable = await snapshotRow.isVisible().catch(() => false);
    if (result.checks.snapshotRowClickable) {
      await snapshotRow.click();
      await page.waitForSelector("#previewPane.open.snapshot-preview", { timeout: 10000 });
      result.checks.snapshotPreviewOpened = true;

      // Wait for the revision API call to resolve before asserting content.
      await page.waitForFunction(
        () => {
          const content = document.querySelector("#previewContent");
          return content && content.textContent !== "加载中...";
        },
        { timeout: 10000 }
      );

      const previewText = await page.textContent("#previewContent");
      result.checks.snapshotPreviewHasHistoricalContent =
        previewText && previewText.includes(seeded.snapshotContent);
      result.checks.snapshotPreviewExcludesLiveContent =
        previewText && !previewText.includes(seeded.liveContentAfterCommit);

      const metaText = await page.textContent("#previewMeta");
      result.checks.snapshotPreviewContextLabelled =
        metaText &&
        metaText.includes("提交:") &&
        metaText.includes("版本:") &&
        metaText.includes(shortId(seeded.commitId)) &&
        metaText.includes(shortId(seeded.snapshotRevisionId));

      await page.click("#closePreviewBtn");
      await page.waitForSelector("#previewPane:not(.open)", { timeout: 5000 });
      result.checks.snapshotPreviewClosed = true;
    } else {
      result.checks.snapshotPreviewOpened = false;
      result.checks.snapshotPreviewHasHistoricalContent = false;
      result.checks.snapshotPreviewExcludesLiveContent = false;
      result.checks.snapshotPreviewContextLabelled = false;
      result.checks.snapshotPreviewClosed = false;
    }

    // Close detail and verify commit_id is cleaned from URL.
    await page.click("#closeCommitDetailBtn");
    await page.waitForFunction(
      () => !document.location.search.includes("commit_id="),
      { timeout: 5000 }
    );
    result.checks.commitIdCleanedFromUrl = true;

    // Verify tab alias: tab=commits should activate history.
    const aliasUrl =
      `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=commits`;
    await page.goto(aliasUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="history"].active', {
      timeout: 10000,
    });
    result.checks.commitsAliasActive = true;

    // Deep-link to commit detail via commit_id.
    const detailUrl =
      `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=history&commit_id=${encodeURIComponent(seeded.commitId)}`;
    await page.goto(detailUrl, { waitUntil: "networkidle" });
    await page.waitForSelector("#commitDetailPane.open", { timeout: 10000 });
    result.checks.commitIdDeepLinkOpened = true;

    // Cross-tab navigation: close the detail pane first. On mobile the pane is
    // full-width, so tab clicks behind it are not a valid user path.
    await page.click("#closeCommitDetailBtn", { force: true });
    await page.waitForSelector("#commitDetailPane:not(.open)", {
      timeout: 5000,
    });
    result.checks.detailClosedBeforeTabNavigation = true;

    await page.click('.tab-item[data-tab="files"]');
    await page.waitForSelector('#filesTabContent:not(.hidden)', {
      timeout: 5000,
    });
    result.checks.filesTabNavigable = true;

    // Return to History before screenshot.
    await page.click('.tab-item[data-tab="history"]');
    await page.waitForSelector('.tab-item[data-tab="history"].active', {
      timeout: 5000,
    });

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
    "# Project Space History / Commits — Browser Smoke Evidence",
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
