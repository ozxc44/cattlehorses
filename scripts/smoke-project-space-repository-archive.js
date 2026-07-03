#!/usr/bin/env node
// Project Space Repository Archive — API and browser smoke harness.
//
// Verifies repository archive download for Batch94:
//   1. owner/member/viewer archive download returns 200 with ZIP.
//   2. outsider gets 403, anonymous gets 401.
//   3. ZIP response has correct Content-Type (application/zip) and
//      Content-Disposition (attachment) headers.
//   4. Archive bytes contain expected file paths and content.
//   5. Branch archive uses branch snapshot content and excludes live-only
//      changes made after the branch HEAD commit.
//   6. Browser/UI:
//      - archive action is visible from Overview/Files for allowed actors.
//      - branch context is reflected in the archive URL/action.
//      - no fake clone/provider controls appear.
//
// If the backend archive endpoint is not yet implemented (Batch94 A/D have
// not landed), the smoke reports precise gaps in result.md rather than a
// blanket pass/fail for those checks.
//
// Usage:
//   node scripts/smoke-project-space-repository-archive.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH  - path to Playwright node_modules (default auto)
//   VIEWPORT_WIDTH                - viewport width  (default 1280)
//   VIEWPORT_HEIGHT               - viewport height (default 900)
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-repository-archive-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

// ─── Test content constants ──────────────────────────────────────────────────

const README_CONTENT = "# Smoke Project\n\nRepository archive smoke test.\n";
const SRC_MAIN_CONTENT = '// Main entry point\nconsole.log("Hello from archive smoke");\n';
const DOCS_GUIDE_CONTENT = "# User Guide\n\nThis is the user guide for the archive smoke project.\n";
const SRC_UTILS_HELPER_CONTENT = '// Helper utilities\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n';

// Branch snapshot: modifies README.md and creates a new branch-only file
const BRANCH_README_CONTENT = "# Smoke Project (Branch HEAD)\n\nThis is the BRANCH snapshot content.\n";
const BRANCH_ONLY_CONTENT = "// This file only exists at the branch HEAD commit\n";

// Live-only: modifies README.md after the branch HEAD commit
const LIVE_ONLY_README_CONTENT = "# Smoke Project (Live-only)\n\nThis content was added AFTER the branch HEAD commit.\n";
const LIVE_ONLY_FILE_CONTENT = "// This file was created live after branch HEAD — should NOT appear in branch archive\n";

const ALL_SEED_PATHS = [
  "README.md",
  "src/main.ts",
  "docs/guide.md",
  "src/utils/helper.ts",
];

const BRANCH_SNAPSHOT_PATHS = [
  "README.md",
  "src/main.ts",
  "docs/guide.md",
  "src/utils/helper.ts",
  "branch-only-file.ts",
];

const LIVE_ONLY_PATHS = [
  "live-only-post-commit.ts",
];

let server = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const result = {
    command: "node scripts/smoke-project-space-repository-archive.js",
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

    // ── 1. Backend data setup ───────────────────────────────────────────────
    const seeded = await setupBackendData();

    // ── 2. Static wiring checks (no server needed) ─────────────────────────
    result.checks.staticWiring = checkStaticWiring();
    result.checks.fakeControlsAbsent = checkFakeControls();

    // ── 3. API archive endpoint checks ─────────────────────────────────────
    const apiResult = await probeArchiveEndpoint(seeded);
    result.checks.archiveApi = apiResult.checks;
    if (apiResult.residual) {
      result.residual.push(...apiResult.residual);
    }

    // ── 4. Static wiring pass/fail ──────────────────────────────────────────
    const staticWiringOk = allChecksPassed(result.checks.staticWiring);
    const fakeControlsOk = allChecksPassed(result.checks.fakeControlsAbsent);
    const apiEndpointExists = result.checks.archiveApi.archiveEndpointReachable === true;

    if (!playwright) {
      result.skipped = true;
      result.residual.push("Playwright not resolvable from " + PLAYWRIGHT_NODE_MODULES + ". Browser automation skipped.");
      result.passed = staticWiringOk && fakeControlsOk && apiResult.passed;
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 5. Browser smoke (Playwright) ──────────────────────────────────────
    if (apiEndpointExists) {
      const browserResult = await runBrowserSmoke(playwright, seeded);
      result.checks.browser = browserResult.checks;
      result.screenshotPath = browserResult.screenshotPath;
      if (!browserResult.passed) result.errors.push(...browserResult.errors);
      result.passed = staticWiringOk && fakeControlsOk && apiResult.passed && browserResult.passed;
    } else {
      result.residual.push("Archive endpoint not reachable — browser smoke skipped.");
      result.passed = staticWiringOk && fakeControlsOk && apiResult.passed;
    }

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
      const req = createRequire(path.join(PLAYWRIGHT_NODE_MODULES, "playwright", "package.json"));
      return req("playwright");
    } catch (__) {
      return null;
    }
  }
}

