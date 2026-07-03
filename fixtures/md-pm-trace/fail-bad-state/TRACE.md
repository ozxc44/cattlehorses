# Bad State Trace

```json md-pm-trace
{
  "artifact_type": "trace",
  "id": "artifact-trace-bad-state",
  "orchestration_id": "orch-bad-state",
  "status": "accepted",
  "final_decision": "accepted",
  "links": {
    "goal": "GOAL.md",
    "plan": "PLAN.md"
  },
  "tasks": [
    {
      "id": "TASK-1",
      "path": "tasks/TASK-1/TASK.md",
      "status": "approved"
    }
  ],
  "events": [
    {
      "id": "evt-bad-goal",
      "type": "goal_created",
      "artifact": "GOAL.md",
      "at": "2026-06-20T14:00:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    },
    {
      "id": "evt-bad-submit",
      "type": "submit",
      "artifact": "tasks/TASK-1/RESULT.md",
      "at": "2026-06-20T14:04:00Z",
      "actor": {
        "id": "worker-agent-1",
        "role": "agent",
        "interface": "cli"
      }
    },
    {
      "id": "evt-bad-review",
      "type": "review",
      "artifact": "tasks/TASK-1/REVIEW.md",
      "at": "2026-06-20T14:05:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    }
  ]
}
```

The trace claims acceptance despite an impossible transition and inaccessible evidence.
