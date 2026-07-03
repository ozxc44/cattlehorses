#!/usr/bin/env node
// Project Space Review Comments — backend API smoke.
//
// Tests changeset review comment behavior at the API level.
// The changeset comment API (POST/GET/PATCH /comments) supports
// general comments, file/line anchored comments, threaded replies,
// and resolve/reopen state transitions.
//
// If Playwright is not resolvable, the script still verifies backend data
// setup and static JS wiring, then exits with a structured result.
//
// Usage:
//   node scripts/smoke-project-space-review-comments.js
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-review-comments-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

const DEFAULT_PLAYWRIGHT_NODE_MODULES =
  "/Users/z/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PLAYWRIGHT_NODE_MODULES = process.env.PLAYWRIGHT_NODE_MODULES_PATH || DEFAULT_PLAYWRIGHT_NODE_MODULES;
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH || "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT || "900", 10);

let server = null;
let appDataSource = null;
let browser = null;
let context = null;

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  // ── Self-test: sanitizer must redact camelCase token keys ───────────────
  smokeTestSanitizer();

  const result = {
    command: "node scripts/smoke-project-space-review-comments.js",
    timestamp: new Date().toISOString(),
    passed: false,
    skipped: false,
    browserAvailable: false,
    backendBuilt: fs.existsSync(APP_MODULE) && fs.existsSync(DATASOURCE_MODULE),
    screenshotPath: null,
    evidencePath: EVIDENCE_MD,
    checks: {},
    errors: [],
    pendingDeps: [],
    // Feature gap notes: intentionally empty because the changeset comment
    // API (POST/GET/PATCH /comments) is now implemented in Batch99.
    // Future gaps (UI integration, DELETE, edit history) are tracked
    // separately in the audit notes or future batches.
    missingFeatures: [],
    auditNotes: {
      deleteCommentEndpoint: "DELETE /comments not implemented — soft-delete via PATCH status=resolved only",
      commentEditHistory: "No comment edit history tracking — content overwritten on PATCH",
      fakeProviderReviewSync: "No external provider review sync detected — absent by design",
      emailNotification: "No email notification facility for review comments — absent by design",
      signedReview: "No external signed review mechanism — absent by design",
      remoteCI: "No remote CI integration for review comments — absent by design",
      externalCodeOwnerControls: "No code-owner-based access controls — absent by design",
    },
  };

  try {
    if (!result.backendBuilt) {
      throw new Error("Backend dist missing. Run: cd backend && npm run build");
    }

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    // ── 1. Backend API checks ─────────────────────────────────────────────
    const backendChecks = await runBackendChecks();
    result.checks.backend = backendChecks.checks;
    result.pendingDeps = backendChecks.pendingDeps || [];

    // Extract non-secret seed identifiers for debugging evidence, then strip
    // the raw _seeded object (which may contain JWT tokens) from the result.
    // MUST run before any writeEvidence call (Playwright and no-Playwright paths).
    // Save seeded ref first — runBrowserSmoke needs it but the _seeded key is
    // deleted from the shared backendChecks object below.
    const seededData = result.checks.backend && result.checks.backend._seeded;
    if (seededData) {
      result.seedIds = {
        projectId: seededData.projectId,
        changesetId: seededData.changesetId,
        browserChangesetId: seededData.browserChangesetId,
        ownerId: seededData.ownerId,
        memberId: seededData.memberId,
        viewerId: seededData.viewerId,
      };
      delete result.checks.backend._seeded;
    }

    if (!backendChecks.available) {
      result.errors.push("Backend review-comments API is not available.");
      result.passed = false;
      await writeEvidence(result);
      process.exit(1);
    }

    // ── 2. Static JS wiring check ─────────────────────────────────────────
    const staticChecks = checkStaticWiring();
    result.checks.staticWiring = staticChecks;

    const backendOk = Object.values(result.checks.backend).every((v) => typeof v === "boolean" ? v : true);
    const staticOk = (staticChecks.required ? Object.values(staticChecks.required) : [])
      .filter((v) => typeof v === "boolean")
      .every(Boolean);

    if (!playwright) {
      result.skipped = true;
      result.passed = backendOk && staticOk;
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 3. Real browser smoke ─────────────────────────────────────────────
    const browserResult = await runBrowserSmoke(playwright, seededData);
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    result.passed = backendOk && staticOk && browserResult.passed;
    if (!result.passed) {
      if (!backendOk) result.errors.push("Backend review-comments checks failed.");
      if (!staticOk) result.errors.push("Static review-comments wiring checks failed.");
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

async function runBackendChecks() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-review-comments-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";

  // Mirror backend test CWD for OpenAPI path resolution.
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;

  await AppDataSource.initialize();
  appDataSource = AppDataSource;
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const checks = {};
  const pendingDeps = [];

  try {
    // ── Register owner ───────────────────────────────────────────────────
    const ownerEmail = `review-comments-owner-${Date.now()}@example.invalid`;
    const password = "SmokeTest123!";
    const ownerReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: ownerEmail,
      password,
      display_name: "Review Comments Owner",
    });
    if (ownerReg.status !== 201) {
      pendingDeps.push("User registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const ownerToken = ownerReg.data.access_token;
    const ownerId = ownerReg.data.user.id;

    // ── Register a member user ───────────────────────────────────────────
    const memberEmail = `review-comments-member-${Date.now()}@example.invalid`;
    const memberReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: memberEmail,
      password,
      display_name: "Review Comments Member",
    });
    if (memberReg.status !== 201) {
      pendingDeps.push("Member registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const memberToken = memberReg.data.access_token;
    const memberId = memberReg.data.user.id;

    // ── Register a viewer user ───────────────────────────────────────────
    const viewerEmail = `review-comments-viewer-${Date.now()}@example.invalid`;
    const viewerReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: viewerEmail,
      password,
      display_name: "Review Comments Viewer",
    });
    if (viewerReg.status !== 201) {
      pendingDeps.push("Viewer registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const viewerToken = viewerReg.data.access_token;
    const viewerId = viewerReg.data.user.id;

    // ── Register a non-member (outsider) user ────────────────────────────
    const outsiderEmail = `review-comments-outsider-${Date.now()}@example.invalid`;
    const outsiderReg = await api(baseUrl, "POST", "/v1/auth/register", null, {
      email: outsiderEmail,
      password,
      display_name: "Review Comments Outsider",
    });
    if (outsiderReg.status !== 201) {
      pendingDeps.push("Outsider registration unavailable");
      return { checks, pendingDeps, available: false };
    }
    const outsiderToken = outsiderReg.data.access_token;

    // ── Create project ───────────────────────────────────────────────────
    const projectRes = await api(baseUrl, "POST", "/v1/projects", ownerToken, {
      name: "Review Comments Smoke Project",
      description: "Smoke for changeset review comments",
    });
    if (projectRes.status !== 201) {
      pendingDeps.push("Project creation unavailable");
      return { checks, pendingDeps, available: false };
    }
    const projectId = projectRes.data.id;

    // ── Add member (role: member) ────────────────────────────────────────
    const addMemberRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
      user_id: memberId,
      role: "member",
    });
    if (addMemberRes.status !== 201) {
      pendingDeps.push("Add member unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Add viewer ───────────────────────────────────────────────────────
    const addViewerRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
      user_id: viewerId,
      role: "viewer",
    });
    if (addViewerRes.status !== 201) {
      pendingDeps.push("Add viewer unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Create base file ─────────────────────────────────────────────────
    const fileRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, ownerToken, {
      path: "README.md",
      content: "# Review Comments Smoke\n\nOriginal content",
      message: "Initial README",
    });
    if (fileRes.status !== 201) {
      pendingDeps.push("File creation unavailable");
      return { checks, pendingDeps, available: false };
    }

    // ── Create changeset ─────────────────────────────────────────────────
    const csRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, ownerToken, {
      title: "Test review comments",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Review Comments Smoke\n\nUpdated content",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    });
    if (csRes.status !== 201) {
      pendingDeps.push("Changeset creation unavailable");
      return { checks, pendingDeps, available: false };
    }
    const changesetId = csRes.data.id;

    // =====================================================================
    // CHANGESET COMMENT API CHECKS
    // =====================================================================

    // ── C1: Owner can create a general comment (no anchor) ───────────────
    const generalComment = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      { content: "This is a general comment for the changeset." }
    );
    checks.ownerCanCreateGeneralComment =
      generalComment.status === 201 &&
      generalComment.data.content === "This is a general comment for the changeset." &&
      generalComment.data.file_path === null &&
      generalComment.data.side === null &&
      generalComment.data.line === null &&
      generalComment.data.status === "active" &&
      generalComment.data.author_type === "user" &&
      generalComment.data.author_id === ownerId;
    const genCommentId = generalComment.status === 201 ? generalComment.data.id : null;

    // ── C2: Owner can create a file/line anchored comment ────────────────
    const anchoredComment = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      {
        content: "This line needs fixing.",
        file_path: "README.md",
        side: "head",
        line: 3,
      }
    );
    checks.ownerCanCreateAnchoredComment =
      anchoredComment.status === 201 &&
      anchoredComment.data.file_path === "README.md" &&
      anchoredComment.data.side === "head" &&
      anchoredComment.data.line === 3 &&
      anchoredComment.data.content === "This line needs fixing." &&
      anchoredComment.data.status === "active";
    const anchoredCommentId = anchoredComment.status === 201 ? anchoredComment.data.id : null;

    // ── C3: Owner can create a threaded reply ────────────────────────────
    let threadedComment = null;
    if (genCommentId) {
      threadedComment = await api(
        baseUrl,
        "POST",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
        ownerToken,
        {
          content: "This is a reply to the general comment.",
          parent_comment_id: genCommentId,
        }
      );
    }
    checks.ownerCanCreateThreadedReply =
      threadedComment != null &&
      threadedComment.status === 201 &&
      threadedComment.data.parent_comment_id === genCommentId &&
      threadedComment.data.content === "This is a reply to the general comment.";
    const threadCommentId = threadedComment && threadedComment.status === 201 ? threadedComment.data.id : null;

    // ── C4: Member can create a comment (has SendMessage) ────────────────
    const memberComment = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      memberToken,
      { content: "Member comment on the changeset." }
    );
    checks.memberCanCreateComment =
      memberComment.status === 201 &&
      memberComment.data.author_id === memberId;
    const memberCommentId = memberComment.status === 201 ? memberComment.data.id : null;

    // ── C5: List comments returns all created comments ───────────────────
    const listComments = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken
    );
    checks.commentListReturnsAll =
      listComments.status === 200 &&
      Array.isArray(listComments.data.data) &&
      listComments.data.data.length >= 4 &&
      listComments.data.total >= 4;

    // ── C6: Comment list items contain required metadata ─────────────────
    let listHasGeneral = false;
    let listHasAnchored = false;
    let listHasThreaded = false;
    let listHasMember = false;
    if (listComments.status === 200 && Array.isArray(listComments.data.data)) {
      for (const c of listComments.data.data) {
        if (c.id === genCommentId) {
          listHasGeneral = c.content === "This is a general comment for the changeset." &&
            c.status === "active" &&
            c.author_type === "user" &&
            c.file_path === null &&
            c.side === null &&
            c.line === null &&
            c.parent_comment_id === null;
        }
        if (c.id === anchoredCommentId) {
          listHasAnchored = c.file_path === "README.md" &&
            c.side === "head" &&
            c.line === 3 &&
            c.status === "active";
        }
        if (c.id === threadCommentId) {
          listHasThreaded = c.parent_comment_id === genCommentId &&
            c.content === "This is a reply to the general comment." &&
            c.file_path === null;
        }
        if (c.id === memberCommentId) {
          listHasMember = c.author_id === memberId && c.content === "Member comment on the changeset.";
        }
      }
    }
    checks.commentListMetadataComplete =
      listHasGeneral && listHasAnchored && listHasThreaded && listHasMember;

    // ── C7: Viewer can list/read comments (ViewProject) ──────────────────
    const viewerList = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      viewerToken
    );
    checks.viewerCanListComments =
      viewerList.status === 200 &&
      Array.isArray(viewerList.data.data);

    // ── C8: Viewer cannot create a comment (no SendMessage) ──────────────
    const viewerCreate = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      viewerToken,
      { content: "Viewer should not be able to comment." }
    );
    checks.viewerCannotCreateComment = viewerCreate.status === 403;

    // ── C9: Viewer cannot resolve/reopen a comment (no SendMessage) ──────
    let viewerCannotResolve = false;
    if (genCommentId) {
      const viewerResolve = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments/${genCommentId}`,
        viewerToken,
        { status: "resolved" }
      );
      viewerCannotResolve = viewerResolve.status === 403;
    }
    checks.viewerCannotResolveComment = viewerCannotResolve;

    // ── C10: Owner can resolve a comment (PATCH status → resolved) ──────
    let ownerCanResolve = false;
    let resolvedBy = null;
    let resolvedAt = null;
    if (genCommentId) {
      const resolveRes = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments/${genCommentId}`,
        ownerToken,
        { status: "resolved" }
      );
      ownerCanResolve =
        resolveRes.status === 200 &&
        resolveRes.data.status === "resolved" &&
        resolveRes.data.resolved_by === ownerId &&
        resolveRes.data.resolved_at !== null;
      resolvedBy = resolveRes.data.resolved_by;
      resolvedAt = resolveRes.data.resolved_at;
    }
    checks.ownerCanResolveComment = ownerCanResolve;

    // ── C11: Owner can reopen a resolved comment (PATCH status → active) ─
    let ownerCanReopen = false;
    if (genCommentId) {
      const reopenRes = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments/${genCommentId}`,
        ownerToken,
        { status: "active" }
      );
      ownerCanReopen =
        reopenRes.status === 200 &&
        reopenRes.data.status === "active" &&
        reopenRes.data.resolved_by === null &&
        reopenRes.data.resolved_at === null;
    }
    checks.ownerCanReopenComment = ownerCanReopen;

    // ── C12: Member can resolve own comment ──────────────────────────────
    let memberCanResolveOwn = false;
    if (memberCommentId) {
      const memberResolve = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments/${memberCommentId}`,
        memberToken,
        { status: "resolved" }
      );
      memberCanResolveOwn =
        memberResolve.status === 200 &&
        memberResolve.data.status === "resolved" &&
        memberResolve.data.resolved_by === memberId;
    }
    checks.memberCanResolveOwnComment = memberCanResolveOwn;

    // ── C13: Outsider gets 403 on create ─────────────────────────────────
    const outsiderCreate = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      outsiderToken,
      { content: "Outsider attempt." }
    );
    checks.outsiderCannotCreateComment = outsiderCreate.status === 403;

    // ── C14: Anonymous gets 401 on create ────────────────────────────────
    const anonCreate = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      null,
      { content: "Anonymous attempt." }
    );
    checks.anonymousCannotCreateComment = anonCreate.status === 401;

    // ── C15: Invalid side is rejected (422) ──────────────────────────────
    const invalidSide = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      {
        content: "Invalid side test",
        file_path: "README.md",
        side: "invalid_side_value",
      }
    );
    checks.invalidSideRejected = invalidSide.status === 422;

    // ── C16: Invalid line (0) is rejected (422) ──────────────────────────
    const invalidLine = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      {
        content: "Invalid line test",
        file_path: "README.md",
        line: 0,
      }
    );
    checks.invalidLineRejected = invalidLine.status === 422;

    // ── C17: Line without file_path is rejected (422) ────────────────────
    const lineNoFile = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      {
        content: "Line without file test",
        line: 5,
      }
    );
    checks.lineWithoutFileRejected = lineNoFile.status === 422;

    // ── C18: Invalid status on PATCH is rejected (422) ───────────────────
    let invalidStatusRejected = false;
    if (genCommentId) {
      const invalidStatus = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId}/comments/${genCommentId}`,
        ownerToken,
        { status: "bogus_status" }
      );
      invalidStatusRejected = invalidStatus.status === 422;
    }
    checks.invalidStatusRejected = invalidStatusRejected;

    // ── C19: Invalid parent_comment_id is rejected (404) ─────────────────
    const fakeParentId = "00000000-0000-0000-0000-000000000000";
    const invalidParent = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/changesets/${changesetId}/comments`,
      ownerToken,
      {
        content: "Reply to non-existent parent.",
        parent_comment_id: fakeParentId,
      }
    );
    checks.invalidParentCommentRejected = invalidParent.status === 404;

    // ═════════════════════════════════════════════════════════════════════
    // Legacy review-with-notes checks (still valid smoke coverage)
    // ═════════════════════════════════════════════════════════════════════

    // ── R1: Owner can review with notes ──────────────────────────────────
    const reviewWithNotes = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      ownerToken,
      { decision: "changes_requested", notes: "Please update the title" }
    );
    checks.ownerCanReviewWithNotes = reviewWithNotes.status === 200 &&
      reviewWithNotes.data.status === "changes_requested" &&
      reviewWithNotes.data.review_notes === "Please update the title";

    // ── R2: Reviews array serialized correctly ───────────────────────────
    checks.reviewsArraySerialized =
      reviewWithNotes.status === 200 &&
      Array.isArray(reviewWithNotes.data.reviews) &&
      reviewWithNotes.data.reviews.length === 1 &&
      reviewWithNotes.data.reviews[0].decision === "changes_requested" &&
      reviewWithNotes.data.reviews[0].reviewer_type === "user";

    // ── R3: Diff endpoint available ──────────────────────────────────────
    const diffRes = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/changesets/${changesetId}/diff`,
      ownerToken
    );
    checks.diffEndpointAvailable = diffRes.status === 200 &&
      Array.isArray(diffRes.data.files) &&
      diffRes.data.files.length === 1;

    // ── R4: Owner can approve a new changeset ────────────────────────────
    const csRes2 = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, ownerToken, {
      title: "Test approval flow",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Review Comments Smoke\n\nApproved content",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    });
    const changesetId2 = csRes2.status === 201 ? csRes2.data.id : null;
    let approveResult;
    if (changesetId2) {
      approveResult = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${changesetId2}/review`,
        ownerToken,
        { decision: "approved", notes: "Looks good" }
      );
    }
    checks.ownerCanApproveWithNotes =
      approveResult != null &&
      approveResult.status === 200 &&
      approveResult.data.status === "approved" &&
      approveResult.data.review_notes === "Looks good";

    // ── R5: Viewer cannot review (403) ───────────────────────────────────
    const viewerReview = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      viewerToken,
      { decision: "approved", notes: "Viewer approval attempt" }
    );
    checks.viewerCannotReview = viewerReview.status === 403;

    // ── R6: Member cannot review (403) ───────────────────────────────────
    const memberReview = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      memberToken,
      { decision: "approved", notes: "Member approval attempt" }
    );
    checks.memberCannotReview = memberReview.status === 403;

    // ── R7: Outsider/anonymous denied ────────────────────────────────────
    const outsiderReview = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      outsiderToken,
      { decision: "approved", notes: "Outsider approval attempt" }
    );
    checks.outsiderCannotReview = outsiderReview.status === 403;

    const anonymousReview = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      null,
      { decision: "approved", notes: "Anonymous approval attempt" }
    );
    checks.anonymousCannotReview = anonymousReview.status === 401;

    // ── R8: Detail endpoint returns reviews ──────────────────────────────
    const detailRes = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/changesets/${changesetId}`,
      ownerToken
    );
    checks.detailReturnsReviews = detailRes.status === 200 &&
      Array.isArray(detailRes.data.reviews) &&
      detailRes.data.reviews.length >= 1;

    // ── R9: Review decisions transition state correctly ──────────────────
    const transitionResult = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      ownerToken,
      { decision: "approved", notes: "I accept the changes now" }
    );
    checks.reviewDecisionStateTransition =
      transitionResult.status === 200 &&
      transitionResult.data.status === "approved" &&
      transitionResult.data.reviews.length >= 1;

    // ── R10: Reject decision works ───────────────────────────────────────
    const csRes3 = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, ownerToken, {
      title: "Test rejection flow",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Review Comments Smoke\n\nRejected attempt",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    });
    if (csRes3.status === 201) {
      const rejectResult = await api(
        baseUrl,
        "PATCH",
        `/v1/projects/${projectId}/changesets/${csRes3.data.id}/review`,
        ownerToken,
        { decision: "rejected", notes: "This is not acceptable" }
      );
      checks.rejectDecisionWorks = rejectResult.status === 200 &&
        rejectResult.data.status === "rejected" &&
        rejectResult.data.review_notes === "This is not acceptable";
    }

    // ── R11: Invalid review decision is rejected ─────────────────────────
    const invalidDecision = await api(
      baseUrl,
      "PATCH",
      `/v1/projects/${projectId}/changesets/${changesetId}/review`,
      ownerToken,
      { decision: "invalid_decision", notes: "test" }
    );
    checks.invalidReviewDecisionRejected = invalidDecision.status === 422;

    // ── Create a fresh un-reviewed changeset for browser smoke ───────────
    const csBrowserRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/changesets`, ownerToken, {
      title: "Browser review smoke",
      file_ops: [
        {
          op: "upsert",
          path: "README.md",
          content: "# Review Comments Smoke\n\nBrowser content",
          base_revision_id: fileRes.data.current_revision_id,
        },
      ],
    });
    const browserChangesetId = csBrowserRes.status === 201 ? csBrowserRes.data.id : null;

    // ── Store seeded state for browser smoke ─────────────────────────────
    checks._seeded = {
      baseUrl,
      ownerToken,
      memberToken,
      viewerToken,
      ownerId,
      memberId,
      viewerId,
      projectId,
      changesetId,
      browserChangesetId,
    };

    return { checks, pendingDeps, available: true };
  } catch (err) {
    return { checks, pendingDeps, available: false, error: String(err) };
  }
}

