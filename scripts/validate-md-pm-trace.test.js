#!/usr/bin/env node
// Fixture tests for scripts/validate-md-pm-trace.js.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-md-pm-trace.js');

function runValidator(fixture) {
  const result = spawnSync(process.execPath, [VALIDATOR, path.join(ROOT, fixture)], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`validator did not emit JSON for ${fixture}: ${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return { ...result, report };
}

function checkSyntax() {
  const result = spawnSync(process.execPath, ['--check', VALIDATOR], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function checkPassingFixture() {
  const { status, report } = runValidator('fixtures/md-pm-trace/pass');
  assert.strictEqual(status, 0, 'passing fixture should exit 0');
  assert.strictEqual(report.ok, true, 'passing fixture report.ok');
  assert.strictEqual(report.final_accepted, true, 'passing fixture final_accepted');
  assert.strictEqual(report.summary.task_count, 2, 'passing fixture task count');
  assert.strictEqual(report.summary.error_count, 0, 'passing fixture error count');
  assert.strictEqual(report.gk_gates.find((gate) => gate.gate === 12).status, 'pass');
}

function checkMissingArtifactFixture() {
  const { status, report } = runValidator('fixtures/md-pm-trace/fail-missing-evidence');
  assert.notStrictEqual(status, 0, 'missing evidence fixture should exit non-zero');
  assert.strictEqual(report.ok, false, 'missing evidence fixture report.ok');
  assert.strictEqual(report.final_accepted, false, 'missing evidence fixture final_accepted');
  const required = report.checks.find((check) => check.id === 'required_artifacts');
  assert.strictEqual(required.status, 'fail', 'missing evidence should fail required_artifacts');
  assert(required.errors.some((error) => error.path === 'tasks/TASK-1/EVIDENCE.md'));
}

function checkBadStateFixture() {
  const { status, report } = runValidator('fixtures/md-pm-trace/fail-bad-state');
  assert.notStrictEqual(status, 0, 'bad state fixture should exit non-zero');
  assert.strictEqual(report.ok, false, 'bad state fixture report.ok');
  const state = report.checks.find((check) => check.id === 'state_machine');
  const review = report.checks.find((check) => check.id === 'review_evidence_gate');
  const final = report.checks.find((check) => check.id === 'final_acceptance');
  assert.strictEqual(state.status, 'fail', 'bad state should fail state_machine');
  assert.strictEqual(review.status, 'fail', 'bad state should fail review_evidence_gate');
  assert.strictEqual(final.status, 'fail', 'bad state should fail final_acceptance');
}

checkSyntax();
checkPassingFixture();
checkMissingArtifactFixture();
checkBadStateFixture();

console.log('validate-md-pm-trace fixture tests passed');
