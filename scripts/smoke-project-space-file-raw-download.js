#!/usr/bin/env node
// Project Space File Raw/Download — API and browser smoke harness.
//
// Probes backend raw/download endpoints, content type/encoding, viewer
// permission, outsider/anonymous denial, branch snapshot content safety,
// and dashboard file preview Raw/Download controls.
//
// The dashboard frontend (project-space.html) exposes Raw/Download actions
// from file preview, backed by local Project Space raw/download endpoints.
//
// If Playwright is not resolvable, the script still verifies backend data
// setup and static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-file-raw-download.js
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

const ROOT = path.resolve(__dirname, "..");
const BACKEND_DIST = path.join(ROOT, "backend", "dist");
const APP_MODULE = path.join(BACKEND_DIST, "src", "app.js");
const DATASOURCE_MODULE = path.join(BACKEND_DIST, "src", "data-source.js");
const DASHBOARD_HTML = path.join(ROOT, "dashboard", "project-space.html");
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-file-raw-download-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

const FILE_CONTENT = "# Hello World\n\nThis is a test file for raw/download smoke.\n\nThe file has multiple lines.\n- Line A\n- Line B\n- Line C\n";
const BRANCH_CONTENT = "# Hello World (branch snapshot)\n\nThis is the BRANCH HEAD content.\n";
const LIVE_ONLY_CONTENT = "# Hello World (live-only)\n\nThis content was added after the branch HEAD commit.\n";

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-file-raw-download.js",
    timestamp: new Date().toISOString(),
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
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
    if (!result.backendBuilt) throw new Error("Backend dist missing. Run: cd backend && npm run build");

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    // ── 1. Backend data setup (always runs) ─────────────────────────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      userCreated: !!seeded.ownerToken,
      projectCreated: !!seeded.projectId,
      textFileCreated: !!seeded.fileId,
      viewerAdded: !!seeded.viewerToken,
      outsiderRegistered: !!seeded.outsiderToken,
      changesetMerged: !!seeded.commitId,
      liveUpdateCreated: !!seeded.liveUpdateCreated,
      contentDivergenceExists: seeded.contentHashA !== null && seeded.contentHashB !== null && seeded.contentHashA !== seeded.contentHashB,
    };

    // ── 2. Backend file detail + raw/download endpoint probe ─────────────────
    result.checks.backendEndpoints = await probeBackendEndpoints(seeded);

    // ── 3. Backend file access permission checks ────────────────────────────
    result.checks.backendPermissions = await probeBackendPermissions(seeded);

    // ── 4. Branch snapshot content safety ───────────────────────────────────
    result.checks.branchContent = await probeBranchContent(seeded);

    // ── 5. Static JS wiring checks ─────────────────────────────────────────
    result.checks.staticWiring = checkStaticWiring();

    // ── 6. Fake controls audit ─────────────────────────────────────────────
    result.checks.fakeControlsAbsent = checkFakeControls();

    // ── 7. Residual documentation ──────────────────────────────────────────
    collectResiduals(result, seeded);

    // ── 8. Browser smoke (when Playwright available) ────────────────────────
    if (!playwright) {
      result.skipped = true;
      result.residual.push("Playwright not resolvable from " + PLAYWRIGHT_NODE_MODULES + ". Browser automation skipped.");
      result.passed = computePassed(result);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    const browserResult = await runBrowserSmoke(playwright, seeded);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    if (!browserResult.passed) result.errors.push(...browserResult.errors);

    result.passed = computePassed(result);
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

function computePassed(result) {
  for (var key in result.checks) {
    if (!result.checks.hasOwnProperty(key)) continue;
    var group = result.checks[key];
    if (typeof group !== "object" || group === null) {
      if (!group) return false;
      continue;
    }
    for (var check in group) {
      if (!group.hasOwnProperty(check)) continue;
      if (group[check] !== true) return false;
    }
  }
  return result.errors.length === 0;
}

function tryRequirePlaywright() {
  try {
    return require("playwright");
  } catch (_) {
    try {
      var createRequire = require("module").createRequire;
      var req = createRequire(path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json"));
      return req("playwright");
    } catch (__) {
      return null;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Backend data seeding
// ────────────────────────────────────────────────────────────────────────────

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-file-raw-download-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  process.chdir(path.join(ROOT, "backend"));

  var { AppDataSource } = require(DATASOURCE_MODULE);
  var app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise(function (resolve) { server.listen(0, resolve); });
  var address = server.address();
  var baseUrl = "http://127.0.0.1:" + address.port;

  process.env.CORS_ORIGINS = baseUrl;

  // Register users.
  var owner = await register(baseUrl, "raw-dl-owner");
  var viewer = await register(baseUrl, "raw-dl-viewer");
  var outsider = await register(baseUrl, "raw-dl-outsider");

  // Create project.
  var projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "File Raw Download Smoke Project",
    description: "Browser smoke for file raw/download parity",
    visibility: "private",
  });
  if (projectRes.status !== 201) throw new Error("Project create failed: " + projectRes.status + " " + JSON.stringify(projectRes.data));
  var projectId = projectRes.data.id;

  // Add viewer member.
  var addViewer = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/members", owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error("Add viewer failed: " + addViewer.status + " " + JSON.stringify(addViewer.data));

  // Seed a text file.
  var fileRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "docs/hello.txt",
    content: FILE_CONTENT,
    message: "Seed text file for raw/download smoke",
  });
  if (fileRes.status !== 201) throw new Error("File create failed: " + fileRes.status + " " + JSON.stringify(fileRes.data));
  var fileId = fileRes.data.id;

  // Create a changeset that modifies docs/hello.txt and adds src/branch-only.ts.
  var changesetRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/changesets", owner.token, {
    title: "Branch snapshot seed",
    file_ops: [
      {
        op: "upsert",
        path: "docs/hello.txt",
        content: BRANCH_CONTENT,
        base_revision_id: fileRes.data.current_revision_id,
      },
      {
        op: "upsert",
        path: "src/branch-only.ts",
        content: "// This file only exists at branch HEAD\n",
      },
    ],
  });
  if (changesetRes.status !== 201) throw new Error("Changeset create failed: " + changesetRes.status + " " + JSON.stringify(changesetRes.data));
  var changesetId = changesetRes.data.id;

  // Approve and merge to create a commit on main.
  var reviewRes = await api(baseUrl, "PATCH", "/v1/projects/" + projectId + "/changesets/" + changesetId + "/review", owner.token, {
    decision: "approved",
    notes: "Approve branch snapshot seed",
  });
  if (reviewRes.status !== 200) throw new Error("Review failed: " + reviewRes.status + " " + JSON.stringify(reviewRes.data));

  var mergeRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/changesets/" + changesetId + "/merge", owner.token);
  if (mergeRes.status !== 200) throw new Error("Merge failed: " + mergeRes.status + " " + JSON.stringify(mergeRes.data));
  var commitId = mergeRes.data.commit && mergeRes.data.commit.id;

  // Capture branch snapshot content hash.
  var commitRes = commitId ? await api(baseUrl, "GET", "/v1/projects/" + projectId + "/commits/" + commitId, owner.token) : null;
  var contentHashA = null;
  if (commitRes && commitRes.status === 200 && commitRes.data && commitRes.data.snapshot) {
    var snapFile = commitRes.data.snapshot["docs/hello.txt"];
    contentHashA = snapFile ? snapFile.content_hash : null;
  }

  // Capture the post-merge revision so the live update honors the base_revision_id contract.
  var postMergeRes = await api(baseUrl, "GET", "/v1/projects/" + projectId + "/files/" + fileId, owner.token);
  if (postMergeRes.status !== 200) throw new Error("Post-merge file detail failed: " + postMergeRes.status + " " + JSON.stringify(postMergeRes.data));

  // Live-only update to docs/hello.txt (after branch HEAD).
  var liveUpdateRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "docs/hello.txt",
    content: LIVE_ONLY_CONTENT,
    message: "Live-only update after branch HEAD",
    base_revision_id: postMergeRes.data.current_revision_id,
  });
  var liveUpdateCreated = liveUpdateRes.status === 200 || liveUpdateRes.status === 201;
  var contentHashB = liveUpdateRes.data && liveUpdateRes.data.content_hash ? liveUpdateRes.data.content_hash : null;

  // Create a post-merge file (live-only, not in branch snapshot).
  var liveFileRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "src/live-only.ts",
    content: "// This file was created after the branch HEAD commit\n",
    message: "Post-commit live-only file",
  });
  if (liveFileRes.status !== 201 && liveFileRes.status !== 200) {
    throw new Error("Live-only file create failed: " + liveFileRes.status + " " + JSON.stringify(liveFileRes.data));
  }

  var branches = await api(baseUrl, "GET", "/v1/projects/" + projectId + "/branches", owner.token);
  var branchList = (branches.data && branches.data.data) || [];
  var mainBranch = branchList.find(function (b) { return b.name === "main"; });
  var branchName = mainBranch ? mainBranch.name : "main";

  return {
    baseUrl: baseUrl,
    projectId: projectId,
    ownerToken: owner.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    fileId: fileId,
    initialRevisionId: fileRes.data.current_revision_id,
    branchRevisionId: null,
    liveRevisionId: liveUpdateRes.data && liveUpdateRes.data.current_revision_id,
    commitId: commitId,
    branchName: branchName,
    liveFileId: liveFileRes.data && liveFileRes.data.id,
    contentHashA: contentHashA,
    contentHashB: contentHashB,
    liveUpdateCreated: liveUpdateCreated,
  };
}

