# Fixture Plan

```json md-pm-trace
{
  "artifact_type": "plan",
  "id": "artifact-plan-pass",
  "orchestration_id": "orch-pass",
  "status": "accepted",
  "links": {
    "goal": "GOAL.md",
    "trace": "TRACE.md",
    "tasks": [
      "tasks/TASK-1/TASK.md",
      "tasks/TASK-2/TASK.md"
    ]
  }
}
```

Two workers execute independent tasks. The PM reviews both with evidence.
