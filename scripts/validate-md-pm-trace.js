#!/usr/bin/env node
// Final MD-driven PM acceptance gate.
//
// Validates an exported project-space collaboration package:
//
//   <artifact-dir>/
//     GOAL.md
//     PLAN.md
//     TRACE.md
//     tasks/<task_id>/TASK.md
//     tasks/<task_id>/RESULT.md
//     tasks/<task_id>/EVIDENCE.md
//     tasks/<task_id>/REVIEW.md
//
// Every Markdown file must include one fenced metadata block:
//
//   ```json md-pm-trace
//   { ... }
//   ```
//
// The validator prints one JSON report to stdout and exits non-zero when any
// blocking gate fails.

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'md-pm-trace-gate/v1';

const ROOT_ARTIFACTS = [
  ['GOAL.md', 'goal'],
  ['PLAN.md', 'plan'],
  ['TRACE.md', 'trace'],
];

const TASK_ARTIFACTS = [
  ['TASK.md', 'task'],
  ['RESULT.md', 'result'],
  ['EVIDENCE.md', 'evidence'],
  ['REVIEW.md', 'review'],
];

const TASK_TRANSITIONS = new Map([
  ['pending', new Set(['dispatched', 'blocked', 'failed', 'cancelled'])],
  ['dispatched', new Set(['running', 'blocked', 'failed', 'cancelled'])],
  ['running', new Set(['ready_for_review', 'blocked', 'failed', 'cancelled'])],
  ['ready_for_review', new Set(['approved', 'changes_requested', 'blocked', 'failed', 'cancelled'])],
  ['changes_requested', new Set(['running', 'ready_for_review', 'blocked', 'failed', 'cancelled'])],
  ['approved', new Set([])],
  ['blocked', new Set([])],
  ['failed', new Set([])],
  ['cancelled', new Set([])],
]);

const TERMINAL_ACCEPTED_TASK_STATE = 'approved';
const ACCEPTED_TRACE_STATES = new Set(['accepted']);
const ACCEPTED_REVIEW_DECISIONS = new Set(['approved']);
const REVIEW_DECISIONS = new Set(['approved', 'changes_requested', 'rejected', 'blocked']);
const REVIEW_AUTHORITIES = new Set(['pm', 'owner', 'main_agent']);

const CHECK_DEFS = [
  ['required_artifacts', 'Required Markdown artifacts exist'],
  ['metadata_schema', 'Markdown metadata schema is present and typed'],
  ['unique_ids', 'Artifact, task, and trace event ids are unique'],
  ['bidirectional_links', 'Goal, plan, trace, and task artifacts link both ways'],
  ['state_machine', 'Task status state machine is consistent'],
  ['submit_evidence_binding', 'Submits bind result and evidence with audit fields'],
  ['review_evidence_gate', 'Review approval is evidence-bound and authorized'],
  ['actor_role_boundaries', 'Human-web and agent-CLI boundaries are explicit'],
  ['secret_scan', 'Artifacts do not contain high-confidence secrets'],
  ['final_acceptance', 'Final accepted state is valid only after all checks pass'],
];

const GK_GATES = [
  {
    gate: 1,
    name: 'Collaboration fact completeness',
    coverage: 'covered',
    checks: ['required_artifacts', 'metadata_schema', 'state_machine'],
  },
  {
    gate: 2,
    name: 'End-to-end traceability',
    coverage: 'covered',
    checks: ['unique_ids', 'bidirectional_links'],
  },
  {
    gate: 3,
    name: 'MD single source of truth',
    coverage: 'partial',
    checks: ['required_artifacts', 'metadata_schema', 'bidirectional_links', 'state_machine'],
    external_required: [
      'Compare reconstructed MD state with live database/cache when validating a deployment.',
      'Covered by backend/tests/md-db-reconciliation.test.ts: drives the full lifecycle, then queries the DB directly (bypassing the API/cache) and proves path-set parity, content/hash parity (DB content recomputes to stored hash and matches API), size_bytes integrity, and state-machine reconstruction (orchestration/task rows rebuild to the TRACE.md-reported facts). Local SQLite run passes; the same code path applies to Postgres in a deployment.',
    ],
  },
  {
    gate: 4,
    name: 'Identity and permission boundary',
    coverage: 'partial',
    checks: ['actor_role_boundaries'],
    external_required: ['Run permission/API rejection tests for unauthorized live paths.'],
  },
  {
    gate: 5,
    name: 'Invitation and join loop',
    coverage: 'external',
    checks: [],
    external_required: ['Run human web invite/join approval E2E and CLI join flow.'],
  },
  {
    gate: 6,
    name: 'Claim concurrency consistency',
    coverage: 'external',
    checks: [],
    external_required: ['Run repeated claim-race/NAS multiworker checks.'],
  },
  {
    gate: 7,
    name: 'Submit and evidence binding',
    coverage: 'covered',
    checks: ['submit_evidence_binding', 'actor_role_boundaries'],
  },
  {
    gate: 8,
    name: 'Review cannot be bypassed',
    coverage: 'covered',
    checks: ['review_evidence_gate', 'final_acceptance'],
  },
  {
    gate: 9,
    name: 'Reproducibility',
    coverage: 'partial',
    checks: ['submit_evidence_binding'],
    external_required: ['Replay evidence commands in the target runtime.'],
  },
  {
    gate: 10,
    name: 'Audit and tamper resistance',
    coverage: 'partial',
    checks: ['unique_ids', 'actor_role_boundaries', 'secret_scan'],
    external_required: ['Validate append-only persistence, diffs, and tamper controls in backend storage.'],
  },
  {
    gate: 11,
    name: 'Failure recovery and idempotency',
    coverage: 'external',
    checks: [],
    external_required: ['Run CLI retry, network interruption, callback duplicate, and restart recovery tests.'],
  },
  {
    gate: 12,
    name: 'Automated final PM acceptance',
    coverage: 'covered',
    checks: ['final_acceptance'],
  },
];

