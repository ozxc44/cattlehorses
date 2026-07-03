# Missing Evidence Trace

```json md-pm-trace
{
  "artifact_type": "trace",
  "id": "artifact-trace-missing-evidence",
  "orchestration_id": "orch-missing-evidence",
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
      "id": "evt-missing-goal",
      "type": "goal_created",
      "artifact": "GOAL.md",
      "at": "2026-06-20T13:00:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    },
    {
      "id": "evt-missing-submit",
      "type": "submit",
      "artifact": "tasks/TASK-1/RESULT.md",
      "at": "2026-06-20T13:04:00Z",
      "actor": {
        "id": "worker-agent-1",
        "role": "agent",
        "interface": "cli"
      }
    },
    {
      "id": "evt-missing-review",
      "type": "review",
      "artifact": "tasks/TASK-1/REVIEW.md",
      "at": "2026-06-20T13:05:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    }
  ]
}
```

The trace claims acceptance even though evidence is absent.