function checkStaticWiring() {
  const required = {};
  const info = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // ── Required checks (must all be true) ──────────────────────────────

    // Changeset detail drawer markup exists.
    required.changesetDetailMarkup =
      html.includes('id="changesetDetailPane"') &&
      html.includes('id="changesetDetailBody"');

    // Review_notes is referenced as the comment mechanism.
    required.reviewNotesReferenced =
      html.includes("review_notes") ||
      html.includes("reviewNotes") ||
      html.includes("review-notes") ||
      html.includes("review notes");

    // No fake email/notification claims for review comments.
    required.noFakeNotificationClaim =
      !html.includes("邮件已发送") &&
      !html.includes("email sent") &&
      !html.includes("external review notification") &&
      !html.includes("email notification") &&
      !html.includes("external notification");

    // No fake provider review sync claims.
    required.noFakeProviderSyncClaim =
      !html.includes("external review provider") &&
      !html.includes("third-party review") &&
      !html.includes("remote review") &&
      !html.includes("signed review");

    // Review action controls exist (approve, request_changes).
    required.reviewActionControls =
      html.includes("data-cs-action=\"approve\"") &&
      html.includes("data-cs-action=\"request_changes\"");

    // Inline script parses.
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      vm.compileFunction(scriptMatch[1].trim());
      required.inlineScriptParses = true;
    } else {
      required.inlineScriptParses = false;
    }

    // ── Informational checks (not counted toward pass/fail) ──────────────

    // General comment UI — check if any general comment markup exists.
    // Currently expected to be ABSENT since comment UI is not yet built
    // in dashboard/project-space.html (frontend lane is future work).
    info.generalCommentUiPresent =
      html.includes("data-tab=\"comments\"") ||
      html.includes("#commentsPanel") ||
      html.includes("commentsPanel");

    // File/line comment UI — check if any inline comment markup exists.
    info.fileLineCommentUiPresent =
      html.includes("data-testid=\"inline-comment\"") ||
      html.includes("inline-comment") ||
      html.includes("data-line-comment");
  } catch (err) {
    required.error = String(err);
  }
  return { required, info };
}

