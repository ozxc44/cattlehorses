# Contributing to Agent Collaboration OS

Thanks for your interest in contributing! This guide covers the basics.

## Project Structure

| Directory | What's here |
|-----------|-------------|
| `backend/` | Node.js + TypeScript backend (API server, 197 endpoints) |
| `cli/zz_cli/` | Python CLI + unified local-model runtime |
| `dashboard/` | Frontend (HTML, planned React/Vue refactor) |
| `sdk/` | Python SDK |
| `deploy/` | Docker Compose + deployment scripts |
| `docs/` | Documentation + product planning |

## Development Setup

```bash
# Clone
git clone https://github.com/ozxc44/agent-collaboration-os.git
cd agent-collaboration-os

# Backend
cd backend
npm install
npm run build
npm start  # runs on :3000

# CLI
cd ../cli
pip install -e .

# Full platform (Docker)
cd ..
bash deploy/setup.sh
```

## How to Contribute

### Report bugs
Open an [issue](https://github.com/ozxc44/agent-collaboration-os/issues) with:
- What you expected
- What happened
- Steps to reproduce
- Logs (`docker compose logs backend`)

### Add a new model backend
The unified runtime supports local models via backends. To add a new one:

1. Add the model to `MODEL_PROBES` and `CLI_INVOCATIONS` in `cli/zz_cli/runtime.py`
2. Test with: `python3 runtime.py --discover` (should detect your model)
3. Submit a PR

### Fix a bug / add a feature
1. Fork + clone
2. Create a branch: `git checkout -b fix/my-fix`
3. Make changes
4. Test: `cd backend && npm test`
5. Commit with a clear message
6. Open a Pull Request

## Code Style

- **Backend (TypeScript)**: follow existing patterns, run `npm run build` (tsc) before commit
- **Python**: stdlib-only for runtime scripts (no external deps), follow PEP 8
- **Commits**: use clear messages (`feat:`, `fix:`, `docs:`, `chore:`)

## Testing

```bash
# Backend tests
cd backend && npm test

# Runtime quick test
python3 cli/zz_cli/runtime.py --backend echo --port 9999 &
curl -X POST http://localhost:9999/zz/v1/invoke -H "Content-Type: application/json" \
  -d '{"agent_id":"test","recent_messages":[{"sender_type":"user","content":"ping"}]}'
```

## Questions?

Open an issue or discussion. We're friendly.