const SECRET_PATTERNS = [
  ['openai_or_provider_key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['agent_key', /\bzzk_[A-Za-z0-9_-]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ['secret_assignment', /\b(password|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+~-]{16,}/gi],
];

function makeChecks() {
  const checks = new Map();
  for (const [id, title] of CHECK_DEFS) {
    checks.set(id, { id, title, status: 'pass', errors: [], warnings: [], details: {} });
  }
  return checks;
}

function addFailure(checks, id, message, details = {}) {
  const check = checks.get(id);
  check.errors.push(compactObject({ message, ...details }));
  check.status = 'fail';
}

function addWarning(checks, id, message, details = {}) {
  const check = checks.get(id);
  check.warnings.push(compactObject({ message, ...details }));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function fromPosix(p) {
  return p.split('/').join(path.sep);
}

function normalizeRel(p) {
  return path.posix.normalize(p).replace(/^\.\//, '');
}

function resolveRel(fromRel, target) {
  if (!target || typeof target !== 'string') return '';
  return normalizeRel(path.posix.join(path.posix.dirname(fromRel), target));
}

function relFromRoot(rootDir, absPath) {
  return toPosix(path.relative(rootDir, absPath));
}

function listImmediateTaskDirs(rootDir, traceMeta) {
  const dirs = new Set();
  const tasksRoot = path.join(rootDir, 'tasks');
  if (fs.existsSync(tasksRoot)) {
    for (const entry of fs.readdirSync(tasksRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        dirs.add(normalizeRel(`tasks/${entry.name}`));
      }
    }
  }

  if (traceMeta && Array.isArray(traceMeta.tasks)) {
    for (const taskRef of traceMeta.tasks) {
      const taskPath = typeof taskRef === 'string' ? taskRef : taskRef && taskRef.path;
      if (typeof taskPath === 'string' && taskPath.endsWith('/TASK.md')) {
        dirs.add(normalizeRel(path.posix.dirname(taskPath)));
      }
    }
  }

  return [...dirs].sort();
}

function extractMetadata(content, relPath, checks) {
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(content))) {
    const info = match[1].toLowerCase().trim();
    if (!info.split(/\s+/).includes('md-pm-trace')) continue;
    try {
      const parsed = JSON.parse(match[2]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        addFailure(checks, 'metadata_schema', 'md-pm-trace metadata must be a JSON object.', { path: relPath });
        return null;
      }
      return parsed;
    } catch (error) {
      addFailure(checks, 'metadata_schema', 'md-pm-trace metadata is not valid JSON.', {
        path: relPath,
        error: error.message,
      });
      return null;
    }
  }

  addFailure(checks, 'metadata_schema', 'Missing fenced metadata block: ```json md-pm-trace.', { path: relPath });
  return null;
}

function readArtifact(rootDir, relPath, expectedType, checks) {
  const absPath = path.join(rootDir, fromPosix(relPath));
  const artifact = {
    path: relPath,
    absPath,
    expected_type: expectedType,
    exists: fs.existsSync(absPath),
    metadata: null,
    bytes: 0,
  };

  if (!artifact.exists) return artifact;

  const content = fs.readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '');
  artifact.content = content;
  artifact.bytes = Buffer.byteLength(content, 'utf8');
  artifact.metadata = extractMetadata(content, relPath, checks);
  return artifact;
}

function buildContext(rootDir, checks) {
  const artifacts = new Map();
  const add = (relPath, expectedType) => {
    const normalized = normalizeRel(relPath);
    if (!artifacts.has(normalized)) {
      artifacts.set(normalized, readArtifact(rootDir, normalized, expectedType, checks));
    }
    return artifacts.get(normalized);
  };

  for (const [relPath, expectedType] of ROOT_ARTIFACTS) {
    add(relPath, expectedType);
  }

  const trace = artifacts.get('TRACE.md');
  const taskDirs = listImmediateTaskDirs(rootDir, trace && trace.metadata);
  for (const taskDir of taskDirs) {
    for (const [name, expectedType] of TASK_ARTIFACTS) {
      add(`${taskDir}/${name}`, expectedType);
    }
  }

  return { rootDir, artifacts, taskDirs };
}

