#!/usr/bin/env bash
# Rollback zhuzeyang-agent to a previous release.
#
# Releases are expected under:
#   /opt/zz-agent-v1/releases/<timestamp>-<name>/
# with a symlink  /opt/zz-agent-v1/current ->  .../releases/<active-release>/
# and systemd unit zz-agent-v1.service for the current cloud deployment.
#
# Usage:
#   bash deploy/rollback.sh                     # interactive — pick from list
#   bash deploy/rollback.sh --list               # list available releases
#   bash deploy/rollback.sh <release-dir-name>   # rollback to named release
#   bash deploy/rollback.sh --revert-migration    # rollback + revert last migration

set -euo pipefail

ORIGINAL_ARGS=("$@")

readonly DEPLOY_DIR="${DEPLOY_DIR:-/opt/zz-agent-v1}"
readonly RELEASES_DIR="${RELEASES_DIR:-${DEPLOY_DIR}/releases}"
readonly CURRENT_LINK="${CURRENT_LINK:-${DEPLOY_DIR}/current}"
readonly SERVICE_NAME="${SERVICE_NAME:-zz-agent-v1}"
readonly BACKEND_DIR="${BACKEND_DIR:-$(cd "$(dirname "$0")/../backend" && pwd)}"

PASS=0
FAIL=0
REVERT_MIGRATION=false
TARGET=""

pass() { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

die_usage() {
  echo "Usage: $0 [--list | --revert-migration | <release-dir>]"
  echo ""
  echo "  --list               List available releases and exit"
  echo "  --revert-migration   Also revert the last TypeORM migration"
  echo "  <release-dir>        Roll back to this release (basename, e.g. 20260527-patch-1)"
  echo "  (no args)            Interactive — prompts for target from list"
  exit 1
}

list_releases() {
  if [[ ! -d "$RELEASES_DIR" ]]; then
    echo "No releases directory found at $RELEASES_DIR" >&2
    return 1
  fi
  echo "Available releases in $RELEASES_DIR:"
  echo ""
  local dirs=()
  mapfile -d '' dirs < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
  if [[ ${#dirs[@]} -eq 0 ]]; then
    echo "  (no releases found)"
    return 1
  fi
  local dir
  for dir in "${dirs[@]}"; do
    local name
    name="$(basename "$dir")"
    if [[ "$(readlink -f "$CURRENT_LINK")" == "$(readlink -f "$dir")" ]]; then
      printf "  %s  [current]\n" "$name"
    else
      printf "  %s\n" "$name"
    fi
  done
}

resolve_target() {
  local target="$1"
  local resolved="$RELEASES_DIR/$target"
  if [[ -d "$resolved" ]]; then
    echo "$resolved"
    return 0
  fi
  # Try matching partial prefix
  local match
  match="$(find "$RELEASES_DIR" -maxdepth 1 -type d -name "${target}*" | head -1)"
  if [[ -n "$match" ]]; then
    echo "$match"
    return 0
  fi
  return 1
}

# ---- arg parse -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)            list_releases; exit 0 ;;
    --revert-migration) REVERT_MIGRATION=true; shift ;;
    --help|-h)         die_usage ;;
    *)                 TARGET="$1"; shift ;;
  esac
done

# ---- pre-flight ------------------------------------------------------------
echo "============================================"
echo "  ZZ Agent — Rollback"
echo "  DEPLOY_DIR:    $DEPLOY_DIR"
echo "  RELEASES_DIR:  $RELEASES_DIR"
echo "  SERVICE:       $SERVICE_NAME"
echo "============================================"
echo ""

# Ensure script is run as root or with sudo.
if [[ $EUID -ne 0 ]]; then
  # Re-exec if available
  if command -v sudo >/dev/null 2>&1; then
    exec sudo "$0" "${ORIGINAL_ARGS[@]}"
  fi
  fail "this script must be run as root (or via sudo) to manage systemd and $DEPLOY_DIR"
  echo "  Usage: sudo bash deploy/rollback.sh ..."
  exit 1
fi

# ---- interactive target selection ------------------------------------------
if [[ -z "$TARGET" ]]; then
  if ! list_releases; then
    exit 1
  fi
  echo ""
  # Pick the second-most-recent (previous) release automatically.
  current="$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")"
  previous=""
  release_dirs=()
  mapfile -d '' release_dirs < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
  for dir in "${release_dirs[@]}"; do
    dir="$(readlink -f "$dir")"
    if [[ "$dir" != "$current" ]]; then
      previous="$dir"
    fi
  done
  if [[ -z "$previous" ]]; then
    fail "no previous release found (only one release or no current symlink)"
    exit 1
  fi
  TARGET="$(basename "$previous")"
  echo "Auto-selected previous release: $TARGET"
  echo "Press Ctrl-C within 5 s to cancel, or Enter to proceed."
  read -r -t 5 || true
