#!/usr/bin/env node
// PM output-contract validator for structured assessment reports.
//
// Validates that a result.md file conforms to the six-section contract
// required for PM assessment output, catching the structural failure class
// that caused multiple repair rounds.
//
// Contract:
//   1. File starts exactly with "## Product Read" (no BOM, no leading
//      whitespace, no preface text).
//   2. EXACTLY six top-level ("## ") sections, in this exact order, and no
//      other "## " heading anywhere in the document:
//        ## Product Read
//        ## Architecture Map
//        ## Top 8 Recommendations
//        ## Two-Week Roadmap
//        ## Verification Performed
//        ## Evidence Gaps And Residual Risks
//   3. EXACTLY 8 recommendation block starts under ## Top 8 Recommendations
//      (counted by block starts, not by unique numbers), numbered uniquely
//      and consecutively 1..8. Each block starts with "**N. Title**".
//   4. Each recommendation contains exactly one Impact:, one Evidence:, and
//      one Next action:, in that order.
//
// Usage:
//   node scripts/validate-pm-result-contract.js <path-to-result.md>
//
// Exit code 0 = contract holds, 1 = one or more violations.

const fs = require('fs');

const REQUIRED_SECTIONS = [
  '## Product Read',
  '## Architecture Map',
  '## Top 8 Recommendations',
  '## Two-Week Roadmap',
  '## Verification Performed',
  '## Evidence Gaps And Residual Risks',
];

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
// Check 1: file starts exactly with "## Product Read"
// ---------------------------------------------------------------------------