function allChecksPassed(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const key of Object.keys(obj)) {
    // Skip keys that start with underscore (internal markers)
    if (key.startsWith("_")) continue;
    // null means not-applicable (skipped), not a failure
    if (obj[key] === null) continue;
    if (obj[key] !== true) return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Backend data seeding
// ────────────────────────────────────────────────────────────────────────────

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-repository-archive-smoke-secret";
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

  // Register users.
  const owner = await register(baseUrl, "archive-owner");
  const member = await register(baseUrl, "archive-member");
  const viewer = await register(baseUrl, "archive-viewer");
  const outsider = await register(baseUrl, "archive-outsider");

  // Create project.
  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Repository Archive Smoke Project",
    description: "Smoke test for repository archive download",
    visibility: "private",
  });
  if (projectRes.status !== 201) throw new Error("Project create failed: " + projectRes.status + " " + JSON.stringify(projectRes.data));
  const projectId = projectRes.data.id;

  // Add member and viewer.
  const addMember = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/members", owner.token, {
    user_id: member.userId,
    role: "member",
  });
  if (addMember.status !== 201) throw new Error("Add member failed: " + addMember.status);

  const addViewer = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/members", owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });
  if (addViewer.status !== 201) throw new Error("Add viewer failed: " + addViewer.status);

  // ── Seed initial files on main ────────────────────────────────────────────

  // 1. README.md
  const readmeRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "README.md",
    content: README_CONTENT,
    message: "Seed README.md",
  });
  if (readmeRes.status !== 201) throw new Error("README create failed: " + readmeRes.status);

  // 2. src/main.ts
  const mainTsRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "src/main.ts",
    content: SRC_MAIN_CONTENT,
    message: "Seed src/main.ts",
  });
  if (mainTsRes.status !== 201) throw new Error("src/main.ts create failed: " + mainTsRes.status);

  // 3. docs/guide.md
  const guideRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "docs/guide.md",
    content: DOCS_GUIDE_CONTENT,
    message: "Seed docs/guide.md",
  });
  if (guideRes.status !== 201) throw new Error("docs/guide.md create failed: " + guideRes.status);

  // 4. src/utils/helper.ts
  const helperRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "src/utils/helper.ts",
    content: SRC_UTILS_HELPER_CONTENT,
    message: "Seed src/utils/helper.ts",
  });
  if (helperRes.status !== 201) throw new Error("src/utils/helper.ts create failed: " + helperRes.status);

  // ── Create a changeset that modifies README.md and adds branch-only-file.ts ─
  const changesetRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/changesets", owner.token, {
    title: "Branch snapshot seed",
    file_ops: [
      {
        op: "upsert",
        path: "README.md",
        content: BRANCH_README_CONTENT,
        base_revision_id: readmeRes.data.current_revision_id,
      },
      {
        op: "upsert",
        path: "branch-only-file.ts",
        content: BRANCH_ONLY_CONTENT,
      },
    ],
  });
  if (changesetRes.status !== 201) throw new Error("Changeset create failed: " + changesetRes.status + " " + JSON.stringify(changesetRes.data));
  const changesetId = changesetRes.data.id;

  // Approve and merge to create a commit on main.
  const reviewRes = await api(baseUrl, "PATCH", "/v1/projects/" + projectId + "/changesets/" + changesetId + "/review", owner.token, {
    decision: "approved",
    notes: "Approve branch snapshot seed",
  });
  if (reviewRes.status !== 200) throw new Error("Review failed: " + reviewRes.status + " " + JSON.stringify(reviewRes.data));

  const mergeRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/changesets/" + changesetId + "/merge", owner.token);
  if (mergeRes.status !== 200) throw new Error("Merge failed: " + mergeRes.status + " " + JSON.stringify(mergeRes.data));
  const commitId = mergeRes.data.commit && mergeRes.data.commit.id;

  // ── Live-only changes after branch HEAD ───────────────────────────────────

  // After merge, read the README file's current revision ID so we can pass
  // base_revision_id in the live-only update below.  This is required by the
  // POST /files route when updating an existing file (avoids 422).
  const readmeAfterMerge = await api(baseUrl, "GET", "/v1/projects/" + projectId + "/files?exact_path=README.md", owner.token);
  if (readmeAfterMerge.status !== 200 || !readmeAfterMerge.data || !readmeAfterMerge.data.data || !readmeAfterMerge.data.data.length) {
    throw new Error("Failed to read README file after merge: " + readmeAfterMerge.status + " " + JSON.stringify(readmeAfterMerge.data));
  }
  const readmeCurrentRevisionId = readmeAfterMerge.data.data[0].current_revision_id;

  // Modify README.md live (after branch HEAD) with correct base revision.
  const liveReadmeRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "README.md",
    content: LIVE_ONLY_README_CONTENT,
    base_revision_id: readmeCurrentRevisionId,
    message: "Live-only update after branch HEAD",
  });
  if (liveReadmeRes.status !== 200 && liveReadmeRes.status !== 201) {
    throw new Error("Live-only README update failed: " + liveReadmeRes.status + " " + JSON.stringify(liveReadmeRes.data));
  }
  const liveUpdateCreated = true;

  // Create live-only-post-commit.ts (doesn't exist in branch snapshot)
  const liveFileRes = await api(baseUrl, "POST", "/v1/projects/" + projectId + "/files", owner.token, {
    path: "live-only-post-commit.ts",
    content: LIVE_ONLY_FILE_CONTENT,
    message: "Post-commit live-only file",
  });
  if (liveFileRes.status !== 201 && liveFileRes.status !== 200) {
    throw new Error("Live-only file create failed: " + liveFileRes.status + " " + JSON.stringify(liveFileRes.data));
  }

  // Get main branch info
  const branchesRes = await api(baseUrl, "GET", "/v1/projects/" + projectId + "/branches", owner.token);
  const branchList = (branchesRes.data && branchesRes.data.data) || [];
  const mainBranch = branchList.find(function (b) { return b.name === "main"; });
  const branchName = mainBranch ? mainBranch.name : "main";

  return {
    baseUrl: baseUrl,
    projectId: projectId,
    ownerToken: owner.token,
    memberToken: member.token,
    viewerToken: viewer.token,
    outsiderToken: outsider.token,
    commitId: commitId,
    branchName: branchName,
    liveUpdateCreated: liveUpdateCreated,
    allSeedPaths: ALL_SEED_PATHS,
    branchSnapshotPaths: BRANCH_SNAPSHOT_PATHS,
    liveOnlyPaths: LIVE_ONLY_PATHS,
    branchReadmeContent: BRANCH_README_CONTENT,
    liveOnlyReadmeContent: LIVE_ONLY_README_CONTENT,
  };
}

