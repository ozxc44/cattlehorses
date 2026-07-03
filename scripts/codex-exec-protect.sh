#!/bin/bash
# ============================================================================
# scripts/codex-exec-protect.sh — Safe Codex exec wrapper with artifact protection
#
# Prevents `codex exec -o <path>` from overwriting durable artifacts that a
# worker agent wrote to <path> during execution.
#
# Usage (as a drop-in replacement for `codex` in PATH):
#   codex exec -o taskdir/result.md -m gpt-5.5 < task.md
#
# Mechanism:
#   1. Detect `-o <path>` and change it to `-o <path>.codex-wrapper.md`
#   2. Record the pre-execution state of <path> (exists? size?)
#   3. Run the real Codex CLI
#   4. After completion:
#      a. If <path> exists and has substantive content (written by the agent
#         during execution), preserve it as the durable artifact.
#      b. If <path> is empty/missing/trivial, copy <path>.codex-wrapper.md
#         to <path> for backward compatibility.
#      c. Always keep <path>.codex-wrapper.md for debugging/review.
#
# ============================================================================
set -euo pipefail

REAL_CODEX="${CODEX_EXEC_PROTECT_REAL_CODEX:-/Applications/Codex.app/Contents/Resources/codex}"
if [ ! -x "$REAL_CODEX" ]; then
    # Fallback: resolve from PATH
    REAL_CODEX="$(command -v codex 2>/dev/null || true)"
    if [ -z "$REAL_CODEX" ] || [ ! -x "$REAL_CODEX" ]; then
        echo "ERROR: codex binary not found" >&2
        exit 1
    fi
fi

# Prevent recursion if this script is invoked as 'codex'
if [ "${CODEX_EXEC_PROTECT_ACTIVE:-}" = "1" ]; then
    exec "$REAL_CODEX" "$@"
fi
export CODEX_EXEC_PROTECT_ACTIVE=1

# ─── Parse arguments ──────────────────────────────────────────────────────────
# We need to find `-o <path>` (or `--output-last-message <path>`) and
# determine if it points to a file that should be protected.

args=("$@")
modify_idx=-1
output_path=""
wrap_path=""
modified_args=()

i=0
while [ $i -lt "${#args[@]}" ]; do
    arg="${args[$i]}"
    if [ "$arg" = "-o" ] || [ "$arg" = "--output-last-message" ]; then
        if [ $((i + 1)) -lt "${#args[@]}" ]; then
            output_path="${args[$((i + 1))]}"
            output_dir="$(dirname "$output_path")"
            output_base="$(basename "$output_path")"
            wrap_path="${output_dir}/.${output_base}.codex-wrapper.md"
            modify_idx=$i
            # Forward the output flag to the real Codex CLI, but point it at a
            # temporary wrapper path so the user's durable artifact path cannot
            # be overwritten by the final summary.
            args[$((i + 1))]="$wrap_path"
            modified_args+=("$arg" "$wrap_path")
            i=$((i + 2))
            continue
        fi
    fi
    modified_args+=("$arg")
    i=$((i + 1))
done

# ─── Snapshot pre-execution state ─────────────────────────────────────────────
if [ -n "$output_path" ]; then
    if [ -f "$output_path" ]; then
        pre_size=$(wc -c < "$output_path" 2>/dev/null || echo 0)
        pre_lines=$(wc -l < "$output_path" 2>/dev/null || echo 0)
        # Save a backup
        cp "$output_path" "${output_path}.pre.bak" 2>/dev/null || true
    else
        pre_size=0
        pre_lines=0
    fi
fi

# ─── Run real codex ──────────────────────────────────────────────────────────
set +e
"$REAL_CODEX" "${modified_args[@]}"
EXIT_CODE=$?
set -e

# ─── Post-execution: protect artifacts ───────────────────────────────────────
if [ -n "$output_path" ] && [ -n "$wrap_path" ]; then
    # Determine if result.md has substantive content (agent artifact)
    if [ -f "$output_path" ]; then
        post_size=$(wc -c < "$output_path" 2>/dev/null || echo 0)
        post_lines=$(wc -l < "$output_path" 2>/dev/null || echo 0)
    else
        post_size=0
        post_lines=0
    fi

    # Heuristic: a "substantive" artifact is > 5 lines or > 500 bytes.
    # This catches real agent-written artifacts and distinguishes from
    # empty/new files or trivial CLIs.
    SUBSTANTIVE_THRESHOLD_LINES=5
    SUBSTANTIVE_THRESHOLD_BYTES=500

    if [ "$post_size" -gt "$SUBSTANTIVE_THRESHOLD_BYTES" ] || [ "$post_lines" -gt "$SUBSTANTIVE_THRESHOLD_LINES" ]; then
        # result.md has substantive content — the agent wrote a durable artifact.
        # Preserve it and append a note about the clean wrapper output path.
        echo "" >> "$output_path"
        echo "---" >> "$output_path"
        echo "_Codex wrapper output saved at \`${output_base}.wrapper.md\`_" >> "$output_path"
    else
        # No durable artifact — copy the wrapper output to result.md for
        # backward compatibility (non-Codex workers, or tasks where the agent
        # didn't produce a separate result.md artifact).
        if [ -f "$wrap_path" ]; then
            cp "$wrap_path" "$output_path"
        fi
    fi

    # Always save the wrapper output with a clean name for debugging
    wrapper_saved="${output_dir}/${output_base}.wrapper.md"
    if [ -f "$wrap_path" ]; then
        cp "$wrap_path" "$wrapper_saved" 2>/dev/null || true
    fi

    # Clean up temp files
    rm -f "${output_path}.pre.bak" 2>/dev/null || true
    # Remove the dotfile wrapper (clean name already saved above)
    rm -f "$wrap_path" 2>/dev/null || true
fi

exit $EXIT_CODE