function artifactFor(context, relPath) {
  return context.artifacts.get(normalizeRel(relPath));
}

function taskArtifact(context, taskDir, name) {
  return artifactFor(context, `${taskDir}/${name}`);
}

function validateRequiredArtifacts(context, checks) {
  if (!fs.existsSync(context.rootDir)) {
    addFailure(checks, 'required_artifacts', 'Artifact directory does not exist.', { path: context.rootDir });
    return;
  }

  for (const [relPath] of ROOT_ARTIFACTS) {
    const artifact = artifactFor(context, relPath);
    if (!artifact || !artifact.exists) {
      addFailure(checks, 'required_artifacts', 'Missing required root artifact.', { path: relPath });
    }
  }

  const tasksRoot = path.join(context.rootDir, 'tasks');
  if (!fs.existsSync(tasksRoot)) {
    addFailure(checks, 'required_artifacts', 'Missing required tasks/ directory.', { path: 'tasks' });
  }

  if (context.taskDirs.length === 0) {
    addFailure(checks, 'required_artifacts', 'No task directories found under tasks/.', { path: 'tasks' });
  }

  for (const taskDir of context.taskDirs) {
    for (const [name] of TASK_ARTIFACTS) {
      const relPath = `${taskDir}/${name}`;
      const artifact = artifactFor(context, relPath);
      if (!artifact || !artifact.exists) {
        addFailure(checks, 'required_artifacts', 'Missing required task artifact.', { path: relPath });
      }
    }
  }
}

function requireString(checks, checkId, obj, key, relPath) {
  if (!obj || typeof obj[key] !== 'string' || obj[key].trim() === '') {
    addFailure(checks, checkId, `Missing required string field: ${key}.`, { path: relPath });
    return false;
  }
  return true;
}

function requireBooleanTrue(checks, checkId, obj, key, relPath) {
  if (!obj || obj[key] !== true) {
    addFailure(checks, checkId, `Required boolean field must be true: ${key}.`, { path: relPath });
    return false;
  }
  return true;
}

function validateMetadataSchema(context, checks) {
  for (const artifact of context.artifacts.values()) {
    if (!artifact.exists || !artifact.metadata) continue;
    const meta = artifact.metadata;
    requireString(checks, 'metadata_schema', meta, 'artifact_type', artifact.path);
    requireString(checks, 'metadata_schema', meta, 'id', artifact.path);
    requireString(checks, 'metadata_schema', meta, 'orchestration_id', artifact.path);

    if (meta.artifact_type !== artifact.expected_type) {
      addFailure(checks, 'metadata_schema', 'artifact_type does not match artifact path.', {
        path: artifact.path,
        expected: artifact.expected_type,
        actual: meta.artifact_type,
      });
    }

    if (!meta.links || typeof meta.links !== 'object' || Array.isArray(meta.links)) {
      addFailure(checks, 'metadata_schema', 'Missing required links object.', { path: artifact.path });
    }

    if (artifact.path.startsWith('tasks/') && artifact.expected_type !== 'task') {
      requireString(checks, 'metadata_schema', meta, 'task_id', artifact.path);
    }
  }

  const trace = artifactFor(context, 'TRACE.md');
  if (trace && trace.exists && trace.metadata) {
    if (!Array.isArray(trace.metadata.tasks)) {
      addFailure(checks, 'metadata_schema', 'TRACE.md metadata must include tasks array.', { path: 'TRACE.md' });
    }
    requireString(checks, 'metadata_schema', trace.metadata, 'status', 'TRACE.md');
    requireString(checks, 'metadata_schema', trace.metadata, 'final_decision', 'TRACE.md');
  }
}

function validateUniqueIds(context, checks) {
  const artifactIds = new Map();
  const taskIds = new Map();
  const eventIds = new Map();

  for (const artifact of context.artifacts.values()) {
    if (!artifact.exists || !artifact.metadata) continue;
    const meta = artifact.metadata;
    if (typeof meta.id === 'string' && meta.id) {
      if (artifactIds.has(meta.id)) {
        addFailure(checks, 'unique_ids', 'Duplicate artifact id.', {
          id: meta.id,
          first_path: artifactIds.get(meta.id),
          path: artifact.path,
        });
      } else {
        artifactIds.set(meta.id, artifact.path);
      }
    }

    if (artifact.expected_type === 'task' && typeof meta.task_id === 'string' && meta.task_id) {
      if (taskIds.has(meta.task_id)) {
        addFailure(checks, 'unique_ids', 'Duplicate task_id in TASK.md metadata.', {
          task_id: meta.task_id,
          first_path: taskIds.get(meta.task_id),
          path: artifact.path,
        });
      } else {
        taskIds.set(meta.task_id, artifact.path);
      }
    }
  }

  const trace = artifactFor(context, 'TRACE.md');
  if (trace && trace.exists && trace.metadata) {
    if (Array.isArray(trace.metadata.tasks)) {
      const traceTaskIds = new Map();
      for (const task of trace.metadata.tasks) {
        if (!task || typeof task.id !== 'string' || !task.id) {
          addFailure(checks, 'unique_ids', 'TRACE.md task entry is missing id.', { path: 'TRACE.md' });
          continue;
        }
        if (traceTaskIds.has(task.id)) {
          addFailure(checks, 'unique_ids', 'Duplicate task id in TRACE.md tasks.', {
            task_id: task.id,
            first_path: traceTaskIds.get(task.id),
            path: task.path,
          });
        } else {
          traceTaskIds.set(task.id, task.path || 'TRACE.md');
        }
      }
    }

    if (Array.isArray(trace.metadata.events)) {
      for (const event of trace.metadata.events) {
        if (!event || typeof event.id !== 'string' || !event.id) {
          addFailure(checks, 'unique_ids', 'TRACE.md event entry is missing id.', { path: 'TRACE.md' });
          continue;
        }
        if (eventIds.has(event.id)) {
          addFailure(checks, 'unique_ids', 'Duplicate TRACE.md event id.', {
            event_id: event.id,
            first_type: eventIds.get(event.id),
            actual_type: event.type,
          });
        } else {
          eventIds.set(event.id, event.type || '');
        }
      }
    } else {
      addFailure(checks, 'unique_ids', 'TRACE.md metadata must include events array with ids.', { path: 'TRACE.md' });
    }
  }
}

