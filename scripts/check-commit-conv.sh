#!/usr/bin/env bash
set -euo pipefail

# Conventional Commits validator
# Usage: check-commit-conv.sh [N]  (default N=10)

N="${1:-10}"
VALID_TYPES="feat|fix|docs|style|refactor|perf|test|chore|ci|build"
PATTERN="^(${VALID_TYPES})(\(.+\))?!?: .+"

fail_count=0
total=0

while IFS= read -r line; do
  hash="${line%% *}"
  msg="${line#* }"
  total=$((total + 1))

  if [[ "$msg" =~ $PATTERN ]]; then
    echo "PASS  $hash  $msg"
  else
    echo "FAIL  $hash  $msg"
    fail_count=$((fail_count + 1))
  fi
done < <(git log --oneline -"$N")

echo ""
echo "Checked $total commits, $fail_count failed."

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
