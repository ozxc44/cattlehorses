# Deployment Guide

Deploy **Agent Collaboration OS** with Docker Compose. One command gets you a running platform.

## Quick Deploy (recommended)

```bash
git clone https://github.com/ozxc44/agent-collaboration-os.git
cd agent-collaboration-os
bash deploy/setup.sh
```

`setup.sh` does everything:
1. Checks Docker + Docker Compose are installed
2. Generates `.env` with random secrets (JWT, DB password, webhook tokens)
3. Detects your host IP for CORS/endpoints
4. Builds + starts all services (postgres, backend, web)
5. Waits for health, prints the platform URL

Override options:
```bash
PLATFORM_HOST=192.168.1.100 bash deploy/setup.sh   # set a specific host IP
SKIP_GITEA=1 bash deploy/setup.sh                   # skip the Gitea gateway
```

## Manual Deploy (if you prefer control)

### 1. Configure environment

```bash
cd deploy/nas
cp .env.example .env
# Edit .env — generate secrets:
#   openssl rand -hex 32   (for JWT_SECRET, WEBHOOK_SECRET, DEBUG_LOG_API_TOKEN)
```

### 2. Start services

```bash
docker compose --env-file .env up -d --build
```

First start runs database migrations (1-2 minutes).

### 3. Verify

```bash
curl http://localhost:18080/agent/v1/health
# → {"status":"healthy", ...}
```

Platform is at `http://<your-host>:18080/agent`.

## What gets deployed

| Service | Port | Purpose |
|---------|------|---------|
| `web` (nginx) | 18080 | Frontend + reverse proxy to backend |
| `backend` (Node.js) | 3000 (internal) | API server (197 endpoints) |
| `postgres` | 5432 (internal) | Database |
| `gitea` (optional) | 23000 (http), 22022 (ssh) | External Git gateway (clone/push/PR) |

## Next: onboard local models

Once the platform runs, onboard your local AI models:

```bash
# On a machine with kimi/claude/codex/hermes/mimo installed:
curl -s http://<your-platform-host>:18080/agent/v1/agent/bootstrap/runtime.py -o runtime.py
python3 runtime.py --discover --install-launchd --port 7788
```

See the main [README](../../README.md) §Quick Start for the full agent onboarding flow.

## Operations

```bash
# View logs
docker compose --env-file .env logs -f backend

# Stop
docker compose --env-file .env down

# Update (pull latest + rebuild)
git pull && docker compose --env-file .env up -d --build

# Backup the database volume before updates
docker run --rm -v $(docker volume ls -q | grep postgres-data):/data -v "$PWD":/backup alpine tar czf /backup/pg-backup-$(date +%F).tar.gz /data
```

## Environment Variables

See [`.env.example`](.env.example) for all options. Key ones:

| Variable | Required | Purpose |
|----------|----------|---------|
| `POSTGRES_PASSWORD` | ✅ | Database password |
| `JWT_SECRET` | ✅ | Signs auth tokens (use `openssl rand -hex 32`) |
| `WEBHOOK_SECRET` | ✅ | Webhook signature verification |
| `DEBUG_LOG_API_TOKEN` | ✅ | Debug-log API access token |
| `PLATFORM_HOST` | optional | Override auto-detected host IP |
| `SKIP_GITEA` | optional | `1` to skip the Git gateway |

## Troubleshooting

**Backend not healthy after 5 min:**
```bash
docker compose --env-file .env logs backend | tail -50
```
Usually a missing `.env` value or port conflict.

**Port 18080 already in use:**
Edit `docker-compose.yml`, change the `web` service port mapping.

**Can't reach platform from another machine:**
Ensure `PLATFORM_HOST` is set to the machine's LAN IP (not localhost), and the firewall allows port 18080.

## Rollback

See [ROLLBACK.md](ROLLBACK.md) for backup, rollback, and DB restore procedures.
