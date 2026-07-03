#!/usr/bin/env node
// Reusable dashboard HTML inline-script syntax checker.
// Scans all dashboard/*.html files for inline <script> blocks and
// verifies each block parses without error via Node's compiler.
//
// Usage: node scripts/check-dashboard-syntax.js [dashboard_dir]
// Exit code 0 = all clean, 1 = one or more syntax errors.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dashboardDir = process.argv[2] || 'dashboard';

const htmlFiles = fs.readdirSync(dashboardDir)
  .filter(f => f.endsWith('.html'))
  .map(f => path.join(dashboardDir, f))
  .sort();

if (htmlFiles.length === 0) {
  console.error('No .html files found in', dashboardDir);
  process.exit(1);
}

let totalErrors = 0;
let totalScripts = 0;

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let scriptIndex = 0;
  let fileErrors = 0;

  while ((m = re.exec(html)) !== null) {
    const code = m[1].trim();
    if (!code) continue;
    scriptIndex++;
    try {
      vm.compileFunction(code);
    } catch (e) {
      console.error(`${file}: script block ${scriptIndex}: ${e.message}`);
      fileErrors++;
      totalErrors++;
    }
  }

  totalScripts += scriptIndex;
  if (fileErrors === 0) {
    console.log(`${file}: ${scriptIndex} inline script(s) — syntax OK`);
  }
}

console.log(`\nTotal: ${htmlFiles.length} file(s), ${totalScripts} script(s), ${totalErrors} error(s)`);

if (totalErrors > 0) {
  process.exit(1);
}