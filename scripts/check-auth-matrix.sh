#!/usr/bin/env bash
# check-auth-matrix.sh — Lightweight maintainer script to verify that
# docs/auth-permission-matrix.md covers the routes defined in backend/src/routes.
#
# Usage:
#   bash scripts/check-auth-matrix.sh
#   bash scripts/check-auth-matrix.sh --verbose

set -euo pipefail

MATRIX="docs/auth-permission-matrix.md"
ROUTES_DIR="backend/src/routes"
VERBOSE=0

if [[ "${1:-}" == "--verbose" ]]; then
  VERBOSE=1
fi

if [[ ! -f "$MATRIX" ]]; then
  echo "[ERROR] Matrix file not found: $MATRIX"
  exit 1
fi

if [[ ! -d "$ROUTES_DIR" ]]; then
  echo "[ERROR] Routes directory not found: $ROUTES_DIR"
  exit 1
fi

TMP_ROUTES=$(mktemp)
TMP_MATRIX=$(mktemp)

trap 'rm -f "$TMP_ROUTES" "$TMP_MATRIX"' EXIT

# Extract route strings from backend route files.
# We look for any quoted string starting with /v1/ in the routes directory.
grep -rohE "['\"/]v1/[^'\"\`]+" "$ROUTES_DIR" \
  | sed "s/^[\"']//" \
  | grep -E '^/v1/' \
  | sed -E 's/\?[a-zA-Z0-9_&=]+//g' \
  | sed -E 's/:[a-zA-Z0-9_]+/{placeholder}/g' \
  | sort -u > "$TMP_ROUTES"

# Extract route strings from the matrix markdown.
# Matches backtick-wrapped /v1/... strings in table rows.
grep -oE '\| `/v1/[^`]+`' "$MATRIX" \
  | sed -E "s/\| \`([^\`]+)\`/\1/" \
  | sed -E 's/\{[a-zA-Z0-9_]+\}/{placeholder}/g' \
  | sort -u > "$TMP_MATRIX"

MISSING=0
while IFS= read -r route; do
  # route already normalized to {placeholder}
  if grep -qF "$route" "$TMP_MATRIX"; then
    [[ "$VERBOSE" -eq 1 ]] && echo "[OK]   $route"
  else
    echo "[MISSING] $route (in code, not in matrix)"
    MISSING=$((MISSING + 1))
  fi
done < "$TMP_ROUTES"

EXTRA=0
while IFS= read -r route; do
  if grep -qF "$route" "$TMP_ROUTES"; then
    true
  else
    echo "[EXTRA] $route (in matrix, not found in code)"
    EXTRA=$((EXTRA + 1))
  fi
done < "$TMP_MATRIX"

echo ""
echo "Summary:"
echo "  Routes in code:      $(wc -l < "$TMP_ROUTES" | tr -d ' ')"
echo "  Routes in matrix:    $(wc -l < "$TMP_MATRIX" | tr -d ' ')"
echo "  Missing from matrix: $MISSING"
echo "  Extra in matrix:     $EXTRA"

if [[ "$MISSING" -gt 0 ]] || [[ "$EXTRA" -gt 0 ]]; then
  echo ""
  echo "Run with --verbose to see matched routes."
  exit 1
fi

echo "All routes are covered."