function requireLink(context, checks, artifact, key, expectedRel) {
  const meta = artifact && artifact.metadata;
  if (!meta || !meta.links || typeof meta.links !== 'object') return;
  const raw = meta.links[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    addFailure(checks, 'bidirectional_links', `Missing link: links.${key}.`, { path: artifact.path });
    return;
  }
  const actualRel = resolveRel(artifact.path, raw);
  if (actualRel !== expectedRel) {
    addFailure(checks, 'bidirectional_links', `Link target mismatch: links.${key}.`, {
      path: artifact.path,
      expected: expectedRel,
      actual: actualRel,
    });
  }
  const targetArtifact = artifactFor(context, actualRel);
  if (!targetArtifact || !targetArtifact.exists) {
    addFailure(checks, 'bidirectional_links', `Link target does not exist: links.${key}.`, {
      path: artifact.path,
      target: actualRel,
    });
  }
}

function normalizeLinkList(fromRel, values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string')
    .map((value) => resolveRel(fromRel, value))
    .sort();
}

function requireTaskListLinks(checks, artifact, expectedTaskRels) {
  const meta = artifact && artifact.metadata;
  if (!meta || !meta.links || typeof meta.links !== 'object') return;
  const actual = normalizeLinkList(artifact.path, meta.links.tasks);
  const expected = [...expectedTaskRels].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    addFailure(checks, 'bidirectional_links', 'Task link list does not match discovered task TASK.md artifacts.', {
      path: artifact.path,
      expected,
      actual,
    });
  }
}

function traceTaskEntries(trace) {
  if (!trace || !trace.metadata || !Array.isArray(trace.metadata.tasks)) return [];
  return trace.metadata.tasks
    .map((task) => {
      if (typeof task === 'string') return { path: normalizeRel(task) };
      if (!task || typeof task !== 'object') return {};
      return { ...task, path: typeof task.path === 'string' ? normalizeRel(task.path) : task.path };
    })
    .filter((task) => task.path);
}

function validateBidirectionalLinks(context, checks) {
  const goal = artifactFor(context, 'GOAL.md');
  const plan = artifactFor(context, 'PLAN.md');
  const trace = artifactFor(context, 'TRACE.md');
  const taskRels = context.taskDirs.map((taskDir) => `${taskDir}/TASK.md`).sort();

  if (goal && goal.exists) {
    requireLink(context, checks, goal, 'plan', 'PLAN.md');
    requireLink(context, checks, goal, 'trace', 'TRACE.md');
    requireTaskListLinks(checks, goal, taskRels);
  }

  if (plan && plan.exists) {
    requireLink(context, checks, plan, 'goal', 'GOAL.md');
    requireLink(context, checks, plan, 'trace', 'TRACE.md');
    requireTaskListLinks(checks, plan, taskRels);
  }

  if (trace && trace.exists) {
    requireLink(context, checks, trace, 'goal', 'GOAL.md');
    requireLink(context, checks, trace, 'plan', 'PLAN.md');
    const traceTaskRels = traceTaskEntries(trace).map((task) => task.path).sort();
    if (JSON.stringify(traceTaskRels) !== JSON.stringify(taskRels)) {
      addFailure(checks, 'bidirectional_links', 'TRACE.md task list does not match discovered task TASK.md artifacts.', {
        path: 'TRACE.md',
        expected: taskRels,
        actual: traceTaskRels,
      });
    }
  }

  for (const taskDir of context.taskDirs) {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    const result = taskArtifact(context, taskDir, 'RESULT.md');
    const evidence = taskArtifact(context, taskDir, 'EVIDENCE.md');
    const review = taskArtifact(context, taskDir, 'REVIEW.md');
    const taskRel = `${taskDir}/TASK.md`;
    const resultRel = `${taskDir}/RESULT.md`;
    const evidenceRel = `${taskDir}/EVIDENCE.md`;
    const reviewRel = `${taskDir}/REVIEW.md`;

    if (task && task.exists) {
      requireLink(context, checks, task, 'goal', 'GOAL.md');
      requireLink(context, checks, task, 'plan', 'PLAN.md');
      requireLink(context, checks, task, 'trace', 'TRACE.md');
      requireLink(context, checks, task, 'result', resultRel);
      requireLink(context, checks, task, 'evidence', evidenceRel);
      requireLink(context, checks, task, 'review', reviewRel);
    }
    if (result && result.exists) {
      requireLink(context, checks, result, 'task', taskRel);
      requireLink(context, checks, result, 'evidence', evidenceRel);
      requireLink(context, checks, result, 'review', reviewRel);
    }
    if (evidence && evidence.exists) {
      requireLink(context, checks, evidence, 'task', taskRel);
      requireLink(context, checks, evidence, 'result', resultRel);
      requireLink(context, checks, evidence, 'review', reviewRel);
    }
    if (review && review.exists) {
      requireLink(context, checks, review, 'task', taskRel);
      requireLink(context, checks, review, 'result', resultRel);
      requireLink(context, checks, review, 'evidence', evidenceRel);
    }
  }
}

