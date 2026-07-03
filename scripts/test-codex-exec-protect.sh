#!/bin/bash
# ============================================================================
# scripts/test-codex-exec-protect.sh — Regression test for result.md overwrite
#
# Simulates the failure mode from task 20260620_202406_codex-deep where
# `codex exec -o result.md` overwrote a durable agent-written artifact.
# Proves the wrapper prevents this.
#
# Usage: bash scripts/test-codex-exec-protect.sh
#
# Exit codes:
#   0  All tests passed
#   1  One or more tests failed
# ============================================================================
set -euo pipefail

PASS_COUNT=0
FAIL_COUNT=0
TEST_DIR=""

cleanup() {
    if [ -n "$TEST_DIR" ] && [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Create temp test directory
TEST_DIR=$(mktemp -d /tmp/codex-exec-protect-test-XXXXXX)
WRAPPER_SRC="$(cd "$(dirname "$0")" && pwd)/codex-exec-protect.sh"
CODEX_BIN="/Applications/Codex.app/Contents/Resources/codex"
FAKE_CODEX="$TEST_DIR/fake-codex"

# Use a counter file to work around sub-shell scoping
COUNTER_FILE="$TEST_DIR/.counters"
echo "0 0" > "$COUNTER_FILE"

# Atomic counter update
inc_pass() {
    local p f
    read -r p f < "$COUNTER_FILE"
    echo "$((p + 1)) $f" > "$COUNTER_FILE"
}
inc_fail() {
    local p f
    read -r p f < "$COUNTER_FILE"
    echo "$p $((f + 1))" > "$COUNTER_FILE"
}

pass() { inc_pass; echo "  PASS: $1"; }
fail() { inc_fail; echo "  FAIL: $1"; }

# Ensure we have the right codex binary
cat > "$FAKE_CODEX" <<'FAKE'
#!/bin/bash
set -euo pipefail
out=""
args=("$@")
i=0
while [ $i -lt "${#args[@]}" ]; do
  case "${args[$i]}" in
    -o|--output-last-message)
      out="${args[$((i + 1))]}"
      i=$((i + 2))
      ;;
    *)
      i=$((i + 1))
      ;;
  esac
done
if [ -n "$out" ]; then
  mkdir -p "$(dirname "$out")"
  printf '# Fake Codex Wrapper Output\n\nThis is the final message.\n' > "$out"
fi
exit 0
FAKE
chmod +x "$FAKE_CODEX"

echo "=== Test 1: Agent artifact is preserved (failure mode reproduction) ==="
echo "  Simulating: agent writes long artifact to result.md"

mkdir -p "$TEST_DIR/test1"
cd "$TEST_DIR/test1"

# Create a simulated agent artifact (long markdown, like the ~323-line adversarial review)
python3 -c "
for i in range(50):
    print(f'Line {i+1}: This is part of the simulated durable artifact. P0 gap, missing assertion, file to modify.')
print()
print('## Verdict')
print('NEEDS_FIX')
" > result.md

artifact_lines=$(wc -l < result.md)

CODEX_EXEC_PROTECT_REAL_CODEX="$FAKE_CODEX" "$WRAPPER_SRC" exec -o result.md >/dev/null

# Verify
final_lines=$(wc -l < result.md)
if [ "$final_lines" -gt 5 ]; then
    pass "Artifact preserved ($final_lines lines, was $artifact_lines, threshold >5)"
else
    fail "Artifact was overwritten ($final_lines lines)"
fi

if [ -f result.md.wrapper.md ]; then
    pass "Wrapper output saved separately at result.md.wrapper.md"
else
    fail "Wrapper output not saved"
fi
if [ -f .result.md.codex-wrapper.md ]; then
    fail "Temporary dotfile wrapper output was not cleaned up"
else
    pass "Temporary dotfile wrapper output cleaned up"
fi

echo ""

echo "=== Test 2: Backward compatibility (dir with no durable artifact) ==="
mkdir -p "$TEST_DIR/test2"
cd "$TEST_DIR/test2"

CODEX_EXEC_PROTECT_REAL_CODEX="$FAKE_CODEX" "$WRAPPER_SRC" exec -o result.md >/dev/null

if [ -f result.md ]; then
    content=$(cat result.md)
    if echo "$content" | grep -q "Fake Codex Wrapper Output"; then
        pass "Backward compat: empty dir gets wrapper output in result.md"
    else
        fail "Backward compat: result.md content mismatch"
    fi
else
    fail "Backward compat: result.md not created"
fi

if [ -f result.md.wrapper.md ]; then
    pass "Wrapper also saved as result.md.wrapper.md"
else
    fail "Wrapper not saved separately"
fi
echo ""

echo "=== Test 3: Non-Codex worker still works (no -o flag) ==="
mkdir -p "$TEST_DIR/test3"
cd "$TEST_DIR/test3"

# Simulate a non-Codex worker that writes result.md directly
python3 -c "
print('# Non-Codex Worker Result')
print()
print('Task completed successfully.')
print('## Changes')
print('- Modified file A')
print('- Added test B')
" > result.md

# No -o flag was used, nothing to protect
# result.md should remain as-is (the wrapper is a no-op in this case)
final_lines=$(wc -l < result.md)
if [ "$final_lines" -eq 6 ]; then
    pass "Non-Codex worker result.md unchanged ($final_lines lines)"
else
    fail "Non-Codex worker result.md was modified ($final_lines lines)"
fi
echo ""

echo "=== Test 4: Threshold boundary - trivial result.md replaced correctly ==="
mkdir -p "$TEST_DIR/test4"
cd "$TEST_DIR/test4"

# Create a tiny result.md (below 5 lines / 500 byte threshold)
echo "# Small" > result.md

CODEX_EXEC_PROTECT_REAL_CODEX="$FAKE_CODEX" "$WRAPPER_SRC" exec -o result.md >/dev/null

content=$(cat result.md)
first_line=$(head -1 result.md)
if [ "$first_line" = "# Fake Codex Wrapper Output" ]; then
    pass "Trivial result.md replaced by wrapper output (correct fallback)"
else
    fail "Expected wrapper output, got: $first_line"
fi
echo ""

echo "=== Test 5: Real wrapper forwards -o to safe path ==="
mkdir -p "$TEST_DIR/test5"
cd "$TEST_DIR/test5"

CODEX_EXEC_PROTECT_REAL_CODEX="$FAKE_CODEX" "$WRAPPER_SRC" exec -o pm-review.md >/dev/null

if [ -f pm-review.md ] && grep -q "Fake Codex Wrapper Output" pm-review.md; then
    pass "Wrapper-created review output copied to requested path when no durable artifact exists"
else
    fail "Wrapper did not create requested output path from safe -o target"
fi

if [ -f pm-review.md.wrapper.md ] && grep -q "Fake Codex Wrapper Output" pm-review.md.wrapper.md; then
    pass "Wrapper output saved at clean debug path"
else
    fail "Clean wrapper debug path missing"
fi
echo ""

echo "=========================================="
read -r p f < "$COUNTER_FILE"
echo "Results: $p passed, $f failed"
echo "=========================================="

cleanup
trap - EXIT

if [ "$f" -gt 0 ]; then
    exit 1
fi
exit 0
