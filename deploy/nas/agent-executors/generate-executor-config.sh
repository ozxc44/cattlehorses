#!/usr/bin/env bash
# Generate a concrete executor keepalive config (launchd plist on macOS,
# systemd unit on Linux) from the templates, filled with your platform URL,
# agent key, and local paths.
#
# Usage:
#   ./generate-executor-config.sh <agent-type> --base-url <url> --key <zzk_...>
#       [--label <name>] [--install]
#
# agent-type: codex | kimi | mimo  (determines wrapper + env var name)
# --install:  macOS loads the plist into launchd; Linux copies to /etc/systemd
#
# Example:
#   ./generate-executor-config.sh kimi \
#       --base-url http://192.168.1.10:18080/agent \
#       --key zzk_abc123...
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

BASE_URL=""; KEY=""; LABEL=""; INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --label) LABEL="$2"; shift 2;;
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
  *) echo "ERROR: unknown agent-type '$AGENT_TYPE' (use codex|kimi|mimo)"; exit 1;;
esac

LABEL="${LABEL:-com.zz-agent.${AGENT_TYPE}-executor}"
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
