#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Agent Collaboration OS — One-command deployment
#
# Usage:
#   git clone https://github.com/ozxc44/agent-collaboration-os.git
#   cd agent-collaboration-os
#   bash deploy/setup.sh
#
# What it does:
#   1. Checks prerequisites (Docker, Docker Compose)
#   2. Generates .env with random secrets (if not present)
#   3. Detects your host IP (for CORS/endpoints)
#   4. Builds + starts all services (postgres, backend, web)
#   5. Waits for health, prints the platform URL
#
# Optional env vars:
#   PLATFORM_HOST  — override auto-detected host IP (for CORS/endpoints)
#   SKIP_GITEA=1   — don't start the Gitea Git gateway (start with core only)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo root (parent of deploy/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy/nas"

cd "$DEPLOY_DIR"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Agent Collaboration OS — Deployment                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
echo "▶ Checking prerequisites..."

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ Docker is not installed. Install it first: https://docs.docker.com/get-docker/"
  exit 1
fi
echo "  ✓ Docker: $(docker --version)"

if ! docker compose version >/dev/null 2>&1; then
  echo "✗ Docker Compose v2 is not available. Install it: https://docs.docker.com/compose/install/"
  exit 1
fi
echo "  ✓ Docker Compose: $(docker compose version --short)"
echo ""

# ── 2. Generate .env (with random secrets) ────────────────────────────────────
ENV_FILE="$DEPLOY_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "▶ Generating .env with random secrets..."
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"

  # Generate random secrets
  JWT_SECRET=$(openssl rand -hex 32)
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  DEBUG_LOG_TOKEN=$(openssl rand -hex 32)
  PG_PASSWORD=$(openssl rand -hex 16)

  # Replace placeholders (portable sed)
  sed -i.bak \
    -e "s|run-openssl-rand-hex-32-and-paste-here|$JWT_SECRET|" \
    -e "s|change-me-to-a-strong-password|$PG_PASSWORD|" \
    "$ENV_FILE"
  # webhook + debug tokens (second occurrence of the placeholder)
  sed -i.bak2 "s|run-openssl-rand-hex-32-and-paste-here|$WEBHOOK_SECRET|" "$ENV_FILE"
  sed -i.bak3 "s|run-openssl-rand-hex-32-and-paste-here|$DEBUG_LOG_TOKEN|" "$ENV_FILE"
  rm -f "$ENV_FILE".bak "$ENV_FILE".bak2 "$ENV_FILE".bak3

  echo "  ✓ .env generated (secrets randomized)"
  echo "    ⚠ Review it: $ENV_FILE"
else
  echo "▶ .env already exists — using it."
fi
echo ""

# ── 3. Detect host IP ─────────────────────────────────────────────────────────
if [ -z "${PLATFORM_HOST:-}" ]; then
  # Try to detect a non-loopback IP
  PLATFORM_HOST=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$PLATFORM_HOST" ]; then
    # macOS fallback
    PLATFORM_HOST=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
  fi
fi
echo "▶ Platform host: $PLATFORM_HOST"
echo "  (override with: PLATFORM_HOST=<ip> bash deploy/setup.sh)"
echo ""

# ── 4. Build + start ──────────────────────────────────────────────────────────
echo "▶ Building and starting services..."
echo "  This runs database migrations on first start (may take 1-2 minutes)."
echo ""

COMPOSE_ARGS=(--env-file "$ENV_FILE")
if [ "${SKIP_GITEA:-0}" = "1" ]; then
  echo "  (SKIP_GITEA=1 — starting core services only, no Gitea gateway)"
fi

docker compose "${COMPOSE_ARGS[@]}" up -d --build 2>&1 | sed 's/^/  /'

echo ""

# ── 5. Health check ───────────────────────────────────────────────────────────
echo "▶ Waiting for backend to become healthy..."
PROTOCOL="http"
PORT=18080
HEALTH_URL="${PROTOCOL}://localhost:${PORT}/agent/v1/health"

for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "  ✓ Backend healthy (after ${i}0s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ✗ Backend did not become healthy in 5 minutes."
    echo "    Check logs: docker compose --env-file $ENV_FILE logs backend"
    exit 1
  fi
  sleep 10
  printf "."
done
echo ""
echo ""

# ── 6. Done ───────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ✓ Deployed! Agent Collaboration OS is running.            ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║   Platform:  ${PROTOCOL}://${PLATFORM_HOST}:${PORT}/agent                     "
echo "║   Health:    ${HEALTH_URL}                       "
echo "║                                                              ║"
echo "║   Next: onboard local models — see README.md §Quick Start   ║"
echo "║                                                              ║"
echo "║   Logs:      docker compose --env-file .env logs -f backend ║"
echo "║   Stop:      docker compose --env-file .env down            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
