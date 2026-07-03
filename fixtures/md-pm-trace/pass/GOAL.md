# Fixture Goal

```json md-pm-trace
{
  "artifact_type": "goal",
  "id": "artifact-goal-pass",
  "orchestration_id": "orch-pass",
  "status": "accepted",
  "links": {
    "plan": "PLAN.md",
    "trace": "TRACE.md",
    "tasks": [
      "tasks/TASK-1/TASK.md",
      "tasks/TASK-2/TASK.md"
    ]
  }
}
```

Validate that two CLI workers completed tasks under a PM-reviewed Markdown trace.
