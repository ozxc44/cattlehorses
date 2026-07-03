#!/usr/bin/env node
// Static smoke check for the Orchestration Trace & Review panel.
//
// Validates that owner-home.html contains:
//   1. The trace panel HTML section with expected structural IDs.
//   2. Artifact link rendering with explicit "未生成" (pending/missing) states.
//   3. Review decision badges (approved, changes_requested, pending).
//   4. API integration for orchestrations and file loading.
//   5. Human-facing copy only (no agent-action hints in the panel).
//
// Usage: node scripts/check-trace-panel.js [dashboard_dir]

const fs = require('fs');
const path = require('path');

const dashboardDir = process.argv[2] || 'dashboard';
const html = fs.readFileSync(path.join(dashboardDir, 'owner-home.html'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

console.log('Orchestration Trace & Review panel (owner-home.html):');

// 1. Structural IDs present
assert(html.includes('id="tracePanel"'), 'tracePanel section exists');
assert(html.includes('id="traceProjectSelect"'), 'project selector exists');
assert(html.includes('id="traceOrchList"'), 'orchestration list container exists');
assert(html.includes('id="traceOrchDetail"'), 'orchestration detail container exists');
assert(html.includes('id="traceTaskGrid"'), 'task grid exists');
assert(html.includes('id="traceMdLink"'), 'TRACE.md link element exists');
assert(html.includes('id="traceArtifactPreview"'), 'artifact preview area exists');

// 2. Explicit missing/pending states (no silent blanks)
assert(html.includes('未生成'), 'explicit "未生成" text for missing artifacts');
assert(html.includes('trace-artifact-link missing'), 'CSS class for missing artifact state');
assert(html.includes('选择项目查看编排'), 'empty state when no project selected');
assert(html.includes('该项目暂无编排'), 'empty state when no orchestrations');

// 3. Review decision visibility
assert(html.includes('review-badge approved'), 'approved review badge class');
assert(html.includes('review-badge changes_requested'), 'changes_requested review badge class');
assert(html.includes('review-badge pending'), 'pending review badge class');
assert(html.includes('已通过'), 'Chinese label for approved');
assert(html.includes('需修改'), 'Chinese label for changes_requested');
assert(html.includes('待评审'), 'Chinese label for pending review');

// 4. API integration
assert(html.includes('/orchestrations'), 'orchestrations API endpoint referenced');
assert(html.includes('/files?path_prefix='), 'file listing API with path_prefix');
assert(html.includes('/files/') , 'file detail API referenced');
assert(html.includes('md_artifacts'), 'md_artifacts field accessed from task data');

// 5. All 5 per-task artifacts referenced
assert(html.includes('TASK.md'), 'TASK.md artifact referenced');
assert(html.includes('RESULT.md'), 'RESULT.md artifact referenced');
assert(html.includes('EVIDENCE.md'), 'EVIDENCE.md artifact referenced');
assert(html.includes('REVIEW.md'), 'REVIEW.md artifact referenced');
assert(html.includes('CHANGELOG.md'), 'CHANGELOG.md artifact referenced');

// 6. Human-facing copy: no agent-action hints in the trace panel
// The panel intro text should mention "PM" and "人类", not CLI commands
const traceSectionMatch = html.match(/id="tracePanel"[\s\S]*?id="joinPanel"/);
if (traceSectionMatch) {
  const traceSection = traceSectionMatch[0];
  assert(!/zz\s+agent|cli|命令行/.test(traceSection), 'no agent CLI hints in trace panel HTML');
  assert(/人类|PM|检查|评审/.test(traceSection), 'human-facing copy in trace panel');
} else {
  assert(false, 'could not isolate tracePanel section for boundary check');
}

// 7. renderTrace function exists
assert(html.includes('function renderTrace'), 'renderTrace function defined');
assert(html.includes('function loadTraceOrchestrations'), 'loadTraceOrchestrations function defined');
assert(html.includes('function loadTraceOrchDetail'), 'loadTraceOrchDetail function defined');
assert(html.includes('function loadTraceFileContent'), 'loadTraceFileContent function defined');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