function traceTaskById(context) {
  const trace = artifactFor(context, 'TRACE.md');
  const map = new Map();
  for (const task of traceTaskEntries(trace)) {
    if (task.id) map.set(task.id, task);
  }
  return map;
}

function taskIdFromTaskMeta(task) {
  return task && task.metadata && task.metadata.task_id;
}

function validateTaskStateMachine(context, checks) {
  const traceTasks = traceTaskById(context);

  for (const taskDir of context.taskDirs) {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    if (!task || !task.exists || !task.metadata) continue;
    const meta = task.metadata;
    const relPath = task.path;

    requireString(checks, 'state_machine', meta, 'task_id', relPath);
    requireString(checks, 'state_machine', meta, 'status', relPath);

    if (!Array.isArray(meta.state_history) || meta.state_history.length === 0) {
      addFailure(checks, 'state_machine', 'TASK.md must include non-empty state_history array.', { path: relPath });
      continue;
    }

    const states = meta.state_history.map((entry) => entry && entry.state);
    if (states[0] !== 'pending') {
      addFailure(checks, 'state_machine', 'Task state_history must start at pending.', {
        path: relPath,
        actual: states[0],
      });
    }

    for (let i = 0; i < meta.state_history.length; i += 1) {
      const entry = meta.state_history[i] || {};
      if (typeof entry.state !== 'string' || !TASK_TRANSITIONS.has(entry.state)) {
        addFailure(checks, 'state_machine', 'Unknown task state in state_history.', {
          path: relPath,
          index: i,
          state: entry.state,
        });
      }
      if (typeof entry.at !== 'string' || !entry.at) {
        addFailure(checks, 'state_machine', 'State transition is missing at timestamp.', { path: relPath, index: i });
      }
    }

    for (let i = 1; i < states.length; i += 1) {
      const previous = states[i - 1];
      const current = states[i];
      const allowed = TASK_TRANSITIONS.get(previous);
      if (!allowed || !allowed.has(current)) {
        addFailure(checks, 'state_machine', 'Invalid task state transition.', {
          path: relPath,
          from: previous,
          to: current,
          index: i,
        });
      }
    }

    const lastState = states[states.length - 1];
    if (meta.status !== lastState) {
      addFailure(checks, 'state_machine', 'TASK.md status must match last state_history state.', {
        path: relPath,
        expected: lastState,
        actual: meta.status,
      });
    }

    const traceTask = traceTasks.get(meta.task_id);
    if (!traceTask) {
      addFailure(checks, 'state_machine', 'TRACE.md is missing this task id.', {
        path: relPath,
        task_id: meta.task_id,
      });
    } else if (traceTask.status !== meta.status) {
      addFailure(checks, 'state_machine', 'TRACE.md task status does not match TASK.md status.', {
        path: relPath,
        task_id: meta.task_id,
        expected: meta.status,
        actual: traceTask.status,
      });
    }
  }
}

