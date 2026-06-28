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
#   3. Creates data directories (logs, project-git) — portable under ./data/
#   4. Detects your host IP (for CORS/endpoints)
#   5. Builds + starts all services (postgres, backend, web)
#   6. Waits for health, prints the platform URL + data location
#
# Optional env vars:
#   PLATFORM_HOST  — override auto-detected host IP
#   INCLUDE_GITEA=1 — also start the Gitea Git gateway
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy/nas"
DATA_DIR="$DEPLOY_DIR/data"

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
  echo "✗ Docker Compose v2 is not available. Install: https://docs.docker.com/compose/install/"
  exit 1
fi
echo "  ✓ Docker Compose: $(docker compose version --short)"
echo ""

# ── 2. Generate .env ──────────────────────────────────────────────────────────
ENV_FILE="$DEPLOY_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "▶ Generating .env with random secrets..."
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  sed -i.bak "s|change-me-to-a-strong-password|$(openssl rand -hex 16)|" "$ENV_FILE"
  sed -i.bak "s|run-openssl-rand-hex-32-and-paste-here|$(openssl rand -hex 32)|g" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  echo "  ✓ .env generated (secrets randomized)"
else
  echo "▶ .env already exists — using it."
fi
echo ""

# ── 3. Create data directories (so bind mounts don't fail) ───────────────────
echo "▶ Creating data directories..."
mkdir -p "$DATA_DIR/logs" "$DATA_DIR/project-git"
[ "${INCLUDE_GITEA:-0}" = "1" ] && mkdir -p "$DATA_DIR/gitea"
echo "  ✓ $DATA_DIR/logs"
echo "  ✓ $DATA_DIR/project-git"
[ "${INCLUDE_GITEA:-0}" = "1" ] && echo "  ✓ $DATA_DIR/gitea"
echo ""

# ── 4. Detect host IP ─────────────────────────────────────────────────────────
if [ -z "${PLATFORM_HOST:-}" ]; then
  PLATFORM_HOST=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$PLATFORM_HOST" ]; then
    PLATFORM_HOST=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
  fi
fi
# Write PLATFORM_HOST into .env so docker-compose picks it up
if ! grep -q "^PLATFORM_HOST=" "$ENV_FILE" 2>/dev/null; then
  echo "PLATFORM_HOST=$PLATFORM_HOST" >> "$ENV_FILE"
else
  sed -i.bak "s|^PLATFORM_HOST=.*|PLATFORM_HOST=$PLATFORM_HOST|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
fi
echo "▶ Platform host: $PLATFORM_HOST"
echo ""

# ── 5. Build + start ──────────────────────────────────────────────────────────
echo "▶ Building and starting services (first run builds images, ~2-3 min)..."
COMPOSE_ARGS=(--env-file "$ENV_FILE")
if [ "${INCLUDE_GITEA:-0}" = "1" ]; then
  COMPOSE_ARGS+=(--profile gitea)
  echo "  (INCLUDE_GITEA=1 — starting Gitea gateway too)"
fi
docker compose "${COMPOSE_ARGS[@]}" up -d --build 2>&1 | sed 's/^/  /'
echo ""

# ── 6. Health check ───────────────────────────────────────────────────────────
echo "▶ Waiting for backend to become healthy..."
HEALTH_URL="http://localhost:18080/agent/v1/health"
for i in $(seq 1 30); do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "  ✓ Backend healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ✗ Backend not healthy after 5 min. Check: docker compose --env-file .env logs backend"
    exit 1
  fi
  sleep 10; printf "."
done
echo ""; echo ""

# ── 7. Done ───────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ✓ Deployed! Agent Collaboration OS is running.            ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║                                                              ║"
echo "║   Platform:  http://${PLATFORM_HOST}:18080/agent"
echo "║   Health:    ${HEALTH_URL}"
echo "║                                                              ║"
echo "║   Data stored in:                                            ║"
echo "║     • Postgres:    docker volume 'postgres-data'             ║"
echo "║     • Logs:        $DATA_DIR/logs"
echo "║     • Git repos:   $DATA_DIR/project-git"
echo "║                                                              ║"
echo "║   Next: onboard local models — see README.md §Quick Start   ║"
echo "║                                                              ║"
echo "║   Logs:      docker compose --env-file .env logs -f backend ║"
echo "║   Stop:      docker compose --env-file .env down            ║"
echo "║   Backup DB: docker run --rm -v \$(docker volume ls -q |     ║"
echo "║              grep postgres-data):/data alpine tar czf        ║"
echo "║              $DATA_DIR/db-backup.tar.gz /data"
echo "╚══════════════════════════════════════════════════════════════╝"
