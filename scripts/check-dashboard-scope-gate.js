#!/usr/bin/env node
// Static evidence check for the Dashboard Scope Gates.
//
// Proves the three persistence guarantees required by the repair:
//   1. owner-home.html (Golden Path) has the TTFT panel and NO scope-gate marker.
//   2. Every non-Golden-Path page carries a persistent scope marker that is
//      always rendered (banner text + always-on badge) and never toggled off.
//   3. No localStorage-based dismissal can hide the only scope marker:
//      the banner has no `display:none` and there is no `zz_scope_gate_dismissed`
//      key or scope-gate `localStorage.setItem`.
//
// Usage: node scripts/check-dashboard-scope-gate.js [dashboard_dir]

const fs = require('fs');
const path = require('path');

const dashboardDir = process.argv[2] || 'dashboard';
const NON_GOLDEN = ['product.html', 'human-workspace.html', 'index.html'];

function read(name) {
  return fs.readFileSync(path.join(dashboardDir, name), 'utf8');
}

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// 1. owner-home.html: Golden Path surface — TTFT intact, no scope-gate marker.
console.log('owner-home.html (Golden Path):');
const owner = read('owner-home.html');
assert(/TTFT|首次评审完成时间/.test(owner), 'TTFT panel present');
assert(!/scope-gate|scopeGate|实验性页面|非 Golden Path/.test(owner),
  'no scope-gate marker added/removed around TTFT');

// 2 & 3. Non-Golden-Path pages: persistent marker, never hidden, no localStorage dismissal.
for (const name of NON_GOLDEN) {
  const html = read(name);
  const bannerDecl = html.match(/<div[^>]*id="scopeGateBanner"[^>]*>/) || [];
  const bannerOpen = bannerDecl[0] || '';

  console.log(`\n${name} (non-Golden-Path):`);
  assert(/实验性页面（非 Golden Path）/.test(html), 'persistent banner scope-marker text present');
  assert(/id="scopeGateBadge"/.test(html) && /非 Golden Path/.test(html),
    'always-on corner badge present (scopeGateBadge + "非 Golden Path")');
  assert(/<a class="scope-gate-cta" href="\.\/owner-home\.html">/.test(html),
    'banner routes to owner-home.html via persistent CTA');
  assert(!/display:\s*none/.test(bannerOpen),
    'banner is not hidden by inline display:none (always shown)');
  assert(!/zz_scope_gate_dismissed/.test(html),
    'no scope-gate localStorage dismissal key');
  assert(!/scopeGateDismiss|scope-gate-dismiss/.test(html),
    'no permanent dismiss control');
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} assertion failure(s)`);
process.exit(failures === 0 ? 0 : 1);
