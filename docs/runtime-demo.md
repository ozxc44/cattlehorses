# Runtime Demo Driver

The CLI ships two development helpers for the V1 runtime loop:

- `zz dev fake-agent`: local HTTP fake agent at `POST /zz/v1/invoke`
- `zz dev quickstart-runtime`: E2E driver that starts two fake agents and calls the backend happy path

## Fake Agent

```bash
zz dev fake-agent \
  --name reviewer \
  --port 7781 \
  --invoke-secret reviewer-secret
```

Supported modes:

| Mode | Behavior |
| --- | --- |
| `normal` | HTTP 200 with `status=completed`, one agent message, and metrics |
| `slow` | Sleeps for `--delay`, then behaves like `normal` |
| `fail` | HTTP 200 with `status=failed` and a retryable error |
| `reject` | HTTP 200 with `status=rejected` and a non-retryable error |
| `invalid-json` | HTTP 200 with malformed JSON |
| `no-reply` | HTTP 200 with `status=no_reply` and metrics |

The fake agent requires V1 runtime headers by default and validates:

```text
body_hash = sha256(raw_body)
signed_payload = timestamp + "." + delivery_id + "." + body_hash
signature = hmac_sha256(invoke_secret, signed_payload)
X-ZZ-Signature = sha256=<signature>
```

It also caches responses by `X-ZZ-Idempotency-Key`. A repeated request returns
the same response with `X-ZZ-Idempotent-Replay: true`.

## Direct Signed Invoke Sample

With the fake agent running on port `7781`:

```bash
python - <<'PY'
import json
import time
import httpx

from zz_cli.fake_agent import sign_runtime_request

body = {
    "protocol_version": "runtime.v1",
    "project_id": "proj_demo",
    "session_id": "sess_demo",
    "agent_id": "agent_reviewer",
    "run_id": "run_demo",
    "delivery_id": "deliv_demo",
    "attempt": 1,
    "trigger": {"message": {"content": "Review this diff."}},
    "agent": {"name": "reviewer"},
    "session": {"title": "Runtime Demo"},
    "recent_messages": [{"role": "user", "content": "Review this diff."}],
    "runtime": {"timeout_ms": 5000},
    "trace_id": "trace_demo",
    "correlation_id": "corr_demo",
    "created_at": "2026-05-28T00:00:00Z",
}
raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
timestamp = str(int(time.time()))
delivery_id = body["delivery_id"]
signature = sign_runtime_request(raw, "reviewer-secret", timestamp, delivery_id)

headers = {
    "Content-Type": "application/json",
    "User-Agent": "zhuzeyang-agent-runtime/1.0",
    "X-ZZ-Protocol-Version": "runtime.v1",
    "X-ZZ-Project-Id": body["project_id"],
    "X-ZZ-Session-Id": body["session_id"],
    "X-ZZ-Agent-Id": body["agent_id"],
    "X-ZZ-Run-Id": body["run_id"],
    "X-ZZ-Delivery-Id": delivery_id,
    "X-ZZ-Attempt": "1",
    "X-ZZ-Timestamp": timestamp,
    "X-ZZ-Trace-Id": body["trace_id"],
    "X-ZZ-Idempotency-Key": "run_demo:attempt:1",
    "X-ZZ-Signature": signature,
}

response = httpx.post(
    "http://127.0.0.1:7781/zz/v1/invoke",
    content=raw,
    headers=headers,
)
print(response.status_code)
print(response.text)
print("replay:", response.headers.get("X-ZZ-Idempotent-Replay"))
PY
```

Run the same sample twice to verify the in-memory idempotency cache.

## Quickstart Runtime Driver

```bash
export ZZ_BASE_URL=http://127.0.0.1:8000
zz login --email agent-owner@example.com --password "change-me" --base-url "$ZZ_BASE_URL"

zz dev quickstart-runtime
```

The driver performs:

```text
create project
start fake reviewer and tester
register agents with endpoint_url and invoke_secret
create shared session
send broadcast
send targeted direct message
poll session events
read project health
```

The backend runtime dispatch path is wired in V1. A successful run should show
the full broadcast/targeted timeline with `message.created`, `agent.run.queued`,
`agent.run.started`, `health.metric`, and `agent.run.completed` events.

Cloud validation on 2026-05-28 used two fake agents on the production host and
confirmed:

- broadcast message -> two completed agent runs
- targeted direct message -> one completed agent run
- zero failed runs
- project health reported `healthy`

## Static Runtime Dashboard

Open `dashboard/index.html` directly in a browser for a no-build V1 runtime
operator console, or use the deployed dashboard at
`<your-platform-base-url>/ (e.g. http://127.0.0.1:18080/agent/)`. The dashboard supports email/password
registration and login, and it can also accept a pasted JWT bearer token for
operator workflows.

- `GET /v1/auth/me` to verify the token.
- `GET/POST /v1/projects` for project selection and creation.
- `GET/POST /v1/projects/{pid}/agents` to register agents with `endpoint_url`
  and `invoke_secret`.
- `GET/POST /v1/projects/{pid}/sessions` to create shared sessions.
- `GET/POST /v1/sessions/{sid}/messages` for broadcast, targeted, and direct
  messages.
- `GET /v1/sessions/{sid}/events` and `GET /v1/health` for timeline and health
  snapshots.

Because the file is static, no dashboard server is required. If the API is on a
different origin, the backend must allow browser CORS for the configured URL.
