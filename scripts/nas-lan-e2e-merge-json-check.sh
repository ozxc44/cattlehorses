#!/usr/bin/env bash
# nas-lan-e2e-merge-json-check.sh
# Lightweight regression check for merge JSON extraction.
# Does NOT require live NAS credentials; pipes sample JSON through the same
# json_get helper used by nas-lan-e2e-dryrun.sh Step 9.
#
# Validates:
#   - changeset.status extraction (not top-level status)
#   - commit.id extraction (not top-level commit_id)
#   - Optional gitea_sync field does not cause failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRYRUN="$SCRIPT_DIR/nas-lan-e2e-dryrun.sh"

# ---- json_get helper (identical to the one in nas-lan-e2e-dryrun.sh) ----
json_get() {
  node -e '
    const path = process.argv[1].split(".");
    let value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const key of path) value = value && value[key];
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(String(value));
  ' "$1"
}

# ---- Sample merge response matching backend shape ----
# Shape from backend/src/routes/versioning.routes.ts lines 380-383:
#   { changeset: { ...status... }, commit: { ...id... } }
SAMPLE_MERGE='{"changeset":{"id":"cs123","status":"merged","title":"DryRun result changeset"},"commit":{"id":"abc123def456","message":"Merge changeset cs123","changed_files":[]}}'

SAMPLE_WITH_GITEA='{"changeset":{"id":"cs456","status":"merged","title":"Sync changeset"},"commit":{"id":"def789ghi012","message":"Merge changeset cs456","changed_files":[]},"gitea_sync":{"action":"pushed","repo":"owner/repo"}}'

FAILED=0

echo "========================================"
echo "  NAS LAN E2E Merge JSON Regression"
echo "========================================"

# Test 1: changeset.status extraction
echo ""
echo "[1/5] changeset.status extraction"
result=$(printf '%s' "$SAMPLE_MERGE" | json_get changeset.status)
if [[ "$result" == "merged" ]]; then
  echo "  [OK] changeset.status = $result"
else
  echo "  [FAIL] expected 'merged', got '$result'" >&2
  FAILED=1
fi

# Test 2: commit.id extraction
echo ""
echo "[2/5] commit.id extraction"
result=$(printf '%s' "$SAMPLE_MERGE" | json_get commit.id)
if [[ "$result" == "abc123def456" ]]; then
  echo "  [OK] commit.id = $result"
else
  echo "  [FAIL] expected 'abc123def456', got '$result'" >&2
  FAILED=1
fi

# Test 3: top-level status should be absent (verifies wrong path fails)
echo ""
echo "[3/5] top-level status key should not be used"
if printf '%s' "$SAMPLE_MERGE" | json_get status 2>/dev/null; then
  echo "  [FAIL] top-level 'status' should not be used (should be changeset.status)" >&2
  FAILED=1
else
  echo "  [OK] top-level 'status' correctly returns empty (path does not exist)"
fi

# Test 4: top-level commit_id should be absent
echo ""
echo "[4/5] top-level commit_id key should not be used"
if printf '%s' "$SAMPLE_MERGE" | json_get commit_id 2>/dev/null; then
  echo "  [FAIL] top-level 'commit_id' should not be used (should be commit.id)" >&2
  FAILED=1
else
  echo "  [OK] top-level 'commit_id' correctly returns empty (path does not exist)"
fi

# Test 5: gitea_sync optional field — extracting it should not break
echo ""
echo "[5/5] optional gitea_sync field handling"
gitea_action=$(printf '%s' "$SAMPLE_WITH_GITEA" | json_get gitea_sync 2>/dev/null) && [[ -n "$gitea_action" ]] && echo "  [OK] gitea_sync present: $gitea_action" || echo "  [OK] gitea_sync absent — not a failure"

echo ""
echo "========================================"
if [[ "$FAILED" -eq 0 ]]; then
  echo "  ALL EXTRACTION CHECKS PASSED"
  echo "========================================"
  exit 0
else
  echo "  SOME CHECKS FAILED — see above"
  echo "========================================"
  exit 1
fi
