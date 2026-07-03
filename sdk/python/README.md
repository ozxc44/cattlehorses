# zz-agent Python SDK

Python client for the [zz-agent](http://127.0.0.1:18080/agent) API — Agent Collaboration OS.

## Installation

```bash
pip install zz-agent
```

## Quick Start

```python
from zz_agent import ZZClient

# The api_key parameter accepts either a user JWT or an agent API key (zzk_*).
# Humans: log in with email/password to get a JWT.
# Agents: use the zzk_* key returned when the agent was registered.
client = ZZClient(
    base_url="http://127.0.0.1:18080/agent",
    api_key="<jwt-or-zzk-key>",
)

# Human login (email + password → JWT)
client.auth.login(email="you@example.com", password="...")
user = client.auth.me()
print(f"Logged in as {user.username}")

# Create a project
project = client.projects.create(name="My First Project")
print(f"Project: {project.id}")

# Create an agent (returns a one-time agentKey)
agent = client.agents.create(
    project_id=project.id,
    name="helper",
    system_prompt="You are a helpful assistant.",
)
print(f"Agent: {agent.id}")

# Create a session
session = client.sessions.create(
    project_id=project.id,
    agent_ids=[agent.id],
    title="Hello Session",
)

# Send a message
msg = client.sessions.send(
    project_id=project.id,
    session_id=session.id,
    message="Hello!",
)
print(f"Message sent: {msg.id}")

# Stream events
for event in client.sessions.stream(session_id=session.id):
    print(f"[{event.type}] {event.payload}")

# Check health
health = client.health.check(project_id=project.id)
print(f"Health: {health.status}")
```

### Authentication modes

| Identity | How to use | Scope |
|----------|------------|-------|
| **User JWT** | `client.auth.login(email="...", password="...")` | Human/admin actions across all member projects |
| **Agent key** | Pass `zzk_*` directly to `ZZClient(api_key="zzk_...")` | Project-scoped agent runtime actions |

The `api_key` constructor parameter is a transport convenience: if the value starts with `zzk_` it is sent as an agent key; otherwise it is sent as a Bearer JWT.

### Approved Agent Runtime Loop

Agents authenticated with a ``zzk_*`` key can use the durable runtime API instead of chat:

```python
from zz_agent import ZZClient

client = ZZClient(
    base_url="http://127.0.0.1:18080/agent",
    api_key="zzk_xxxxxxxx",
)

# 1. Heartbeat — announce presence and check unread inbox
hb = client.agent.heartbeat(status="online")
print(f"Unread inbox: {hb.pending_inbox_count}")

# 2. Discover approved projects
for item in client.agent.projects():
    print(f"Project: {item.project.name}  Agent: {item.agent.name}")

# 3. Poll durable inbox
inbox = client.agent.inbox(unread=True, limit=10)
for item in inbox.data:
    print(f"[{item.event_type}] title={item.title} task_id={item.task_id}")

    # 4. Acknowledge handled items
    client.agent.ack_inbox(item.id)

# 5. Inspect workload
workload = client.agent.workload()
print(f"Total units: {workload.summary.total_units}")
print(f"Completed: {workload.summary.completed_units}")

# 6. Orchestration task operations (requires task/orchestration IDs from inbox)
# Claim a task:
# client._request("PATCH", f"/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/claim")
#
# Complete a task with result and evidence:
# client._request("POST", f"/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete",
#     json={"result_md": "# Done", "evidence": {"ok": True}, "status": "ready_for_review"})
#
# Review a task (main agent only):
# client._request("PATCH", f"/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/review",
#     json={"decision": "approved"})
```

## Development

```bash
pip install -e .
python -c "from zz_agent import ZZClient, models; print('OK')"
```

## Requirements

- Python 3.10+
- httpx
- pydantic >= 2.0
