#!/usr/bin/env node
// Project Space Mobile Smoke Suite — companion runner.
//
// Runs the same child smoke scripts as the desktop suite, but with a mobile
// viewport (390x844, iPhone 14-proportioned) via VIEWPORT_WIDTH /
// VIEWPORT_HEIGHT env vars. Writes consolidated evidence under
// dashboard-e2e-artifacts/project-space-suite-mobile-smoke/.
//
// The desktop suite (smoke-project-space-suite.js) is unaffected.
//
// Usage:
//   node scripts/smoke-project-space-suite-mobile.js
//
// Environment:
//   TIMEOUT_MS          - per-child timeout in ms (default 120000)
//   PLAYWRIGHT_NODE_MODULES_PATH  - forwarded to each child if set
//
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const ARTIFACT_DIR = path.join(ROOT, "dashboard-e2e-artifacts", "project-space-suite-mobile-smoke");
const EVIDENCE_JSON = path.join(ARTIFACT_DIR, "evidence.json");
const EVIDENCE_MD = path.join(ARTIFACT_DIR, "evidence.md");
const CHILD_TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "120000", 10);

// ---------------------------------------------------------------------------
// Ordered list of smoke scripts to run.
// Each entry is { label, script, required }.
// ---------------------------------------------------------------------------
const SMOKES = [
  {
    label: "Repo Overview",
    script: "scripts/smoke-project-space-repo-overview.js",
    required: true,
    evidenceDir: "project-space-repo-overview-smoke",
  },
  {
    label: "Work",
    script: "scripts/smoke-project-space-work.js",
    required: true,
  },
  {
    label: "Settings",
    script: "scripts/smoke-project-space-settings.js",
    required: true,
  },
  {
    label: "Reviews",
    script: "scripts/smoke-project-space-reviews.js",
    required: true,
  },
  {
    label: "Reviewer Assignment",
    script: "scripts/smoke-project-space-reviewer-assignment.js",
    required: true,
    evidenceDir: "project-space-reviewer-assignment-smoke",
  },
  {
    label: "People",
    script: "scripts/smoke-project-space-people.js",
    required: true,
  },
  {
    label: "History",
    script: "scripts/smoke-project-space-history.js",
    required: true,
  },
  {
    label: "Commit Verification",
    script: "scripts/smoke-project-space-commit-verification.js",
    required: true,
    evidenceDir: "project-space-commit-verification-smoke",
  },
  {
    label: "File History",
    script: "scripts/smoke-project-space-file-history.js",
    required: true,
    evidenceDir: "project-space-file-history-smoke",
  },
  {
    label: "Code Search",
    script: "scripts/smoke-project-space-code-search.js",
    required: true,
    evidenceDir: "project-space-code-search-smoke",
  },
  {
    label: "File Raw/Download",
    script: "scripts/smoke-project-space-file-raw-download.js",
    required: true,
    evidenceDir: "project-space-file-raw-download-smoke",
  },
  {
    label: "File Code View",
    script: "scripts/smoke-project-space-file-code-view.js",
    required: true,
    evidenceDir: "project-space-file-code-view-smoke",
  },
  {
    label: "Flow (Work → Reviews → History)",
    script: "scripts/smoke-project-space-flow-work-to-reviews-to-history.js",
    required: true,
    evidenceDir: "project-space-flow-smoke",
  },
  {
    label: "Branch Context",
    script: "scripts/smoke-project-space-branch-context.js",
    required: true,
  },
  {
    label: "Keyboard A11y",
    script: "scripts/smoke-project-space-keyboard-a11y.js",
    required: true,
  },
  {
    label: "Branch Management",
    script: "scripts/smoke-project-space-branch-management.js",
    required: true,
  },
  {
    label: "Branch Policy",
    script: "scripts/smoke-project-space-branch-policy.js",
    required: true,
  },
  {
    label: "Branch Protection Rules",
    script: "scripts/smoke-project-space-branch-protection-rules.js",
    required: true,
  },
  {
    label: "Merge Queue",
    script: "scripts/smoke-project-space-merge-queue.js",
    required: true,
    evidenceDir: "project-space-merge-queue-smoke",
  },
  {
    label: "Branch Compare",
    script: "scripts/smoke-project-space-branch-compare.js",
    required: true,
  },
  {
    label: "Repository Tree",
    script: "scripts/smoke-project-space-repository-tree.js",
    required: true,
    evidenceDir: "project-space-repository-tree-smoke",
  },
  {
    label: "File Upload",
    script: "scripts/smoke-project-space-file-upload.js",
    required: true,
    evidenceDir: "project-space-file-upload-smoke",
  },
  {
    label: "Tab Overflow",
    script: "scripts/smoke-project-space-tab-overflow.js",
    required: true,
    evidenceDir: "project-space-tab-overflow-smoke",
  },
  {
    label: "Extras",
    script: "scripts/smoke-project-space-extras.js",
    required: true,
  },
  {
    label: "Insights",
    script: "scripts/smoke-project-space-insights.js",
    required: true,
  },
  {
    label: "Settings Advanced",
    script: "scripts/smoke-project-space-settings-advanced.js",
    required: true,
  },
  {
    label: "People Invite",
    script: "scripts/smoke-project-space-people-invite.js",
    required: true,
  },
  {
    label: "Member Audit",
    script: "scripts/smoke-project-space-member-audit.js",
    required: true,
  },
  {
    label: "Owner Transfer",
    script: "scripts/smoke-project-space-owner-transfer.js",
    required: true,
  },
  {
    label: "Settings Audit",
    script: "scripts/smoke-project-space-settings-audit.js",
    required: true,
  },
  {
    label: "Module Audit",
    script: "scripts/smoke-project-space-module-audit.js",
    required: true,
  },
  {
    label: "Audit Export",
    script: "scripts/smoke-project-space-audit-export.js",
    required: true,
  },
  {
    label: "Wiki",
    script: "scripts/smoke-project-space-wiki.js",
    required: true,
  },
  {
    label: "Releases",
    script: "scripts/smoke-project-space-releases.js",
    required: true,
  },
  {
    label: "Tags",
    script: "scripts/smoke-project-space-tags.js",
    required: true,
    evidenceDir: "project-space-tags-smoke",
  },
  {
    label: "Packages",
    script: "scripts/smoke-project-space-packages.js",
    required: true,
  },
  {
    label: "Security",
    script: "scripts/smoke-project-space-security.js",
    required: true,
  },
  {
    label: "Repository Archive",
    script: "scripts/smoke-project-space-repository-archive.js",
    required: true,
    evidenceDir: "project-space-repository-archive-smoke",
  },
];