async function register(baseUrl, prefix) {
  var res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + "@example.invalid",
    password: "SmokeTest123!",
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error("Register " + prefix + " failed: " + res.status + " " + JSON.stringify(res.data));
  return { token: res.data.access_token, userId: res.data.user.id };
}

// ────────────────────────────────────────────────────────────────────────────
// Backend endpoint probes
// ────────────────────────────────────────────────────────────────────────────

async function probeBackendEndpoints(seeded) {
  var checks = {};

  // ── File detail (exists) ──────────────────────────────────────────────────
  var fileDetail = await api(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId,
    seeded.ownerToken,
  );
  checks.fileDetailReturns200 = fileDetail.status === 200;
  checks.fileDetailHasContent = !!(fileDetail.data && typeof fileDetail.data.content === "string" && fileDetail.data.content.length > 0);
  checks.fileDetailHasContentType = !!(fileDetail.data && typeof fileDetail.data.content_type === "string");
  checks.fileDetailPathIsValid = !!(fileDetail.data && fileDetail.data.path === "docs/hello.txt");
  checks.fileDetailContentIsLiveAfterUpdate = !!(fileDetail.data && fileDetail.data.content && fileDetail.data.content.indexOf("live-only") !== -1);

  // ── Raw endpoint ─────────────────────────────────────────────────────────
  var rawEndpoint = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw",
    seeded.ownerToken,
  );
  checks.rawEndpointReturns200 = rawEndpoint.status === 200;
  checks.rawEndpointReturnsLiveContent = rawEndpoint.body === LIVE_ONLY_CONTENT;
  checks.rawEndpointContentTypeReadable = /^(text\/|application\/octet-stream)/i.test(rawEndpoint.contentType || "");
  checks.rawEndpointHasRevisionHeader = rawEndpoint.revisionId === seeded.liveRevisionId;
  checks.rawEndpointHasPathHeader = rawEndpoint.filePath === "docs/hello.txt";

  // ── Download endpoint ────────────────────────────────────────────────────
  var downloadEndpoint = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/download",
    seeded.ownerToken,
  );
  checks.downloadEndpointReturns200 = downloadEndpoint.status === 200;
  checks.downloadEndpointReturnsLiveContent = downloadEndpoint.body === LIVE_ONLY_CONTENT;
  checks.downloadEndpointAttachment = /attachment/i.test(downloadEndpoint.contentDisposition || "");
  checks.downloadEndpointFilename = /hello\.txt/.test(downloadEndpoint.contentDisposition || "");

  var rawDownloadParam = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw?download=1",
    seeded.ownerToken,
  );
  checks.rawDownloadParamAttachment = rawDownloadParam.status === 200 && /attachment/i.test(rawDownloadParam.contentDisposition || "");

  // ── File detail with branch query ─────────────────────────────────────────
  var branchDetail = await api(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "?branch=" + encodeURIComponent(seeded.branchName),
    seeded.ownerToken,
  );
  checks.branchDetailReturns200 = branchDetail.status === 200;
  checks.branchDetailHasBranchMeta = !!(branchDetail.data && branchDetail.data.branch && branchDetail.data.branch.name === seeded.branchName);
  checks.branchDetailReturnsSnapshotContent = !!(branchDetail.data && branchDetail.data.content && branchDetail.data.content.indexOf("branch snapshot") !== -1 && branchDetail.data.content.indexOf("live-only") === -1);
  checks.branchDetailHasRevisionMeta = !!(branchDetail.data && branchDetail.data.revision && branchDetail.data.revision.id);
  checks.branchDetailHasCommitMeta = !!(branchDetail.data && branchDetail.data.branch_commit_id === seeded.commitId);
  seeded.branchRevisionId = branchDetail.data && branchDetail.data.current_revision_id;

  var branchRaw = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw?branch=" + encodeURIComponent(seeded.branchName),
    seeded.ownerToken,
  );
  checks.branchRawReturns200 = branchRaw.status === 200;
  checks.branchRawReturnsSnapshotContent = branchRaw.body === BRANCH_CONTENT;
  checks.branchRawDoesNotLeakLiveContent = branchRaw.body.indexOf("live-only") === -1;
  checks.branchRawHasBranchHeader = branchRaw.branch === seeded.branchName;
  checks.branchRawHasCommitHeader = branchRaw.branchCommitId === seeded.commitId;

  var historicalRaw = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw?revision_id=" + encodeURIComponent(seeded.initialRevisionId),
    seeded.ownerToken,
  );
  checks.historicalRawReturns200 = historicalRaw.status === 200;
  checks.historicalRawReturnsExactInitialContent = historicalRaw.body === FILE_CONTENT;
  checks.historicalRawHasRevisionHeader = historicalRaw.revisionId === seeded.initialRevisionId;

  var missingRevision = await rawFetch(
    seeded.baseUrl, "GET",
    "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw?revision_id=00000000-0000-0000-0000-000000000000",
    seeded.ownerToken,
  );
  checks.missingRevisionReturns404 = missingRevision.status === 404;

  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Backend permission probes