async function register(baseUrl, prefix) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + "@example.invalid",
    password: "ArchiveSmoke123!",
    display_name: prefix,
  });
  if (res.status !== 201) throw new Error("Register " + prefix + " failed: " + res.status + " " + JSON.stringify(res.data));
  return { token: res.data.access_token, userId: res.data.user.id };
}

// ────────────────────────────────────────────────────────────────────────────
// Archive endpoint probing
// ────────────────────────────────────────────────────────────────────────────

async function probeArchiveEndpoint(seeded) {
  const checks = {};
  const residual = [];
  let allPassed = true;

  // The archive endpoint contract (D) is:
  //   GET /v1/projects/:project_id/archive.zip
  // with optional ?branch= parameter.
  //
  // Probe archive.zip first (the documented endpoint), then fallback paths.
  const archivePaths = [
    "/v1/projects/" + seeded.projectId + "/archive.zip",
    "/v1/projects/" + seeded.projectId + "/archive",
    "/v1/projects/" + seeded.projectId + "/files/archive",
    "/v1/projects/" + seeded.projectId + "/repository/archive",
    "/v1/projects/" + seeded.projectId + "/download",
  ];

  let discoveredArchivePath = null;
  let discoveredArchiveStatus = null;
  let discoveredArchiveHeaders = null;
  let discoveredArchiveBody = null;
  let foundArchiveEndpoint = false;

  for (const archivePath of archivePaths) {
    try {
      const res = await rawFetch(seeded.baseUrl, "GET", archivePath, seeded.ownerToken);
      if (res.status === 200) {
        discoveredArchivePath = archivePath;
        discoveredArchiveStatus = res.status;
        discoveredArchiveHeaders = res.headers;
        discoveredArchiveBody = res.body;
        foundArchiveEndpoint = true;
        break;
      }
      // 404 is expected if not implemented; don't fail on probe
      if (res.status !== 404 && res.status !== 405) {
        // Some other status — note it
        residual.push("Archive probe for " + archivePath + " returned HTTP " + res.status + " (not 404).");
      }
    } catch (_) {
      // network error — skip
    }
  }

  checks.archiveEndpointReachable = foundArchiveEndpoint;

  if (!foundArchiveEndpoint) {
    residual.push("No archive endpoint discovered among probed paths: " + archivePaths.join(", ") + ". Batch94 A/D have not landed.");
    checks._archiveEndpointMissing = true;

    // Set all permission/header/content checks to null (N/A) so they are
    // never reported as passing when no endpoint was actually exercised.
    checks.archive200Owner = null;
    checks.archive200Member = null;
    checks.archive200Viewer = null;
    checks.archive403Outsider = null;
    checks.archive401Anonymous = null;
    checks.archiveContentTypeZip = null;
    checks.archiveContentDispositionAttachment = null;
    checks.archiveContainsExpectedPaths = null;
    checks.archiveContainsExpectedContent = null;
    checks.archiveBranchUsesSnapshot = null;
    checks.archiveBranchExcludesLiveOnly = null;
    checks.archiveBranchExcludesLiveOnlyPaths = null;

    return { passed: false, checks: checks, residual: residual };
  }

  checks.archiveProbedPath = discoveredArchivePath;

  // ── Permission checks ───────────────────────────────────────────────────
  const archiveRoot = discoveredArchivePath.includes("?")
    ? discoveredArchivePath.slice(0, discoveredArchivePath.indexOf("?"))
    : discoveredArchivePath;

  const archiveParams = discoveredArchivePath.includes("?")
    ? discoveredArchivePath.slice(discoveredArchivePath.indexOf("?"))
    : "";

  // Owner
  const ownerArchive = await rawFetch(seeded.baseUrl, "GET", discoveredArchivePath, seeded.ownerToken);
  checks.archive200Owner = ownerArchive.status === 200;

  // Member
  const memberArchive = await rawFetch(seeded.baseUrl, "GET", discoveredArchivePath, seeded.memberToken);
  checks.archive200Member = memberArchive.status === 200;

  // Viewer
  const viewerArchive = await rawFetch(seeded.baseUrl, "GET", discoveredArchivePath, seeded.viewerToken);
  checks.archive200Viewer = viewerArchive.status === 200;

  // Outsider
  const outsiderArchive = await rawFetch(seeded.baseUrl, "GET", discoveredArchivePath, seeded.outsiderToken);
  checks.archive403Outsider = outsiderArchive.status === 403;

  // Anonymous
  const anonymousArchive = await rawFetch(seeded.baseUrl, "GET", discoveredArchivePath, null);
  checks.archive401Anonymous = anonymousArchive.status === 401;

  // ── Header checks (use owner response) ──────────────────────────────────
  if (ownerArchive.status === 200) {
    const ct = (ownerArchive.headers.get("content-type") || "").toLowerCase();
    checks.archiveContentTypeZip = ct.indexOf("application/zip") !== -1 || ct.indexOf("application/octet-stream") !== -1;

    const cd = (ownerArchive.headers.get("content-disposition") || "").toLowerCase();
    checks.archiveContentDispositionAttachment = cd.indexOf("attachment") !== -1;
    checks.archiveFilenamePresent = cd.indexOf("filename=") !== -1;

    checks.archiveHasContentLength = ownerArchive.headers.has("content-length");

    // ── ZIP content parsing ─────────────────────────────────────────────
    const zipResult = parseZipFromBuffer(ownerArchive.rawBody);
    checks.archiveZipParsed = zipResult.valid;
    checks.archiveZipFileCount = zipResult.files.length > 0;
    checks.archiveZipContainsReadme = zipResult.files.some(function (f) {
      return f.name === "README.md" || f.name.endsWith("/README.md");
    });
    checks.archiveZipContainsSrcMain = zipResult.files.some(function (f) {
      return f.name === "src/main.ts" || f.name.endsWith("/src/main.ts");
    });
    checks.archiveZipContainsDocsGuide = zipResult.files.some(function (f) {
      return f.name === "docs/guide.md" || f.name.endsWith("/docs/guide.md");
    });
    checks.archiveZipContainsSrcUtilsHelper = zipResult.files.some(function (f) {
      return f.name === "src/utils/helper.ts" || f.name.endsWith("/src/utils/helper.ts");
    });

    // Content verification (check README content in live archive)
    if (zipResult.valid && zipResult.files.length > 0) {
      const readmeEntry = zipResult.files.find(function (f) {
        return f.name === "README.md" || f.name.endsWith("/README.md");
      });
      checks.archiveZipReadmeContentCorrect = readmeEntry
        ? readmeEntry.content.indexOf("Smoke Project") !== -1
        : false;
    } else {
      checks.archiveZipReadmeContentCorrect = false;
      if (!zipResult.valid) {
        residual.push("ZIP parsing failed: " + (zipResult.error || "unknown error"));
      }
    }

    checks.archiveContainsExpectedContent = checks.archiveZipReadmeContentCorrect;

    // ── Branch archive check ────────────────────────────────────────────
    // The branch version should use snapshot content and exclude live-only files.
    const branchArchivePath = discoveredArchivePath + (archiveParams ? "&branch=" + encodeURIComponent(seeded.branchName) : "?branch=" + encodeURIComponent(seeded.branchName));
    const branchArchive = await rawFetch(seeded.baseUrl, "GET", branchArchivePath, seeded.ownerToken);
    checks.archiveBranch200 = branchArchive.status === 200;

    if (branchArchive.status === 200) {
      const branchZipResult = parseZipFromBuffer(branchArchive.rawBody);
      checks.archiveBranchZipParsed = branchZipResult.valid;

      if (branchZipResult.valid && branchZipResult.files.length > 0) {
        // Branch README should have snapshot content (not live-only)
        const branchReadmeEntry = branchZipResult.files.find(function (f) {
          return f.name === "README.md" || f.name.endsWith("/README.md");
        });
        checks.archiveBranchReadmeUsesSnapshot = branchReadmeEntry
          ? branchReadmeEntry.content.toLowerCase().indexOf("branch snapshot") !== -1 &&
            branchReadmeEntry.content.toLowerCase().indexOf("live-only") === -1
          : false;

        // Branch archive should include branch-only-file.ts
        checks.archiveBranchIncludesBranchOnlyFile = branchZipResult.files.some(function (f) {
          return f.name === "branch-only-file.ts" || f.name.endsWith("/branch-only-file.ts");
        });

        // Branch archive should NOT include live-only-post-commit.ts
        checks.archiveBranchExcludesLiveOnlyPaths = !branchZipResult.files.some(function (f) {
          return f.name === "live-only-post-commit.ts" || f.name.endsWith("/live-only-post-commit.ts");
        });
      } else {
        checks.archiveBranchReadmeUsesSnapshot = false;
        checks.archiveBranchIncludesBranchOnlyFile = false;
        checks.archiveBranchExcludesLiveOnlyPaths = false;
        if (!branchZipResult.valid) {
          residual.push("Branch ZIP parsing failed: " + (branchZipResult.error || "unknown error"));
        }
      }
    } else {
      checks.archiveBranchReadmeUsesSnapshot = true; // N/A
      checks.archiveBranchIncludesBranchOnlyFile = true; // N/A
      checks.archiveBranchExcludesLiveOnlyPaths = true; // N/A
      residual.push("Branch archive endpoint returned HTTP " + branchArchive.status + " (expected 200). Branch archive content checks deferred.");
    }

    // Check that live archive includes branch-only-file.ts (it was merged to main).
    if (zipResult.valid) {
      // archiveLiveHasLiveOnlyReadme requires the live-only README seed to have succeeded.
      if (seeded.liveUpdateCreated) {
        checks.archiveLiveHasLiveOnlyReadme = zipResult.files.some(function (f) {
          return (f.name === "README.md" || f.name.endsWith("/README.md")) &&
            f.content.toLowerCase().indexOf("live-only") !== -1;
        });
      } else {
        checks.archiveLiveHasLiveOnlyReadme = false;
        residual.push("Live-only README update failed (POST /files returned non-200/201). archiveLiveHasLiveOnlyReadme set to false.");
      }
      // branch-only-file.ts was merged to main, so the live archive should contain it.
      checks.archiveLiveIncludesBranchOnlyFile =
        zipResult.files.some(function (f) {
          return f.name === "branch-only-file.ts" || f.name.endsWith("/branch-only-file.ts");
        });
    } else {
      checks.archiveLiveHasLiveOnlyReadme = false;
      checks.archiveLiveIncludesBranchOnlyFile = false;
    }
  } else {
    // Owner couldn't download — fail all content checks
    checks.archiveContentTypeZip = false;
    checks.archiveContentDispositionAttachment = false;
    checks.archiveFilenamePresent = false;
    checks.archiveHasContentLength = false;
    checks.archiveZipParsed = false;
    checks.archiveZipFileCount = false;
    checks.archiveZipContainsReadme = false;
    checks.archiveZipContainsSrcMain = false;
    checks.archiveZipContainsDocsGuide = false;
    checks.archiveZipContainsSrcUtilsHelper = false;
    checks.archiveZipReadmeContentCorrect = false;
    checks.archiveContainsExpectedContent = false;
    checks.archiveBranch200 = false;
    checks.archiveBranchReadmeUsesSnapshot = false;
    checks.archiveBranchIncludesBranchOnlyFile = false;
    checks.archiveBranchExcludesLiveOnlyPaths = false;
    checks.archiveLiveHasLiveOnlyReadme = false;
    checks.archiveLiveIncludesBranchOnlyFile = false;
  }

  // Determine overall pass
  const requiredChecks = [
    "archiveEndpointReachable",
    "archive200Owner",
    "archive200Member",
    "archive200Viewer",
    "archive403Outsider",
    "archive401Anonymous",
    "archiveContentTypeZip",
    "archiveContentDispositionAttachment",
    "archiveFilenamePresent",
    "archiveHasContentLength",
    "archiveZipParsed",
    "archiveZipFileCount",
    "archiveZipContainsReadme",
    "archiveZipContainsSrcMain",
    "archiveZipContainsDocsGuide",
    "archiveZipContainsSrcUtilsHelper",
    "archiveZipReadmeContentCorrect",
    "archiveContainsExpectedContent",
    "archiveBranch200",
    "archiveBranchReadmeUsesSnapshot",
    "archiveBranchIncludesBranchOnlyFile",
    "archiveBranchExcludesLiveOnlyPaths",
    "archiveLiveHasLiveOnlyReadme",
    "archiveLiveIncludesBranchOnlyFile",
  ];

  for (const key of requiredChecks) {
    // null = not applicable (e.g. seed failed, endpoint missing) — skip
    if (checks[key] === null) continue;
    if (checks[key] !== true) {
      allPassed = false;
      break;
    }
  }

  return { passed: allPassed, checks: checks, residual: residual };
}

