#!/usr/bin/env node
// Frozen-surface guard for project-space route files.
//
// Parses both project-space.routes.ts (GP-Required + GP-Support) and
// project-space-frozen.routes.ts (Frozen) to enumerate every registered route
// pattern, then compares against a known manifest AND cross-checks the same
// manifest against the freeze documentation and the capability matrix. Fails if:
//   1. Any route in source is NOT in the manifest (silent expansion).
//   2. Any manifest entry is missing from source (route removed without doc update).
//   3. The freeze docs (docs/api-surface-freeze.md) family counts or frozen
//      sub-route names drift from the manifest.
//   4. The capability matrix (.codex/pm-workers/current-capability-matrix.md)
//      route totals / family counts drift from the manifest.
//
// The manifest partitions routes into three families:
//   - GP-Required:  files CRUD, read helpers, revisions (step 8)
//   - GP-Support:   memories CRUD, join-requests     (operations)
//   - Frozen:       clone, file-proposals            (no new endpoints)
//
// This closes the PM review finding that a developer could update the manifest
// + source but forget docs/api-surface-freeze.md / the matrix: the guard now
// machine-enforces that all four artifacts agree.
//
// Parser limitation (documented, intentionally not fixed): source parsing only
// matches literal `router.METHOD('...')` registrations. Dynamic route
// registration (variables, loops, conditional mounts) is NOT detected. This is
// acceptable because both project-space route files use only literal
// registrations; do not rewrite the router to work around this guard.
//
// Usage:
//   node scripts/validate-project-space-routes.js
//
// Test-only path overrides (used by project-space-route-guard.test.ts to prove
// drift is caught; defaults point at the real repo artifacts):
//   VALIDATE_PS_SOURCE=/path/to/project-space.routes.ts
//   VALIDATE_PS_FROZEN_SOURCE=/path/to/project-space-frozen.routes.ts
//   VALIDATE_PS_FREEZE_DOC=/path/to/api-surface-freeze.md
//   VALIDATE_PS_MATRIX=/path/to/current-capability-matrix.md
//
// Exit code 0 = guard holds, 1 = violation detected.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Known manifest — frozen since Batch 83.
// Update this manifest, docs/api-surface-freeze.md, AND the capability matrix
// together if a legitimate new route is added to project-space.routes.ts.
// ---------------------------------------------------------------------------