function checksumLooksValid(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function validateSubmitEvidenceBinding(context, checks) {
  for (const taskDir of context.taskDirs) {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    const result = taskArtifact(context, taskDir, 'RESULT.md');
    const evidence = taskArtifact(context, taskDir, 'EVIDENCE.md');
    if (!task || !task.metadata || !result || !result.exists || !result.metadata || !evidence || !evidence.exists || !evidence.metadata) {
      continue;
    }

    const taskId = taskIdFromTaskMeta(task);
    const resultMeta = result.metadata;
    const evidenceMeta = evidence.metadata;
    const submit = resultMeta.submit;

    if (resultMeta.task_id !== taskId) {
      addFailure(checks, 'submit_evidence_binding', 'RESULT.md task_id does not match TASK.md task_id.', {
        path: result.path,
        expected: taskId,
        actual: resultMeta.task_id,
      });
    }
    if (evidenceMeta.task_id !== taskId) {
      addFailure(checks, 'submit_evidence_binding', 'EVIDENCE.md task_id does not match TASK.md task_id.', {
        path: evidence.path,
        expected: taskId,
        actual: evidenceMeta.task_id,
      });
    }

    if (!submit || typeof submit !== 'object' || Array.isArray(submit)) {
      addFailure(checks, 'submit_evidence_binding', 'RESULT.md metadata must include submit object.', { path: result.path });
    } else {
      requireString(checks, 'submit_evidence_binding', submit, 'source', result.path);
      requireString(checks, 'submit_evidence_binding', submit, 'submitted_at', result.path);
      requireString(checks, 'submit_evidence_binding', submit, 'checksum', result.path);
      requireBooleanTrue(checks, 'submit_evidence_binding', submit, 'accessibility_checked', result.path);
      if (!checksumLooksValid(submit.checksum)) {
        addFailure(checks, 'submit_evidence_binding', 'RESULT.md submit.checksum must use sha256:<64 hex> format.', {
          path: result.path,
        });
      }
      const evidenceTarget = resolveRel(result.path, submit.evidence || '');
      if (evidenceTarget !== evidence.path) {
        addFailure(checks, 'submit_evidence_binding', 'RESULT.md submit.evidence must point to EVIDENCE.md.', {
          path: result.path,
          expected: evidence.path,
          actual: evidenceTarget || submit.evidence,
        });
      }
    }

    requireString(checks, 'submit_evidence_binding', evidenceMeta, 'source', evidence.path);
    requireString(checks, 'submit_evidence_binding', evidenceMeta, 'collected_at', evidence.path);
    requireString(checks, 'submit_evidence_binding', evidenceMeta, 'checksum', evidence.path);
    requireBooleanTrue(checks, 'submit_evidence_binding', evidenceMeta, 'accessible', evidence.path);
    if (!checksumLooksValid(evidenceMeta.checksum)) {
      addFailure(checks, 'submit_evidence_binding', 'EVIDENCE.md checksum must use sha256:<64 hex> format.', {
        path: evidence.path,
      });
    }
    const hasCommands = Array.isArray(evidenceMeta.commands) && evidenceMeta.commands.length > 0;
    const hasArtifacts = Array.isArray(evidenceMeta.artifacts) && evidenceMeta.artifacts.length > 0;
    if (!hasCommands && !hasArtifacts) {
      addFailure(checks, 'submit_evidence_binding', 'EVIDENCE.md must include commands or artifacts array.', {
        path: evidence.path,
      });
    }
  }
}

function validateReviewEvidenceGate(context, checks) {
  for (const taskDir of context.taskDirs) {
    const review = taskArtifact(context, taskDir, 'REVIEW.md');
    const evidence = taskArtifact(context, taskDir, 'EVIDENCE.md');
    if (!review || !review.exists || !review.metadata) continue;
    const meta = review.metadata;
    requireString(checks, 'review_evidence_gate', meta, 'decision', review.path);
    requireString(checks, 'review_evidence_gate', meta, 'reviewed_at', review.path);
    requireString(checks, 'review_evidence_gate', meta, 'reviewer_authority', review.path);

    if (typeof meta.decision === 'string' && !REVIEW_DECISIONS.has(meta.decision)) {
      addFailure(checks, 'review_evidence_gate', 'Unknown review decision.', {
        path: review.path,
        actual: meta.decision,
      });
    }
    if (typeof meta.reviewer_authority === 'string' && !REVIEW_AUTHORITIES.has(meta.reviewer_authority)) {
      addFailure(checks, 'review_evidence_gate', 'Reviewer authority is not allowed for PM acceptance.', {
        path: review.path,
        actual: meta.reviewer_authority,
      });
    }

    const evidenceTarget = resolveRel(review.path, meta.evidence || '');
    if (evidenceTarget !== `${taskDir}/EVIDENCE.md`) {
      addFailure(checks, 'review_evidence_gate', 'REVIEW.md evidence field must point to EVIDENCE.md.', {
        path: review.path,
        expected: `${taskDir}/EVIDENCE.md`,
        actual: evidenceTarget || meta.evidence,
      });
    }

    if (ACCEPTED_REVIEW_DECISIONS.has(meta.decision)) {
      if (!evidence || !evidence.exists || !evidence.metadata) {
        addFailure(checks, 'review_evidence_gate', 'Approved review is blocked because EVIDENCE.md is missing.', {
          path: review.path,
        });
      } else if (evidence.metadata.accessible !== true) {
        addFailure(checks, 'review_evidence_gate', 'Approved review is blocked because evidence is not accessible.', {
          path: review.path,
          evidence_path: evidence.path,
        });
      }
    }
  }
}

function validateActor(checks, actor, location, required = {}) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    addFailure(checks, 'actor_role_boundaries', 'Missing actor object.', location);
    return;
  }

  const role = actor.role;
  const iface = actor.interface;
  if (typeof actor.id !== 'string' || actor.id.trim() === '') {
    addFailure(checks, 'actor_role_boundaries', 'Actor is missing id.', location);
  }
  if (!['human', 'agent'].includes(role)) {
    addFailure(checks, 'actor_role_boundaries', 'Actor role must be human or agent.', { ...location, actual: role });
  }
  if (!['web', 'cli'].includes(iface)) {
    addFailure(checks, 'actor_role_boundaries', 'Actor interface must be web or cli.', { ...location, actual: iface });
  }
  if (role === 'human' && iface !== 'web') {
    addFailure(checks, 'actor_role_boundaries', 'Human actors must use web interface.', { ...location, actual: iface });
  }
  if (role === 'agent' && iface !== 'cli') {
    addFailure(checks, 'actor_role_boundaries', 'Agent actors must use cli interface.', { ...location, actual: iface });
  }
  if (required.role && role !== required.role) {
    addFailure(checks, 'actor_role_boundaries', `Actor role must be ${required.role}.`, { ...location, actual: role });
  }
  if (required.interface && iface !== required.interface) {
    addFailure(checks, 'actor_role_boundaries', `Actor interface must be ${required.interface}.`, { ...location, actual: iface });
  }
}