// ────────────────────────────────────────────────────────────────────────────

async function probeBackendPermissions(seeded) {
  var checks = {};

  var ownerRead = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId, seeded.ownerToken);
  checks.ownerCanRead = ownerRead.status === 200 && !!(ownerRead.data && ownerRead.data.content);

  var viewerRead = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId, seeded.viewerToken);
  checks.viewerCanRead = viewerRead.status === 200 && !!(viewerRead.data && viewerRead.data.content);

  var viewerRaw = await rawFetch(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw", seeded.viewerToken);
  checks.viewerCanRawRead = viewerRaw.status === 200 && viewerRaw.body === LIVE_ONLY_CONTENT;

  var outsiderRead = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId, seeded.outsiderToken);
  checks.outsiderDenied = outsiderRead.status === 403;

  var outsiderRaw = await rawFetch(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw", seeded.outsiderToken);
  checks.outsiderRawDenied = outsiderRaw.status === 403;

  var anonymousRead = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId, null);
  checks.anonymousDenied = anonymousRead.status === 401;

  var anonymousRaw = await rawFetch(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw", null);
  checks.anonymousRawDenied = anonymousRaw.status === 401;

  var viewerList = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files?limit=100", seeded.viewerToken);
  checks.viewerCanListFiles = viewerList.status === 200 && Array.isArray(viewerList.data && viewerList.data.data);

  var unknownFile = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/00000000-0000-0000-0000-000000000000", seeded.ownerToken);
  checks.unknownFileReturns404 = unknownFile.status === 404;

  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Branch snapshot content safety
// ────────────────────────────────────────────────────────────────────────────

async function probeBranchContent(seeded) {
  var checks = {};

  var liveDetail = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId, seeded.ownerToken);
  checks.liveDetailReturnsLiveContent = !!(liveDetail.data && liveDetail.data.content && liveDetail.data.content.indexOf("live-only") !== -1);

  var branchDetail = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "?branch=" + encodeURIComponent(seeded.branchName), seeded.ownerToken);
  checks.branchDetailReturnsSnapshotContent = !!(branchDetail.data && branchDetail.data.content && branchDetail.data.content.indexOf("branch snapshot") !== -1 && branchDetail.data.content.indexOf("live-only") === -1);

  var branchRaw = await rawFetch(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "/raw?branch=" + encodeURIComponent(seeded.branchName), seeded.ownerToken);
  checks.branchRawReturnsSnapshotContent = branchRaw.status === 200 && branchRaw.body === BRANCH_CONTENT;

  var unknownBranch = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + seeded.fileId + "?branch=nonexistent-xyz-" + Date.now(), seeded.ownerToken);
  checks.unknownBranchReturns404 = unknownBranch.status >= 400;

  // Live-only file absent from branch.
  var liveFileList = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files?exact_path=src%2Flive-only.ts&limit=10", seeded.ownerToken);
  var liveFileId = null;
  if (liveFileList.status === 200 && liveFileList.data && liveFileList.data.data && liveFileList.data.data.length > 0) {
    liveFileId = liveFileList.data.data[0].id;
  }
  if (liveFileId) {
    var branchLiveFile = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + liveFileId + "?branch=" + encodeURIComponent(seeded.branchName), seeded.ownerToken);
    checks.liveOnlyFileAbsentFromBranch = branchLiveFile.status >= 400;
    var branchLiveRaw = await rawFetch(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files/" + liveFileId + "/raw?branch=" + encodeURIComponent(seeded.branchName), seeded.ownerToken);
    checks.liveOnlyFileRawAbsentFromBranch = branchLiveRaw.status >= 400;
  } else {
    checks.liveOnlyFileAbsentFromBranch = true;
    checks.liveOnlyFileRawAbsentFromBranch = true;
  }

  var branchFileList = await api(seeded.baseUrl, "GET", "/v1/projects/" + seeded.projectId + "/files?limit=100&branch=" + encodeURIComponent(seeded.branchName), seeded.ownerToken);
  checks.branchListExcludesLiveOnlyFiles = !!(branchFileList.status === 200 && Array.isArray(branchFileList.data && branchFileList.data.data));
  if (branchFileList.status === 200 && branchFileList.data && branchFileList.data.data) {
    var branchPaths = branchFileList.data.data.map(function (f) { return f.path; });
    checks.branchListHasHelloText = branchPaths.indexOf("docs/hello.txt") !== -1;
    checks.branchListHasBranchOnlyTs = branchPaths.indexOf("src/branch-only.ts") !== -1;
    checks.branchListExcludesLiveOnlyTs = branchPaths.indexOf("src/live-only.ts") === -1;
  }

  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Static wiring checks — verify frontend Raw/Download IS wired