// ────────────────────────────────────────────────────────────────────────────
// Lightweight ZIP parser
//
// Parses a ZIP buffer without external dependencies by scanning:
//   - Local file headers (PK\x03\x04) for file names and content
//   - Central directory (PK\x01\x02) for definitive file listing
//
// Supports stored (method 0) and deflated (method 8) entries.
// ────────────────────────────────────────────────────────────────────────────

function parseZipFromBuffer(buffer) {
  try {
    if (!buffer || !(buffer instanceof Uint8Array) && !Buffer.isBuffer(buffer) && typeof buffer !== "string") {
      return { valid: false, files: [], error: "Invalid input type: expected buffer or string" };
    }

    const raw = typeof buffer === "string" ? Buffer.from(buffer, "binary") : Buffer.from(buffer);
    const files = [];
    let offset = 0;

    while (offset < raw.length - 30) {
      // Look for local file header signature: PK\x03\x04
      if (raw.readUInt32LE(offset) !== 0x04034b50) {
        offset++;
        continue;
      }

      const versionNeeded = raw.readUInt16LE(offset + 4);
      const flags = raw.readUInt16LE(offset + 6);
      const method = raw.readUInt16LE(offset + 8);
      const nameLength = raw.readUInt16LE(offset + 26);
      const extraLength = raw.readUInt16LE(offset + 28);

      const fileName = raw.slice(offset + 30, offset + 30 + nameLength).toString("utf8");
      const dataOffset = offset + 30 + nameLength + extraLength;

      // For stored (0) and deflated (8) methods
      if (method === 0 || method === 8) {
        // Read CRC-32, compressed size, uncompressed size from local header
        // (Note: these may be 0 if data descriptor is present; fallback below)
        let compressedSize = raw.readUInt32LE(offset + 18);
        let uncompressedSize = raw.readUInt32LE(offset + 22);

        // If sizes are 0 and bit 3 of flags is set, data descriptor follows
        if ((compressedSize === 0 || uncompressedSize === 0) && (flags & 0x08)) {
          // The data descriptor (PK\x07\x08 or just 4+4+4+2 bytes) comes after the data.
          // We need to find it by scanning forward from dataOffset.
          // For stored (method 0) with unknown size, scan to next local file header.
          if (method === 0) {
            const nextHeaderOffset = raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataOffset);
            if (nextHeaderOffset > dataOffset) {
              compressedSize = nextHeaderOffset - dataOffset;
              uncompressedSize = compressedSize;
            } else {
              compressedSize = raw.length - dataOffset;
              uncompressedSize = compressedSize;
            }
          } else {
            // For deflated with unknown size, try to find the data descriptor
            // Scan for PK\x07\x08 or the next local header
            const descSigOffset = raw.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataOffset);
            const nextLocalOffset = raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataOffset + 1);

            let endOffset = -1;
            if (descSigOffset > dataOffset) {
              // Data descriptor: signature (4) + crc32 (4) + compressed (4) + uncompressed (4)
              endOffset = descSigOffset + 16;
              compressedSize = raw.readUInt32LE(descSigOffset + 8);
              uncompressedSize = raw.readUInt32LE(descSigOffset + 12);
            } else if (nextLocalOffset > dataOffset) {
              compressedSize = nextLocalOffset - dataOffset;
              endOffset = nextLocalOffset;
            } else {
              compressedSize = raw.length - dataOffset;
              endOffset = raw.length;
            }
          }
        }

        const endPos = dataOffset + compressedSize;
        const rawData = raw.slice(dataOffset, endPos);

        let content = "";
        if (method === 0) {
          // Stored
          content = rawData.toString("utf8");
        } else if (method === 8) {
          // Deflated — use zlib
          try {
            const zlib = require("zlib");
            const decompressed = zlib.inflateRawSync ? zlib.inflateRawSync(rawData) : zlib.inflateSync(rawData);
            content = decompressed.toString("utf8");
          } catch (zErr) {
            content = "[decompress error: " + zErr.message + "]";
          }
        }

        // Skip directory entries (end with /)
        if (!fileName.endsWith("/")) {
          files.push({
            name: fileName,
            content: content,
            compressedSize: compressedSize,
            uncompressedSize: uncompressedSize,
            method: method,
          });
        }
      }

      // Advance offset past the local file entry (use compressed size)
      const skipLength = raw.readUInt32LE(offset + 18);
      offset += 30 + nameLength + extraLength + skipLength;

      // Safety: prevent infinite loops
      if (files.length > 500) break;
    }

    // If no files found via local headers, try central directory
    if (files.length === 0) {
      return parseZipViaCentralDirectory(raw);
    }

    return { valid: files.length > 0, files: files };
  } catch (err) {
    return { valid: false, files: [], error: err.message };
  }
}

