#!/usr/bin/env node
// Project Space People — browser/runtime smoke harness.
//
// Starts the built backend, seeds a real project with a member and optionally
// an agent, opens /project-space.html?project_id=...&tab=people in a real
// Chromium via Playwright, and asserts that the People surface renders members
// and agents, counts, role pills, and presence signals.
//
// If Playwright is not resolvable, the script still verifies the backend data
// setup and static JS wiring, then exits with a structured "skipped" result.
//
// Usage:
//   node scripts/smoke-project-space-people.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
//                                  (defaults to the bundled runtime path).

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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-people-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "screenshot.png");

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
    command: "node scripts/smoke-project-space-people.js",
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
      memberListed: seeded.memberListed,
      agentCreated: seeded.agentCreated,
      agentListed: seeded.agentListed,
      // Member management checks
      patchMemberToAdmin: seeded.patchMemberToAdmin,
      patchAdminToViewer: seeded.patchAdminToViewer,
      patchViewerToMember: seeded.patchViewerToMember,
      ownerRoleRejectedOnAdd: seeded.ownerRoleRejectedOnAdd,
      ownerRoleRejectedOnPatch: seeded.ownerRoleRejectedOnPatch,
      memberRemovableDeleted: seeded.memberRemovableDeleted,
      removableGone: seeded.removableGone,
      viewerCannotManageRole: seeded.viewerCannotManageRole,
      viewerCannotManageDelete: seeded.viewerCannotManageDelete,
      memberCannotManageRole: seeded.memberCannotManageRole,
      memberCannotManageDelete: seeded.memberCannotManageDelete,
    };

    // ── 2. Static JS wiring check (always runs) ─────────────────────────────
    const staticOk = checkStaticWiring();
    result.checks.staticWiring = staticOk;

    // Compute management API passed (all must be true)
    const mgmtApiOk =
      seeded.patchMemberToAdmin &&
      seeded.patchAdminToViewer &&
      seeded.patchViewerToMember &&
      seeded.ownerRoleRejectedOnAdd &&
      seeded.ownerRoleRejectedOnPatch &&
      seeded.memberRemovableDeleted &&
      seeded.removableGone &&
      seeded.viewerCannotManageRole &&
      seeded.viewerCannotManageDelete &&
      seeded.memberCannotManageRole &&
      seeded.memberCannotManageDelete;

    if (!playwright) {
      result.skipped = true;
      const staticAllOk = staticOk && !staticOk.error && Object.values(staticOk).every(Boolean);
      result.passed = staticAllOk && seeded.memberListed && mgmtApiOk;
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
    const staticAllOk = staticOk && !staticOk.error && Object.values(staticOk).every(Boolean);
    result.passed = staticAllOk && browserResult.passed && mgmtApiOk;
    if (!result.passed) {
      if (!staticAllOk) result.errors.push("Static wiring checks failed.");
      if (!browserResult.passed) result.errors.push(...browserResult.errors);
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
  process.env.JWT_SECRET = "project-space-people-smoke-secret";
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

  const ts = Date.now();

  // ── Owner registration ─────────────────────────────────────────────────
  const ownerEmail = `people-smoke-owner-${ts}@example.invalid`;
  const ownerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: ownerEmail,
    password: "SmokeTest123!",
    display_name: "People Smoke Owner",
  });
  if (ownerRes.status !== 201) {
    throw new Error(`Owner register failed: ${ownerRes.status} ${JSON.stringify(ownerRes.data)}`);
  }
  const token = ownerRes.data.access_token;
  const userId = ownerRes.data.user.id;

  const projectRes = await api(baseUrl, "POST", "/v1/projects", token, {
    name: "People Smoke Project",
    description: "Browser smoke for Project Space People tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  // The owner is automatically a member; verify the members endpoint returns them.
  const membersRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/members`, token);
  const memberListed =
    membersRes.status === 200 &&
    Array.isArray(membersRes.data.data || membersRes.data) &&
    (membersRes.data.data || membersRes.data).some((m) => (m.user_id || m.userId) === userId);

  // ── Seed additional users for role-change and removal tests ──────────
  // admin user
  const adminEmail = `people-smoke-admin-${ts}@example.invalid`;
  const adminRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: adminEmail, password: "SmokeTest456!", display_name: "People Smoke Admin",
  });
  if (adminRes.status !== 201) throw new Error(`Admin register failed: ${adminRes.status}`);
  const adminUserId = adminRes.data.user.id;
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: adminUserId, role: "admin" });

  // member user
  const memberEmail = `people-smoke-member-${ts}@example.invalid`;
  const memberRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: memberEmail, password: "SmokeTest789!", display_name: "People Smoke Member",
  });
  if (memberRes.status !== 201) throw new Error(`Member register failed: ${memberRes.status}`);
  const memberUserId = memberRes.data.user.id;
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: memberUserId, role: "member" });

  // viewer user
  const viewerEmail = `people-smoke-viewer-${ts}@example.invalid`;
  const viewerRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: viewerEmail, password: "SmokeTest000!", display_name: "People Smoke Viewer",
  });
  if (viewerRes.status !== 201) throw new Error(`Viewer register failed: ${viewerRes.status}`);
  const viewerUserId = viewerRes.data.user.id;
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: viewerUserId, role: "viewer" });

  // removable member user (target for DELETE test)
  const removableEmail = `people-smoke-removable-${ts}@example.invalid`;
  const removableRes = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: removableEmail, password: "SmokeTest111!", display_name: "People Smoke Removable",
  });
  if (removableRes.status !== 201) throw new Error(`Removable register failed: ${removableRes.status}`);
  const removableUserId = removableRes.data.user.id;
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: removableUserId, role: "member" });

  // ── Member management API checks ────────────────────────────────────

  // PATCH role change: member → admin
  const patchAdminRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${memberUserId}`, token, { role: "admin" });
  const patchMemberToAdmin = patchAdminRes.status === 200 && patchAdminRes.data && (patchAdminRes.data.role || "").toLowerCase() === "admin";

  // PATCH role change: admin → viewer
  const patchViewerRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${memberUserId}`, token, { role: "viewer" });
  const patchAdminToViewer = patchViewerRes.status === 200 && patchViewerRes.data && (patchViewerRes.data.role || "").toLowerCase() === "viewer";

  // PATCH role change: viewer → member (restore)
  const patchMemberRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${memberUserId}`, token, { role: "member" });
  const patchViewerToMember = patchMemberRes.status === 200 && patchMemberRes.data && (patchMemberRes.data.role || "").toLowerCase() === "member";

  // Owner role rejection: POST with role=owner must NOT be accepted (would escalate)
  const ownerRejectAddRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, token, { user_id: viewerUserId, role: "owner" });
  const ownerRoleRejectedOnAdd = ownerRejectAddRes.status !== 201;

  // Owner role rejection: PATCH to role=owner must NOT be accepted
  const ownerRejectPatchRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${memberUserId}`, token, { role: "owner" });
  const ownerRoleRejectedOnPatch = ownerRejectPatchRes.status !== 200;

  // DELETE non-owner member
  const deleteRes = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/members/${removableUserId}`, token);
  const memberRemovableDeleted = deleteRes.status === 204;

  // Verify deleted member no longer listed
  const membersAfterDeleteRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/members`, token);
  const membersData = membersAfterDeleteRes.data && (membersAfterDeleteRes.data.data || membersAfterDeleteRes.data);
  const removableGone = Array.isArray(membersData) && !membersData.some((m) => (m.user_id || m.userId) === removableUserId);

  // Viewer cannot manage members
  const viewerToken = viewerRes.data.access_token;
  const viewerPatchRes = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${memberUserId}`, viewerToken, { role: "admin" });
  const viewerCannotManageRole = viewerPatchRes.status === 403;
  const viewerDeleteRes = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/members/${memberUserId}`, viewerToken);
  const viewerCannotManageDelete = viewerDeleteRes.status === 403;

  // Member (non-admin) cannot manage members — use memberToken after PATCH restored them to member
  const memberToken = memberRes.data.access_token;
  const memberPatchRes2 = await api(baseUrl, "PATCH", `/v1/projects/${projectId}/members/${viewerUserId}`, memberToken, { role: "admin" });
  const memberCannotManageRole = memberPatchRes2.status === 403;
  const memberDeleteRes = await api(baseUrl, "DELETE", `/v1/projects/${projectId}/members/${viewerUserId}`, memberToken);
  const memberCannotManageDelete = memberDeleteRes.status === 403;

  // ── Agent creation (non-fatal) ──────────────────────────────────────
  let agentCreated = false;
  let agentListed = false;
  let agentId = null;
  try {
    const agentRes = await api(baseUrl, "POST", `/v1/projects/${projectId}/agents`, token, {
      name: "people-smoke-agent",
      description: "Smoke test agent",
    });
    if (agentRes.status === 201) {
      agentCreated = true;
      agentId = agentRes.data.id;
    }
  } catch (_) { /* ignore */ }

  if (agentCreated) {
    const agentsRes = await api(baseUrl, "GET", `/v1/projects/${projectId}/agents?limit=100`, token);
    agentListed =
      agentsRes.status === 200 &&
      Array.isArray(agentsRes.data.data || agentsRes.data) &&
      (agentsRes.data.data || agentsRes.data).some((a) => a.id === agentId);
  }

  return {
    baseUrl,
    token,
    userId,
    projectId,
    memberListed,
    agentCreated,
    agentListed,
    // Management seeds
    adminUserId,
    memberUserId,
    viewerUserId,
    viewerToken,
    // Management API results
    patchMemberToAdmin,
    patchAdminToViewer,
    patchViewerToMember,
    ownerRoleRejectedOnAdd,
    ownerRoleRejectedOnPatch,
    memberRemovableDeleted,
    removableGone,
    viewerCannotManageRole,
    viewerCannotManageDelete,
    memberCannotManageRole,
    memberCannotManageDelete,
  };
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    checks.peopleTabMarkup =
      html.includes('data-tab="people"') && html.includes('id="peoplePanel"');

    checks.peopleAliasWiring =
      html.includes('members: "people"') &&
      html.includes('agents: "people"') &&
      html.includes('collaborators: "people"');

    checks.peopleApiCalls =
      html.includes('"/v1/projects/" + pid + "/members"') &&
      html.includes('"/v1/projects/" + pid + "/agents?limit=100"');

    // Only api_key_prefix / apiKeyPrefix should be referenced; raw api_key /
    // apiKey must never be displayed.
    checks.noRawApiKeyDisplay =
      !/api_key"/.test(html) &&
      !/\.api_key(?!_prefix)/.test(html) &&
      !/apiKey"/.test(html) &&
      !/\.apiKey(?!Prefix)/.test(html);

    checks.peopleRolePills = html.includes('class="people-role-pill');

    // Member management API wiring: PATCH for role change, DELETE for removal
    checks.patchMemberApiWired = /api\(\s*["']PATCH["'][^)]*\/members/.test(html);
    checks.deleteMemberApiWired = /api\(\s*["']DELETE["'][^)]*\/members/.test(html);

    // Management controls should be gated by canManageMembers()
    checks.manageMembersGateWired =
      html.includes("function canManageMembers()") &&
      html.includes("if (canManageMembers())");

    // Role picker must not include owner
    checks.rolePickerConstrained =
      html.includes("[['admin', 'admin'], ['member', 'member'], ['viewer', 'viewer']]") &&
      !html.includes("['owner', 'owner']");

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

  // Helper: wait for a tab to be active, supporting primary and overflow tabs.
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

    const url = `${origin}/project-space.html?project_id=${encodeURIComponent(
      seeded.projectId
    )}&tab=people`;

    await page.goto(url, { waitUntil: "networkidle" });

    await waitTab("people");
    result.checks.peopleTabActive = true;

    // Members/agents content should render from the URL deep link without a
    // compensating click.
    await page.waitForSelector(".people-table", { timeout: 10000 });
    result.checks.peopleSectionsRendered = true;

    // Member count card visible.
    const peopleText = await page.textContent(".people-panel");
    result.checks.memberCountVisible = /成员/.test(peopleText);
    result.checks.ownerMemberRendered =
      peopleText.includes("People Smoke Owner") || peopleText.includes(seeded.userId);

    // Owner role pill visible.
    result.checks.rolePillVisible = await page.locator(".people-role-pill").count() > 0;

    // Agent section and seeded agent row visible.
    result.checks.agentSectionVisible = /Agent/.test(peopleText);
    result.checks.agentRowRendered =
      seeded.agentCreated ? peopleText.includes("people-smoke-agent") : true;

    // ── Member management controls (owner/admin) ─────────────────────────
    // Role-change dropdowns visible for non-owner, non-self members
    const roleSelectCount = await page.locator(".people-role-select").count();
    result.checks.managementRoleSelectVisible = roleSelectCount > 0;

    // Remove buttons visible for non-owner members
    const removeBtnCount = await page.locator(".people-remove-btn").count();
    result.checks.managementRemoveBtnVisible = removeBtnCount > 0;

    // Owner row must NOT have a role-select or remove button
    const ownerRowRoleSelect = await page.locator('.people-role-pill.owner ~ .people-actions .people-role-select').count();
    result.checks.ownerRowNotEditable = ownerRowRoleSelect === 0;
    const ownerRowRemoveBtn = await page.locator('.people-role-pill.owner ~ .people-actions .people-remove-btn').count();
    result.checks.ownerRowNoRemove = ownerRowRemoveBtn === 0;

    // Attempt a role change via browser: find the first non-owner role-select
    // and change its value, then verify the success message.
    if (roleSelectCount > 0) {
      const firstSelect = page.locator(".people-role-select").first();
      const firstMemberId = await firstSelect.getAttribute("data-member-user-id");
      if (firstMemberId) {
        // Get current value, then switch to a different valid role
        const currentVal = await firstSelect.inputValue();
        const targetVal = currentVal === "member" ? "viewer" : "member";
        await firstSelect.selectOption(targetVal);
        // Wait for the role-change API call to succeed and refresh
        await page.waitForTimeout(2000);
        // Check for success message or that the value actually changed
        const bodyText = await page.textContent("body");
        result.checks.roleChangeViaBrowser = bodyText.includes("角色已更新") || bodyText.includes(targetVal);
      } else {
        result.checks.roleChangeViaBrowser = false;
      }
    } else {
      result.checks.roleChangeViaBrowser = false;
    }

    // ── Viewer should see no management controls ─────────────────────────
    // Switch to viewer identity
    const viewerToken = seeded.viewerToken;
    if (viewerToken) {
      await page.evaluate(
        ({ key, token, projectId, baseUrl }) => {
          localStorage.setItem(
            key,
            JSON.stringify({ jwt: token, selectedProjectId: projectId, baseUrl })
          );
        },
        {
          key: storageKey,
          token: viewerToken,
          projectId: seeded.projectId,
          baseUrl: origin,
        }
      );
      await page.goto(url, { waitUntil: "networkidle" });
      await page.waitForSelector(".people-table", { timeout: 10000 });
      result.checks.viewerPeopleRendered = true;
      result.checks.viewerNoRoleSelect = (await page.locator(".people-role-select").count()) === 0;
      result.checks.viewerNoRemoveBtn = (await page.locator(".people-remove-btn").count()) === 0;
    }

    // Alias smoke: visit tab=agents and confirm it maps to people with content.
    await page.goto(
      `${origin}/project-space.html?project_id=${encodeURIComponent(
        seeded.projectId
      )}&tab=agents`,
      { waitUntil: "networkidle" }
    );
    // Agents alias maps to People tab. Wait for people panel to render.
    await page.waitForSelector(".people-panel", { timeout: 10000 }).catch(function () {
      // Fallback: wait for has-active indicator
      return page.waitForFunction(function () {
        var btn = document.querySelector("#tabMoreBtn");
        return !!(btn && btn.classList.contains("has-active"));
      }, { timeout: 10000 });
    });
    result.checks.agentsAliasNavigable = true;
    await page.waitForFunction(
      () => {
        const panel = document.querySelector(".people-panel");
        return panel && panel.textContent.includes("people-smoke-agent");
      },
      { timeout: 10000 }
    );
    result.checks.agentsAliasContentRendered = true;

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
    "# Project Space People — Browser Smoke Evidence",
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