async function runBrowserSmoke(playwright, seeded) {
  const result = {
    passed: false,
    checks: {},
    errors: [],
    screenshotPath: null,
  };

  if (!seeded) {
    result.errors.push("No seeded data for browser smoke");
    return result;
  }

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();

  try {
    const origin = seeded.baseUrl;
    const storageKey = "zz_human_workspace_simple_v1";
    const storagePayload = JSON.stringify({
      jwt: seeded.ownerToken,
      selectedProjectId: seeded.projectId,
      baseUrl: origin,
    });

    await page.goto(origin);
    await page.evaluate(
      ({ key, value }) => { localStorage.setItem(key, value); },
      { key: storageKey, value: storagePayload }
    );

    const changesetForBrowser = seeded.browserChangesetId || seeded.changesetId;
    const url =
      `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=reviews&changeset_id=${encodeURIComponent(changesetForBrowser)}`;
    await page.goto(url, { waitUntil: "networkidle" });

    // Wait for the Reviews tab to become active.
    await page.waitForSelector('.tab-item[data-tab="reviews"].active', { timeout: 10000 });
    result.checks.reviewsTabActive = true;

    // Click Reviews tab to force data load.
    await page.click('.tab-item[data-tab="reviews"]', { force: true });

    // Changeset detail drawer opened.
    await page.waitForSelector("#changesetDetailPane.open", { timeout: 10000 });
    result.checks.changesetDetailOpened = true;

    // Title visible.
    const title = await page.textContent("#changesetDetailTitle");
    result.checks.detailTitle = title && (title.includes("Test review comments") || title.includes("Browser review smoke"));

    // Check that detail body doesn't make fake email/webhook claims.
    const bodyText = await page.textContent("#changesetDetailBody");
    result.checks.noFakeNotificationClaims =
      !bodyText.includes("邮件已发送") &&
      !bodyText.includes("email sent") &&
      !bodyText.includes("notification sent") &&
      !bodyText.includes("external notification") &&
      !bodyText.includes("external CI");

    // Check no fake inline comment UI is rendered (comment UI not yet built in dashboard).
    const inlineCommentElements = await page.$$("[data-testid=\"inline-comment\"]");
    result.checks.noInlineCommentUi = inlineCommentElements.length === 0;

    // Check no general comment panel is rendered.
    const commentPanels = await page.$$("#commentsPanel");
    result.checks.noCommentsPanel = commentPanels.length === 0;

    // Review action controls present.
    await page.waitForSelector("[data-cs-action='approve']", { timeout: 5000 });
    await page.waitForSelector("[data-cs-action='request_changes']", { timeout: 5000 });
    result.checks.reviewActionControlsVisible = true;

    // Screenshot.
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    result.passed = Object.values(result.checks)
      .filter((v) => typeof v === "boolean")
      .every(Boolean);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try { await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true }); result.screenshotPath = SCREENSHOT_PATH; } catch (_) {}
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