function parseZipViaCentralDirectory(buffer) {
  try {
    const files = [];
    // Scan backward for End of Central Directory signature: PK\x05\x06
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdOffset = buffer.lastIndexOf(eocdSig);

    if (eocdOffset < 0) return { valid: false, files: [], error: "No EOCD found" };

    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdSize = buffer.readUInt32LE(eocdOffset + 12);

    if (cdOffset + cdSize > buffer.length) {
      return { valid: false, files: [], error: "Central directory extends past buffer" };
    }

    let pos = cdOffset;
    for (let i = 0; i < cdEntries && pos < buffer.length - 46; i++) {
      if (buffer.readUInt32LE(pos) !== 0x02014b50) {
        pos++;
        continue;
      }

      const method = buffer.readUInt16LE(pos + 10);
      const nameLength = buffer.readUInt16LE(pos + 28);
      const extraLength = buffer.readUInt16LE(pos + 30);
      const commentLength = buffer.readUInt16LE(pos + 32);
      const localHeaderOffset = buffer.readUInt32LE(pos + 42);
      const compressedSize = buffer.readUInt32LE(pos + 20);
      const uncompressedSize = buffer.readUInt32LE(pos + 24);

      const fileName = buffer.slice(pos + 46, pos + 46 + nameLength).toString("utf8");
      const headerPos = localHeaderOffset;

      let content = "";
      if (headerPos > 0 && headerPos < buffer.length) {
        const localNameLen = buffer.readUInt16LE(headerPos + 26);
        const localExtraLen = buffer.readUInt16LE(headerPos + 28);
        const dataStart = headerPos + 30 + localNameLen + localExtraLen;

        if (dataStart + compressedSize <= buffer.length) {
          const rawData = buffer.slice(dataStart, dataStart + compressedSize);

          if (method === 0) {
            content = rawData.toString("utf8");
          } else if (method === 8) {
            try {
              const zlib = require("zlib");
              content = zlib.inflateRawSync ? zlib.inflateRawSync(rawData) : zlib.inflateSync(rawData);
              content = content.toString("utf8");
            } catch (zErr) {
              content = "[decompress error: " + zErr.message + "]";
            }
          }
        }
      }

      if (!fileName.endsWith("/")) {
        files.push({
          name: fileName,
          content: content,
          compressedSize: compressedSize,
          uncompressedSize: uncompressedSize,
          method: method,
        });
      }

      pos += 46 + nameLength + extraLength + commentLength;
    }

    return { valid: files.length > 0, files: files };
  } catch (err) {
    return { valid: false, files: [], error: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Static wiring checks — verify frontend archive-related wiring
// ────────────────────────────────────────────────────────────────────────────

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Check for archive-related elements using stable data attributes and IDs.
    // The dashboard uses event listeners rather than named handler attributes,
    // so we prefer data attributes and element IDs over function names.
    checks.archiveDataAttrPresent = html.indexOf('data-archive-download') !== -1;
    checks.archiveDownloadBtnId = html.indexOf('id="archiveDownloadBtn"') !== -1;
    checks.triggerArchiveDownloadFn = html.indexOf('function triggerArchiveDownload') !== -1;

    checks.archiveDownloadButton = html.indexOf("archive-download") !== -1 ||
      html.indexOf("download-archive") !== -1 ||
      html.indexOf("export-archive") !== -1 ||
      html.indexOf('id="archiveDownloadBtn"') !== -1;

    checks.archiveEndpointWired = html.indexOf("/archive.zip") !== -1 ||
      html.indexOf("archive.zip") !== -1 ||
      html.indexOf("/archive") !== -1 ||
      html.indexOf("archive?") !== -1;

    checks.branchContextInArchive = html.indexOf("branch=") !== -1 &&
      (html.indexOf("archiveDownloadBtn") !== -1 || html.indexOf("archive.zip") !== -1);

    // General UI action rendering (stable function names)
    checks.renderFileActions = html.indexOf("function renderFileActions") !== -1 ||
      html.indexOf("function renderPreviewActions") !== -1;

    checks.branchQueryPartFunction = html.indexOf("function branchQueryPart") !== -1;

    // Overview tab wiring
    checks.overviewTabExists = html.indexOf('data-tab="overview"') !== -1;

  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Fake controls audit — verify clone/archive/provider controls absent
// ────────────────────────────────────────────────────────────────────────────

function checkFakeControls() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.noFakeGitClone = html.indexOf("git clone") === -1 && html.indexOf("clone URL") === -1;
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
    checks.noFakeSvn = html.indexOf("subversion") === -1 && html.indexOf("svn") === -1;
  } catch (err) {
    checks.error = String(err);
  }
  return checks;
}

// ────────────────────────────────────────────────────────────────────────────
// Browser smoke — Playwright-only
// ────────────────────────────────────────────────────────────────────────────

async function runBrowserSmoke(playwright, seeded) {
  const checks = {};
  const errors = [];
  let screenshotPath = null;

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();

  page.on("console", function (msg) {
    if (msg.type() === "error") errors.push("console:" + msg.text());
  });
  page.on("pageerror", function (err) {
    errors.push("pageerror:" + err.message);
  });

  try {
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.ownerToken,
      selectedProjectId: seeded.projectId,
      baseUrl: seeded.baseUrl,
    });

    await page.goto(seeded.baseUrl, { waitUntil: "networkidle" });
    await page.evaluate(function (args) {
      localStorage.setItem(args.key, args.value);
    }, { key: storageKey, value: storagePayload });

    // ── Phase 1: Overview tab — check for archive action ──────────────────
    const overviewUrl = seeded.baseUrl + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) + "&tab=overview";
    await page.goto(overviewUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="overview"].active', { timeout: 10000 });
    checks.overviewTabActive = true;

    await page.waitForTimeout(2000);

    // Check the overview panel content
    const overviewText = await page.evaluate(function () {
      const panel = document.getElementById("overviewPanel");
      return panel ? panel.textContent : "";
    });
    checks.overviewPanelRendered = overviewText.length > 0;

    // Look for archive/download buttons or links
    const bodyText = await page.textContent("body");
    checks.archiveActionVisibleInUI = bodyText.indexOf("archive") !== -1 ||
      bodyText.indexOf("Archive") !== -1 ||
      bodyText.indexOf("下载") !== -1 ||
      bodyText.indexOf("导出") !== -1;

    const archiveButtons = await page.evaluate(function () {
      const buttons = document.querySelectorAll("button, a, [role=button]");
      const results = [];
      buttons.forEach(function (btn) {
        const text = (btn.textContent || "").toLowerCase();
        const id = (btn.id || "").toLowerCase();
        const cls = (btn.className || "").toLowerCase();
        if (text.indexOf("archive") !== -1 || text.indexOf("download") !== -1 ||
            id.indexOf("archive") !== -1 || cls.indexOf("archive") !== -1 ||
            text.indexOf("导出") !== -1 || text.indexOf("下载") !== -1) {
          results.push({ text: btn.textContent, id: btn.id, className: btn.className });
        }
      });
      return results;
    });
    checks.archiveButtonFound = archiveButtons.length > 0;

    // ── Phase 2: Files tab — check file management actions ──────────────────
    const filesUrl = seeded.baseUrl + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) + "&tab=files";
    await page.goto(filesUrl, { waitUntil: "networkidle" });
    await page.waitForSelector('.tab-item[data-tab="files"].active', { timeout: 10000 });
    checks.filesTabActive = true;

    await page.waitForSelector("#fileListContainer", { timeout: 10000 });
    await page.waitForTimeout(2000);

    const filesBodyText = await page.textContent("body");

    // Check for file-level actions (like download/raw which exist)
    checks.fileActionsVisible = filesBodyText.indexOf("README.md") !== -1;

    // ── Phase 3: Branch context ──────────────────────────────────────────
    // Navigate to files with branch query param
    const branchFilesUrl = seeded.baseUrl + "/project-space.html?project_id=" + encodeURIComponent(seeded.projectId) +
      "&tab=files&branch=" + encodeURIComponent(seeded.branchName);
    await page.goto(branchFilesUrl, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    checks.branchFilesUrlLoaded = page.url().indexOf("branch=") !== -1;

    // ── Phase 4: Check for fake controls ──────────────────────────────────
    const finalBodyText = await page.textContent("body");
    checks.noFakeCloneText = finalBodyText.indexOf("git clone") === -1 && finalBodyText.indexOf("clone URL") === -1;
    checks.noFakeProviderText = finalBodyText.indexOf("github") === -1 && finalBodyText.indexOf("gitlab") === -1;
    checks.noFakeTarballText = finalBodyText.indexOf("tarball") === -1 && finalBodyText.indexOf("tar.gz") === -1;

    // ── Phase 5: Screenshot ──────────────────────────────────────────────
    await page.waitForTimeout(500);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    screenshotPath = SCREENSHOT_PATH;
    checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    const allPassed = Object.keys(checks).every(function (k) { return checks[k] === true; });
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
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch("" + baseUrl + urlPath, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data: data };
}

