#!/usr/bin/env node
// Project Space Security Tab — backend/runtime smoke harness.
//
// Verifies the real Project Space Security implementation: backend API
// create/list/read/update for security advisories, RBAC gating (owner/admin
// can edit, member/viewer read-only), input validation, and static HTML
// wiring for the Security tab, Extras placement, and browser create/edit
// flows.
//
// Usage:
//   node scripts/smoke-project-space-security.js
//
// Environment:
//   PLAYWRIGHT_NODE_MODULES_PATH - directory containing a `playwright` package
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
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-security-smoke");
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
    command: "node scripts/smoke-project-space-security.js",
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

    const seeded = await setupBackendData();
    result.checks.backendSeed = {
      ownerCreated: !!seeded.ownerToken,
      memberCreated: !!seeded.memberToken,
      viewerCreated: !!seeded.viewerToken,
      projectCreated: !!seeded.projectId,
    };

    result.checks.backendSecurityApi = await probeBackendSecurityApi(seeded);
    result.checks.staticWiring = checkStaticWiring();

    result.checks.securityUiFunctions = await checkSecurityUiFunctions();

    if (!playwright) {
      result.skipped = true;
      result.residual.push(
        "Playwright was unavailable, so browser UI automation was skipped."
      );
      result.passed =
        allChecksPassed(result.checks.backendSecurityApi) &&
        allChecksPassed(result.checks.staticWiring) &&
        allChecksPassed(result.checks.securityUiFunctions);
      await writeEvidence(result);
      process.exit(result.passed ? 0 : 1);
      return;
    }

    result.checks.browser = await runBrowserSmoke(playwright, seeded);
    if (result.checks.browser.screenshotPath) {
      result.screenshotPath = result.checks.browser.screenshotPath;
    }
    result.passed =
      allChecksPassed(result.checks.backendSecurityApi) &&
      allChecksPassed(result.checks.staticWiring) &&
      allChecksPassed(result.checks.securityUiFunctions) &&
      result.checks.browser.passed;
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
  process.env.JWT_SECRET = "project-space-security-smoke-secret";
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

  const password = "SmokeTest123!";
  const owner = await register(baseUrl, "security-owner", password);
  const member = await register(baseUrl, "security-member", password);
  const viewer = await register(baseUrl, "security-viewer", password);
  const outsider = await register(baseUrl, "security-outsider", password);

  const projectRes = await api(baseUrl, "POST", "/v1/projects", owner.token, {
    name: "Security Smoke Project",
    description: "Backend smoke for Project Space Security tab",
  });
  if (projectRes.status !== 201) {
    throw new Error(`Project create failed: ${projectRes.status} ${JSON.stringify(projectRes.data)}`);
  }
  const projectId = projectRes.data.id;

  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: member.userId,
    role: "member",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/members`, owner.token, {
    user_id: viewer.userId,
    role: "viewer",
  });

  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "README.md",
    content: "# Security Smoke\n\nProject used to verify the Security tab.",
    message: "Initial README for security smoke",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "package.json",
    content: JSON.stringify({
      scripts: { bootstrap: "curl http://example.invalid/install.sh" },
      dependencies: { lodash: "*", express: "latest" },
    }),
    content_type: "application/json",
    message: "Seed manifest hygiene package",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: ".npmrc",
    content: "registry=http://registry.example.invalid\n",
    content_type: "text/plain",
    message: "Seed npmrc for manifest hygiene",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "packages/bad/package.json",
    content: "{",
    content_type: "application/json",
    message: "Seed malformed package manifest",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "packages/locked/package.json",
    content: JSON.stringify({
      dependencies: { "left-pad": "1.3.0" },
      devDependencies: { vite: "^5.0.0" },
    }),
    content_type: "application/json",
    message: "Seed dependency audit manifest",
  });
  await api(baseUrl, "POST", `/v1/projects/${projectId}/files`, owner.token, {
    path: "packages/locked/package-lock.json",
    content: JSON.stringify({
      name: "locked-package",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "left-pad": "1.3.0" }, devDependencies: { vite: "^5.0.0" } },
      },
    }),
    content_type: "application/json",
    message: "Seed dependency audit lockfile",
  });

  return {
    baseUrl,
    ownerToken: owner.token,
    ownerUser: owner.user,
    memberToken: member.token,
    memberUser: member.user,
    viewerToken: viewer.token,
    viewerUser: viewer.user,
    outsiderToken: outsider.token,
    outsiderUser: outsider.user,
    projectId,
  };
}

async function register(baseUrl, prefix, password) {
  const res = await api(baseUrl, "POST", "/v1/auth/register", null, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password,
    display_name: prefix,
  });
  if (res.status !== 201) {
    throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { token: res.data.access_token, user: res.data.user, userId: res.data.user.id };
}

async function probeBackendSecurityApi(seeded) {
  const checks = {};
  const { baseUrl, ownerToken, memberToken, viewerToken, projectId } = seeded;

  // ── Owner creates an advisory ──
  const createRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    {
      title: "Critical XSS Vulnerability",
      slug: "critical-xss",
      severity: "critical",
      status: "published",
      affected_package: "lodash",
      affected_version: "4.17.20",
      fixed_version: "4.17.21",
      cve_id: "CVE-2024-XXXX",
      body: "## Summary\n\nA cross-site scripting vulnerability was found.",
      references: ["https://example.com/advisory/1"],
    }
  );
  checks.advisoryCreate = {
    httpStatus: createRes.status,
    ok: createRes.status === 201,
    id: createRes.data && createRes.data.id,
    slugOk: createRes.status === 201 && createRes.data.slug === "critical-xss",
    severityOk: createRes.status === 201 && createRes.data.severity === "critical",
    publishedOk: createRes.status === 201 && createRes.data.status === "published",
  };
  const advisoryId = createRes.data && createRes.data.id;

  // ── Owner creates a draft advisory (default severity/status) ──
  const draftRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    { title: "Medium Advisory" }
  );
  checks.advisoryCreateDraft = {
    status: draftRes.status,
    ok: draftRes.status === 201,
    slug: draftRes.status === 201 && draftRes.data.slug === "medium-advisory",
    defaultSeverity: draftRes.status === 201 && draftRes.data.severity === "medium",
    defaultStatus: draftRes.status === 201 && draftRes.data.status === "draft",
    publishedAtNull: draftRes.status === 201 && draftRes.data.published_at === null,
  };

  // ── List advisories ──
  const listRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories`,
    memberToken
  );
  checks.advisoryListReadable = {
    status: listRes.status,
    ok: listRes.status === 200 && Array.isArray(listRes.data.data),
  };
  checks.advisoryListIncludesCreated =
    listRes.status === 200 &&
    listRes.data.data.length >= 2;
  checks.advisoryListOmitsBody =
    listRes.status === 200 &&
    listRes.data.data.every(function (item) { return item.body === undefined; });

  // ── List filters: severity/status and validation ──
  const severityList = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories?severity=critical`,
    ownerToken
  );
  checks.advisoryListFilterBySeverity = {
    status: severityList.status,
    ok: severityList.status === 200 &&
      severityList.data.meta.total === 1 &&
      severityList.data.data.every(function (item) { return item.severity === "critical"; }),
  };

  const statusList = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories?status=draft`,
    ownerToken
  );
  checks.advisoryListFilterByStatus = {
    status: statusList.status,
    ok: statusList.status === 200 &&
      statusList.data.meta.total === 1 &&
      statusList.data.data.every(function (item) { return item.status === "draft"; }),
  };

  const combinedList = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories?severity=medium&status=draft`,
    ownerToken
  );
  checks.advisoryListFilterCombined = {
    status: combinedList.status,
    ok: combinedList.status === 200 &&
      combinedList.data.meta.total === 1 &&
      combinedList.data.data.every(function (item) {
        return item.severity === "medium" && item.status === "draft";
      }),
  };

  checks.advisoryInvalidSeverityFilterRejected = (
    await api(baseUrl, "GET", `/v1/projects/${projectId}/security-advisories?severity=severe`, ownerToken)
  ).status === 422;
  checks.advisoryInvalidStatusFilterRejected = (
    await api(baseUrl, "GET", `/v1/projects/${projectId}/security-advisories?status=scanning`, ownerToken)
  ).status === 422;
  checks.advisoryInvalidSkipRejected = (
    await api(baseUrl, "GET", `/v1/projects/${projectId}/security-advisories?skip=-1`, ownerToken)
  ).status === 422;

  // ── Read single advisory ──
  const readRes = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories/${advisoryId}`,
    viewerToken
  );
  checks.advisoryViewerCanRead = {
    status: readRes.status,
    ok: readRes.status === 200 && readRes.data.title === "Critical XSS Vulnerability",
    includesBody: readRes.status === 200 && !!readRes.data.body,
    includesReferences: readRes.status === 200 && Array.isArray(readRes.data.references),
  };

  // ── Owner updates advisory ──
  const updateRes = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/security-advisories/${advisoryId}`,
    ownerToken,
    {
      title: "Critical XSS Vulnerability (Patched)",
      severity: "high",
      status: "resolved",
      body: "## Updated\n\nVulnerability has been patched.",
    }
  );
  checks.advisoryOwnerUpdate = {
    status: updateRes.status,
    ok: updateRes.status === 200,
    titleUpdated: updateRes.status === 200 && updateRes.data.title === "Critical XSS Vulnerability (Patched)",
    severityUpdated: updateRes.status === 200 && updateRes.data.severity === "high",
    statusUpdated: updateRes.status === 200 && updateRes.data.status === "resolved",
    publishedAtSet: updateRes.status === 200 && !!updateRes.data.published_at,
  };

  // ── Owner creates advisory with all severity levels ──
  const severities = ["low", "medium", "high", "critical"];
  checks.advisoryAllSeverities = {};
  for (var si = 0; si < severities.length; si++) {
    var sv = severities[si];
    var svRes = await api(
      baseUrl,
      "POST",
      `/v1/projects/${projectId}/security-advisories`,
      ownerToken,
      { title: "Severity " + sv, severity: sv }
    );
    checks.advisoryAllSeverities[sv] = {
      status: svRes.status,
      ok: svRes.status === 201 && svRes.data.severity === sv,
    };
  }

  // ── RBAC: member cannot create ──
  const memberCreate = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    memberToken,
    { title: "Member Advisory" }
  );
  checks.advisoryMemberCannotCreate = memberCreate.status === 403;

  // ── RBAC: viewer cannot create ──
  const viewerCreate = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    viewerToken,
    { title: "Viewer Advisory" }
  );
  checks.advisoryViewerCannotCreate = viewerCreate.status === 403;

  // ── RBAC: viewer cannot update ──
  const viewerUpdate = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/security-advisories/${advisoryId}`,
    viewerToken,
    { title: "No" }
  );
  checks.advisoryViewerCannotUpdate = viewerUpdate.status === 403;

  // ── RBAC: member cannot update ──
  const memberUpdate = await api(
    baseUrl,
    "PATCH",
    `/v1/projects/${projectId}/security-advisories/${advisoryId}`,
    memberToken,
    { title: "No" }
  );
  checks.advisoryMemberCannotUpdate = memberUpdate.status === 403;

  // ── Validation: missing title ──
  const noTitleRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    { severity: "critical" }
  );
  checks.advisoryMissingTitleRejected = noTitleRes.status === 422;

  // ── Validation: invalid severity ──
  const badSeverityRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    { title: "Bad Severity", severity: "extreme" }
  );
  checks.advisoryInvalidSeverityRejected = badSeverityRes.status === 422;

  // ── Validation: invalid status ──
  const badStatusRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    { title: "Bad Status", status: "archived" }
  );
  checks.advisoryInvalidStatusRejected = badStatusRes.status === 422;

  // ── Duplicate slug ──
  const dupRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security-advisories`,
    ownerToken,
    { title: "Duplicate XSS", slug: "critical-xss" }
  );
  checks.advisoryDuplicateSlugRejected = dupRes.status === 409;

  // ── Read-only roles can list/read ──
  const memberList = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories`,
    memberToken
  );
  checks.advisoryMemberCanList = memberList.status === 200 && Array.isArray(memberList.data.data);

  const viewerList = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories`,
    viewerToken
  );
  checks.advisoryViewerCanList = viewerList.status === 200 && Array.isArray(viewerList.data.data);

  const memberRead = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security-advisories/${advisoryId}`,
    memberToken
  );
  checks.advisoryMemberCanRead = {
    status: memberRead.status,
    ok: memberRead.status === 200 && !!memberRead.data.title,
  };

  const scanRes = await api(
    baseUrl,
    "POST",
    `/v1/projects/${projectId}/security/manifest-hygiene-scan`,
    ownerToken
  );
  const scanRuleIds = scanRes.status === 200 && Array.isArray(scanRes.data.findings)
    ? scanRes.data.findings.map(function (finding) { return finding.rule_id; })
    : [];
  checks.manifestHygieneOwnerRun = {
    status: scanRes.status,
    ok: scanRes.status === 200,
    scanType: scanRes.status === 200 && scanRes.data.scan_type === "manifest_hygiene",
    notVulnerabilityScan: scanRes.status === 200 && scanRes.data.is_vulnerability_scan === false,
  };
  checks.manifestHygieneCheckedFiles =
    scanRes.status === 200 &&
    Array.isArray(scanRes.data.checked_files) &&
    scanRes.data.checked_files.indexOf("package.json") !== -1 &&
    scanRes.data.checked_files.indexOf(".npmrc") !== -1;
  checks.manifestHygieneFindings =
    scanRuleIds.indexOf("manifest_missing_lockfile") !== -1 &&
    scanRuleIds.indexOf("manifest_unpinned_dependency") !== -1 &&
    scanRuleIds.indexOf("manifest_insecure_script_url") !== -1 &&
    scanRuleIds.indexOf("manifest_insecure_registry") !== -1 &&
    scanRuleIds.indexOf("manifest_json_invalid") !== -1;
  checks.manifestHygieneReadOnlyRejected =
    (await api(baseUrl, "POST", `/v1/projects/${projectId}/security/manifest-hygiene-scan`, memberToken)).status === 403 &&
    (await api(baseUrl, "POST", `/v1/projects/${projectId}/security/manifest-hygiene-scan`, viewerToken)).status === 403;

  const dependencyAudit = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security/dependency-audit`,
    ownerToken
  );
  const dependencyAuditViewer = await api(
    baseUrl,
    "GET",
    `/v1/projects/${projectId}/security/dependency-audit`,
    viewerToken
  );
  checks.dependencyAuditOwnerRead = {
    status: dependencyAudit.status,
    ok: dependencyAudit.status === 200,
    auditType: dependencyAudit.status === 200 && dependencyAudit.data.audit_type === "local_dependency_audit",
    notExternalScan: dependencyAudit.status === 200 && dependencyAudit.data.is_external_vulnerability_scan === false,
  };
  checks.dependencyAuditCounts =
    dependencyAudit.status === 200 &&
    dependencyAudit.data.dependency_count >= 4 &&
    dependencyAudit.data.lockfile_count >= 1 &&
    dependencyAudit.data.dependency_counts_by_section.dependencies >= 3 &&
    dependencyAudit.data.checked_files.indexOf("packages/locked/package-lock.json") !== -1;
  checks.dependencyAuditProjectAdvisoryMatch =
    dependencyAudit.status === 200 &&
    Array.isArray(dependencyAudit.data.known_advisory_matches) &&
    dependencyAudit.data.known_advisory_matches.some(function (match) {
      return match.affected_package === "lodash" && ["critical", "high"].indexOf(match.severity) !== -1;
    });
  checks.dependencyAuditLimitations =
    dependencyAudit.status === 200 &&
    Array.isArray(dependencyAudit.data.limitations) &&
    dependencyAudit.data.limitations.join(" ").includes("No external vulnerability database");
  checks.dependencyAuditViewerRead =
    dependencyAuditViewer.status === 200 &&
    dependencyAuditViewer.data.audit_type === "local_dependency_audit";
  checks.dependencyAuditOutsiderDenied =
    (await api(baseUrl, "GET", `/v1/projects/${projectId}/security/dependency-audit`, seeded.outsiderToken)).status === 403;
  checks.dependencyAuditAnonymousDenied =
    (await api(baseUrl, "GET", `/v1/projects/${projectId}/security/dependency-audit`, null)).status === 401;
  checks.dependencyAuditMutationAbsent =
    (await api(baseUrl, "POST", `/v1/projects/${projectId}/security/dependency-audit`, ownerToken)).status === 404;

  return checks;
}

function checkStaticWiring() {
  const checks = {};
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");

    // Security tab button and panel must exist in HTML
    checks.securityTabMarkup =
      html.includes('data-tab="security"') &&
      html.includes('id="tab-security"') &&
      html.includes(">Security</button>");

    checks.securityPanelMarkup =
      html.includes('id="securityPanel"') &&
      html.includes('aria-labelledby="tab-security"');

    // Security must be in the tab allowlist
    checks.securityAllowlisted =
      html.includes('"security"') &&
      /TAB_ALLOWLIST[\s\S]*"security"/.test(html);

    // Security is now an implemented module in Extras; automated scanning
    // remains deferred.
    checks.securityExtrasImplemented =
      html.includes('{ tab: "security"') &&
      html.includes('name: "Security"') &&
      html.includes("安全公告与发现记录");
    const extrasDeferredMatch = html.match(/var deferred\s*=\s*\[([\s\S]*?)\];/);
    const deferredBlock = extrasDeferredMatch ? extrasDeferredMatch[1] : "";
    checks.securityNotDeferred = !!deferredBlock && !deferredBlock.includes('name: "Security"');
    checks.automatedScanningDeferred =
      deferredBlock.includes('name: "Automated scanning"') &&
      (deferredBlock.includes("外部漏洞库扫描") || deferredBlock.includes("自动漏洞扫描"));

    // No fake scan/import/fix controls anywhere in the HTML. Creating and
    // editing metadata-only advisories is real and expected.
    checks.noFakeSecurityControls =
      !/security scan|run scan|import security|fix security|audit now|vulnerability scan|delete advisory|auto fix|dependency scan/i.test(html);

    // Tab switching code must reference security
    checks.securityTabSwitch =
      html.includes('tab === "security"');

    // Security panel reference in els
    checks.securityPanelRef =
      html.includes('securityPanel: $("securityPanel")');
    checks.manifestHygieneWiring =
      html.includes("/security/manifest-hygiene-scan") &&
      html.includes("function renderHygieneScan") &&
      html.includes("function bindHygieneScanEvents") &&
      html.includes("运行清单卫生检查");
    checks.dependencyAuditWiring =
      html.includes("/security/dependency-audit") &&
      html.includes("function renderDependencyAudit") &&
      html.includes("本地依赖审计");

    // Inline script parses without syntax error
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      new vm.Script(scriptMatch[1], { filename: "project-space.inline.js" });
      checks.inlineScriptParses = true;
    } else {
      checks.inlineScriptParses = false;
    }
  } catch (err) {
    checks.error = String(err.stack || err.message || err);
  }
  return checks;
}

async function runBrowserSmoke(playwright, seeded) {
  const result = { passed: false, checks: {}, errors: [], screenshotPath: null };

  browser = await playwright.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
  page = await context.newPage();

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
    const securityUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=security`;

    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    await page.goto(securityUrl, { waitUntil: "networkidle" });
    await waitTab("security");
    await page.waitForSelector("#securityCreateBtn", { timeout: 10000 });

    result.checks.securityTabActive = !!(await page.$('.tab-item[data-tab="security"].active')) ||
      (await page.evaluate(function () {
        var btn = document.querySelector("#tabMoreBtn");
        return !!(btn && btn.classList.contains("has-active"));
      }));
    result.checks.securityPanelVisible = !!(await page.$("#securityPanel:not(.hidden)"));
    result.checks.ownerSeesCreate = !!(await page.$("#securityCreateBtn"));
    result.checks.ownerSeesHygieneRun = !!(await page.$("#hygieneScanRunBtn"));
    await page.waitForFunction(
      function () {
        var el = document.querySelector("#dependencyAuditSection");
        return el && el.textContent && el.textContent.indexOf("本地依赖审计") !== -1;
      },
      null,
      { timeout: 10000 }
    );
    const dependencyAuditText = await page.textContent("#dependencyAuditSection");
    result.checks.ownerDependencyAuditVisible =
      !!dependencyAuditText &&
      dependencyAuditText.includes("直接依赖") &&
      dependencyAuditText.includes("packages/locked/package-lock.json") &&
      dependencyAuditText.includes("lodash") &&
      dependencyAuditText.includes("Critical XSS Vulnerability");
    result.checks.dependencyAuditLocalOnlyWording =
      !!dependencyAuditText &&
      dependencyAuditText.includes("不调用外部漏洞库") &&
      dependencyAuditText.includes("不运行 npm audit") &&
      dependencyAuditText.includes("不自动修复");

    await page.click("#hygieneScanRunBtn");
    await page.waitForFunction(
      function () {
        var el = document.querySelector("#securityPanel");
        return el && el.textContent && el.textContent.indexOf("manifest_missing_lockfile") !== -1;
      },
      null,
      { timeout: 10000 }
    );
    const hygieneText = await page.textContent("#securityPanel");
    result.checks.ownerHygieneResultVisible =
      !!hygieneText &&
      hygieneText.indexOf("manifest_missing_lockfile") !== -1 &&
      hygieneText.indexOf("manifest_unpinned_dependency") !== -1 &&
      hygieneText.indexOf("manifest_insecure_registry") !== -1;

    await page.click("#securityCreateBtn");
    await page.fill("#securityTitleInput", "Browser Security Advisory");
    await page.fill("#securitySlugInput", "browser-security-advisory");
    await page.selectOption("#securitySeverityInput", "critical");
    await page.selectOption("#securityStatusInput", "published");
    await page.fill("#securityAffectedPackageInput", "agent-ui");
    await page.fill("#securityAffectedVersionInput", "1.0.0");
    await page.fill("#securityFixedVersionInput", "1.0.1");
    await page.fill("#securityCveInput", "CVE-2026-4242");
    await page.fill("#securityBodyInput", "## Summary\n\nCreated by browser smoke.");
    await page.fill("#securityReferencesInput", "https://example.com/security/browser");
    await page.click("#securitySaveBtn");
    await page.waitForSelector(".security-detail", { timeout: 10000 });

    const createdText = await page.textContent("#securityPanel");
    result.checks.ownerCreatedAdvisoryVisible =
      !!createdText &&
      createdText.includes("Browser Security Advisory") &&
      createdText.includes("critical") &&
      createdText.includes("CVE-2026-4242") &&
      createdText.includes("agent-ui");
    result.checks.ownerSeesEdit = !!(await page.$("#securityEditBtn"));
    result.checks.urlCarriesSecurityId = page.url().includes("security_id=");

    await page.click("#securityEditBtn");
    await page.selectOption("#securitySeverityInput", "high");
    await page.selectOption("#securityStatusInput", "resolved");
    await page.fill("#securityBodyInput", "## Updated\n\nResolved by browser smoke.");
    await page.click("#securitySaveBtn");
    await page.waitForSelector(".security-detail", { timeout: 10000 });

    const updatedText = await page.textContent("#securityPanel");
    result.checks.ownerUpdatedAdvisoryVisible =
      !!updatedText && updatedText.includes("Resolved by browser smoke") && updatedText.includes("resolved") && updatedText.includes("high");

    result.checks.noFakeScanControlsInPanel =
      !/security scan|run scan|import security|fix security|audit now|vulnerability scan|auto fix|dependency scan/i.test(updatedText || "");

    await setStoredSession(origin, storageKey, seeded.viewerToken, seeded.projectId);
    await page.goto(securityUrl, { waitUntil: "networkidle" });
    await waitTab("security");
    await page.waitForSelector("#securityPanel .security-row", { timeout: 10000 });

    result.checks.viewerCannotCreate = !(await page.$("#securityCreateBtn"));
    result.checks.viewerCannotRunHygiene = !(await page.$("#hygieneScanRunBtn"));
    const viewerDependencyAuditText = await page.textContent("#dependencyAuditSection");
    result.checks.viewerCanReadDependencyAudit =
      !!viewerDependencyAuditText &&
      viewerDependencyAuditText.includes("本地依赖审计") &&
      viewerDependencyAuditText.includes("Critical XSS Vulnerability");
    const viewerRows = await page.$$("#securityPanel .security-row");
    if (viewerRows.length > 0) {
      await viewerRows[0].click();
      await page.waitForSelector(".security-detail", { timeout: 10000 });
    }
    result.checks.viewerCannotEdit = !(await page.$("#securityEditBtn"));

    await setStoredSession(origin, storageKey, seeded.memberToken, seeded.projectId);
    await page.goto(securityUrl, { waitUntil: "networkidle" });
    await waitTab("security");
    await page.waitForSelector("#securityPanel .security-row", { timeout: 10000 });
    result.checks.memberCannotCreate = !(await page.$("#securityCreateBtn"));
    result.checks.memberCannotRunHygiene = !(await page.$("#hygieneScanRunBtn"));
    result.checks.memberCanReadList = (await page.$$("#securityPanel .security-row")).length > 0;

    await setStoredSession(origin, storageKey, seeded.ownerToken, seeded.projectId);
    const extrasUrl = `${origin}/project-space.html?project_id=${encodeURIComponent(seeded.projectId)}&tab=extras`;
    await page.goto(extrasUrl, { waitUntil: "networkidle" });
    await waitTab("extras");

    const extrasText = await page.textContent("#extrasPanel");
    const deferredNames = await page.$$eval("#extrasPanel .extras-deferred .extras-deferred-name", function (els) {
      return els.map(function (el) { return el.textContent.trim(); });
    });
    result.checks.extrasSecurityImplemented =
      !!extrasText && extrasText.includes("已实现的模块") && extrasText.includes("Security");
    result.checks.extrasSecurityNotDeferred = deferredNames.indexOf("Security") === -1;
    result.checks.extrasAutomatedScanningDeferred = deferredNames.indexOf("Automated scanning") !== -1;
    result.checks.noFakeSecurityActionsInExtras =
      !/security scan|run scan|import security|fix security|audit now|vulnerability scan|auto fix|dependency scan/i.test(extrasText || "");

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
    await context.close().catch(function () {});
    await browser.close().catch(function () {});
    context = null;
    browser = null;
  }

  return result;
}