/**
 * Regression check: prove deepSanitize redacts camelCase token keys.
 * Called once at startup. If this fails, the smoke exits immediately
 * before any backend work or evidence write.
 */
function smokeTestSanitizer() {
  const sample = {
    ownerToken: "secret",
    memberToken: "secret",
    viewerToken: "secret",
    authToken: "secret",
    jwtToken: "secret",
    Authorization: "Bearer secret",
    jwt: "secret",
  };
  const sanitized = deepSanitize(sample);
  const failures = [];
  for (const key of Object.keys(sample)) {
    if (sanitized[key] !== "[REDACTED]") {
      failures.push(key);
    }
  }
  if (failures.length) {
    throw new Error(
      `Sanitizer regression: keys [${failures.join(", ")}] were NOT redacted. ` +
      `deepSanitize(${JSON.stringify(sample)}) => ${JSON.stringify(sanitized)}`
    );
  }
}

/**
 * Recursively sanitize an object tree, replacing values under keys whose
 * names contain "token", "authorization", or "jwt" (case-insensitive)
 * with "[REDACTED]" to prevent accidental credential leakage in evidence.
 */
function deepSanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(deepSanitize);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (/token|authorization|jwt/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = deepSanitize(value);
    }
  }
  return out;
}

async function writeEvidence(result) {
  // Defensive sanitizer: redact any values under keys matching token/auth/jwt
  // patterns to prevent accidental credential leakage in evidence artifacts.
  result = deepSanitize(result);

  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const md = [
    "# Project Space Review Comments — Smoke Evidence",
    "",
    "## Summary",
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
  ];

  if (result.seedIds) {
    md.push("## Seed Identifiers", "", "```json", JSON.stringify(result.seedIds, null, 2), "```", "");
  }

  md.push(
    "",
    "## Feature Gap Notes",
    "",
  );

  if (result.missingFeatures && result.missingFeatures.length) {
    md.push("", ...result.missingFeatures.map((f) => `- ${f}`), "");
  } else {
    md.push("*No acceptance-critical feature gaps. See Audit Notes for deferred capabilities.*");
  }

  md.push(
    "",
    "## Backend Checks",
    "",
    "```json",
    JSON.stringify(result.checks.backend || {}, null, 2),
    "```",
    "",
    "## Static Wiring Checks",
    "",
    "```json",
    JSON.stringify(result.checks.staticWiring || {}, null, 2),
    "```",
    "",
  );

  if (result.checks.browser) {
    md.push("## Browser Checks", "", "```json", JSON.stringify(result.checks.browser, null, 2), "```", "");
  }

  if (result.pendingDeps && result.pendingDeps.length) {
    md.push("## Pending Dependencies", "", ...result.pendingDeps.map((d) => `- ${d}`), "");
  }

  if (result.errors.length) {
    md.push("## Errors", "", ...result.errors.map((e) => `- ${e}`), "");
  }

  if (result.auditNotes) {
    md.push("## Audit Notes", "");
    for (const [key, note] of Object.entries(result.auditNotes)) {
      md.push(`- **${key}:** ${note}`);
    }
    md.push("");
  }

  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async () => {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (appDataSource && appDataSource.isInitialized) await appDataSource.destroy();
  } catch (_) {}
});