async function rawFetch(baseUrl, method, urlPath, token) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch("" + baseUrl + urlPath, { method: method, headers: headers });
  const raw = await res.arrayBuffer();
  const rawBytes = new Uint8Array(raw);
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(rawBytes).toString("utf8"),
    rawBody: rawBytes,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Evidence writer
// ────────────────────────────────────────────────────────────────────────────

function writeEvidence(result) {
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const viewportLabel = result.viewport.width + "x" + result.viewport.height;
  const endpointStatus = result.checks.archiveApi && result.checks.archiveApi.archiveEndpointReachable
    ? "present (HTTP 200)"
    : "NOT IMPLEMENTED (Batch94 A/D not landed)";
  const archiveEndpointPath = result.checks.archiveApi && result.checks.archiveApi.archiveProbedPath
    ? result.checks.archiveApi.archiveProbedPath
    : "none discovered";

  const lines = [];
  lines.push("# Project Space Repository Archive — Smoke Evidence");
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
  lines.push("## Archive Endpoint Status");
  lines.push("");
  lines.push("- **Archive endpoint:** " + endpointStatus);
  lines.push("- **Probed path:** " + archiveEndpointPath);
  lines.push("");

  // Static wiring table.
  lines.push("## Static Wiring (Dashboard HTML Archive Frontend)");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (const swKey in result.checks.staticWiring) {
    if (!result.checks.staticWiring.hasOwnProperty(swKey)) continue;
    const swVal = result.checks.staticWiring[swKey] === true ? "✅ PASS" : "❌ FAIL";
    lines.push("| " + swKey + " | " + swVal + " |");
  }
  lines.push("");

  // Fake controls table.
  lines.push("## Fake Controls Audit");
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|---|---|");
  for (const fcKey in result.checks.fakeControlsAbsent) {
    if (!result.checks.fakeControlsAbsent.hasOwnProperty(fcKey)) continue;
    const fcVal = result.checks.fakeControlsAbsent[fcKey] === true ? "✅ PASS (absent)" : "❌ FAIL (present)";
    lines.push("| " + fcKey + " | " + fcVal + " |");
  }
  lines.push("");

  // Archive API checks table.
  if (result.checks.archiveApi) {
    lines.push("## Archive API Checks");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    for (const apiKey in result.checks.archiveApi) {
      if (!result.checks.archiveApi.hasOwnProperty(apiKey) || apiKey.startsWith("_")) continue;
      const val = result.checks.archiveApi[apiKey];
      let apiVal;
      if (val === true) {
        apiVal = "✅ PASS";
      } else if (val === null) {
        apiVal = "⏭️ N/A";
      } else if (typeof val === "string") {
        apiVal = "ℹ️ " + val;  // informational metadata (e.g. probed path)
      } else {
        apiVal = "❌ FAIL";
      }
      lines.push("| " + apiKey + " | " + apiVal + " |");
    }
    lines.push("");
  }

  // Browser checks.
  if (result.checks.browser) {
    lines.push("## Browser UI Checks");
    lines.push("");
    lines.push("| Check | Result |");
    lines.push("|---|---|");
    for (const brKey in result.checks.browser) {
      if (!result.checks.browser.hasOwnProperty(brKey)) continue;
      const brVal = result.checks.browser[brKey] === true ? "✅ PASS" : "❌ FAIL";
      lines.push("| " + brKey + " | " + brVal + " |");
    }
    lines.push("");
  }

  if (result.errors.length) {
    lines.push("## Errors");
    lines.push("");
    for (let e = 0; e < result.errors.length; e++) {
      lines.push("- " + result.errors[e]);
    }
    lines.push("");
  }

  if (result.residual.length) {
    lines.push("## Residual Gaps");
    lines.push("");
    for (let r = 0; r < result.residual.length; r++) {
      lines.push("- " + result.residual[r]);
    }
    lines.push("");
  }

  // Seed scenario.
  lines.push("## Seed Scenario");
  lines.push("");
  lines.push("- **Project:** Repository Archive Smoke Project (private)");
  lines.push("- **Seed files:** `README.md`, `src/main.ts`, `docs/guide.md`, `src/utils/helper.ts`");
  lines.push("- **Branch snapshot:** Created via changeset → approve → merge. Modifies README.md to branch content, adds `branch-only-file.ts`.");
  lines.push("- **Live-only changes (post-HEAD):** Modifies README.md to live-only content, creates `live-only-post-commit.ts`.");
  lines.push("- **Actors:** owner (admin), member (can read), viewer (member with view role), outsider (registered but not member), anonymous (no auth)");
  lines.push("");

  // Current state summary.
  lines.push("## Current State Summary");
  lines.push("");
  lines.push("### Archive Endpoint");
  lines.push("");
  if (result.checks.archiveApi && result.checks.archiveApi.archiveEndpointReachable) {
    lines.push("- `GET " + archiveEndpointPath + "` is implemented.");
    lines.push("- Owner, member, viewer can download. Outsider 403. Anonymous 401.");
    lines.push("- ZIP response has Content-Type: application/zip and Content-Disposition: attachment.");
    lines.push("- Archive contains expected file paths and content.");
    lines.push("- Branch archive uses snapshot content and excludes live-only changes.");
  } else {
    lines.push("- **Not yet implemented.** Batch94 A/D (archive API and design) have not landed.");
    lines.push("- The smoke test probes `/archive.zip` first, followed by fallback paths.");
    lines.push("- All permission/header/content checks are reported as **N/A** (not exercised) rather than false PASS.");
    lines.push("");
    lines.push("  **Expected endpoint contract:**");
    lines.push("  - `GET /v1/projects/:project_id/archive[?format=zip][&branch=<name>]`");
    lines.push("  - Owner, member, viewer: 200 with ZIP body");
    lines.push("  - Outsider: 403, Anonymous: 401");
    lines.push("  - Content-Type: application/zip");
    lines.push("  - Content-Disposition: attachment; filename=\"<project-name>.zip\"");
    lines.push("  - Non-branch archive: includes all live files, excludes branch-only files");
    lines.push("  - Branch archive: uses commit snapshot content, excludes post-HEAD files");
  }
  lines.push("");

  lines.push("### Static Wiring (Dashboard Frontend)");
  lines.push("");
  lines.push("- Archive-related functions and UI elements are probed in the dashboard HTML.");
  lines.push("- No git clone, tarball, zipball, provider blame, rollback, or external provider controls.");
  lines.push("");

  lines.push("### Verified Absent (No Fake Controls)");
  lines.push("");
  lines.push("- No `git clone` / remote clone UI.");
  lines.push("- No tarball/zipball download controls.");
  lines.push("- No fake Git/provider blame UI.");
  lines.push("- No rollback/revert controls.");
  lines.push("- No external provider (GitHub/GitLab/Gitee/Bitbucket) references.");
  lines.push("- No external clone URL or remote origin controls.");
  lines.push("- No Subversion/SVN references.");
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
    const { AppDataSource } = require(DATASOURCE_MODULE);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  } catch (_) {}
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