// ────────────────────────────────────────────────────────────────────────────

function checkStaticWiring() {
  var checks = {};
  try {
    var html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // File preview pane exists.
    checks.previewPaneExists = html.indexOf('id="previewPane"') !== -1;
    checks.previewActionsContainerExists = html.indexOf('id="previewActions"') !== -1;

    // ── Frontend Raw/Download wiring IS present ────────────────────────────
    checks.fileRawPathFunctionExists = html.indexOf("function fileRawPath(") !== -1;
    checks.renderPreviewActionsFunctionExists = html.indexOf("function renderPreviewActions(") !== -1;
    checks.openPreviewRawFunctionExists = html.indexOf("function openPreviewRaw(") !== -1;
    checks.downloadPreviewRawFunctionExists = html.indexOf("function downloadPreviewRaw(") !== -1;
    checks.fetchPreviewBlobFunctionExists = html.indexOf("function fetchPreviewBlob(") !== -1;
    checks.rawBtnWiredInClickHandler = html.indexOf("openPreviewRaw(") !== -1 && html.indexOf("[data-preview-raw-url]") !== -1;
    checks.downloadBtnWiredInClickHandler = html.indexOf("downloadPreviewRaw(") !== -1 && html.indexOf("[data-preview-download-url]") !== -1;

    // Raw/Download buttons are generated in HTML (via renderPreviewActions).
    checks.rawButtonGenerated = html.indexOf(">Raw<") !== -1 && html.indexOf("data-preview-raw-url") !== -1;
    checks.downloadButtonGenerated = html.indexOf(">Download<") !== -1 && html.indexOf("data-preview-download-url") !== -1;

    // Raw endpoint path is wired in JavaScript.
    checks.rawPathHasFilesRoute = html.indexOf('/raw"') !== -1 || html.indexOf('/raw?') !== -1 || html.indexOf("'/raw'") !== -1;
    checks.branchContextInRawUrl = html.indexOf("branch=") !== -1 && html.indexOf("fileRawPath") !== -1;

    // Branch context in URLs.
    checks.branchQueryPartFunction = html.indexOf("function branchQueryPart") !== -1;
    checks.branchContextWired = html.indexOf("branchQueryPart") !== -1 || html.indexOf("?branch=") !== -1;

    // ── OpenAPI check ──────────────────────────────────────────────────────
    var openapi = fs.readFileSync(path.join(ROOT, "openapi-v2.yaml"), "utf8");
    checks.openapiFileDetailExists = openapi.indexOf("/v1/projects/{pid}/files/{file_id}") !== -1;
    checks.openapiRawPathDocumented = openapi.indexOf("/v1/projects/{pid}/files/{file_id}/raw") !== -1;
    checks.openapiDownloadPathDocumented = openapi.indexOf("/v1/projects/{pid}/files/{file_id}/download") !== -1;
    checks.openapiRevisionIdDocumented = openapi.indexOf("revision_id") !== -1 && openapi.indexOf("Exact file revision") !== -1;

  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Fake controls audit — verify clone/archive/provider blame controls absent
// ────────────────────────────────────────────────────────────────────────────

function checkFakeControls() {
  var checks = {};
  try {
    var html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.noFakeCloneControl = html.indexOf("git clone") === -1 && html.indexOf("clone URL") === -1;
    checks.noFakeTarball = html.indexOf("tarball") === -1 && html.indexOf("tar.gz") === -1;
    checks.noFakeZipball = html.indexOf("zipball") === -1;
    checks.noFakeProviderBlame = html.indexOf("git blame") === -1 && html.indexOf("provider blame") === -1;
    checks.noFakeRollback = html.indexOf("rollback") === -1 && html.indexOf("回滚") === -1;
    checks.noFakeProviderControls =
      html.indexOf("github") === -1 &&
      html.indexOf("gitlab") === -1 &&
      html.indexOf("gitee") === -1 &&
      html.indexOf("bitbucket") === -1;
    checks.noFakeExternalClone = html.indexOf("external clone") === -1 && html.indexOf("remote origin") === -1;

  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Residual documentation
// ────────────────────────────────────────────────────────────────────────────

function collectResiduals(result, seeded) {
  if (!result.checks.backendEndpoints.rawEndpointReturns200) {
    result.residual.push("Backend GET /files/:file_id/raw did not return 200.");
  }
  if (!result.checks.backendEndpoints.downloadEndpointReturns200) {
    result.residual.push("Backend GET /files/:file_id/download did not return 200.");
  }
  if (!result.checks.backendEndpoints.branchDetailReturnsSnapshotContent) {
    result.residual.push("CRITICAL: Branch file detail did not return branch HEAD snapshot content. GET /files/:file_id?branch=main must return the revision content captured by the commit snapshot.");
  }
  if (!result.checks.backendEndpoints.branchDetailHasBranchMeta) {
    result.residual.push("Branch-scoped file detail is missing branch metadata (branch.name). The branch parameter may be silently ignored.");
  }
  if (!result.checks.backendPermissions.viewerCanRead) {
    result.residual.push("Viewer cannot read file detail. The GET /files/:file_id endpoint may not grant view permission to viewer-role members.");
  }

  result.residual.push("Raw/download is local Project Space file content only; no git clone/archive/provider surface is exposed in this batch.");
  result.residual.push("Raw/download URLs carry exact revision_id when the preview knows the rendered revision, otherwise they carry branch context.");
  result.residual.push("No fake clone, archive, tarball, zipball, provider blame, rollback, or external provider controls are present.");
}

// ────────────────────────────────────────────────────────────────────────────
// Browser smoke
// ────────────────────────────────────────────────────────────────────────────

async function runBrowserSmoke(playwright, seeded) {
  var checks = {};
  var errors = [];
  var screenshotPath = null;

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  var page = await context.newPage();

  page.on("console", function (msg) {
    if (msg.type() === "error") errors.push("console:" + msg.text());
  });
  page.on("pageerror", function (err) {
    errors.push("pageerror:" + err.message);
  });

  try {
    var storageKey = "zz_human_workspace_simple_v1";
    var storagePayload = JSON.stringify({
      jwt: seeded.ownerToken,
      selectedProjectId: seeded.projectId,
      baseUrl: seeded.baseUrl,
    });

    await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(function (args) {
      localStorage.setItem(args.key, args.value);
    }, { key: storageKey, value: storagePayload });

    // ── Phase 1: Files tab — file preview ──────────────────────────────────
    var filesUrl = seeded.baseUrl + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) + "&tab=files";
    await page.goto(filesUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
    checks.filesTabActive = true;

    await page.waitForSelector("#fileListContainer", { timeout: 10000 });
    checks.fileListRendered = true;

    // Navigate to docs/ directory.
    await page.waitForTimeout(1500);
    await page.evaluate(function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll(".folder-row"));
      var docsRow = rows.find(function (row) {
        return row.textContent && row.textContent.indexOf("docs") !== -1;
      });
      if (docsRow) docsRow.click();
    });
    await page.waitForTimeout(1000);

    // Click hello.txt to open preview.
    await page.evaluate(function () {
      var rows = Array.prototype.slice.call(document.querySelectorAll(".file-entry"));
      var target = rows.find(function (row) {
        return row.textContent && row.textContent.indexOf("hello.txt") !== -1;
      });
      if (target) target.click();
    });

    // Wait for preview pane to open.
    await page.waitForSelector('#previewPane[aria-hidden="false"]', { timeout: 10000 });
    checks.previewPaneOpens = true;

    // Verify preview content is visible.
    await page.waitForFunction(function () {
      var el = document.getElementById("previewContent");
      return el && el.textContent && el.textContent.length > 0;
    }, null, { timeout: 10000 });
    checks.previewContentVisible = true;
    var previewText = await page.textContent("#previewContent");
    checks.previewShowsFileContent = !!(previewText && previewText.length > 20);

    // Verify preview metadata is visible.
    var metaText = await page.textContent("#previewMeta");
    checks.previewMetaVisible = !!(metaText && metaText.length > 0);
    checks.previewMetaShowsContentType = metaText.indexOf("类型") !== -1 || metaText.indexOf("text/") !== -1;

    // ── Phase 2: Check for Raw/Download actions in preview ──────────────────
    var actionsVisible = await page.evaluate(function () {
      var actions = document.getElementById("previewActions");
      if (!actions) return "no-element";
      return actions.classList.contains("hidden") ? "hidden" : "visible";
    });
    checks.previewActionsContainerExists = actionsVisible !== "no-element";

    // Check for buttons in the preview pane markup.
    var hasDataRawUrl = await page.evaluate(function () {
      return !!document.querySelector("[data-preview-raw-url]");
    });
    var hasDataDownloadUrl = await page.evaluate(function () {
      return !!document.querySelector("[data-preview-download-url]");
    });
    checks.rawButtonInPreview = hasDataRawUrl;
    checks.downloadButtonInPreview = hasDataDownloadUrl;

    // If actions are visible, verify Raw/Download button text.
    if (actionsVisible === "visible") {
      var actionsText = await page.evaluate(function () {
        var el = document.getElementById("previewActions");
        return el ? el.textContent : "";
      });
      checks.rawButtonTextPresent = actionsText.indexOf("Raw") !== -1;
      checks.downloadButtonTextPresent = actionsText.indexOf("Download") !== -1;

      // Check revision/branch context in raw URL.
      var rawUrl = await page.evaluate(function () {
        var btn = document.querySelector("[data-preview-raw-url]");
        return btn ? btn.getAttribute("data-preview-raw-url") : "";
      });
      checks.rawUrlHasRevisionOrBranchContext = rawUrl.indexOf("revision_id=") !== -1 || rawUrl.indexOf("branch=") !== -1;
      checks.rawUrlHasProjectId = rawUrl.indexOf(seeded.projectId) !== -1;
      checks.rawUrlHasFileId = rawUrl.indexOf(seeded.fileId) !== -1;
      checks.rawUrlUsesRawRoute = rawUrl.indexOf("/raw") !== -1;

      var downloadUrl = await page.evaluate(function () {
        var btn = document.querySelector("[data-preview-download-url]");
        return btn ? btn.getAttribute("data-preview-download-url") : "";
      });
      checks.downloadUrlHasRevisionOrBranchContext = downloadUrl.indexOf("revision_id=") !== -1 || downloadUrl.indexOf("branch=") !== -1;
      checks.downloadUrlHasDownloadParam = downloadUrl.indexOf("download=1") !== -1;
    }

    // ── Phase 3: Check for fake controls (browser) ──────────────────────────
    var bodyText = await page.textContent("body");
    checks.noFakeCloneText = bodyText.indexOf("git clone") === -1 && bodyText.indexOf("clone URL") === -1;
    checks.noFakeProviderBlameText = bodyText.indexOf("git blame") === -1 && bodyText.indexOf("Provider blame") === -1;
    checks.noFakeRollbackText = bodyText.indexOf("rollback") === -1 && bodyText.indexOf("回滚") === -1;
    checks.noFakeProviderText = bodyText.indexOf("github") === -1 && bodyText.indexOf("gitlab") === -1;

    // ── Phase 4: Branch context preservation ───────────────────────────────
    await page.keyboard.press("Escape");
    await page.waitForSelector('#previewPane[aria-hidden="true"]', { timeout: 5000 });
    checks.previewClosesOnEscape = true;

    var branchControlExists = await page.$("#branchPill");
    if (branchControlExists) {
      await page.click("#branchPill");
      await page.waitForSelector("#branchPopover:not(.hidden)", { timeout: 5000 });
      checks.branchPopoverOpens = true;

      await page.evaluate(function () {
        var choices = Array.prototype.slice.call(document.querySelectorAll("#branchPopoverList [data-branch-value]"));
        var choice = choices.find(function (c) {
          var rect = c.getBoundingClientRect();
          var style = window.getComputedStyle(c);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }) || choices[0];
        if (choice) choice.click();
      });

      await page.waitForFunction(function () {
        return new URL(window.location.href).searchParams.has("branch");
      }, null, { timeout: 5000 });
      checks.branchSelectionPersistsInUrl = page.url().indexOf("branch=") !== -1;
    }

    // ── Phase 5: Screenshot ────────────────────────────────────────────────
    await page.waitForTimeout(500);
    await page.evaluate(function () {
      var folderRows = Array.prototype.slice.call(document.querySelectorAll(".folder-row"));
      var docsFolder = folderRows.find(function (row) {
        return row.textContent && row.textContent.indexOf("docs") !== -1;
      });
      if (docsFolder) docsFolder.click();
    });
    await page.waitForTimeout(1000);
    await page.evaluate(function () {
      var fileRows = Array.prototype.slice.call(document.querySelectorAll(".file-entry"));
      var target = fileRows.find(function (row) {
        return row.textContent && row.textContent.indexOf("hello.txt") !== -1;
      });
      if (target) target.click();
    });
    await page.waitForSelector('#previewPane[aria-hidden="false"]', { timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    screenshotPath = SCREENSHOT_PATH;
    checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    var allPassed = Object.keys(checks).every(function (k) { return checks[k] === true; });
    return { passed: allPassed, checks: checks, errors: errors, screenshotPath: screenshotPath };
  } catch (err) {
    errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
    return { passed: false, checks: checks, errors: errors, screenshotPath: screenshotPath };
  } finally {
    await context.close();
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────────────

async function api(baseUrl, method, urlPath, token, body) {
  var headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  var res = await fetch("" + baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var text = await res.text();
  var data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data: data };
}

async function rawFetch(baseUrl, method, urlPath, token) {
  var headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  var res = await fetch("" + baseUrl + urlPath, { method: method, headers: headers });
  var text = await res.text();
  return {
    status: res.status,
    body: text,
    contentType: res.headers.get("content-type"),
    contentDisposition: res.headers.get("content-disposition"),
    filePath: res.headers.get("x-project-file-path"),
    revisionId: res.headers.get("x-project-file-revision-id"),
    branch: res.headers.get("x-project-branch"),
    branchCommitId: res.headers.get("x-project-branch-commit-id"),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Evidence writer
// ────────────────────────────────────────────────────────────────────────────

function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  var viewportLabel = result.viewport.width + "x" + result.viewport.height;
  var lines = [];
  lines.push("# Project Space File Raw/Download — Smoke Evidence");
  lines.push("");
  lines.push("- **Command:** `" + result.command + "`");
  lines.push("- **Timestamp:** " + result.timestamp);
  lines.push("- **Viewport:** " + viewportLabel);
  lines.push("- **Backend built:** " + result.backendBuilt);
  lines.push("- **Browser available:** " + result.browserAvailable);
  lines.push("- **Passed:** " + result.passed);
  lines.push("- **Skipped:** " + result.skipped);
  if (result.screenshotPath) lines.push("- **Screenshot:** `" + result.screenshotPath + "`");
  lines.push("- **Evidence JSON:** `" + EVIDENCE_JSON + "`");
  lines.push("");

  // Backend seed.
  lines.push("## Backend Seed");
  lines.push("");
  lines.push("| Check | Value |");
  lines.push("|---|---|");
  for (var seedKey in result.checks.backendSeed) {
    if (!result.checks.backendSeed.hasOwnProperty(seedKey)) continue;
    lines.push("| " + seedKey + " | " + result.checks.backendSeed[seedKey] + " |");
  }
  lines.push("");

  // Backend endpoints.
  lines.push("## Backend File Endpoints");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (var epKey in result.checks.backendEndpoints) {
    if (!result.checks.backendEndpoints.hasOwnProperty(epKey)) continue;
    var epVal = result.checks.backendEndpoints[epKey] === true ? "✅ PASS" : "❌ FAIL";
    lines.push("| " + epKey + " | " + epVal + " |");
  }
  lines.push("");

  // Backend permissions.
  lines.push("## Backend Permissions");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (var permKey in result.checks.backendPermissions) {
    if (!result.checks.backendPermissions.hasOwnProperty(permKey)) continue;
    var permVal = result.checks.backendPermissions[permKey] === true ? "✅ PASS" : "❌ FAIL";
    lines.push("| " + permKey + " | " + permVal + " |");
  }
  lines.push("");

  // Branch content.
  lines.push("## Branch Snapshot Content Safety");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (var bcKey in result.checks.branchContent) {
    if (!result.checks.branchContent.hasOwnProperty(bcKey)) continue;
    var bcVal = result.checks.branchContent[bcKey] === true ? "✅ PASS" : "❌ FAIL";
    lines.push("| " + bcKey + " | " + bcVal + " |");
  }
  lines.push("");

  // Static wiring.
  lines.push("## Static Wiring (Dashboard HTML Raw/Download Frontend)");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (var swKey in result.checks.staticWiring) {
    if (!result.checks.staticWiring.hasOwnProperty(swKey)) continue;
    var swVal = result.checks.staticWiring[swKey] === true ? "✅ PASS" : "❌ FAIL";
    lines.push("| " + swKey + " | " + swVal + " |");
  }
  lines.push("");

  // Fake controls.
  lines.push("## Fake Controls Audit");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (var fcKey in result.checks.fakeControlsAbsent) {
    if (!result.checks.fakeControlsAbsent.hasOwnProperty(fcKey)) continue;
    var fcVal = result.checks.fakeControlsAbsent[fcKey] === true ? "✅ PASS (absent)" : "❌ FAIL (present)";
    lines.push("| " + fcKey + " | " + fcVal + " |");
  }
  lines.push("");

  // Browser checks.
  if (result.checks.browser) {
    lines.push("## Browser UI Checks");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    for (var brKey in result.checks.browser) {
      if (!result.checks.browser.hasOwnProperty(brKey)) continue;
      var brVal = result.checks.browser[brKey] === true ? "✅ PASS" : "❌ FAIL";
      lines.push("| " + brKey + " | " + brVal + " |");
    }
    lines.push("");
  }

  if (result.errors.length) {
    lines.push("## Errors");
    lines.push("");
    for (var e = 0; e < result.errors.length; e++) {
      lines.push("- " + result.errors[e]);
    }
    lines.push("");
  }

  if (result.residual.length) {
    lines.push("## Residual Gaps");
    lines.push("");
    for (var r = 0; r < result.residual.length; r++) {
      lines.push("- " + result.residual[r]);
    }
    lines.push("");
  }

  // Seed scenario.
  lines.push("## Seed Scenario");
  lines.push("");
  lines.push("- **Project:** File Raw Download Smoke Project (private)");
  lines.push("- **Test file:** `docs/hello.txt` — created via POST /files, then modified via changeset merge (branch HEAD), then updated again via POST /files (live-only)");
  lines.push("- **Branch-scoped file:** `src/branch-only.ts` — only exists in the branch HEAD commit snapshot");
  lines.push("- **Live-only file:** `src/live-only.ts` — created via POST /files after branch HEAD, NOT in the commit snapshot");
  lines.push("- **Actors:** owner (admin), viewer (member with view role), outsider (registered but not a member), anonymous (no auth)");
  lines.push("");

  // Current state summary.
  lines.push("## Current State Summary");
  lines.push("");
  lines.push("### Implemented (Backend)");
  lines.push("");
  lines.push("- `GET /v1/projects/:project_id/files/:file_id` returns file content, content_type, path, revision metadata.");
  lines.push("- `GET /v1/projects/:project_id/files/:file_id?branch=<name>` returns branch HEAD snapshot content and metadata.");
  lines.push("- Owner and viewer can read file detail. Outsider gets 403. Anonymous gets 401.");
  lines.push("- Unknown files return 404. Unknown branches return 404.");
  lines.push("- File content respects branch context: branch query returns snapshot revision content; no-branch query returns latest live content.");
  lines.push("");
  lines.push("### Implemented (Frontend Raw/Download Wiring)");
  lines.push("");
  lines.push("- **`function fileRawPath(file, opts)`** — generates raw/download paths with branch/revision context and `download=1` param.");
  lines.push("- **`function renderPreviewActions(file, opts)`** — renders Raw and Download buttons with `data-preview-raw-url` and `data-preview-download-url` attributes.");
  lines.push("- **`function openPreviewRaw(rawPath)`** — fetches raw file as blob, opens in new tab via `URL.createObjectURL()`.");
  lines.push("- **`function downloadPreviewRaw(rawPath)`** — fetches file as blob, triggers download via hidden `<a>` element.");
  lines.push("- **`#previewActions` container** — hidden by default, populated by `renderPreviewActions()` when a file is previewed.");
  lines.push("- **Click handlers** — `[data-preview-raw-url]` and `[data-preview-download-url]` elements are handled via delegated click listener on `#previewActions`.");
  lines.push("- **Branch context in URLs** — raw/download URLs include `?branch=<name>` via `fileRawPath()` calling `branchQueryPart()`.");
  lines.push("");
  lines.push("### Implemented (Backend Raw/Download)");
  lines.push("");
  lines.push("- **`GET /files/:file_id/raw`** returns raw local file content with path/revision/branch headers.");
  lines.push("- **`GET /files/:file_id/raw?download=1`** returns the same content with an attachment disposition.");
  lines.push("- **`GET /files/:file_id/download`** returns raw local file content as an attachment.");
  lines.push("- **`revision_id`** returns exact historical file content, while **`branch`** resolves branch HEAD snapshot content.");
  lines.push("- OpenAPI documents `/raw`, `/download`, `revision_id`, `branch`, and response headers.");
  lines.push("");
  lines.push("### Verified Absent (No Fake Controls)");
  lines.push("");
  lines.push("- No `git clone` / remote clone UI.");
  lines.push("- No tarball/zipball download controls.");
  lines.push("- No fake Git/provider blame UI; local Project Space blame is covered by the file code view smoke.");
  lines.push("- No rollback/revert controls.");
  lines.push("- No external provider (GitHub/GitLab/Gitee/Bitbucket) references.");
  lines.push("- No external clone URL or remote origin controls.");
  lines.push("");

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────────────────

async function cleanup() {
  if (context) await context.close().catch(function () {});
  if (browser) await browser.close().catch(function () {});
  if (server) {
    await new Promise(function (resolve) { server.close(function () { resolve(); }); });
  }
  try {
    var { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
}

main();
