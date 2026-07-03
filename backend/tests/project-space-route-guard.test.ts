/**
 * Frozen-surface guard for project-space route files.
 *
 * Parses both project-space.routes.ts (GP-Required + GP-Support) and
 * project-space-frozen.routes.ts (Frozen) and verifies the registered endpoint
 * count matches the known manifest (24 routes across 3 families). The guard
 * ALSO cross-checks the same manifest against docs/api-surface-freeze.md and
 * the capability matrix, so a developer cannot update the manifest + source but
 * forget the docs/matrix. If someone adds a new route to either project-space
 * route file without updating the manifest (and docs + matrix), this test will
 * fail — preventing silent expansion of frozen sub-routes.
 *
 * Manifest lives in scripts/validate-project-space-routes.js (MANIFEST array).
 *
 * Tests:
 *   1. End-to-end: the guard passes against the real repo artifacts.
 *   2. Drift: a freeze doc with wrong frozen count is rejected (exit != 0).
 *   3. Drift: a matrix with wrong family counts is rejected (exit != 0).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// __dirname is backend/dist/tests when compiled; go up 3 levels to repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-project-space-routes.js');
const REAL_FREEZE_DOC = path.join(REPO_ROOT, 'docs', 'api-surface-freeze.md');
const REAL_MATRIX = path.join(REPO_ROOT, '.codex', 'pm-workers', 'current-capability-matrix.md');

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
  } catch (err: any) {
    failed++;
    console.log(`  ❌ ${label}: ${err.message}`);
  }
}

/** Run the guard script with optional env overrides; return {status, stdout, stderr}. */
function runGuard(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (err: any) {
    return { status: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Write a temp file and return its path; cleaned up by the caller via cleanup(). */
const tempFiles: string[] = [];
function writeTemp(content: string): string {
  const p = path.join(os.tmpdir(), `ps-guard-${process.pid}-${tempFiles.length}.md`);
  fs.writeFileSync(p, content, 'utf8');
  tempFiles.push(p);
  return p;
}
function cleanup(): void {
  for (const p of tempFiles) {
    try { fs.unlinkSync(p); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  console.log('project-space-route-guard.test.ts');
  console.log('──────────────────────────────────');

  try {
    // ─── Test 1: end-to-end against real artifacts ─────────────────────
    check('frozen-surface guard passes against source + manifest + docs + matrix', () => {
      const { status, stdout, stderr } = runGuard();
      const combined = stdout + stderr;
      assert.equal(status, 0, `Guard script exited ${status}:\n${combined}`);
      assert(stdout.includes('Routes found in source: 27'), `Expected 27 routes, got: ${stdout}`);
      assert(stdout.includes('Frozen-surface guard PASSED'), `Expected PASSED in output:\n${stdout}`);
      // Confirm the new cross-check actually ran against the real artifacts.
      assert(stdout.includes('Cross-check artifacts:'), `Guard did not report cross-check:\n${stdout}`);
      assert(stdout.includes(REAL_FREEZE_DOC), `Guard did not cross-check the freeze doc`);
      assert(stdout.includes(REAL_MATRIX), `Guard did not cross-check the matrix`);
      // Confirm both source files are mentioned.
      assert(stdout.includes('project-space.routes.ts'), `Guard did not mention main source file:\n${stdout}`);
      assert(stdout.includes('project-space-frozen.routes.ts'), `Guard did not mention frozen source file:\n${stdout}`);
      // Manifest-derived counts must appear for all three families.
      assert(/GP-Required:\s+source=17\s+manifest=17/.test(stdout), `GP-Required count mismatch:\n${stdout}`);
      assert(/GP-Support:\s+source=5\s+manifest=5/.test(stdout), `GP-Support count mismatch:\n${stdout}`);
      assert(/Frozen:\s+source=5\s+manifest=5/.test(stdout), `Frozen count mismatch:\n${stdout}`);
    });

    // ─── Test 2: freeze-doc drift is rejected ──────────────────────────
    check('freeze doc with wrong frozen count is rejected (drift detected)', () => {
      // Same structure as the real guard section, but frozen count bumped to 6.
      const driftedDoc = [
        '### Automated Frozen-Surface Guard',
        '',
        'A machine-checkable guard enforces the surface:',
        '',
        '- **Script:** `scripts/validate-project-space-routes.js` — compares against a known 19-route manifest partitioned into three families:',
        '  - **GP-Required** (10 routes): files CRUD + revisions',
        '  - **GP-Support** (5 routes): memories CRUD, join-requests',
        '  - **Frozen** (6 routes): clone, file-proposals',
        '',
      ].join('\n');
      const temp = writeTemp(driftedDoc);
      const { status, stderr } = runGuard({ VALIDATE_PS_FREEZE_DOC: temp });
      assert.notEqual(status, 0, `Guard must fail on freeze-doc drift, but exited ${status}`);
      assert(/FREEZE DOC DRIFT/.test(stderr), `Expected FREEZE DOC DRIFT in stderr:\n${stderr}`);
    });

    // ─── Test 3: matrix drift is rejected ──────────────────────────────
    check('matrix with wrong family breakdown is rejected (drift detected)', () => {
      // Real total (19) but a wrong GP-Required count (10 instead of 9).
      const driftedMatrix = [
        '## Golden Path Required Capabilities',
        '',
        'Frozen-surface guard enforces a 19-route manifest (10 GP-Required, 5 GP-Support, 4 Frozen).',
        'Correction markers: validate-pm-result-contract, /v1/projects/:project_id/reward-preview,',
        '/v1/work-units/:work_unit_id/adjust, 20260620_142155_c.',
        '',
      ].join('\n');
      const temp = writeTemp(driftedMatrix);
      const { status, stderr } = runGuard({ VALIDATE_PS_MATRIX: temp });
      assert.notEqual(status, 0, `Guard must fail on matrix drift, but exited ${status}`);
      assert(/MATRIX DRIFT/.test(stderr), `Expected MATRIX DRIFT in stderr:\n${stderr}`);
    });
  } finally {
    cleanup();
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
