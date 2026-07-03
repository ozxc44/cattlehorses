#!/usr/bin/env node
// Capability-matrix contract validator.
//
// Validates that the five-section capability matrix at
// .codex/pm-workers/current-capability-matrix.md conforms to its structural
// contract, catching the "no machine-check guard" proof gap (gap 14).
//
// Contract:
//   1. First line is exactly "## Golden Path Required Capabilities"
//      (no BOM, no leading whitespace, no preface text).
//   2. EXACTLY five top-level ("## ") sections, in this exact order. Each
//      heading must match LITERALLY — no trailing whitespace is tolerated:
//        ## Golden Path Required Capabilities
//        ## Golden Path Support Capabilities
//        ## Frozen / Exploratory Capabilities
//        ## Verified Proof / Evidence
//        ## Remaining Proof Gaps
//      No other "## " heading allowed anywhere in the document.
//   3. At least 90 lines total.
//   4. No top-level "## Final Summary" wrapper.
//   5. Required correction markers are present:
//        - "validate-pm-result-contract"
//        - "/v1/projects/:project_id/reward-preview"
//        - "/v1/work-units/:work_unit_id/adjust"
//        - "20260620_142155_c"
//
// Usage:
//   node scripts/validate-capability-matrix.js <path-to-matrix.md>
//
// Exit code 0 = contract holds, 1 = one or more violations.

const fs = require('fs');

const REQUIRED_SECTIONS = [
  '## Golden Path Required Capabilities',
  '## Golden Path Support Capabilities',
  '## Frozen / Exploratory Capabilities',
  '## Verified Proof / Evidence',
  '## Remaining Proof Gaps',
];

const REQUIRED_MARKERS = [
  'validate-pm-result-contract',
  '/v1/projects/:project_id/reward-preview',
  '/v1/work-units/:work_unit_id/adjust',
  '20260620_142155_c',
];

const MIN_LINES = 90;

const FORBIDDEN_HEADING = '## Final Summary';

const ERRORS = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function err(msg, line) {
  const loc = line !== undefined ? ` (line ${line})` : '';
  ERRORS.push(`FAIL: ${msg}${loc}`);
}

function readLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n');
}

// ---------------------------------------------------------------------------
// Check 1: file starts exactly with "## Golden Path Required Capabilities"
// ---------------------------------------------------------------------------

function checkOpening(lines) {
  if (lines.length === 0) {
    err('File is empty — expected "## Golden Path Required Capabilities" as first line', 1);
    return;
  }
  const first = lines[0];
  const expected = REQUIRED_SECTIONS[0];
  if (first !== expected) {
    const snippet = first.length > 60 ? first.slice(0, 57) + '...' : first;
    err(
      `File does not start with ${JSON.stringify(expected)}.\n` +
      `  First line: ${JSON.stringify(snippet)}\n` +
      `  (No BOM, no leading whitespace, no preface text is allowed.)`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2: EXACTLY five top-level sections, in order, no extras
// ---------------------------------------------------------------------------

const TOP_LEVEL_RE = /^## /;

function checkSections(lines) {
  // Collect every top-level heading in document order.
  const found = []; // { heading, line }  (line is 1-indexed)
  for (let i = 0; i < lines.length; i++) {
    if (TOP_LEVEL_RE.test(lines[i])) {
      // Literal capture: no trailing-whitespace trimming, so every required
      // heading must match its expected string exactly (byte-for-byte).
      found.push({ heading: lines[i], line: i + 1 });
    }
  }

  const foundHeadings = found.map(f => f.heading);
  const requiredList = REQUIRED_SECTIONS.map(s => JSON.stringify(s)).join(' → ');

  // (a) Exactly five top-level headings.
  if (foundHeadings.length !== REQUIRED_SECTIONS.length) {
    const listing = foundHeadings.length === 0
      ? '  (none found)'
      : foundHeadings
          .map((h, idx) => `  ${idx + 1}. ${JSON.stringify(h)} (line ${found[idx].line})`)
          .join('\n');
    err(
      `Expected exactly ${REQUIRED_SECTIONS.length} top-level ("## ") headings, ` +
      `but found ${foundHeadings.length}.\n${listing}\n` +
      `  Required (in order): ${requiredList}`
    );
  }

  // (b) Element-wise match against the required list.
  const sharedLen = Math.min(foundHeadings.length, REQUIRED_SECTIONS.length);
  for (let i = 0; i < sharedLen; i++) {
    if (foundHeadings[i] !== REQUIRED_SECTIONS[i]) {
      err(
        `Top-level heading #${i + 1} is ${JSON.stringify(foundHeadings[i])} ` +
        `(line ${found[i].line}), expected ${JSON.stringify(REQUIRED_SECTIONS[i])}.\n` +
        `  Required order: ${requiredList}`
      );
    }
  }

  // (c) Any heading beyond the fifth is a contract violation.
  if (foundHeadings.length > REQUIRED_SECTIONS.length) {
    for (let i = REQUIRED_SECTIONS.length; i < foundHeadings.length; i++) {
      err(
        `Unexpected extra top-level heading ${JSON.stringify(foundHeadings[i])} ` +
        `(line ${found[i].line}); the contract allows exactly five.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: at least 90 lines
// ---------------------------------------------------------------------------

function checkLineCount(lines) {
  if (lines.length < MIN_LINES) {
    err(
      `File has ${lines.length} line(s), expected at least ${MIN_LINES}. ` +
      `Short by ${MIN_LINES - lines.length} line(s).`
    );
  }
}

// ---------------------------------------------------------------------------
// Check 4: no "## Final Summary" top-level wrapper
// ---------------------------------------------------------------------------

function checkForbiddenHeading(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === FORBIDDEN_HEADING) {
      err(
        `Found forbidden top-level heading ${JSON.stringify(FORBIDDEN_HEADING)} ` +
        `(line ${i + 1}). This matrix must NOT have a "## Final Summary" wrapper.`
      );
      return; // one error is enough
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5: required correction markers present
// ---------------------------------------------------------------------------

function checkMarkers(content) {
  for (const marker of REQUIRED_MARKERS) {
    if (!content.includes(marker)) {
      err(
        `Required correction marker ${JSON.stringify(marker)} not found in file.\n` +
        `  This marker must appear to confirm the matrix was corrected for the ` +
        `corresponding prior issue.\n` +
        `  See .codex/pm-workers/current-capability-matrix.md "Remaining Proof Gaps" ` +
        `for context on each marker.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: node scripts/validate-capability-matrix.js <path-to-matrix.md>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = readLines(filePath);

  // -- Check 1: opening line --
  checkOpening(lines);

  // -- Check 2: sections and ordering --
  checkSections(lines);

  // -- Check 3: line count --
  checkLineCount(lines);

  // -- Check 4: forbidden heading --
  checkForbiddenHeading(lines);

  // -- Check 5: correction markers --
  checkMarkers(raw);

  // -- Report --
  console.log(`File: ${filePath}`);
  console.log(`Contract: capability-matrix five-section report (${REQUIRED_SECTIONS.length} sections, ≥${MIN_LINES} lines, ${REQUIRED_MARKERS.length} markers)`);
  console.log('');

  if (ERRORS.length === 0) {
    console.log('✓ Contract validation PASSED — all checks green.');
    process.exit(0);
  } else {
    for (const e of ERRORS) {
      console.error(e);
    }
    console.log('');
    console.error(`✗ Contract validation FAILED — ${ERRORS.length} violation(s) found.`);
    process.exit(1);
  }
}

main();