const MANIFEST = [
  // GP-Required: Files CRUD, read helpers, and revisions (step 8)
  { method: 'GET',    pattern: '/v1/projects/:project_id/files',                         family: 'gp-required' },
  { method: 'POST',   pattern: '/v1/projects/:project_id/files',                         family: 'gp-required' },
  { method: 'POST',   pattern: '/v1/projects/:project_id/files/upload',                  family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/search',                  family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id',                family: 'gp-required' },
  { method: 'PATCH',  pattern: '/v1/projects/:project_id/files/:file_id',                family: 'gp-required' },
  { method: 'DELETE', pattern: '/v1/projects/:project_id/files/:file_id',                family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id/raw',            family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id/download',       family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id/blame',          family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id/revisions',      family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/files/:file_id/revisions/compare', family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/readme',                        family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/agents-rules',                  family: 'gp-required' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/archive.zip',                   family: 'gp-required' },

  // GP-Support: Memories CRUD
  { method: 'GET',    pattern: '/v1/projects/:project_id/memories',                      family: 'gp-support' },
  { method: 'POST',   pattern: '/v1/projects/:project_id/memories',                      family: 'gp-support' },

  // GP-Support: Join Requests (V1 membership gateway)
  { method: 'POST',   pattern: '/v1/projects/:project_id/join-requests',                 family: 'gp-support' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/join-requests',                 family: 'gp-support' },
  { method: 'PATCH',  pattern: '/v1/projects/:project_id/join-requests/:request_id',     family: 'gp-support' },

  // Frozen: Clone
  { method: 'POST',   pattern: '/v1/projects/:project_id/clone',                         family: 'frozen' },

  // Frozen: File Proposals
  { method: 'POST',   pattern: '/v1/projects/:project_id/file-proposals',                family: 'frozen' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/file-proposals',                family: 'frozen' },
  { method: 'GET',    pattern: '/v1/projects/:project_id/file-proposals/:proposal_id',   family: 'frozen' },
  { method: 'PATCH',  pattern: '/v1/projects/:project_id/file-proposals/:proposal_id/review', family: 'frozen' },
];

const FAMILY_LABELS = {
  'gp-required': 'GP-Required',
  'gp-support': 'GP-Support',
  'frozen': 'Frozen',
};

// ---------------------------------------------------------------------------
// Manifest-derived summary (the single source of truth the guard enforces
// against source, freeze docs, and matrix).
// ---------------------------------------------------------------------------

function manifestSummary() {
  const counts = { 'gp-required': 0, 'gp-support': 0, 'frozen': 0 };
  for (const r of MANIFEST) {
    if (!(r.family in counts)) {
      throw new Error(`MANIFEST entry has unknown family: ${r.family} (${r.method} ${r.pattern})`);
    }
    counts[r.family]++;
  }
  // Distinct frozen sub-route names, e.g. /v1/projects/:project_id/clone -> "clone".
  const frozenNames = new Set();
  for (const r of MANIFEST) {
    if (r.family !== 'frozen') continue;
    const m = r.pattern.match(/^\/v1\/projects\/:[^/]+\/([^/]+)/);
    if (m) frozenNames.add(m[1]);
  }
  return {
    total: MANIFEST.length,
    counts,
    frozenNames,
  };
}

// ---------------------------------------------------------------------------
// Source parsing (literal registrations only — see header limitation note).
// ---------------------------------------------------------------------------

function parseRoutes(source) {
  const routes = [];
  // Match: router.METHOD( followed by a string literal route pattern
  const re = /router\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    routes.push({
      method: m[1].toUpperCase(),
      pattern: m[2],
    });
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Freeze-doc parsing (docs/api-surface-freeze.md).
// Extracts the documented family counts and the frozen sub-route names from
// the "Automated Frozen-Surface Guard" bullet list.
// ---------------------------------------------------------------------------

function parseFreezeDoc(markdown) {
  const result = {
    found: false,
    counts: {},          // { 'gp-required': N, 'gp-support': N, 'frozen': N }
    frozenNames: new Set(),
  };

  for (const family of Object.keys(FAMILY_LABELS)) {
    const label = FAMILY_LABELS[family];
    // Match: **GP-Required** (N routes)[: optional trailing names]
    const re = new RegExp(
      '\\*\\*\\s*' + label + '\\s*\\*\\*\\s*\\(\\s*(\\d+)\\s+routes?\\s*\\)([^\\n]*)',
      'i',
    );
    const m = markdown.match(re);
    if (m) {
      result.found = true;
      result.counts[family] = parseInt(m[1], 10);
      if (family === 'frozen' && m[2]) {
        // Trailing text after the count, e.g. ": clone, file-proposals"
        const tail = m[2].replace(/^[\s:]+/, '');
        for (const name of tail.split(',')) {
          const trimmed = name.trim().toLowerCase();
          if (trimmed) result.frozenNames.add(trimmed);
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix parsing (.codex/pm-workers/current-capability-matrix.md).
// Extracts the documented total ("N-route manifest") and the family breakdown
// "(N GP-Required, N GP-Support, N Frozen)".
// ---------------------------------------------------------------------------

function parseMatrix(markdown) {
  const result = { foundTotal: false, foundBreakdown: false, total: null, counts: {} };

  // All "N-route manifest" mentions must be consistent.
  const totals = [...markdown.matchAll(/(\d+)-route manifest/gi)].map((m) => parseInt(m[1], 10));
  if (totals.length > 0) {
    result.foundTotal = true;
    result.total = totals[0];
    result.consistentTotal = totals.every((t) => t === result.total);
    result.totalsSeen = totals;
  }

  const m = markdown.match(/\(\s*(\d+)\s*GP-Required\s*,\s*(\d+)\s*GP-Support\s*,\s*(\d+)\s*Frozen\s*\)/i);
  if (m) {
    result.foundBreakdown = true;
    result.counts['gp-required'] = parseInt(m[1], 10);
    result.counts['gp-support'] = parseInt(m[2], 10);
    result.counts['frozen'] = parseInt(m[3], 10);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const srcPath = process.env.VALIDATE_PS_SOURCE
    || path.join(repoRoot, 'backend', 'src', 'routes', 'project-space.routes.ts');
  const frozenSrcPath = process.env.VALIDATE_PS_FROZEN_SOURCE
    || path.join(repoRoot, 'backend', 'src', 'routes', 'project-space-frozen.routes.ts');
  const freezeDocPath = process.env.VALIDATE_PS_FREEZE_DOC
    || path.join(repoRoot, 'docs', 'api-surface-freeze.md');
  const matrixPath = process.env.VALIDATE_PS_MATRIX
    || path.join(repoRoot, '.codex', 'pm-workers', 'current-capability-matrix.md');

  const errors = [];

  // --- 1. Source vs manifest ------------------------------------------------
  if (!fs.existsSync(srcPath)) {
    console.error(`Source file not found: ${srcPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(frozenSrcPath)) {
    console.error(`Frozen source file not found: ${frozenSrcPath}`);
    process.exit(1);
  }
  const source = fs.readFileSync(srcPath, 'utf8');
  const frozenSource = fs.readFileSync(frozenSrcPath, 'utf8');
  const parsed = [...parseRoutes(source), ...parseRoutes(frozenSource)];

  const manifestKeys = new Set(MANIFEST.map((r) => `${r.method} ${r.pattern}`));
  const parsedKeys = new Set(parsed.map((r) => `${r.method} ${r.pattern}`));

  for (const route of parsed) {
    const key = `${route.method} ${route.pattern}`;
    if (!manifestKeys.has(key)) {
      errors.push(
        `UNDOCUMENTED ROUTE: ${key}\n` +
        `  This route exists in project-space route files but is not in the manifest.\n` +
        `  If intentional, update scripts/validate-project-space-routes.js MANIFEST,\n` +
        `  docs/api-surface-freeze.md, AND the capability matrix before merging.`,
      );
    }
  }
  for (const route of MANIFEST) {
    const key = `${route.method} ${route.pattern}`;
    if (!parsedKeys.has(key)) {
      errors.push(
        `MISSING ROUTE: ${key}\n` +
        `  This route is in the manifest but not found in project-space route files.\n` +
        `  If intentionally removed, update the manifest, docs, and matrix.`,
      );
    }
  }

  // --- 2. Manifest-derived summary (source of truth) -----------------------
  const summary = manifestSummary();

  // --- 3. Freeze doc vs manifest -------------------------------------------
  const freezeDocLabel = 'docs/api-surface-freeze.md';
  if (!fs.existsSync(freezeDocPath)) {
    errors.push(`FREEZE DOC NOT FOUND: ${freezeDocPath} (expected at ${freezeDocPath})`);
  } else {
    const doc = parseFreezeDoc(fs.readFileSync(freezeDocPath, 'utf8'));
    if (!doc.found) {
      errors.push(
        `FREEZE DOC DRIFT: ${freezeDocLabel} does not declare the guard's family counts.\n` +
        `  Expected a bullet list like "**GP-Required** (N routes) / **GP-Support** (N routes)\n` +
        `  / **Frozen** (N routes)" in the "Automated Frozen-Surface Guard" section. If you\n` +
        `  reworded that section, restore the declaration so the manifest and docs stay in sync.`,
      );
    } else {
      for (const family of Object.keys(FAMILY_LABELS)) {
        const expected = summary.counts[family];
        const actual = doc.counts[family];
        if (actual === undefined) {
          errors.push(
            `FREEZE DOC DRIFT: ${freezeDocLabel} is missing the "${FAMILY_LABELS[family]}" family count.`,
          );
        } else if (actual !== expected) {
          errors.push(
            `FREEZE DOC DRIFT: ${freezeDocLabel} ${FAMILY_LABELS[family]} count is ${actual}, ` +
            `but the manifest has ${expected}. Update the docs to match the manifest.`,
          );
        }
      }
      // Frozen sub-route names must match the manifest's frozen families.
      const expectedFrozen = [...summary.frozenNames].sort();
      const actualFrozen = [...doc.frozenNames].sort();
      if (actualFrozen.length === 0) {
        errors.push(
          `FREEZE DOC DRIFT: ${freezeDocLabel} did not list frozen sub-route names after the\n` +
          `  "Frozen (N routes):" bullet. Expected: ${expectedFrozen.join(', ')}.`,
        );
      } else if (actualFrozen.join('|') !== expectedFrozen.join('|')) {
        errors.push(
          `FREEZE DOC DRIFT: ${freezeDocLabel} frozen sub-routes are [${actualFrozen.join(', ')}],\n` +
          `  but the manifest frozen families are [${expectedFrozen.join(', ')}].`,
        );
      }
    }
  }

  // --- 4. Matrix vs manifest ------------------------------------------------
  const matrixLabel = '.codex/pm-workers/current-capability-matrix.md';
  if (!fs.existsSync(matrixPath)) {
    errors.push(`MATRIX NOT FOUND: ${matrixLabel} (expected at ${matrixPath})`);
  } else {
    const matrix = parseMatrix(fs.readFileSync(matrixPath, 'utf8'));
    if (!matrix.foundTotal) {
      errors.push(
        `MATRIX DRIFT: ${matrixLabel} does not reference an "N-route manifest" total.\n` +
        `  Add/restore the manifest total (e.g. "enforces 19-route manifest").`,
      );
    } else {
      if (!matrix.consistentTotal) {
        errors.push(
          `MATRIX DRIFT: ${matrixLabel} has inconsistent manifest totals: [${matrix.totalsSeen.join(', ')}].`,
        );
      }
      if (matrix.total !== summary.total) {
        errors.push(
          `MATRIX DRIFT: ${matrixLabel} manifest total is ${matrix.total}, but the manifest has ${summary.total} routes.`,
        );
      }
    }
    if (!matrix.foundBreakdown) {
      errors.push(
        `MATRIX DRIFT: ${matrixLabel} does not declare the manifest family breakdown.\n` +
        `  Expected a "(N GP-Required, N GP-Support, N Frozen)" declaration matching the manifest.`,
      );
    } else {
      for (const family of Object.keys(FAMILY_LABELS)) {
        const expected = summary.counts[family];
        const actual = matrix.counts[family];
        if (actual !== expected) {
          errors.push(
            `MATRIX DRIFT: ${matrixLabel} ${FAMILY_LABELS[family]} count is ${actual}, but the manifest has ${expected}.`,
          );
        }
      }
    }
  }

  // --- Report ---------------------------------------------------------------
  const familyCounts = {};
  for (const r of parsed) {
    const manifestEntry = MANIFEST.find((m) => m.method === r.method && m.pattern === r.pattern);
    const family = manifestEntry ? manifestEntry.family : 'UNKNOWN';
    familyCounts[family] = (familyCounts[family] || 0) + 1;
  }

  console.log('Files: backend/src/routes/project-space.routes.ts + project-space-frozen.routes.ts');
  console.log(`Routes found in source: ${parsed.length}`);
  console.log(`Routes in manifest: ${MANIFEST.length}`);
  console.log('');
  console.log('Family breakdown (source vs manifest):');
  for (const family of Object.keys(FAMILY_LABELS)) {
    console.log(`  ${FAMILY_LABELS[family]}: source=${familyCounts[family] || 0} manifest=${summary.counts[family]}`);
  }
  console.log(`  Frozen sub-routes: ${[...summary.frozenNames].sort().join(', ')}`);
  console.log('');
  console.log(`Cross-check artifacts:`);
  console.log(`  freeze doc : ${freezeDocPath}`);
  console.log(`  matrix     : ${matrixPath}`);
  console.log('');

  if (errors.length === 0) {
    console.log('✓ Frozen-surface guard PASSED — source, manifest, freeze docs, and matrix agree.');
    process.exit(0);
  } else {
    for (const e of errors) {
      console.error(e);
    }
    console.log('');
    console.error(`✗ Frozen-surface guard FAILED — ${errors.length} violation(s).`);
    process.exit(1);
  }
}

main();
