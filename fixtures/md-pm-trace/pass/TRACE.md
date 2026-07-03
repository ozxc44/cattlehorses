# Fixture Trace

```json md-pm-trace
{
  "artifact_type": "trace",
  "id": "artifact-trace-pass",
  "orchestration_id": "orch-pass",
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
    },
    {
      "id": "TASK-2",
      "path": "tasks/TASK-2/TASK.md",
      "status": "approved"
    }
  ],
  "events": [
    {
      "id": "evt-goal-created",
      "type": "goal_created",
      "artifact": "GOAL.md",
      "at": "2026-06-20T12:00:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    },
    {
      "id": "evt-plan-published",
      "type": "plan_published",
      "artifact": "PLAN.md",
      "at": "2026-06-20T12:01:00Z",
      "actor": {
        "id": "pm-agent",
        "role": "agent",
        "interface": "cli"
      }
    },
    {
      "id": "evt-task-1-submitted",
      "type": "submit",
      "artifact": "tasks/TASK-1/RESULT.md",
      "at": "2026-06-20T12:07:00Z",
      "actor": {
        "id": "worker-agent-1",
        "role": "agent",
        "interface": "cli"
      }
    },
    {
      "id": "evt-task-1-reviewed",
      "type": "review",
      "artifact": "tasks/TASK-1/REVIEW.md",
      "at": "2026-06-20T12:09:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    },
    {
      "id": "evt-task-2-submitted",
      "type": "submit",
      "artifact": "tasks/TASK-2/RESULT.md",
      "at": "2026-06-20T12:17:00Z",
      "actor": {
        "id": "worker-agent-2",
        "role": "agent",
        "interface": "cli"
      }
    },
    {
      "id": "evt-task-2-reviewed",
      "type": "review",
      "artifact": "tasks/TASK-2/REVIEW.md",
      "at": "2026-06-20T12:19:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    },
    {
      "id": "evt-final-accepted",
      "type": "accept",
      "artifact": "TRACE.md",
      "at": "2026-06-20T12:20:00Z",
      "actor": {
        "id": "human-owner",
        "role": "human",
        "interface": "web"
      }
    }
  ]
}
```

Final state is accepted only after both task reviews are approved.
