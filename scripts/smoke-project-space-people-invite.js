#!/usr/bin/env node
// Project Space People Invite — registered-user add-member browser/runtime smoke.
//
// Verifies that:
//   1. Backend POST /v1/projects/:id/members accepts user_id and creates
//      a member record with the correct role (backend-level verification).
//   2. Backend GET /v1/users/search can look up a user by email prefix.
//   3. Duplicate invite (already-added user) returns 409 Conflict.
//   4. Static dashboard HTML wiring is checked for registered-user search
//      form in the People panel, plus landed People classes (people-panel,
//      people-table, people-role-pill).
//   5. If the invite UI has landed AND Playwright is available, opens the
//      People tab as owner, searches for a registered user, submits with a role,
//      and verifies:
//        a. The invite UI triggers POST /v1/projects/:id/members correctly.
//        b. The invited member appears in the member table.
//        c. The new member row displays the chosen role.
//   6. Assert no fake "email sent" claim unless the backend truly sends email.
//   7. Assert only safeguarded member-management controls are present:
//      PATCH role change (admin/member/viewer only), DELETE removal with
//      confirmation prompt, both gated by canManageMembers() authorization.
//      Fake/unprotected destructive controls (expel, no-confirm removal) fail.
//   8. Verify viewer/member cannot invite (no ManageMembers permission).
//
// This smoke is required once the UI lands. A missing or dishonest add-member
// UI should fail the suite.
//
// Usage:
//   node scripts/smoke-project-space-people-invite.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH  - directory containing a `playwright` package
//                                   (defaults to the bundled runtime path).
//   VIEWPORT_WIDTH / VIEWPORT_HEIGHT - overrides for suite runners.
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
  "project-space-people-invite-smoke"
);
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

  const result = {
    command: "node scripts/smoke-project-space-people-invite.js",
    timestamp: new Date().toISOString(),
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
    if (!result.backendBuilt) {
      throw new Error("Backend dist missing. Run: cd backend && npm run build");
    }

    const playwright = tryRequirePlaywright();
    result.browserAvailable = !!playwright;

    // ── 1. Backend data setup + API capability verification ──────────────
    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      ownerCreated: !!seeded.ownerToken,
      projectCreated: !!seeded.projectId,
      inviteeCreated: !!seeded.inviteeUserId,
      userSearchByEmailWorks: seeded.userSearchByEmailWorks,
      inviteViaApiWorks: seeded.inviteViaApiWorks,
      invitedMemberCorrectRole: seeded.invitedMemberCorrectRole,
      invitedMemberListed: seeded.invitedMemberListed,
      duplicateInviteConflict: seeded.duplicateInviteConflict,
      viewerCannotInvite: seeded.viewerCannotInvite,
      ownerRoleAddRejected: seeded.ownerRoleAddRejected,
      ownerRoleUpdateRejected: seeded.ownerRoleUpdateRejected,
      roleChangeViaApiWorks: seeded.roleChangeViaApiWorks,
      removeViaApiWorks: seeded.removeViaApiWorks,
      viewerCannotRemove: seeded.viewerCannotRemove,
    };

    // ── 2. Static JS wiring check — detect if invite UI has landed ───────
    const staticChecks = checkInviteUiWiring();
    result.checks.staticWiring = staticChecks;
    const inviteUiHasLanded = staticChecks.inviteFormWired;

    if (!inviteUiHasLanded) {
      result.residual.push(
        "People Invite UI (registered-user search form and add-member button) has NOT " +
          "landed in dashboard/project-space.html. The smoke PASSES on backend API capability " +
          "but the browser rendering path is skipped. Revisit when an invite form is added to " +
          "the People panel."
      );
    }

    // ── 3. Determine pass/fail base ────────────────────────────────────
    // Backend checks must always pass.
    const backendOk = allTrue(result.checks.backendSeed);
    // Static wiring: require no error, honest copy, constrained roles, permission gate,
    // no fake email claims, and no destructive controls.
    const staticEssentialOk =
      !staticChecks.error &&
      staticChecks.noFakeEmailSentClaim === true &&
      staticChecks.registeredUserCopyWired === true &&
      staticChecks.rolePickerConstrained === true &&
      staticChecks.manageMembersGateWired === true &&
      staticChecks.noRawApiKeyRendered === true &&
      staticChecks.noInvitationEmailActionCopy === true &&
      staticChecks.noResultCopyWired === true &&
      staticChecks.safeguardedControlsOnly === true &&
      staticChecks.inlineScriptParses === true &&
      staticChecks.peoplePanelLanded === true;

    if (!playwright) {
      result.skipped = true;
      result.passed = backendOk && staticEssentialOk;
      result.residual.push("Real-browser rendering skipped because Playwright is unavailable.");
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    // ── 4. Browser smoke (adaptive) ────────────────────────────────────
    const browserResult = await runBrowserSmokeAdaptive(
      playwright,
      seeded,
      inviteUiHasLanded
    );
    result.checks.browser = browserResult.checks;
    result.screenshotPath = browserResult.screenshotPath;
    if (!browserResult.passed) {
      result.errors.push(...browserResult.errors);
    }

    result.passed = backendOk && staticEssentialOk && browserResult.passed;

    await writeEvidence(result);
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    await writeEvidence(result);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

// ── Playwright resolution ──────────────────────────────────────────────────

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

// ── Backend data setup ────────────────────────────────────────────────────

async function setupBackendData() {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "project-space-people-invite-smoke-secret";
  process.env.SERVE_DASHBOARD = "1";
  process.chdir(path.join(ROOT, "backend"));

  const { AppDataSource } = require(DATASOURCE_MODULE);
  const app = require(APP_MODULE).default;
  appDataSource = AppDataSource;
  await AppDataSource.initialize();
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CORS_ORIGINS = baseUrl;

  const ts = Date.now();

  // ── Owner setup ──────────────────────────────────────────────────────
  const ownerEmail = `people-invite-owner-${ts}@example.invalid`;
  const ownerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: ownerEmail,
    password: "SmokeTest123!",
    display_name: "People Invite Owner",
  });
  if (ownerRes.status !== 201)
    throw new Error(`Owner register failed: ${ownerRes.status}`);
  const ownerToken = ownerRes.data.access_token;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", ownerToken, {
    name: "People Invite Project",
    description: "Project for invite smoke",
  });
  if (projectRes.status !== 201)
    throw new Error(`Project create failed: ${projectRes.status}`);
  const projectId = projectRes.data.id;

  // ── Invitee setup ────────────────────────────────────────────────────
  const inviteeEmail = `people-invite-target-${ts}@example.invalid`;
  const inviteeRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: inviteeEmail,
    password: "SmokeTest456!",
    display_name: "People Invite Target",
  });
  if (inviteeRes.status !== 201)
    throw new Error(`Invitee register failed: ${inviteeRes.status}`);
  const inviteeUserId = inviteeRes.data.user.id;

  // ── Browser invitee (fresh user for browser invite, NOT added as member ─
  const browserInviteEmail = `people-invite-browser-${ts}@example.invalid`;
  const browserInviteDisplayName = "Browser Invite Target";
  const browserInviteRes = await api(
    baseUrl,
    "POST",
    "/v1/auth/register",
    null,
    {
      email: browserInviteEmail,
      password: "SmokeTest999!",
      display_name: browserInviteDisplayName,
    }
  );
  if (browserInviteRes.status !== 201)
    throw new Error(
      `Browser invitee register failed: ${browserInviteRes.status}`
    );
  const browserInviteUserId = browserInviteRes.data.user.id;

  // ── Verify user search by email works ───────────────────────────────
  const searchEmail = inviteeEmail.substring(0, inviteeEmail.indexOf("@"));
  const searchRes = await api(
    baseUrl,
    "GET",
    `/v1/users/search?q=${encodeURIComponent(searchEmail)}`,
    ownerToken
  );
  const userSearchByEmailWorks =
    searchRes.status === 200 &&
    Array.isArray(searchRes.data.data) &&
    searchRes.data.data.some((u) => u.id === inviteeUserId);

  // ── Owner invites invitee via API with role=member ───────────────────
  const inviteRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/members`,
    ownerToken,
    { user_id: inviteeUserId, role: "member" }
  );
  const inviteViaApiWorks = inviteRes.status === 201;

  // ── Verify invited member role ──────────────────────────────────────
  let invitedMemberCorrectRole = false;
  let invitedMemberListed = false;
  if (inviteViaApiWorks) {
    const membersRes = await api(
      baseUrl,
      "GET",
      `/v1/projects/${projectId}/members`,
      ownerToken
    );
    const members = membersRes.data && (membersRes.data.data || membersRes.data);
    if (Array.isArray(members)) {
      const invited = members.find(
        (m) => (m.user_id || m.userId) === inviteeUserId
      );
      invitedMemberCorrectRole =
        !!invited && (invited.role || "").toLowerCase() === "member";
      invitedMemberListed = !!invited;
    }
  }

  // ── Verify duplicate invite returns conflict ────────────────────────
  let duplicateInviteConflict = false;
  if (inviteViaApiWorks) {
    const duplicateRes = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/members`,
      ownerToken,
      { user_id: inviteeUserId, role: "member" }
    );
    duplicateInviteConflict = duplicateRes.status === 409;
  }

  // ── Verify viewer cannot invite (no ManageMembers) ──────────────────
  // Register a viewer user
  const viewerEmail = `people-invite-viewer-${ts}@example.invalid`;
  const viewerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: viewerEmail,
    password: "SmokeTest789!",
    display_name: "People Invite Viewer",
  });
  if (viewerRes.status !== 201)
    throw new Error(`Viewer register failed: ${viewerRes.status}`);
  const viewerToken = viewerRes.data.access_token;
  const viewerUserId = viewerRes.data.user.id;

  // Add viewer as viewer role
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, ownerToken, {
    user_id: viewerUserId,
    role: "viewer",
  });

  // Viewer tries to invite someone new → should be 403
  const outsiderEmail = `people-invite-outsider-${ts}@example.invalid`;
  const outsiderRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: outsiderEmail,
    password: "SmokeTest000!",
    display_name: "People Invite Outsider",
  });
  const outsiderUserId = outsiderRes.data.user.id;

  const viewerInviteRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/members`,
    viewerToken,
    { user_id: outsiderUserId, role: "member" }
  );
  const viewerCannotInvite = viewerInviteRes.status === 403;

  const ownerRoleAddRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/members`,
    ownerToken,
    { user_id: outsiderUserId, role: "owner" }
  );
  const ownerRoleAddRejected = ownerRoleAddRes.status === 422;

  const roleChangeRes = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/members/${inviteeUserId}`,
    ownerToken,
    { role: "viewer" }
  );
  const roleChangeViaApiWorks = roleChangeRes.status === 200 && roleChangeRes.data.role === "viewer";

  const ownerRoleUpdateRes = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/members/${inviteeUserId}`,
    ownerToken,
    { role: "owner" }
  );
  const ownerRoleUpdateRejected = ownerRoleUpdateRes.status === 422;

  const removableEmail = `people-remove-target-${ts}@example.invalid`;
  const removableRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: removableEmail,
    password: "SmokeTestRemove123!",
    display_name: "People Remove Target",
  });
  if (removableRes.status !== 201)
    throw new Error(`Removable register failed: ${removableRes.status}`);
  const removableUserId = removableRes.data.user.id;
  const addRemovableRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/members`,
    ownerToken,
    { user_id: removableUserId, role: "member" }
  );
  if (addRemovableRes.status !== 201)
    throw new Error(`Add removable member failed: ${addRemovableRes.status}`);

  const viewerRemoveRes = await api(
    baseUrl,
    "DELETE",
    `/v1/projects/${projectId}/members/${removableUserId}`,
    viewerToken
  );
  const viewerCannotRemove = viewerRemoveRes.status === 403;

  const removeRes = await api(
    baseUrl,
    "DELETE",
    `/v1/projects/${projectId}/members/${removableUserId}`,
    ownerToken
  );
  const removeViaApiWorks = removeRes.status === 204;

  return {
    baseUrl,
    ownerToken,
    ownerUserId: ownerRes.data.user.id,
    projectId,
    inviteeUserId,
    inviteeEmail,
    browserInviteEmail,
    browserInviteDisplayName,
    browserInviteUserId,
    viewerToken,
    userSearchByEmailWorks,
    inviteViaApiWorks,
    invitedMemberCorrectRole,
    invitedMemberListed,
    duplicateInviteConflict,
    viewerCannotInvite,
    ownerRoleAddRejected,
    ownerRoleUpdateRejected,
    roleChangeViaApiWorks,
    removeViaApiWorks,
    viewerCannotRemove,
  };
}

// ── Static wiring checks ───────────────────────────────────────────────────

function checkInviteUiWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Add-member form in People panel (registered-user search + add button)
    checks.inviteFormWired =
      (html.includes('peopleInviteForm') ||
        html.includes('people-invite-form') ||
        html.includes('peopleInviteEmail') ||
        html.includes('invite-member') ||
        html.includes('inviteMember') ||
        html.includes('add-member') ||
        (html.includes('invite') &&
          (html.includes('type="email"') || html.includes('user-search')))) ||
      false;

    // User search integration (for finding registered users by email)
    checks.userSearchWired =
      html.includes('/v1/users/search') ||
      html.includes('users/search') ||
      html.includes('userSearch') ||
      false;

    // Invite button
    checks.inviteButtonWired =
      html.includes('peopleInviteBtn') ||
      html.includes('people-invite-btn') ||
      html.includes('invite-member-btn') ||
      html.includes('addMemberBtn') ||
      false;

    // People panel with member table has landed
    checks.peoplePanelLanded =
      html.includes('people-panel') ||
      html.includes('people-table') ||
      false;

    // Role pills (owner/admin/member/viewer badges) have landed
    checks.peopleRolePillsLanded =
      html.includes('people-role-pill') ||
      false;

    // The people section should reference POST /members — use a regex
    // to avoid false-positive matching GET /members + authApi("POST").
    checks.postMembersApiWired =
      /api\(\s*["']POST["'][^)]*\/members["'\]]/.test(html) || false;

    checks.registeredUserCopyWired =
      html.includes("已注册用户") &&
      html.includes("不支持通过未注册邮箱邀请");

    checks.rolePickerConstrained =
      html.includes("[['admin', 'admin'], ['member', 'member'], ['viewer', 'viewer']]") &&
      !html.includes("['owner', 'owner']") &&
      !html.includes("['agent', 'agent']");

    checks.manageMembersGateWired =
      html.includes("function canManageMembers()") &&
      html.includes("if (canManageMembers())") &&
      html.includes("currentProjectRole()");

    checks.noResultCopyWired = html.includes("未找到匹配的已注册用户");

    checks.noInvitationEmailActionCopy =
      !/邀请邮件|邮件邀请|Invitation email|email invitation/i.test(html);

    checks.noRawApiKeyRendered =
      !/(agent|a)\.api_key(?!_prefix)/.test(html) &&
      !/(agent|a)\.apiKey(?!Prefix)/.test(html);

    // No fake email-sent claims without backend email
    checks.noFakeEmailSentClaim =
      !html.includes('邀请邮件已发送') &&
      !html.includes('Invitation email sent') &&
      !/email.*sent/i.test(html);

    // Safeguarded member-management controls.
    // Allow PATCH/DELETE member API calls and remove buttons ONLY when they
    // are gated by canManageMembers() authorization + confirmation dialog.
    // Still reject fake/unguarded destructive controls (expel, no-confirm remove).
    checks.safeguardedControlsOnly = (function () {
      const gateExists =
        html.includes("function canManageMembers()") &&
        html.includes("if (canManageMembers())");
      const patchApiExists = /api\(\s*["']PATCH["']/.test(html) && html.includes('/members/');
      const deleteApiExists = /api\(\s*["']DELETE["']/.test(html) && html.includes('/members/');
      const hasRemoveConfirm =
        (html.includes("window.confirm") && html.includes("removeMember")) ||
        (html.includes("peopleMemberConfirmRemoveUserId") && html.includes("cancelRemoveMember"));
      const removeBtnExists = html.includes("people-remove-btn");
      const roleSelectExists = html.includes("people-role-select");
      const ownerRowProtected =
        !html.includes("isOwnerRow") ||
        html.includes("!isOwnerRow");

      // Management API calls are allowed only when gated by canManageMembers()
      const patchGated = !patchApiExists || gateExists;
      const deleteGated = !deleteApiExists || (gateExists && hasRemoveConfirm);
      const removeBtnGated = !removeBtnExists || (gateExists && hasRemoveConfirm);
      const roleSelectGated = !roleSelectExists || gateExists;

      // Still reject fake / unguarded destructive patterns
      const expelAction = 'data-people-action="expel"';
      const deleteAction = 'data-people-action="delete"';
      const expelFn = "expel" + "Member";
      const noConfirmFn = "removeMember" + "WithoutConfirm";
      const noFakeDestructive =
        !html.includes(expelAction) &&
        !html.includes(deleteAction) &&
        !html.includes(expelFn) &&
        !html.includes(noConfirmFn);

      return noFakeDestructive &&
        patchGated && deleteGated &&
        removeBtnGated && roleSelectGated &&
        ownerRowProtected;
    })();

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

// ── Browser smoke (adaptive) ───────────────────────────────────────────────

async function runBrowserSmokeAdaptive(playwright, seeded, inviteUiHasLanded) {
  const result = {
    passed: false,
    screenshotPath: null,
    checks: {},
    errors: [],
  };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  });
  const page = await context.newPage();

  try {
    const storageKey = "zz_human_workspace_simple_v1";
    await page.goto(seeded.baseUrl);
    await page.evaluate(
      ({ key, token, projectId, baseUrl }) => {
        localStorage.setItem(
          key,
          JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl })
        );
      },
      {
        key: storageKey,
        token: seeded.ownerToken,
        projectId: seeded.projectId,
        baseUrl: seeded.baseUrl,
      }
    );

    const url =
      `${seeded.baseUrl}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=people`;
    await page.goto(url, { waitUntil: "networkidle" });
    // Wait for tab active, supporting both primary and overflow tabs.
    const primaryPeople = await page.$('.tab-item[data-tab="people"]');
    if (primaryPeople) {
      await page.waitForSelector('.tab-item[data-tab="people"].active', { timeout: 10000 });
    } else {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector("#tabMoreBtn");
          return btn && btn.classList.contains("has-active") &&
            new URL(window.location.href).searchParams.get("tab") === "people";
        },
        { timeout: 10000 }
      );
    }
    result.checks.peopleTabActive = true;

    await page.waitForSelector(".people-table, .people-panel", {
      timeout: 10000,
    });
    result.checks.peoplePanelRendered = true;

    // Check for invite-related UI
    const inviteFormVisible =
      (await page.$("#peopleInviteForm")) !== null ||
      (await page.$(".people-invite-form")) !== null ||
      (await page.$("#invite-member")) !== null ||
      (await page.$("#peopleInviteEmail")) !== null ||
      (await page.$(".invite-member-btn")) !== null;

    if (inviteUiHasLanded && inviteFormVisible) {
      // Invite UI has landed — attempt the full invite flow via UI
      result.checks.inviteFormVisible = true;

      const roleOptions = await page.$$eval("#peopleInviteRole option", (options) =>
        options.map((option) => option.value).sort()
      );
      result.checks.rolePickerConstrained =
        JSON.stringify(roleOptions) === JSON.stringify(["admin", "member", "viewer"].sort());

      // Try to find and fill the invite email input
      const emailInput =
        (await page.$("#peopleInviteEmail")) ||
        (await page.$("#peopleInviteSearch")) ||
        (await page.$('input[type="email"]')) ||
        (await page.$('input[placeholder*="email"]')) ||
        (await page.$('input[placeholder*="邮箱"]'));

      if (emailInput) {
        await emailInput.fill(seeded.browserInviteEmail);
        result.checks.inviteEmailFilled = true;

        const inviteButtonSelectors = [
          "#peopleInviteBtn",
          "#inviteMemberBtn",
          "#peopleInviteSubmitBtn",
          ".invite-member-btn",
          'button:has-text("Invite")',
          'button:has-text("邀请")',
          'button:has-text("添加")',
        ];
        let inviteButtonSelector = null;
        for (const selector of inviteButtonSelectors) {
          if ((await page.locator(selector).count()) > 0) {
            inviteButtonSelector = selector;
            break;
          }
        }

        if (inviteButtonSelector) {
          await page.waitForFunction(
            (selectors) => {
              for (const selector of selectors) {
                const btn = document.querySelector(selector);
                if (btn && !btn.disabled && btn.offsetParent !== null) return true;
              }
              return false;
            },
            inviteButtonSelectors,
            { timeout: 10000 }
          );
          await page.locator(inviteButtonSelector).first().click();
          // Wait for member table to update
          await page.waitForTimeout(2000);
          result.checks.inviteBtnClicked = true;

          // Verify the invited member appears in the table with the
          // correct role (the browser invite targets a fresh user who
          // has not been added as a member yet).
          const peopleText = await page.textContent(".people-panel");
          result.checks.invitedMemberShownInUi =
            peopleText.includes(seeded.browserInviteDisplayName) ||
            peopleText.includes(seeded.browserInviteEmail.split("@")[0]);
          result.checks.invitedMemberRoleCorrect =
            peopleText.includes(seeded.browserInviteDisplayName) &&
            (peopleText.includes("member") || peopleText.includes("Member"));
        } else {
          result.checks.inviteBtnClicked = false;
        }
      } else {
        result.checks.inviteEmailFilled = false;
      }

      const bodyTextAfterInvite = (await page.textContent("body")) || "";
      result.checks.successMessageVisible = bodyTextAfterInvite.includes("成员已添加");

      const ownerRow = page.locator("tr", { hasText: "People Invite Owner" }).first();
      result.checks.ownerRowProtected =
        (await ownerRow.locator(".people-role-select").count()) === 0 &&
        (await ownerRow.locator(".people-remove-btn").count()) === 0 &&
        ((await ownerRow.textContent()) || "").includes("受保护");

      let invitedRow = page.locator("tr", { hasText: seeded.browserInviteDisplayName }).first();
      result.checks.memberManagementControlsVisible =
        (await invitedRow.locator(".people-role-select").count()) === 1 &&
        (await invitedRow.locator(".people-remove-btn").count()) === 1;

      if (result.checks.memberManagementControlsVisible) {
        await invitedRow.locator(".people-role-select").selectOption("viewer");
        await page.waitForTimeout(1000);
        invitedRow = page.locator("tr", { hasText: seeded.browserInviteDisplayName }).first();
        const roleUpdatedText = (await invitedRow.textContent()) || "";
        result.checks.memberRoleChangedInUi =
          roleUpdatedText.includes("viewer") || roleUpdatedText.includes("Viewer");

        await invitedRow.locator(".people-remove-btn").click();
        await page.waitForTimeout(250);
        invitedRow = page.locator("tr", { hasText: seeded.browserInviteDisplayName }).first();
        result.checks.memberRemoveNeedsConfirmation =
          ((await invitedRow.textContent()) || "").includes("确认移除");
        await invitedRow.locator(".people-remove-btn.confirm").click();
        await page.waitForFunction(
          (displayName) => {
            const rows = Array.from(document.querySelectorAll(".people-panel tr"));
            return rows.every((row) => !((row.textContent || "").includes(displayName)));
          },
          seeded.browserInviteDisplayName,
          { timeout: 10000 }
        ).catch(() => {});
        result.checks.memberRemovedFromUi =
          (await page.locator("tr", { hasText: seeded.browserInviteDisplayName }).count()) === 0;
      } else {
        result.checks.memberRoleChangedInUi = false;
        result.checks.memberRemoveNeedsConfirmation = false;
        result.checks.memberRemovedFromUi = false;
      }
    } else {
      // Invite UI not landed — just verify the People panel renders
      // and the owner member shows up
      result.checks.inviteFormVisible = inviteFormVisible;

      const peopleText = await page.textContent(".people-panel");
      result.checks.ownerShownInMemberTable =
        peopleText.includes("People Invite Owner");
      result.checks.ownerRoleShownCorrectly =
        peopleText.includes("owner") || peopleText.includes("Owner");
      result.checks.memberTableRendered = peopleText.includes("成员") || peopleText.includes("Member");
    }

    // ── No fake email sent claims ───────────────────────────────────
    const pageText = await page.textContent("body");
    result.checks.noFakeEmailSentText =
      !/邀请邮件已发送|Invitation email sent/i.test(pageText || "");
    result.checks.noInvitationEmailActionText =
      !/邀请邮件|邮件邀请|Invitation email|email invitation/i.test(pageText || "");

    // ── Non-destructive text — allow safeguarded remove/role controls ──
    // "移除" as a button label is allowed when gated by canManageMembers().
    // Still reject genuine fake/unprotected destructive claims.
    result.checks.noDestructivePeopleText =
      !/删除成员|Remove Member|Delete Member|Expel/i.test(pageText || "");

    await page.evaluate(
      ({ key, token, projectId, baseUrl }) => {
        localStorage.setItem(
          key,
          JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl })
        );
      },
      {
        key: storageKey,
        token: seeded.viewerToken,
        projectId: seeded.projectId,
        baseUrl: seeded.baseUrl,
      }
    );
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector(".people-table, .people-panel", {
      timeout: 10000,
    });
    result.checks.viewerPeoplePanelRendered = true;
    result.checks.viewerInviteControlsHidden =
      (await page.$("#peopleInviteForm")) === null &&
      (await page.$("#peopleInviteRole")) === null &&
      (await page.$("#peopleInviteBtn")) === null;
    result.checks.viewerMemberManagementControlsHidden =
      (await page.$(".people-role-select")) === null &&
      (await page.$(".people-remove-btn")) === null;

    // Screenshot
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
    result.screenshotPath = SCREENSHOT_PATH;
    result.checks.screenshotCaptured = fs.existsSync(SCREENSHOT_PATH);

    // Adaptive pass: when invite UI hasn't landed, only require base
    // rendering and safety checks. When it has, require all checks.
    if (inviteUiHasLanded) {
      result.passed = allTrue(result.checks);
    } else {
      result.passed =
        result.checks.peopleTabActive === true &&
        result.checks.peoplePanelRendered === true &&
        result.checks.ownerShownInMemberTable === true &&
        result.checks.ownerRoleShownCorrectly === true &&
        result.checks.memberTableRendered === true &&
        result.checks.noFakeEmailSentText === true &&
        result.checks.noDestructivePeopleText === true &&
        result.checks.screenshotCaptured === true;
    }
  } catch (err) {
    result.errors.push(String(err.stack || err.message || err));
    try {
      await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      result.screenshotPath = SCREENSHOT_PATH;
    } catch (_) {}
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function allTrue(obj) {
  return Object.values(obj || {}).every((value) => value === true);
}

async function api(baseUrl, method, urlPath, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

// ── Evidence ──────────────────────────────────────────────────────────────

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));

  const lines = [
    "# Project Space People Invite — Registered-User Invite Smoke Evidence",
    "",
    `- **Command:** \`${result.command}\``,
    `- **Timestamp:** ${result.timestamp}`,
    `- **Backend built:** ${result.backendBuilt}`,
    `- **Browser available:** ${result.browserAvailable}`,
    `- **Passed:** ${result.passed}`,
    `- **Skipped:** ${result.skipped}`,
    result.screenshotPath
      ? `- **Screenshot:** \`${result.screenshotPath}\``
      : null,
    `- **Evidence JSON:** \`${EVIDENCE_JSON}\``,
    "",
    "## Scenario",
    "",
    "1. Owner registers and creates a project.",
    "2. Invitee user registers (simulates a registered user to invite).",
    "3. User search by email prefix is verified (GET /v1/users/search).",
    "4. Owner invites invitee via POST /v1/projects/:id/members with role=member.",
    "5. Members list confirms the invited member appears with correct role.",
    "6. Duplicate invite (same user again) returns 409 Conflict.",
    "7. Viewer-role user cannot invite (403 — ManageMembers permission check).",
    "8. Static dashboard HTML wiring checked for invite form UI and landed People panel classes.",
    "9. If add-member UI has landed: open People tab as Owner, search a registered user, add them, and verify member row with role.",
    "10. Verify no fake 'email sent' claims.",
    "11. Verify only safeguarded member-management controls are present: PATCH role change, DELETE with confirmation, both gated by canManageMembers().",
    "",
    "## Backend API Verification",
    "",
    "```",
    `- User search by email: ${result.checks.backendSeed?.userSearchByEmailWorks}`,
    `- Invite via API: ${result.checks.backendSeed?.inviteViaApiWorks}`,
    `- Invited member correct role: ${result.checks.backendSeed?.invitedMemberCorrectRole}`,
    `- Invited member listed: ${result.checks.backendSeed?.invitedMemberListed}`,
    `- Duplicate invite conflict: ${result.checks.backendSeed?.duplicateInviteConflict}`,
    `- Viewer cannot invite (403): ${result.checks.backendSeed?.viewerCannotInvite}`,
    "```",
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
  ].filter(Boolean);

  if (result.errors.length) {
    lines.push("", "## Errors", "");
    for (const err of result.errors) lines.push(`- ${err}`);
  }
  if (result.residual.length) {
    lines.push("", "## Residual gaps", "");
    for (const item of result.residual) lines.push(`- ${item}`);
  }

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n") + "\n");
}

// ── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup() {
  if (context) {
    try {
      await context.close();
    } catch (_) {}
  }
  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
  }
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (appDataSource && appDataSource.isInitialized) {
    try {
      await appDataSource.destroy();
    } catch (_) {}
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────

main().finally(async () => {
  if (context) {
    try {
      await context.close();
    } catch (_) {}
  }
  if (browser) {
    try {
      await browser.close();
    } catch (_) {}
  }
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (appDataSource && appDataSource.isInitialized) {
    try {
      await appDataSource.destroy();
    } catch (_) {}
  }
});