function checkOpening(lines) {
  if (lines.length === 0) {
    err('File is empty — expected "## Product Read" as first line', 1);
    return;
  }
  const first = lines[0];
  if (first !== '## Product Read') {
    // Show first few chars for context, up to 60
    const snippet = first.length > 60 ? first.slice(0, 57) + '...' : first;
    err(
      `File does not start with "## Product Read".\n` +
      `  First line: ${JSON.stringify(snippet)}\n` +
      `  Expected:   "## Product Read"\n` +
      `  (No BOM, no leading whitespace, no preface text is allowed.)`,
      1
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2: EXACTLY six top-level sections, in order, no extras
// ---------------------------------------------------------------------------

// A top-level heading is a line beginning with exactly "## " (two hashes and
// a space). This deliberately does NOT match "### " or deeper headings,
// because their third character is "#", not a space.
const TOP_LEVEL_RE = /^## /;

function checkSections(lines) {
  // Collect every top-level heading in document order.
  const found = []; // { heading, line }  (line is 1-indexed)
  for (let i = 0; i < lines.length; i++) {
    if (TOP_LEVEL_RE.test(lines[i])) {
      found.push({ heading: lines[i].replace(/\s+$/, ''), line: i + 1 });
    }
  }

  const foundHeadings = found.map(f => f.heading);
  const requiredList = REQUIRED_SECTIONS.map(s => JSON.stringify(s)).join(' → ');

  // (a) Exactly six top-level headings — reject missing AND extra sections.
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

  // (b) Element-wise match against the required list over the shared prefix,
  //     so the first divergence is pinpointed regardless of count.
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

  // (c) Any heading beyond the sixth is an explicit contract violation.
  if (foundHeadings.length > REQUIRED_SECTIONS.length) {
    for (let i = REQUIRED_SECTIONS.length; i < foundHeadings.length; i++) {
      err(
        `Unexpected extra top-level heading ${JSON.stringify(foundHeadings[i])} ` +
        `(line ${found[i].line}); the contract allows exactly six.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3 & 4: exactly 8 recommendation block starts, unique 1..8, fields ok
// ---------------------------------------------------------------------------

// A recommendation block starts with a bolded numbered marker line. The
// documented, accepted shape is EXACTLY:
//
//     **N. Title**
//
// enforced strictly and deterministically:
//   - the line begins with "**"
//   - N is one or more digits
//   - a literal period and at least one space follow N
//   - the title contains non-whitespace text
//   - the line ends with the closing "**" (only trailing whitespace may follow)
//
// A line must NOT be accepted merely because it begins with "**N. ": a missing
// closing "**" or an empty/whitespace-only title is a contract violation.
// REC_LIKE_RE detects lines that look like an attempted marker but fail the
// strict shape, so we report the precise reason instead of a bare count.
const REC_START_RE = /^\*\*(\d+)\. +(.+)\*\*\s*$/;
const REC_LIKE_RE = /^\*\*\d+\./;

function checkRecommendations(lines) {
  // Find the boundaries: everything between "## Top 8 Recommendations"
  // and the next top-level ("## ") heading (or end of file).
  let recStart = -1;
  let recEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '## Top 8 Recommendations') {
      recStart = i;
    } else if (recStart !== -1 && TOP_LEVEL_RE.test(lines[i])) {
      recEnd = i;
      break;
    }
  }

  if (recStart === -1) {
    // Error already reported by checkSections; skip.
    return;
  }

  const recLines = lines.slice(recStart, recEnd);

  // Collect each block start in document order, and flag lines that look like
  // an attempted marker but fail the strict "**N. Title**" shape.
  const blocks = []; // { index (within recLines), number, title, line (1-indexed absolute) }
  const malformedMarkers = []; // { line (1-indexed absolute), text }
  for (let i = 0; i < recLines.length; i++) {
    const text = recLines[i];
    const m = text.match(REC_START_RE);
    if (m) {
      const title = m[2];
      // The regex shape already guarantees non-whitespace title text; assert it
      // explicitly so a future regex change cannot silently relax the rule.
      if (title.trim() === '') {
        malformedMarkers.push({ line: recStart + i + 1, text });
        continue;
      }
      blocks.push({ index: i, number: parseInt(m[1], 10), title: title.trim(), line: recStart + i + 1 });
    } else if (REC_LIKE_RE.test(text)) {
      malformedMarkers.push({ line: recStart + i + 1, text });
    }
  }

  // Report lines that looked like a recommendation marker but violated the
  // strict "**N. Title**" shape (e.g. missing closing "**" or empty title).
  // These are stated before the count check so the root cause is visible even
  // though they also (correctly) throw off the block count.
  for (const mm of malformedMarkers) {
    err(
      `Recommendation marker does not match the required shape "**N. Title**": ` +
      `${JSON.stringify(mm.text)}.\n` +
      `  Required: digits + "." + space + non-empty title + closing "**", with ` +
      `only trailing whitespace after the closing marker.`,
      mm.line
    );
  }

  // --- (a) Exactly 8 block STARTS (not unique-number set cardinality). ---
  if (blocks.length !== 8) {
    const nums = blocks.map(b => b.number).join(', ') || 'none';
    err(
      `Expected exactly 8 recommendation block starts under "## Top 8 Recommendations", ` +
      `but found ${blocks.length} (numbers: ${nums}).\n` +
      `  Each block must start with the pattern "**N. Title**" on its own line, numbered 1–8.`
    );
  }

  // --- (b) Numbers must be unique and consecutive 1..8. ---
  const numbers = blocks.map(b => b.number);
  const seen = new Set();
  const dupes = [];
  for (const n of numbers) {
    if (seen.has(n)) dupes.push(n);
    else seen.add(n);
  }
  if (dupes.length > 0) {
    const dupeList = [...new Set(dupes)].sort((a, b) => a - b).join(', ');
    err(
      `Duplicate recommendation numbers found: ${dupeList}. ` +
      `Block numbers must be unique 1–8.`
    );
  }
  for (let n = 1; n <= 8; n++) {
    if (!seen.has(n)) {
      err(`Recommendation number ${n} is missing; blocks must be numbered consecutively 1–8.`);
    }
  }
  const outOfRange = numbers.filter(n => n < 1 || n > 8);
  if (outOfRange.length > 0) {
    const oobList = [...new Set(outOfRange)].sort((a, b) => a - b).join(', ');
    err(`Recommendation numbers outside 1–8 found: ${oobList}.`);
  }

  // --- (c) Each block: exactly one Impact:, Evidence:, Next action:, in order. ---
  for (let b = 0; b < blocks.length; b++) {
    const blockStart = blocks[b].index;
    const blockEnd = (b + 1 < blocks.length) ? blocks[b + 1].index : recLines.length;
    const block = recLines.slice(blockStart, blockEnd);
    const recNum = blocks[b].number;
    const blockTitle = blocks[b].title;
    const lineOffset = blocks[b].line;

    let impactCount = 0, evidenceCount = 0, nextActionCount = 0;
    const fieldOrder = [];
    for (const line of block) {
      if (/^\s*Impact:/.test(line)) { impactCount++; fieldOrder.push('Impact'); }
      if (/^\s*Evidence:/.test(line)) { evidenceCount++; fieldOrder.push('Evidence'); }
      if (/^\s*Next action:/.test(line)) { nextActionCount++; fieldOrder.push('Next action'); }
    }

    if (impactCount !== 1) {
      err(`Recommendation ${recNum} ("${blockTitle}") has ${impactCount} "Impact:" line(s), expected exactly 1`, lineOffset);
    }
    if (evidenceCount !== 1) {
      err(`Recommendation ${recNum} ("${blockTitle}") has ${evidenceCount} "Evidence:" line(s), expected exactly 1`, lineOffset);
    }
    if (nextActionCount !== 1) {
      err(`Recommendation ${recNum} ("${blockTitle}") has ${nextActionCount} "Next action:" line(s), expected exactly 1`, lineOffset);
    }

    // Field ordering: Impact → Evidence → Next action (only checkable when one of each).
    if (impactCount === 1 && evidenceCount === 1 && nextActionCount === 1) {
      const expected = ['Impact', 'Evidence', 'Next action'];
      for (let f = 0; f < expected.length; f++) {
        if (fieldOrder[f] !== expected[f]) {
          err(
            `Recommendation ${recNum} ("${blockTitle}"): field order is [${fieldOrder.join(', ')}], ` +
            `expected [${expected.join(', ')}]`,
            lineOffset
          );
          break; // One ordering error per block is enough.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: node scripts/validate-pm-result-contract.js <path-to-result.md>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const lines = readLines(filePath);

  // -- Check 1: opening line --
  checkOpening(lines);

  // -- Check 2: sections and ordering --
  checkSections(lines);

  // -- Check 3 & 4: recommendation blocks --
  checkRecommendations(lines);

  // -- Report --
  console.log(`File: ${filePath}`);
  console.log(`Contract: PM assessment six-section report (${REQUIRED_SECTIONS.length} sections, 8 recs)`);
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