async function setStoredSession(origin, storageKey, jwt, projectId) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    function (payload) {
      localStorage.setItem(payload.key, payload.value);
    },
    {
      key: storageKey,
      value: JSON.stringify({ jwt: jwt, selectedProjectId: projectId, baseUrl: origin }),
    }
  );
}

async function checkSecurityUiFunctions() {
  const checks = {
    loadSecurityDataDefined: false,
    renderSecurityDefined: false,
    loadSecurityDataReferenced: false,
    renderSecurityReferenced: false,
    renderHygieneScanDefined: false,
    bindHygieneScanEventsReferenced: false,
  };
  try {
    const html = fs.readFileSync(DASHBOARD_HTML, "utf8");
    var scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    if (scriptMatch && scriptMatch[1]) {
      var script = scriptMatch[1];
      checks.loadSecurityDataReferenced = script.indexOf("loadSecurityData") !== -1;
      checks.renderSecurityReferenced = script.indexOf("renderSecurity") !== -1;
      // Look for function definition pattern
      checks.loadSecurityDataDefined = /function\s+loadSecurityData\s*\(/.test(script);
      checks.renderSecurityDefined = /function\s+renderSecurity\s*\(/.test(script);
      checks.renderHygieneScanDefined = /function\s+renderHygieneScan\s*\(/.test(script);
      checks.bindHygieneScanEventsReferenced = script.indexOf("bindHygieneScanEvents();") !== -1;
    }
  } catch (err) {
    // leave as false
  }
  return checks;
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

async function api(baseUrl, method, requestPath, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  var res = await fetch("" + baseUrl + requestPath, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  var text = await res.text();
  var data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  return { status: res.status, data: data };
}

async function writeEvidence(result) {
  result.evidencePath = EVIDENCE_MD;
  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(result, null, 2));
  var md = [
    "# Project Space Security Tab — Browser Smoke Evidence",
    "",
    "- **Command:** `" + result.command + "`",
    "- **Timestamp:** " + result.timestamp,
    "- **Backend built:** " + result.backendBuilt,
    "- **Browser available:** " + result.browserAvailable,
    "- **Passed:** " + result.passed,
    "- **Skipped:** " + result.skipped,
    result.screenshotPath ? "- **Screenshot:** `" + result.screenshotPath + "`" : "",
    "- **Evidence JSON:** `" + EVIDENCE_JSON + "`",
    "",
    "## Checks",
    "",
    "```json",
    JSON.stringify(result.checks, null, 2),
    "```",
    "",
  ];
  if (result.residual.length) {
    md.push(
      "## Residual gaps",
      "",
      ...result.residual.map(function (r) { return "- " + r; }),
      ""
    );
  }
  if (result.errors.length) {
    md.push(
      "## Errors",
      "",
      ...result.errors.map(function (e) { return "- " + e; }),
      ""
    );
  }
  md.push(
    "",
    "## Scope Note",
    "",
    "This smoke verifies the implemented Project Space Security tab, including ",
    "backend advisory CRUD operations, RBAC gating, input validation, owner ",
    "browser create/edit controls, member/viewer read-only gating, Extras ",
    "placement, and the absence of fake scan/import/fix controls.",
    "",
  );
  fs.writeFileSync(EVIDENCE_MD, md.join("\n"));
}

main().finally(async function () {
  if (page) await page.close().catch(function () {});
  if (context) await context.close().catch(function () {});
  if (browser) await browser.close().catch(function () {});
  if (server) await new Promise(function (resolve) { server.close(resolve); });
  try {
    var ds = require(DATASOURCE_MODULE);
    if (ds.AppDataSource.isInitialized) await ds.AppDataSource.destroy();
  } catch (_) {}
});
