#!/usr/bin/env node
// Project Space Commit Verification — focused wrapper around the History smoke.
//
// The underlying History smoke seeds both a reviewed-merge commit and a local
// rollback commit, then verifies verified/unverified local provenance in the
// backend contract and browser UI.
"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const script = path.join(__dirname, "smoke-project-space-history.js");
const child = spawnSync(process.execPath, [script], {
  stdio: "inherit",
  env: {
    ...process.env,
    HISTORY_SMOKE_ARTIFACT_DIR: "project-space-commit-verification-smoke",
    HISTORY_SMOKE_COMMAND_LABEL: "node scripts/smoke-project-space-commit-verification.js",
  },
});

if (child.error) {
  console.error(child.error);
  process.exit(1);
}

process.exit(child.status == null ? 1 : child.status);
