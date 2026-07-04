#!/usr/bin/env bash
# Generate a concrete executor keepalive config (launchd plist on macOS,
# systemd unit on Linux) from the templates, filled with your platform URL,
# agent key, and local paths.
#
# Usage:
#   ./generate-executor-config.sh <agent-type> --base-url <url> --key <agent-key>
#       [--label <name>] [--install]
#
# agent-type: codex | kimi | mimo | gemini | aider  (determines wrapper + env var name)
# --install:  macOS loads the plist into launchd; Linux copies to /etc/systemd
#
# Example:
#   ./generate-executor-config.sh kimi \
#       --base-url http://192.168.1.10:18080/agent \
#       --key <agent-key>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZZ_AGENT_HOME="${ZZ_AGENT_HOME:-$HOME/.zz-agent}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || command -v python)}"

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \?//'
  exit 1
}

[ $# -ge 1 ] || usage
AGENT_TYPE="$1"; shift

BASE_URL=""; KEY=""; LABEL=""; INSTALL=0; PROJECT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
    --project-dir) PROJECT_DIR="$2"; shift 2;;
    --install) INSTALL=1; shift;;
    *) echo "Unknown option: $1"; usage;;
  esac
done

[ -n "$BASE_URL" ] || { echo "ERROR: --base-url is required"; exit 1; }
[ -n "$KEY" ] || { echo "ERROR: --key is required"; exit 1; }

# Per-agent-type configuration: wrapper script + env var name holding the key.
case "$AGENT_TYPE" in
  codex) WRAPPER="codex-pm-executor-wrapper.py"; ENV_VAR="ZZ_IDENTITY_PATH";;
  kimi)  WRAPPER="kimi-worker-executor-wrapper.py"; ENV_VAR="KIMI_AGENT_KEY";;
  mimo)  WRAPPER="mimo-worker-executor-wrapper.py"; ENV_VAR="MIMO_AGENT_KEY";;
  gemini) WRAPPER="gemini-worker-executor-wrapper.py"; ENV_VAR="GEMINI_AGENT_KEY";;
  aider) WRAPPER="aider-worker-executor-wrapper.py"; ENV_VAR="AIDER_AGENT_KEY";;
  *) echo "ERROR: unknown agent-type '$AGENT_TYPE' (use codex|kimi|mimo|gemini|aider)"; exit 1;;
esac

LABEL="${LABEL:-com.zz-agent.${AGENT_TYPE}-executor}"
# Working directory for the executor: the project repo root, so the agent
# operates on real code. Defaults to the current directory.
PROJECT_DIR="${PROJECT_DIR:-$(pwd)}"
mkdir -p "$ZZ_AGENT_HOME"

fill() {
  # $1 = template path. Reads stdin-free; emits filled file to stdout.
  sed \
    -e "s|{{ZZ_BASE_URL}}|$BASE_URL|g" \
    -e "s|{{AGENT_KEY}}|$KEY|g" \
    -e "s|{{PYTHON}}|$PYTHON_BIN|g" \
    -e "s|{{ZZ_AGENT_HOME}}|$ZZ_AGENT_HOME|g" \
    -e "s|{{LABEL}}|$LABEL|g" \
    -e "s|{{WRAPPER}}|$WRAPPER|g" \
    -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
    -e "s|{{HOME}}|$HOME|g" \
    "$1"
}

case "$(uname -s)" in
  Darwin)
    OUT="$ZZ_AGENT_HOME/${LABEL}.plist"
    fill "$SCRIPT_DIR/com.zz-agent.${AGENT_TYPE}-executor.plist.template" > "$OUT" 2>/dev/null \
      || fill "$SCRIPT_DIR/com.zz-agent.kimi-executor.plist.template" > "$OUT"
    echo "Generated: $OUT"
    if [ "$INSTALL" -eq 1 ]; then
      launchctl unload "$OUT" 2>/dev/null || true
      launchctl load "$OUT"
      echo "Loaded into launchd (KeepAlive enabled)."
    fi
    # macOS: the agent binary needs Full Disk Access to read files under
    # ~/Documents etc. Without it, the agent hangs on a TCC prompt that no
    # one can dismiss when running under launchd. Guide a one-time grant.
    case "$AGENT_TYPE" in
      kimi) AGENT_BIN="${KIMI_BIN:-$HOME/.kimi-code/bin/kimi}";;
      mimo) AGENT_BIN="${MIMO_BIN:-$HOME/.mimocode/bin/mimo}";;
      codex) AGENT_BIN="${CODEX_BIN:-/Applications/Codex.app/Contents/Resources/codex}";;
      *) AGENT_BIN="";;
    esac
    if [ -n "$AGENT_BIN" ] && [ -x "$AGENT_BIN" ]; then
      echo ""
      echo "── macOS permission (one-time) ──"
      echo "The $AGENT_TYPE binary needs Full Disk Access to read project files."
      echo "Opening System Settings > Privacy & Security > Full Disk Access..."
      open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
      sleep 1
      # Reveal the binary in Finder so the user can drag it into the list.
      open -R "$AGENT_BIN" 2>/dev/null
      echo ""
      echo "Steps:"
      echo "  1. Drag '$AGENT_BIN' (shown in Finder) into the Full Disk Access list."
      echo "  2. Ensure its toggle is ON."
      echo "  3. If you changed the plist (--install), restart the executor so the"
      echo "     grant takes effect:"
      echo "       launchctl unload $OUT && launchctl load $OUT"
      echo ""
      echo "After this one-time grant, $AGENT_TYPE runs without prompts."
    fi
    ;;
  Linux)
    OUT="$ZZ_AGENT_HOME/${LABEL}.service"
    fill "$SCRIPT_DIR/zz-agent-executor.service.template" > "$OUT"
    # Replace the generic AGENT_KEY env var with the type-specific name.
    sed -i "s|Environment=AGENT_KEY=|Environment=${ENV_VAR}=|" "$OUT"
    echo "Generated: $OUT"
    if [ "$INSTALL" -eq 1 ]; then
      sudo cp "$OUT" "/etc/systemd/system/${LABEL}.service"
      sudo systemctl daemon-reload
      sudo systemctl enable --now "$LABEL"
      echo "Installed and started via systemd."
    fi
    ;;
  *)
    echo "Platform $(uname -s) not supported by this generator."
    echo "Run the executor manually: $PYTHON_BIN $ZZ_AGENT_HOME/$WRAPPER"
    exit 1
    ;;
esac

echo ""
echo "Agent type:  $AGENT_TYPE"
echo "Wrapper:     $ZZ_AGENT_HOME/$WRAPPER"
echo "Base URL:    $BASE_URL"
echo ""
echo "Make sure the handler scripts are copied to $ZZ_AGENT_HOME/:"
echo "  cp $SCRIPT_DIR/*.py $ZZ_AGENT_HOME/"