function validateActorRoleBoundaries(context, checks) {
  const trace = artifactFor(context, 'TRACE.md');
  if (trace && trace.exists && trace.metadata && Array.isArray(trace.metadata.events)) {
    for (let i = 0; i < trace.metadata.events.length; i += 1) {
      const event = trace.metadata.events[i] || {};
      validateActor(checks, event.actor, { path: 'TRACE.md', event_id: event.id, index: i });
      if (typeof event.at !== 'string' || !event.at) {
        addFailure(checks, 'actor_role_boundaries', 'TRACE.md event is missing at timestamp.', {
          path: 'TRACE.md',
          event_id: event.id,
          index: i,
        });
      }
      if (typeof event.type !== 'string' || !event.type) {
        addFailure(checks, 'actor_role_boundaries', 'TRACE.md event is missing type.', {
          path: 'TRACE.md',
          event_id: event.id,
          index: i,
        });
      }
    }
  }

  for (const taskDir of context.taskDirs) {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    const result = taskArtifact(context, taskDir, 'RESULT.md');
    const evidence = taskArtifact(context, taskDir, 'EVIDENCE.md');
    const review = taskArtifact(context, taskDir, 'REVIEW.md');

    if (task && task.metadata && Array.isArray(task.metadata.state_history)) {
      for (let i = 0; i < task.metadata.state_history.length; i += 1) {
        const entry = task.metadata.state_history[i] || {};
        validateActor(checks, entry.actor, { path: task.path, state: entry.state, index: i });
      }
    }

    if (result && result.metadata && result.metadata.submit) {
      validateActor(checks, result.metadata.submit.actor, { path: result.path, field: 'submit.actor' }, {
        role: 'agent',
        interface: 'cli',
      });
    }

    if (evidence && evidence.metadata) {
      validateActor(checks, evidence.metadata.actor, { path: evidence.path, field: 'actor' }, {
        role: 'agent',
        interface: 'cli',
      });
    }

    if (review && review.metadata) {
      validateActor(checks, review.metadata.actor, { path: review.path, field: 'actor' });
    }
  }
}

function validateSecretScan(context, checks) {
  for (const artifact of context.artifacts.values()) {
    if (!artifact.exists || !artifact.content) continue;
    for (const [name, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(artifact.content)) {
        addFailure(checks, 'secret_scan', 'High-confidence secret-like value found in artifact.', {
          path: artifact.path,
          pattern: name,
        });
      }
    }
  }
}

function nonFinalChecksPassed(checks) {
  for (const check of checks.values()) {
    if (check.id === 'final_acceptance') continue;
    if (check.errors.length > 0) return false;
  }
  return true;
}

function validateFinalAcceptance(context, checks) {
  const trace = artifactFor(context, 'TRACE.md');
  const traceMeta = trace && trace.metadata;

  if (!trace || !trace.exists || !traceMeta) {
    addFailure(checks, 'final_acceptance', 'TRACE.md must exist with metadata before final acceptance can pass.', {
      path: 'TRACE.md',
    });
    return;
  }

  if (!ACCEPTED_TRACE_STATES.has(traceMeta.status) || !ACCEPTED_TRACE_STATES.has(traceMeta.final_decision)) {
    addFailure(checks, 'final_acceptance', 'TRACE.md must declare accepted status and final_decision for final gate pass.', {
      path: 'TRACE.md',
      status: traceMeta.status,
      final_decision: traceMeta.final_decision,
    });
  }

  for (const taskDir of context.taskDirs) {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    const review = taskArtifact(context, taskDir, 'REVIEW.md');
    if (task && task.metadata && task.metadata.status !== TERMINAL_ACCEPTED_TASK_STATE) {
      addFailure(checks, 'final_acceptance', 'Final acceptance requires every task to be approved.', {
        path: task.path,
        task_id: task.metadata.task_id,
        actual: task.metadata.status,
      });
    }
    if (review && review.metadata && !ACCEPTED_REVIEW_DECISIONS.has(review.metadata.decision)) {
      addFailure(checks, 'final_acceptance', 'Final acceptance requires every review decision to be approved.', {
        path: review.path,
        actual: review.metadata.decision,
      });
    }
  }

  if (!nonFinalChecksPassed(checks)) {
    addFailure(checks, 'final_acceptance', 'TRACE.md cannot be accepted while blocking validation checks fail.', {
      path: 'TRACE.md',
    });
  }
}