// ---------------------------------------------------------------------------
// Run a single child script and resolve when it exits.
// Captures stdout, stderr, exit code, and timing.
// Injects mobile viewport env vars so each child renders at the mobile
// viewport without modifying its default standalone behavior.
// ---------------------------------------------------------------------------
function runChild(entry) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(ROOT, entry.script);
    const start = Date.now();
    const result = {
      label: entry.label,
      command: `node ${entry.script}`,
      viewport: { ...MOBILE_VIEWPORT },
      script: entry.script,
      required: entry.required,
      pid: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      childEvidencePath: null,
      passed: false,
    };

    const child = spawn("node", [scriptPath], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        VIEWPORT_WIDTH: String(MOBILE_VIEWPORT.width),
        VIEWPORT_HEIGHT: String(MOBILE_VIEWPORT.height),
        // Forward Playwright path if set at suite level.
        ...(process.env.PLAYWRIGHT_NODE_MODULES_PATH
          ? { PLAYWRIGHT_NODE_MODULES_PATH: process.env.PLAYWRIGHT_NODE_MODULES_PATH }
          : {}),
      },
    });

    result.pid = child.pid;

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      result.timedOut = true;
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000);
    }, CHILD_TIMEOUT_MS);

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      result.exitCode = exitCode;
      result.signal = signal;
      result.durationMs = Date.now() - start;
      result.stdout = stdout;
      result.stderr = stderr;

      // Locate child evidence path from artifact directory convention.
      const childDir = path.join(
        ROOT,
        "dashboard-e2e-artifacts",
        entry.evidenceDir || `project-space-${entry.label.toLowerCase()}-smoke`
      );
      const childEvidence = path.join(childDir, "evidence.json");
      if (fs.existsSync(childEvidence)) {
        result.childEvidencePath = childEvidence;
      }

      // Determine pass/fail.
      if (entry.required) {
        result.passed = exitCode === 0 && signal === null;
      } else {
        result.passed = true;
      }

      resolve(result);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      result.exitCode = -1;
      result.signal = null;
      result.durationMs = Date.now() - start;
      result.stderr = (result.stderr || "") + `\nSpawn error: ${err.message}`;
      result.passed = !entry.required;
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Load child evidence.json to enrich suite summary with check-level detail.
// ---------------------------------------------------------------------------
function loadChildEvidence(childEvidencePath) {
  if (!childEvidencePath || !fs.existsSync(childEvidencePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(childEvidencePath, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write consolidated evidence.
// ---------------------------------------------------------------------------
function writeEvidence(suiteResult) {
  const enriched = SMOKES.map((entry) => {
    const child = suiteResult.children[entry.label];
    const childEvidence = loadChildEvidence(child.childEvidencePath);
    return {
      label: entry.label,
      command: child.command,
      viewport: child.viewport,
      required: child.required,
      exitCode: child.exitCode,
      timedOut: child.timedOut,
      durationMs: child.durationMs,
      passed: child.passed,
      childEvidencePath: child.childEvidencePath,
      childPassed: childEvidence ? childEvidence.passed : null,
      childSkipped: childEvidence ? childEvidence.skipped : null,
      childChecks: childEvidence ? childEvidence.checks : null,
      childErrors: childEvidence ? (childEvidence.errors || []) : [],
    };
  });

  const required = enriched.filter((r) => r.required);
  const requiredPassed = required.filter((r) => r.passed);
  const suitePassed = required.length === requiredPassed.length;

  const summary = {
    command: "node scripts/smoke-project-space-suite-mobile.js",
    timestamp: new Date().toISOString(),
    suitePassed,
    viewport: { ...MOBILE_VIEWPORT },
    childCount: enriched.length,
    requiredCount: required.length,
    requiredPassed: requiredPassed.length,
    children: enriched,
  };

  fs.writeFileSync(EVIDENCE_JSON, JSON.stringify(summary, null, 2));

  // Build markdown summary.
  const lines = [
    "# Project Space Mobile Smoke Suite — Consolidated Evidence",
    "",
    `- **Command:** \`${summary.command}\``,
    `- **Timestamp:** ${summary.timestamp}`,
    `- **Mobile viewport:** ${summary.viewport.width}×${summary.viewport.height}`,
    `- **Suite passed:** ${summary.suitePassed}`,
    `- **Required:** ${summary.requiredPassed}/${summary.requiredCount}`,
    "",
    "## Smoke Results",
    "",
  ];

  for (const child of enriched) {
    const icon = child.passed ? "✅" : "❌";
    const label = child.required ? child.label : `${child.label} (optional)`;
    lines.push(`### ${icon} ${label}`);
    lines.push("");
    lines.push(`- **Command:** \`${child.command}\``);
    lines.push(`- **Viewport:** ${child.viewport.width}×${child.viewport.height}`);
    lines.push(`- **Exit code:** ${child.exitCode}`);
    lines.push(`- **Duration:** ${child.durationMs}ms`);
    lines.push(`- **Passed:** ${child.passed}`);
    if (child.timedOut) lines.push("- **⚠ Timed out**");
    if (child.childPassed !== null) {
      lines.push(`- **Child self-report:** ${child.childPassed ? "passed" : "failed"}`);
    }
    if (child.childSkipped) {
      lines.push("- **Child skipped (Playwright unavailable)**");
    }
    if (child.childEvidencePath) {
      lines.push(`- **Child evidence:** \`${child.childEvidencePath}\``);
    }

    // Include child check-level summary if available.
    if (child.childChecks && Object.keys(child.childChecks).length) {
      const totalChecks = countChecks(child.childChecks);
      const passedChecks = countPassed(child.childChecks);
      lines.push(`- **Checks:** ${passedChecks}/${totalChecks} passed`);
      if (passedChecks < totalChecks) {
        lines.push("", "  **Failed checks:**");
        for (const [group, checks] of Object.entries(child.childChecks)) {
          for (const [name, val] of Object.entries(checks)) {
            if (val === false) lines.push(`  - ${group}.${name} ❌`);
          }
        }
      }
    }

    if (child.childErrors && child.childErrors.length) {
      lines.push("", "  **Errors:**");
      for (const err of child.childErrors.slice(0, 5)) {
        lines.push(`  - ${truncate(err, 200)}`);
      }
      if (child.childErrors.length > 5) {
        lines.push(`  - … and ${child.childErrors.length - 5} more`);
      }
    }

    lines.push("");
  }

  // Summary row.
  lines.push("---", "");
  lines.push(`**Suite verdict:** ${summary.suitePassed ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(`**Mobile viewport:** ${summary.viewport.width}×${summary.viewport.height}`);
  lines.push(`**Required:** ${summary.requiredPassed}/${summary.requiredCount}`);
  lines.push("");

  fs.writeFileSync(EVIDENCE_MD, lines.join("\n"));

  const status = summary.suitePassed ? "PASS" : "FAIL";
  console.log(
    `[suite-mobile] ${status} — ${summary.requiredPassed}/${summary.requiredCount} required passed ` +
    `(${summary.childCount} total children, viewport ${summary.viewport.width}×${summary.viewport.height}, ` +
    `${Math.round(elapsed(summary))}s)`
  );
}

function countChecks(checks) {
  let n = 0;
  for (const v of Object.values(checks)) {
    if (typeof v === "object" && v !== null) n += Object.keys(v).length;
    else if (typeof v === "boolean") n++;
  }
  return n;
}

function countPassed(checks) {
  let n = 0;
  for (const v of Object.values(checks)) {
    if (typeof v === "object" && v !== null) {
      for (const c of Object.values(v)) {
        if (c === true) n++;
      }
    } else if (v === true) {
      n++;
    }
  }
  return n;
}

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function elapsed(summary) {
  const first = summary.children[0];
  const last = summary.children[summary.children.length - 1];
  if (!first || !last) return 0;
  return (first.durationMs + last.durationMs) / 1000;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

  const suiteResult = { children: {} };
  let suiteFailed = false;

  for (const entry of SMOKES) {
    console.log(`[suite-mobile] Starting ${entry.label} (${entry.script})…`);
    const child = await runChild(entry);
    suiteResult.children[entry.label] = child;

    if (child.passed) {
      console.log(`[suite-mobile] ${entry.label} ✅ (${child.durationMs}ms)`);
    } else if (!child.required) {
      console.log(`[suite-mobile] ${entry.label} ⚠ (optional, exit ${child.exitCode})`);
    } else {
      console.log(`[suite-mobile] ${entry.label} ❌ (exit ${child.exitCode}, ${child.durationMs}ms)`);
      suiteFailed = true;
    }
  }

  writeEvidence(suiteResult);

  console.log(`\n[suite-mobile] Evidence written to:`);
  console.log(`         ${EVIDENCE_JSON}`);
  console.log(`         ${EVIDENCE_MD}`);

  process.exit(suiteFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("[suite-mobile] Unhandled error:", err);
  process.exit(1);
});