fi

# ---- resolve target --------------------------------------------------------
TARGET_DIR="$(resolve_target "$TARGET")"
if [[ -z "$TARGET_DIR" ]]; then
  fail "release not found: $TARGET"
  echo "Run '$0 --list' to see available releases." >&2
  exit 1
fi

echo "Target release: $(basename "$TARGET_DIR")"
echo "Target path:    $TARGET_DIR"
echo ""

# ---- stop service ----------------------------------------------------------
echo "--- [1/4] stopping $SERVICE_NAME ---"
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl stop "$SERVICE_NAME" && pass "service stopped" || fail "stop failed"
else
  pass "service not running"
fi

# ---- switch symlink --------------------------------------------------------
echo ""
echo "--- [2/4] updating current symlink ---"
if [[ -L "$CURRENT_LINK" ]]; then
  rm -f "$CURRENT_LINK"
fi
ln -sf "$TARGET_DIR" "$CURRENT_LINK" && pass "symlink -> $TARGET_DIR" || fail "symlink failed"

# ---- revert migration (optional) -------------------------------------------
if $REVERT_MIGRATION; then
  echo ""
  echo "--- [3/4] reverting last migration ---"
  if [[ -d "${CURRENT_LINK}/backend" ]]; then
    pushd "${CURRENT_LINK}/backend" >/dev/null
    if [[ -f package.json ]]; then
      npm run migration:revert 2>&1 | tail -5 && pass "migration reverted" || fail "migration revert"
    else
      fail "no package.json in target backend"
    fi
    popd >/dev/null
  else
    fail "target release has no backend/ directory"
  fi
else
  echo ""
  echo "--- [3/4] migration revert skipped (use --revert-migration to revert) ---"
fi

# ---- start service ---------------------------------------------------------
echo ""
echo "--- [4/4] starting $SERVICE_NAME ---"
systemctl daemon-reload
systemctl start "$SERVICE_NAME" && pass "service started" || fail "start failed"

# ---- verify ----------------------------------------------------------------
echo ""
echo "--- verification ---"
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  pass "$SERVICE_NAME is active"
else
  fail "$SERVICE_NAME is not active — check 'systemctl status $SERVICE_NAME'"
fi

PUBLIC_URL="${PUBLIC_URL:-https://www.zhuzeyang.xyz/agent}"
if curl -fsS -o /dev/null -w "HTTP %{http_code}\n" "${PUBLIC_URL%/}/v1/health" 2>&1; then
  pass "health endpoint at $PUBLIC_URL/v1/health"
else
  fail "health endpoint unreachable"
fi

echo ""
echo "============================================"
echo "  Rollback complete: $(basename "$TARGET_DIR")"
echo "  Results: $PASS passed, $FAIL failed"
echo "============================================"
echo ""
echo "Post-rollback notes:"
echo "  1. Verify all routes:  curl $PUBLIC_URL/v1/health"
echo "  2. Run smoke:          ALLOW_REMOTE_VERIFY=1 BASE_URL=$PUBLIC_URL bash deploy/smoke.sh"
echo "  3. If migration was reverted, data written after the rolled-back"
echo "     release may be incompatible — coordinate with the team."
echo "  4. Check logs:         journalctl -u $SERVICE_NAME -n 50 --no-pager"

exit $(( FAIL > 0 ? 1 : 0 ))