function taskSummaries(context) {
  return context.taskDirs.map((taskDir) => {
    const task = taskArtifact(context, taskDir, 'TASK.md');
    const review = taskArtifact(context, taskDir, 'REVIEW.md');
    return compactObject({
      dir: taskDir,
      task_id: task && task.metadata && task.metadata.task_id,
      status: task && task.metadata && task.metadata.status,
      review_decision: review && review.metadata && review.metadata.decision,
      artifacts: Object.fromEntries(TASK_ARTIFACTS.map(([name]) => {
        const artifact = taskArtifact(context, taskDir, name);
        return [name, Boolean(artifact && artifact.exists)];
      })),
    });
  });
}

function gkGateReport(checks) {
  return GK_GATES.map((gate) => {
    const checkStatuses = gate.checks.map((id) => checks.get(id)).filter(Boolean);
    const hasFailure = checkStatuses.some((check) => check.errors.length > 0);
    let status = 'pass';
    if (hasFailure) {
      status = 'fail';
    } else if (gate.coverage !== 'covered') {
      status = 'external_required';
    }
    return compactObject({
      gate: gate.gate,
      name: gate.name,
      coverage: gate.coverage,
      status,
      checks: gate.checks,
      external_required: gate.external_required,
    });
  });
}

function buildReport(rootDir, context, checks) {
  const checksArray = [...checks.values()].map((check) => ({
    id: check.id,
    title: check.title,
    status: check.errors.length > 0 ? 'fail' : 'pass',
    errors: check.errors,
    warnings: check.warnings,
    details: check.details,
  }));
  const errors = checksArray.flatMap((check) => check.errors.map((error) => ({ check: check.id, ...error })));
  const warnings = checksArray.flatMap((check) => check.warnings.map((warning) => ({ check: check.id, ...warning })));
  const trace = artifactFor(context, 'TRACE.md');
  const finalAccepted = errors.length === 0 &&
    trace && trace.metadata &&
    ACCEPTED_TRACE_STATES.has(trace.metadata.status) &&
    ACCEPTED_TRACE_STATES.has(trace.metadata.final_decision);

  return {
    schema_version: SCHEMA_VERSION,
    artifact_dir: rootDir,
    generated_at: new Date().toISOString(),
    ok: errors.length === 0,
    final_accepted: Boolean(finalAccepted),
    summary: {
      checks_total: checksArray.length,
      checks_passed: checksArray.filter((check) => check.status === 'pass').length,
      checks_failed: checksArray.filter((check) => check.status === 'fail').length,
      error_count: errors.length,
      warning_count: warnings.length,
      task_count: context.taskDirs.length,
    },
    artifacts: {
      root: Object.fromEntries(ROOT_ARTIFACTS.map(([relPath]) => {
        const artifact = artifactFor(context, relPath);
        return [relPath, compactObject({
          exists: Boolean(artifact && artifact.exists),
          id: artifact && artifact.metadata && artifact.metadata.id,
          artifact_type: artifact && artifact.metadata && artifact.metadata.artifact_type,
        })];
      })),
      tasks: taskSummaries(context),
    },
    checks: checksArray,
    gk_gates: gkGateReport(checks),
  };
}

function parseArgs(argv) {
  const args = { pretty: false, out: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pretty') {
      args.pretty = true;
    } else if (arg === '--out') {
      args.out = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      positional.push(arg);
    }
  }
  args.artifactDir = positional[0] || '';
  return args;
}

function usage() {
  return [
    'Usage: node scripts/validate-md-pm-trace.js <artifact-dir> [--pretty] [--out report.json]',
    '',
    'Validates a GOAL/PLAN/TRACE/tasks Markdown collaboration package and emits JSON.',
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.artifactDir) {
    const report = {
      schema_version: SCHEMA_VERSION,
      ok: false,
      error: 'missing_artifact_dir',
      usage: usage(),
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const rootDir = path.resolve(args.artifactDir);
  const checks = makeChecks();
  const context = buildContext(rootDir, checks);

  validateRequiredArtifacts(context, checks);
  validateMetadataSchema(context, checks);
  validateUniqueIds(context, checks);
  validateBidirectionalLinks(context, checks);
  validateTaskStateMachine(context, checks);
  validateSubmitEvidenceBinding(context, checks);
  validateReviewEvidenceGate(context, checks);
  validateActorRoleBoundaries(context, checks);
  validateSecretScan(context, checks);
  validateFinalAcceptance(context, checks);

  const report = buildReport(rootDir, context, checks);
  const json = JSON.stringify(report, null, args.pretty ? 2 : 0);
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), `${json}\n`);
  }
  console.log(json);
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}
