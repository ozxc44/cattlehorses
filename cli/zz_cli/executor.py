#!/usr/bin/env python3
"""
Agent Executor Daemon — a thin RELAY daemon for agents that already have a brain.

The agents on this platform (Kimi, mimocode, you, me, ...) ARE LLM agents.
They already have their own reasoning backend. This daemon does NOT call an LLM
itself in the main path. Its only job is transport:

    poll inbox → forward task to the agent's own brain → submit the result

Execution sources, in priority order:
  1. endpoint_url : POST the task JSON to the agent's own endpoint; its brain runs.
  2. --handler    : pipe the task JSON to an external command (e.g. a CLI bridge);
                    the agent's own runtime responds.
  3. --manual     : read the result from stdin (interactive session / human).
  4. --headless   : ONLY for nodes that genuinely have no brain (a registered
                    identity with no model behind it). Uses an LLM API key.
                    Explicit opt-in — never the default.

If none of these is configured, the daemon does NOT claim tasks and does NOT
submit placeholders. It surfaces the waiting task and leaves it for whoever can
actually do it. No "occupied outhouse".

PM review needs no brain — it's just platform API calls (review + merge), so the
PM loop runs regardless of executor capability.

Usage:
    zz agent executor                          # relay daemon (needs endpoint/handler/manual)
    zz agent executor --pm-only                # PM review + merge only
    zz agent executor --worker-only            # worker relay only
    zz agent executor --handler "cmd"          # bridge to external handler
    zz agent executor --manual                 # interactive: type result each cycle
    zz agent executor --headless               # headless LLM fallback (needs key)
    zz agent executor --once                   # single cycle
"""
import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.error
import platform

DEFAULT_INTERVAL = 30


class HeadlessLLM:
    """LLM fallback for genuinely headless nodes. Opt-in via --headless only.

    Real agents never use this — they have their own brain reachable via
    endpoint_url or a handler. This exists for a registered identity that is
    just an identity (e.g. a queue stub) and has no model of its own.
    """

    def __init__(self):
        self.provider = os.environ.get('AGENT_LLM_PROVIDER', 'openai').lower()
        self.api_key = os.environ.get('AGENT_LLM_API_KEY', '')
        self.model = os.environ.get('AGENT_LLM_MODEL', '')
        self.base_url = os.environ.get('AGENT_LLM_BASE_URL', '')

        if not self.model:
            self.model = {
                'openai': 'gpt-4o',
                'anthropic': 'claude-3-5-sonnet-20241022',
                'google': 'gemini-1.5-pro',
            }.get(self.provider, 'gpt-4o')

        if not self.base_url:
            self.base_url = {
                'openai': 'https://api.openai.com',
                'anthropic': 'https://api.anthropic.com',
                'google': 'https://generativelanguage.googleapis.com',
            }.get(self.provider, 'https://api.openai.com')

    @property
    def available(self):
        return bool(self.api_key)

    def execute(self, task_context):
        system_prompt = (
            "You are a worker node on a multi-agent collaboration platform. "
            "Complete the assigned task and output your result as markdown. "
            "Be thorough and produce real, useful output."
        )
        user_prompt = self._build_prompt(task_context)
        try:
            if self.provider == 'anthropic':
                result_text = self._call_anthropic(system_prompt, user_prompt)
            elif self.provider == 'google':
                result_text = self._call_google(system_prompt, user_prompt)
            else:
                result_text = self._call_openai(system_prompt, user_prompt)
            return {
                'result_md': result_text,
                'evidence': {
                    'llm_provider': self.provider,
                    'llm_model': self.model,
                    'task_id': task_context.get('task_id'),
                    'mode': 'headless_llm',
                },
            }
        except Exception as e:
            return {
                'result_md': f"# Execution Error\n\nLLM call failed: {e}\n\n## Task\n{task_context.get('goal', '')}",
                'evidence': {'error': str(e), 'llm_provider': self.provider, 'mode': 'headless_llm'},
            }

    def _build_prompt(self, ctx):
        lines = [
            f"## Task: {ctx.get('title', '')}",
            f"",
            f"## Goal",
            ctx.get('goal', ''),
            f"",
        ]
        criteria = ctx.get('acceptance_criteria', [])
        if criteria:
            lines.append("## Acceptance Criteria")
            for c in criteria:
                lines.append(f"- {c}")
            lines.append("")

        code_map = ctx.get('code_map', '')
        if code_map:
            lines.append("## Project Context (Code Map)")
            lines.append(code_map[:2000])
            lines.append("")

        lines.append("## Your Output")
        lines.append("Write the complete result. Output directly as markdown, no meta-commentary.")
        return '\n'.join(lines)

    def _call_openai(self, system, user):
        url = f"{self.base_url}/v1/chat/completions"
        body = json.dumps({
            'model': self.model,
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': user},
            ],
            'max_tokens': 4096,
            'temperature': 0.7,
        }).encode()
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Authorization', f'Bearer {self.api_key}')
        with urllib.request.urlopen(req, timeout=300) as resp:
            d = json.loads(resp.read())
            return d['choices'][0]['message']['content']

    def _call_anthropic(self, system, user):
        url = f"{self.base_url}/v1/messages"
        body = json.dumps({
            'model': self.model,
            'max_tokens': 4096,
            'system': system,
            'messages': [{'role': 'user', 'content': user}],
        }).encode()
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('x-api-key', self.api_key)
        req.add_header('anthropic-version', '2023-06-01')
        with urllib.request.urlopen(req, timeout=300) as resp:
            d = json.loads(resp.read())
            return d['content'][0]['text']

    def _call_google(self, system, user):
        url = f"{self.base_url}/v1beta/models/{self.model}:generateContent?key={self.api_key}"
        body = json.dumps({
            'contents': [{'parts': [{'text': f"{system}\n\n{user}"}]}],
            'generationConfig': {'maxOutputTokens': 4096, 'temperature': 0.7},
        }).encode()
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=300) as resp:
            d = json.loads(resp.read())
            return d['candidates'][0]['content']['parts'][0]['text']


class ExecutorDaemon:
    def __init__(self, base_url, api_key, handler_cmd=None, interval=DEFAULT_INTERVAL,
                 manual=False, pm_only=False, worker_only=False, headless=False,
                 self_path=None, no_self_update=False):
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.handler_cmd = handler_cmd
        self.interval = interval
        # R17: all workspace paths derive from ZZ_PROJECT_DIR so parallel workers
        # can use isolated directories (/tmp/zz-workspace-<name>). Falls back to
        # the process cwd when unset (legacy single-workspace behavior).
        self.project_dir = os.environ.get('ZZ_PROJECT_DIR') or os.getcwd()
        self.manual = manual
        self.pm_only = pm_only
        self.worker_only = worker_only
        self.headless = headless
        self.running = True
        self.my_agent_id = None
        self.project_id = None
        self.agent_endpoint = None
        # Headless LLM only instantiated when explicitly opted in.
        self.llm = HeadlessLLM() if headless else None
        # Self-update: re-download executor.py when the platform's SHA changes.
        self.self_path = os.path.abspath(self_path or __file__)
        self.no_self_update = no_self_update
        self.last_sha_check = 0
        # R10a: worker smoke test. Periodically verify the configured handler can
        # actually execute a real (minimal) task end-to-end, and report the result
        # in the heartbeat so the platform can block dispatch for broken handlers
        # (backend R10b consumes the `health` field). The smoke test only applies
        # to --handler mode; without a handler it is skipped (dispatch stays open).
        self.smoke_interval = 10
        try:
            self.smoke_interval = int(os.environ.get('ZZ_SMOKE_TEST_INTERVAL', '10') or '10')
        except (TypeError, ValueError):
            self.smoke_interval = 10
        self._cycle_count = 0
        self.last_smoke_result = None   # {healthy, last_error, duration_ms} or None
        self.last_smoke_at = None       # epoch seconds of the last smoke test

    # ═══════════════════════════════════════════════════
    # SELF-UPDATE: keep the running executor in sync with the platform.
    # The platform publishes a SHA256 of its served executor.py. Each cycle we
    # poll it cheaply; if it differs from our running copy we re-download,
    # verify the new hash, and re-exec ourselves (replacing this process).
    # This is how OLD agents pick up new behavior without anyone poking them.
    # ═══════════════════════════════════════════════════

    def _local_sha(self):
        try:
            import hashlib
            with open(self.self_path, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()
        except Exception:
            return ''

    def _remote_sha(self):
        try:
            url = self.base_url + '/v1/agent/bootstrap/executor.py.sha256'
            req = urllib.request.Request(url)
            req.add_header('X-API-Key', self.api_key)
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.read().decode().strip()
        except Exception:
            return ''

    def _download_new(self):
        try:
            url = self.base_url + '/v1/agent/bootstrap/executor.py'
            req = urllib.request.Request(url)
            req.add_header('X-API-Key', self.api_key)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception:
            return None

    def maybe_self_update(self, force=False):
        """Return True if we re-exec'd (caller path is now replaced)."""
        if self.no_self_update:
            return False
        now = time.time()
        # Throttle: at most one check per cycle is fine, but skip if checked <5s ago.
        if not force and now - self.last_sha_check < 5:
            return False
        self.last_sha_check = now

        remote = self._remote_sha()
        if not remote:
            return False  # platform down or no SHA endpoint yet (old server)
        local = self._local_sha()
        if local == remote:
            return False  # already current

        ts = time.strftime('%H:%M:%S')
        print(f"[{ts}] 🔄 self-update: {local[:12]} → {remote[:12]}", flush=True)
        new_bytes = self._download_new()
        if not new_bytes:
            print(f"  ⚠ download failed, keeping current version", flush=True)
            return False
        import tempfile, hashlib
        got = hashlib.sha256(new_bytes).hexdigest()
        if got != remote:
            print(f"  ⚠ downloaded hash mismatch (got {got[:12]}), refusing update", flush=True)
            return False

        # Atomic write: temp file in same dir, then os.replace.
        d = os.path.dirname(self.self_path)
        try:
            fd, tmp = tempfile.mkstemp(dir=d, suffix='.py.new')
            with os.fdopen(fd, 'wb') as f:
                f.write(new_bytes)
            os.chmod(tmp, 0o755)
            os.replace(tmp, self.self_path)
        except Exception as e:
            print(f"  ⚠ write failed: {e}", flush=True)
            return False
        print(f"  ✓ updated, restarting...", flush=True)
        time.sleep(1)
        # Re-exec: replace this process with a fresh copy of the new file.
        os.execv(sys.executable, [sys.executable, self.self_path] + sys.argv[1:])
        return True  # unreachable, but explicit

    # ═══════════════════════════════════════════════════
    # CAPABILITY: does this daemon have a real brain to call?
    # ═══════════════════════════════════════════════════

    @property
    def has_executor(self):
        """True if there is any real way to produce task output.

        Real agents satisfy this via endpoint_url or --handler.
        Interactive sessions satisfy it via --manual.
        Headless nodes satisfy it via --headless + a key.
        If False, the daemon surfaces tasks but claims nothing.
        """
        if self.agent_endpoint:
            return True
        if self.handler_cmd:
            return True
        if self.manual:
            return True
        if self.llm is not None and self.llm.available:
            return True
        return False

    @property
    def executor_label(self):
        if self.agent_endpoint:
            return f"endpoint:{self.agent_endpoint}"
        if self.handler_cmd:
            return f"handler:{self.handler_cmd}"
        if self.manual:
            return "manual(stdin)"
        if self.llm is not None and self.llm.available:
            return f"headless:{self.llm.provider}/{self.llm.model}"
        return None

    # ═══════════════════════════════════════════════════
    # API helpers
    # ═══════════════════════════════════════════════════

    def api(self, method, path, body=None):
        url = self.base_url + path
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        req.add_header('X-API-Key', self.api_key)
        req.add_header('X-Inbox-No-Lease', '1')
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())
            except Exception:
                err = {'detail': str(e)}
            return {'_error': e.code, **err}
        except Exception as e:
            return {'_error': str(e)}

    def heartbeat(self):
        # R10a: report the last worker smoke-test health so the platform can
        # block dispatch for handlers that cannot execute (backend R10b applies
        # the `health` field). Only sent when a smoke test has actually run
        # (handler mode); legacy/endpoint/manual workers omit it, leaving the
        # platform health columns untouched and dispatch open.
        body = {}
        if self.last_smoke_result is not None:
            body['health'] = {
                'status': 'healthy' if self.last_smoke_result.get('healthy') else 'unhealthy',
                'error': self.last_smoke_result.get('last_error') or '',
                'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            }
        r = self.api('POST', '/v1/agents/heartbeat', body)
        if not self.my_agent_id:
            self.my_agent_id = r.get('agent_id')
        pending = r.get('pending_inbox_count', 0)
        hint = r.get('pending_hint', {})
        self._onboarding_cache = r.get('onboarding', {})
        ts = time.strftime('%H:%M:%S')

        if pending > 0:
            print(f"[{ts}] ♥ online | {pending} pending", flush=True)
            if hint.get('quick_start'):
                print(f"[{ts}] 💡 {hint.get('message','')}", flush=True)
        else:
            print(f"[{ts}] ♥ online", flush=True)

        # Surface the platform's onboarding guidance, and warn when the agent
        # cannot be invoked (no endpoint_url) — which is why dispatched tasks
        # never wake it. Done in run_cycle after project_id is known so the
        # printed commands can carry the real project ID.
        return r


    def _surface_onboarding(self, onboarding):
        """Print actionable upgrade guidance from the platform.

        Distinguishes two states:
        - agent HAS an invoke endpoint → it can be woken by the platform (good)
        - agent has NO endpoint → dispatched tasks won't reach its brain. Print
          the exact commands to expose an invoke endpoint, every cycle, so the
          operator/agent sees them and acts.
        """
        if getattr(self, '_onboarding_shown_recently', 0) > 3:
            # Throttle: print full guidance only every few cycles to avoid log spam.
            self._onboarding_shown_recently = 0
            return
        self._onboarding_shown_recently = getattr(self, '_onboarding_shown_recently', 0) + 1

        if self.agent_endpoint:
            return  # already invocable; nothing to surface

        invoke_cmd = onboarding.get('invoke_server', '')
        register_cmd = onboarding.get('register_invoke', '')
        multi_cmd = onboarding.get('invoke_multi_agent', '')
        ts = time.strftime('%H:%M:%S')
        # Fill placeholders with real values the daemon knows.
        base = self.base_url
        pid = self.project_id or '<project>'
        invoke_cmd = (invoke_cmd
                      .replace('<base>', base)
                      .replace('<key>', self.api_key))
        register_cmd = (register_cmd
                        .replace('<base>', base)
                        .replace('<key>', self.api_key)
                        .replace('<project>', pid)
                        .replace('<name>', 'invoke-server'))
        print(f"[{ts}] ⚠ No invoke endpoint configured — the platform CANNOT wake you.", flush=True)
        print(f"    Dispatched tasks will reach your inbox but never invoke your brain.", flush=True)
        print(f"    To become invocable (expose an HTTP brain endpoint):", flush=True)
        if invoke_cmd:
            print(f"      {invoke_cmd}", flush=True)
        if register_cmd:
            print(f"      {register_cmd}", flush=True)
        if multi_cmd:
            print(f"    (multi-agent host: {multi_cmd})", flush=True)

    def get_inbox(self):
        r = self.api('GET', '/v1/agent/inbox?unread=true&limit=20')
        return r.get('data', [])

    def ack_inbox(self, inbox_id):
        return self.api('POST', f'/v1/agent/inbox/{inbox_id}/ack', {})

    def get_assigned_tasks(self):
        r = self.api('GET', '/v1/agent/assigned-tasks')
        return r.get('data', [])

    def claim_task(self, pid, oid, tid):
        return self.api('PATCH', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/claim', {})

    def get_task(self, pid, oid, tid):
        return self.api('GET', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}')

    def submit_task(self, pid, oid, tid, result_md, evidence=None):
        body = {
            'result_md': result_md,
            'evidence': self._heal_evidence(evidence),
            'status': 'ready_for_review',
        }
        r = self.api('POST', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete', body)
        if r.get('_error') == 422 and 'files_changed' in str(r.get('detail', '')):
            print(f"  [executor] evidence auto-heal: fixing files_changed and retrying", flush=True)
            body['evidence'] = self._heal_evidence(body['evidence'], force=True)
            r = self.api('POST', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete', body)
            if not r.get('_error'):
                print(f"  [executor] auto-heal succeeded on retry", flush=True)
        return r

    def _heal_evidence(self, evidence, force=False):
        if evidence is None:
            evidence = {}
        if not isinstance(evidence, dict):
            evidence = {}
        if force or 'files_changed' not in evidence:
            evidence['files_changed'] = evidence.get('files_changed') or []
        if not isinstance(evidence.get('files_changed'), list):
            evidence['files_changed'] = []
        if 'test_passed' not in evidence:
            evidence['test_passed'] = None
        return evidence

    def detect_code_changes(self):
        """Detect uncommitted file changes in the working directory.

        Prefers ``git diff --name-only HEAD`` (plus untracked files via
        ``git ls-files --others --exclude-standard``), which is reliable. Degrades
        to the snapshot-mtime method when the cwd is not a git repo or git is
        unavailable. Returns a list of file ops:
          - modified / new  -> {path, op: 'upsert', content}
          - deleted         -> {path, op: 'delete', content: ''}
        """
        import os as _os
        cwd = _os.getcwd()
        # R9a: try git first (replaces the unreliable snapshot-mtime detection).
        try:
            return self._detect_code_changes_git(cwd)
        except Exception as e:
            print(f"  ⚠ git diff unavailable ({e}); falling back to snapshot-mtime detection", flush=True)
        try:
            return self._detect_code_changes_snapshot(cwd)
        except Exception as e:
            print(f"  ⚠ detect_code_changes error: {e}", flush=True)
            return []

    def _detect_code_changes_git(self, cwd):
        """Detect changes via git. Raises on non-git cwd / missing git binary."""
        import os as _os
        # Tracked files modified or deleted vs HEAD.
        diff = subprocess.run(
            ['git', 'diff', '--name-only', 'HEAD'],
            capture_output=True, text=True, cwd=cwd, check=True,
        )
        tracked = [ln for ln in diff.stdout.splitlines() if ln.strip()]
        # Untracked new files (respecting .gitignore / .git/info/exclude).
        others = subprocess.run(
            ['git', 'ls-files', '--others', '--exclude-standard'],
            capture_output=True, text=True, cwd=cwd, check=True,
        )
        untracked = [ln for ln in others.stdout.splitlines() if ln.strip()]

        # Skip patterns preserved from the snapshot method.
        skip_tokens = ('.agent/', 'node_modules/', 'dist/')

        def _skip(path):
            norm = path.replace('\\', '/')
            if 'snapshot' in norm:  # never submit the snapshot file itself
                return True
            return any(tok in norm for tok in skip_tokens)

        def _read(path):
            try:
                with open(_os.path.join(cwd, path), 'r') as f:
                    return f.read()
            except (IOError, UnicodeDecodeError):
                return None

        file_ops = []
        seen = set()
        # Tracked changes: modified vs HEAD. A path missing from disk was deleted.
        for path in tracked:
            if _skip(path) or path in seen:
                continue
            seen.add(path)
            if not _os.path.exists(_os.path.join(cwd, path)):
                file_ops.append({'path': path, 'op': 'delete', 'content': ''})
            else:
                content = _read(path)
                if content is not None:
                    file_ops.append({'path': path, 'op': 'upsert', 'content': content})
        # Untracked new files: always upserts.
        for path in untracked:
            if _skip(path) or path in seen:
                continue
            seen.add(path)
            content = _read(path)
            if content is not None:
                file_ops.append({'path': path, 'op': 'upsert', 'content': content})

        print(f"  🔍 detect: {len(file_ops)} changed files "
              f"(git diff: {len(tracked)} tracked, {len(untracked)} untracked)", flush=True)
        return file_ops

    def _detect_code_changes_snapshot(self, cwd):
        """Fallback: snapshot-mtime comparison for non-git working dirs.

        Cannot distinguish deletions, so only emits op='upsert' for new/modified
        files. Kept as a safety net for cwd that is not a git repo.
        """
        import os as _os
        import json as _json
        snapshot_file = _os.path.join(cwd, '.zz-agent-file-snapshot.json')
        # Walk the working directory (top-level + a few levels deep).
        skip_dirs = {'.git', 'node_modules', 'dist', '__pycache__', '.zz-agent', 'backend/dist'}
        current_files = {}
        for root, dirs, files in _os.walk(cwd):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            depth = root.replace(cwd, '').count(_os.sep)
            if depth > 3:
                dirs[:] = []
                continue
            for fname in files:
                fpath = _os.path.join(root, fname)
                relpath = _os.path.relpath(fpath, cwd)
                try:
                    mtime = _os.path.getmtime(fpath)
                    current_files[relpath] = mtime
                except OSError:
                    pass

        # Load previous snapshot.
        prev_files = {}
        if _os.path.exists(snapshot_file):
            try:
                with open(snapshot_file) as f:
                    prev_files = _json.load(f)
            except Exception:
                pass

        # Find new or modified files.
        changed = []
        for relpath, mtime in current_files.items():
            if relpath not in prev_files or prev_files[relpath] != mtime:
                # Skip the snapshot file itself + .agent artifacts.
                if 'snapshot' in relpath or relpath.startswith('.agent/'):
                    continue
                changed.append(relpath)

        # Save snapshot.
        try:
            with open(snapshot_file, 'w') as f:
                _json.dump(current_files, f)
        except OSError:
            pass

        print(f"  🔍 detect: {len(changed)} changed files "
              f"(snapshot mtime, of {len(current_files)} tracked)", flush=True)
        if not changed:
            return []

        file_ops = []
        for path in changed:
            try:
                abs_path = _os.path.join(cwd, path)
                with open(abs_path, 'r') as f:
                    content = f.read()
                file_ops.append({'path': path, 'op': 'upsert', 'content': content})
            except (IOError, UnicodeDecodeError):
                pass
        return file_ops

    def submit_code_changeset(self, pid, oid, tid, file_ops):
        """Submit actual code changes as a changeset before completing the task.

        Returns the changeset id, or None if submission failed. Always fetches a
        base_revision_id for files that already exist on the platform, and honors
        the per-op 'op' field ('upsert' by default, or 'delete' for removed files).
        """
        if not file_ops:
            return None
        enriched_ops = []
        for op in file_ops:
            path = op['path']
            op_type = op.get('op') or 'upsert'
            # Always fetch base_revision_id for existing files (needed for both
            # upsert against the right revision and delete of the right revision).
            r = self.api('GET', f'/v1/projects/{pid}/files?exact_path={path}')
            data = r.get('data', [])
            base_rev = data[0].get('current_revision_id') if data else None
            new_op = {'op': op_type, 'path': path, 'content': op.get('content', '')}
            if base_rev:
                new_op['base_revision_id'] = base_rev
            enriched_ops.append(new_op)

        body = {
            'title': f'Worker code changes (task {tid[:8]})',
            'status': 'submitted',
            'file_ops': enriched_ops,
            'orchestration_id': oid,
        }
        r = self.api('POST', f'/v1/projects/{pid}/changesets', body)
        cs_id = r.get('id')
        if cs_id:
            print(f"  📦 submitted code changeset ({len(enriched_ops)} files): {cs_id[:8]}", flush=True)
        else:
            print(f"  ⚠ code changeset submission failed: {r.get('detail', '?')}", flush=True)
        return cs_id

    def review_changeset(self, pid, cs_id, decision, notes=''):
        return self.api('PATCH', f'/v1/projects/{pid}/changesets/{cs_id}/review', {'decision': decision, 'notes': notes})

    def verify_build(self):
        """Run npm run build in the project's backend dir to verify code compiles.

        Returns True if build succeeds, False otherwise. Best-effort: if
        npm/node not found or build script missing, returns True (skip gate).
        """
        import os as _os
        cwd = _os.getcwd()
        backend_dir = _os.path.join(cwd, 'backend') if _os.path.isdir(_os.path.join(cwd, 'backend')) else cwd
        try:
            r = subprocess.run(
                ['npm', 'run', 'build'],
                capture_output=True, text=True, timeout=300, cwd=backend_dir,
            )
            if r.returncode == 0:
                print(f"  ✅ build passed (PM quality gate)", flush=True)
                return True
            else:
                stderr_tail = (r.stderr or '')[-500:]
                print(f"  ❌ build FAILED (PM quality gate blocked merge)", flush=True)
                print(f"     stderr: {stderr_tail[:200]}", flush=True)
                return False
        except (subprocess.TimeoutExpired, FileNotFoundError):
            print(f"  ⚠ build gate skipped (npm not found or timeout)", flush=True)
            return True

    def merge_changeset(self, pid, cs_id):
        return self.api('POST', f'/v1/projects/{pid}/changesets/{cs_id}/merge', {})

    def review_task(self, pid, oid, tid, decision, notes=''):
        return self.api('PATCH', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/review', {'decision': decision, 'notes': notes})

    def find_changeset_for_task(self, pid, task_id):
        r = self.api('GET', f'/v1/projects/{pid}/changesets?limit=20')
        for c in r.get('data', []):
            if c.get('task_id') == task_id and c.get('status') == 'submitted':
                return c.get('id')
        return None

    def get_project_id(self):
        if self.project_id:
            return self.project_id
        r = self.api('GET', '/v1/agent/projects')
        projects = r.get('data', [])
        if projects:
            p = projects[0]
            self.project_id = (p.get('project') or {}).get('id') or p.get('project_id') or p.get('id')
            # Grab the agent's own endpoint so its brain can execute.
            agent_info = (p.get('agent') or {})
            self.agent_endpoint = agent_info.get('endpoint_url') or agent_info.get('config', {}).get('endpoint_url')
            return self.project_id
        return ''

    def get_code_map(self, project_id):
        r = self.api('GET', f'/v1/projects/{project_id}/files?limit=200')
        files = r.get('data', [])
        for f in files:
            if 'code-map' in f.get('path', '').lower():
                raw = self.api('GET', f"/v1/projects/{project_id}/files/{f['id']}/raw")
                if isinstance(raw, str):
                    return raw[:3000]
        return ''

    # ═══════════════════════════════════════════════════
    # WORKING COPY SYNC: keep the worker base fresh with the platform HEAD.
    # ═══════════════════════════════════════════════════

    def sync_base(self, working_copy=None, project_id=None):
        if working_copy is None:
            working_copy = self.project_dir
        """Refresh the worker working copy to the platform's current git HEAD.

        Detects the local git HEAD, compares it to the platform HEAD, and resets
        hard when the copy is clean and stale. If uncommitted changes exist, it
        skips the reset and reports needs_manual_sync=True. Git failures degrade
        gracefully (log + continue) so a missing git binary or non-git cwd does
        not kill the worker loop.

        Returns a dict with:
            synced, needs_manual_sync, local_head, platform_head, error
        """
        pid = project_id or self.project_id
        result = {
            'synced': False,
            'needs_manual_sync': False,
            'local_head': None,
            'platform_head': None,
            'error': None,
        }
        if not pid:
            result['error'] = 'no project_id'
            print(f"  ⚠ sync_base: no project_id", flush=True)
            return result

        try:
            local_r = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                capture_output=True, text=True, cwd=working_copy,
            )
            if local_r.returncode != 0:
                err = (local_r.stderr or '').strip() or 'git rev-parse failed'
                result['error'] = err
                print(f"  ⚠ sync_base: {err}", flush=True)
                return result
            local_head = local_r.stdout.strip()
            result['local_head'] = local_head
        except FileNotFoundError:
            result['error'] = 'git binary not found'
            print(f"  ⚠ sync_base: git binary not found", flush=True)
            return result
        except Exception as e:
            result['error'] = str(e)
            print(f"  ⚠ sync_base: {e}", flush=True)
            return result

        try:
            # Prefer the real-git log endpoint; fall back to branch list head_commit_id.
            platform_head = None
            r = self.api('GET', f'/v1/projects/{pid}/git/log')
            platform_head = r.get('head') or r.get('head_commit_id')
            if not platform_head:
                branches = self.api('GET', f'/v1/projects/{pid}/branches')
                for b in branches.get('data', []):
                    if b.get('is_default') or b.get('name') == 'main':
                        platform_head = b.get('head_commit_id')
                        break
                if not platform_head and branches.get('data'):
                    platform_head = branches['data'][0].get('head_commit_id')
            result['platform_head'] = platform_head
        except Exception as e:
            result['error'] = f'platform HEAD fetch failed: {e}'
            print(f"  ⚠ sync_base: platform HEAD fetch failed: {e}", flush=True)
            return result

        if not platform_head:
            result['error'] = 'platform HEAD unavailable'
            print(f"  ⚠ sync_base: platform HEAD unavailable", flush=True)
            return result

        if local_head == platform_head:
            print(f"  ✓ sync_base: working copy already at {local_head[:12]}", flush=True)
            return result

        try:
            status_r = subprocess.run(
                ['git', 'status', '--porcelain'],
                capture_output=True, text=True, cwd=working_copy,
            )
            dirty = bool(status_r.stdout.strip())
        except Exception as e:
            result['error'] = f'git status failed: {e}'
            print(f"  ⚠ sync_base: git status failed: {e}", flush=True)
            return result

        if dirty:
            result['needs_manual_sync'] = True
            print(
                f"  ⚠ sync_base: working copy has uncommitted changes "
                f"(local {local_head[:12]} vs platform {platform_head[:12]}); "
                f"manual sync needed", flush=True
            )
            return result

        try:
            fetch_r = subprocess.run(
                ['git', 'fetch', 'origin'],
                capture_output=True, text=True, cwd=working_copy,
            )
            if fetch_r.returncode != 0:
                err = (fetch_r.stderr or '').strip() or 'git fetch failed'
                result['error'] = err
                print(f"  ⚠ sync_base: {err}", flush=True)
                return result
            reset_r = subprocess.run(
                ['git', 'reset', '--hard', platform_head],
                capture_output=True, text=True, cwd=working_copy,
            )
            if reset_r.returncode != 0:
                err = (reset_r.stderr or '').strip() or 'git reset failed'
                result['error'] = err
                print(f"  ⚠ sync_base: {err}", flush=True)
                return result
            result['synced'] = True
            print(
                f"  ✓ sync_base: reset {local_head[:12]} → {platform_head[:12]}", flush=True
            )
            return result
        except Exception as e:
            result['error'] = f'git sync failed: {e}'
            print(f"  ⚠ sync_base: git sync failed: {e}", flush=True)
            return result

    # ═══════════════════════════════════════════════════
    # EXECUTION: relay the task to the agent's own brain.
    # No brain → no execution (caller surfaces instead).
    # ═══════════════════════════════════════════════════

    def execute_task(self, task, pid, oid, code_map=''):
        """Relay task to the agent's own brain. Returns {result_md, evidence} or None."""
        task_ctx = {
            'task_id': task.get('id'),
            'title': task.get('title'),
            'goal': task.get('goal'),
            'acceptance_criteria': task.get('acceptance_criteria', []),
            'project_id': pid,
            'orchestration_id': oid,
            'code_map': code_map[:2000] if code_map else '',
        }
        task_json = json.dumps(task_ctx)

        # Manual (interactive session)
        if self.manual:
            return self._manual_execute(task_ctx)

        # External handler (bridge to the agent's own runtime)
        if self.handler_cmd:
            return self._external_handler(task_ctx, task_json)

        # Agent's own endpoint (its brain)
        if self.agent_endpoint:
            result = self._call_endpoint(task_ctx)
            if result:
                return result
            print(f"  ⚠ endpoint failed, no other brain available", flush=True)
            return None

        # Headless LLM fallback (only if explicitly opted in)
        if self.llm is not None and self.llm.available:
            print(f"  → headless LLM ({self.llm.provider}/{self.llm.model})", flush=True)
            return self.llm.execute(task_ctx)

        # No brain — should not reach here (caller must guard with has_executor).
        return None

    def _manual_execute(self, task_ctx):
        print(f"\n{'='*60}")
        print(f"Task: {task_ctx.get('title')}")
        print(f"Goal: {task_ctx.get('goal')}")
        print(f"{'='*60}")
        print("Type result (Ctrl+D to finish, empty to skip):")
        try:
            text = sys.stdin.read()
        except KeyboardInterrupt:
            text = ''
        if not text.strip():
            return None
        return {'result_md': text, 'evidence': {'mode': 'manual'}}

    def _external_handler(self, task_ctx, task_json):
        try:
            proc = subprocess.run(self.handler_cmd, shell=True, input=task_json,
                                  capture_output=True, text=True, timeout=300)
            output = proc.stdout.strip()
            if not output:
                return {'result_md': f"# Handler Error\nNo output.\nStderr: {proc.stderr[:300]}", 'evidence': {'error': 'empty', 'mode': 'handler'}}
            try:
                result = json.loads(output)
                if 'result_md' not in result:
                    result = {'result_md': output, 'evidence': result}
                ev = result.setdefault('evidence', {}); ev.setdefault('files_changed', []); ev['mode'] = 'handler'
                return result
            except json.JSONDecodeError:
                return {'result_md': output, 'evidence': {'handler': self.handler_cmd, 'mode': 'handler'}}
        except subprocess.TimeoutExpired:
            return {'result_md': "# Timeout\nHandler exceeded 300s.", 'evidence': {'error': 'timeout', 'mode': 'handler'}}
        except Exception as e:
            return {'result_md': f"# Error\n{e}", 'evidence': {'error': str(e), 'mode': 'handler'}}

    # ═══════════════════════════════════════════════════
    # SMOKE TEST: verify the configured handler can run a real (tiny) task.
    # ═══════════════════════════════════════════════════

    def run_smoke_test(self, working_copy=None):
        if working_copy is None:
            working_copy = self.project_dir
        """Run a minimal end-to-end task through the configured handler.

        Verifies the SAME handler used for real tasks (``self.handler_cmd`` via
        ``_external_handler``) can actually execute. Steps:
          1. build a temp file path under the working copy,
          2. invoke the handler with a tiny task whose goal is "create file
             <path> with content ok then respond done",
          3. check the temp file was created with the expected content,
          4. clean up the temp file,
          5. return ``{healthy, last_error, duration_ms}``.

        Everything is wrapped in try/except so any failure (handler not found,
        timeout, file not created, permission denied, …) yields a clear
        ``last_error`` string instead of raising.
        """
        start = time.time()
        result = {'healthy': False, 'last_error': None, 'duration_ms': 0}

        def _finish(healthy, last_error):
            result['healthy'] = bool(healthy)
            result['last_error'] = last_error
            result['duration_ms'] = int((time.time() - start) * 1000)
            return result

        # Only the handler path is smoke-tested. endpoint/manual/headless modes
        # are not covered (and must not be marked unhealthy, which would block
        # dispatch per backend R10b).
        if not self.handler_cmd:
            return _finish(False, 'no handler configured (smoke test requires --handler)')

        # 1. Build the temp file path under the working copy.
        try:
            stamp = int(time.time() * 1000)
            smoke_path = os.path.join(working_copy, f'.zz-smoke-{stamp}.txt')
        except Exception as e:
            return _finish(False, f'could not build smoke file path: {e}')

        # Pre-clean a stale file at that path (extremely unlikely, but be safe).
        try:
            if os.path.exists(smoke_path):
                os.remove(smoke_path)
        except Exception:
            pass

        expected_content = 'ok'

        # 2. Invoke the SAME handler real tasks use. _external_handler normally
        #    swallows subprocess errors and returns an evidence dict with an
        #    `error` key; we still wrap the call defensively in case a future
        #    change (or a test mock) lets it raise.
        task_ctx = {
            'task_id': 'smoke-test',
            'title': 'smoke',
            'goal': f'create file {smoke_path} with content {expected_content} then respond done',
            'acceptance_criteria': [],
            'project_id': self.project_id or '',
            'orchestration_id': '',
            'code_map': '',
            'smoke_test': True,
        }
        task_json = json.dumps(task_ctx)
        try:
            out = self._external_handler(task_ctx, task_json)
        except subprocess.TimeoutExpired:
            return _finish(False, 'handler timed out (smoke test exceeded timeout)')
        except FileNotFoundError as e:
            return _finish(False, f'handler not found: {e}')
        except PermissionError as e:
            return _finish(False, f'permission denied invoking handler: {e}')
        except Exception as e:
            return _finish(False, f'handler raised: {e}')

        # _external_handler returns {result_md, evidence}; an evidence `error`
        # means the handler itself failed (empty output, timeout, missing binary,
        # permission, …). Map each to a clear last_error.
        ev = (out or {}).get('evidence') or {}
        err = ev.get('error')
        if err:
            msg = self._classify_handler_error(err)
            return _finish(False, msg)

        # 3. Verify the temp file was created with the expected content.
        try:
            if not os.path.exists(smoke_path):
                return _finish(False, f'handler did not create smoke file {smoke_path}')
            with open(smoke_path, 'r') as f:
                actual = f.read().strip()
            if actual != expected_content:
                return _finish(
                    False,
                    f'smoke file content mismatch: expected {expected_content!r}, got {actual!r}',
                )
        except PermissionError as e:
            return _finish(False, f'permission denied reading smoke file: {e}')
        except Exception as e:
            return _finish(False, f'could not verify smoke file: {e}')
        finally:
            # 4. Always clean up the temp file, success or failure.
            try:
                if os.path.exists(smoke_path):
                    os.remove(smoke_path)
            except Exception:
                pass

        return _finish(True, None)

    @staticmethod
    def _classify_handler_error(err):
        """Turn an _external_handler evidence `error` value into a clear message."""
        if err == 'timeout':
            return 'handler timed out (smoke test exceeded timeout)'
        if err == 'empty':
            return 'handler produced no output (command not found or crashed)'
        s = str(err).lower()
        if 'no such file' in s or 'not found' in s or 'errno 2' in s:
            return f'handler not found: {err}'
        if 'permission denied' in s or 'errno 13' in s:
            return f'permission denied invoking handler: {err}'
        return f'handler error: {err}'

    def _maybe_run_periodic_smoke(self, force=False):
        """Run a smoke test if the handler is configured and the interval elapsed.

        Stores the result on ``self.last_smoke_result`` so the next heartbeat
        reports it to the platform. No-op (and no health report) when no handler
        is configured, so endpoint/manual/headless agents keep dispatch open.
        """
        if not self.handler_cmd:
            return
        try:
            res = self.run_smoke_test()
        except Exception as e:
            # run_smoke_test is meant to catch everything; stay defensive anyway.
            res = {'healthy': False, 'last_error': f'smoke test crashed: {e}', 'duration_ms': 0}
        self.last_smoke_result = res
        self.last_smoke_at = time.time()
        ts = time.strftime('%H:%M:%S')
        if res.get('healthy'):
            print(f"[{ts}] 🟢 smoke-test: handler healthy ({res.get('duration_ms')}ms)", flush=True)
        else:
            print(f"[{ts}] 🔴 smoke-test: UNHEALTHY — {res.get('last_error')}", flush=True)

    def _call_endpoint(self, task_ctx):
        """POST task to the agent's own endpoint — its brain executes."""
        try:
            url = self.agent_endpoint
            body = json.dumps(task_ctx).encode()
            req = urllib.request.Request(url, data=body, method='POST')
            req.add_header('Content-Type', 'application/json')
            with urllib.request.urlopen(req, timeout=300) as resp:
                d = json.loads(resp.read())
                ev = d.get('evidence', {'endpoint': url})
                ev.setdefault('mode', 'endpoint')
                return {'result_md': d.get('result_md', str(d)), 'evidence': ev}
        except Exception as e:
            print(f"  ⚠ endpoint error: {e}", flush=True)
            return None

    # ═══════════════════════════════════════════════════
    # SURFACE: no brain → show the task, claim nothing.
    # ═══════════════════════════════════════════════════

    def surface_task(self, item, source='inbox'):
        """Print a waiting task clearly without claiming it."""
        ts = time.strftime('%H:%M:%S')
        print(f"\n[{ts}] 📬 Task waiting (not claimed — no executor configured)", flush=True)
        print(f"    source : {source}", flush=True)
        print(f"    title  : {item.get('title', '')}", flush=True)
        goal = (item.get('goal') or '')[:120]
        if goal:
            print(f"    goal   : {goal}{'…' if len(item.get('goal') or '') > 120 else ''}", flush=True)
        tid = item.get('task_id') or item.get('id')
        oid = item.get('orchestration_id')
        pid = item.get('project_id')
        if tid:
            print(f"    task_id: {tid}", flush=True)
        if oid and pid:
            print(f"    claim  : PATCH /v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/claim", flush=True)
        print(f"    hint   : run with --handler, --manual, or set agent endpoint_url to execute.", flush=True)

    # ═══════════════════════════════════════════════════
    # WORKER: claim + lay out TASK.md (always), then execute (if brain)
    # ═══════════════════════════════════════════════════

    def process_worker_task(self, inbox_item, pid, oid, tid):
        # Sync the worker working copy to the platform HEAD before any task work.
        # This prevents stale-base changesets (R8). Errors are logged and the task
        # continues — a missing git binary or non-git cwd must not block execution.
        self.project_id = pid or self.project_id
        try:
            self.sync_base(working_copy=self.project_dir)
        except Exception as e:
            print(f"  ⚠ sync_base failed, continuing: {e}", flush=True)

        iid = inbox_item.get('id')
        self.ack_inbox(iid)
        print(f"  ✓ acked", flush=True)

        # ── Layer 1: TRANSPORT (executor's job, always runs) ──────────────
        # Claim + lay out TASK.md so the agent body can pick it up. This is the
        # executor's core job — it must NOT be skipped just because no "brain"
        # (endpoint/handler/headless) is configured. hermes-lan-002 proved the
        # right contract: claim → read TASK.md → write RESULT.md → submit. The
        # agent body does the thinking; the executor does the carrying.
        claim = self.claim_task(pid, oid, tid)
        if claim.get('_error'):
            print(f"  ✗ claim failed: {claim.get('detail', claim.get('_error'))}", flush=True)
            return False
        print(f"  ✓ claimed", flush=True)

        task = self.get_task(pid, oid, tid)
        if task.get('_error'):
            print(f"  ✗ get_task failed", flush=True)
            return False

        # Lay out TASK.md for the agent body. Print goal + acceptance criteria
        # clearly so a live agent reading this log (or polling get_task) can act.
        self._lay_out_task(task, pid, oid, tid)

        # ── Layer 2: EXECUTE (only if a brain is configured) ───────────────
        if not self.has_executor:
            # No brain configured. Task is CLAIMED and TASK.md is laid out.
            # A live agent body (like hermes-lan-002) now reads TASK.md, does the
            # work, writes RESULT.md, and calls submit itself. The executor stops
            # here — it has done its transport job. Staleness sweep will notify
            # the PM if the agent body never picks it up.
            print(f"  ⏸ claimed + TASK.md laid out — waiting for agent body to act", flush=True)
            print(f"     agent body should: read TASK.md → do work → POST .../tasks/{tid}/complete", flush=True)
            return True

        code_map = self.get_code_map(pid)

        print(f"  → executing via {self.executor_label}", flush=True)
        result = self.execute_task(task, pid, oid, code_map)
        if result is None:
            # Execution declined (e.g. manual skip, endpoint down). Release the claim
            # by leaving status — but we already acked the inbox; surface for retry.
            print(f"  ⚠ execution declined, task left for retry", flush=True)
            return False
        result_md = result.get('result_md', '')
        print(f"  ✓ produced ({len(result_md)} chars)", flush=True)

        # ── R8 break-glass: empty-output guard ───────────────────────────────
        # A handler that produced no real content (e.g. FileNotFoundError on the
        # CLI binary, invoke endpoint down) used to silently submit an empty
        # result_md as ready_for_review, which the PM then had to reject. Block
        # that here: if result_md is empty or too short to be a real deliverable
        # AND no code changeset was produced, submit as `blocked` with a clear
        # reason instead of pretending the work is done.
        result_stripped = (result_md or '').strip()
        looks_empty = len(result_stripped) < 50  # real deliverables are longer
        code_changeset_submitted = False

        # Detect and submit code changes (if the handler's CLI modified files)
        try:
            code_changes = self.detect_code_changes()
            if code_changes:
                cs_id = self.submit_code_changeset(pid, oid, tid, code_changes)
                if cs_id:
                    code_changeset_submitted = True
            else:
                print(f"  (no code changes detected in working dir)", flush=True)
        except Exception as ce:
            print(f"  ⚠ code change detection skipped: {ce}", flush=True)

        if looks_empty and not code_changeset_submitted:
            print(f"  ⛔ empty-output guard: handler produced no real deliverable ({len(result_stripped)} chars) and no code changeset — submitting as blocked, not ready_for_review", flush=True)
            blocked_body = {
                'result_md': f"# Blocked: empty handler output\n\nThe worker handler produced no real deliverable (output was {len(result_stripped)} chars) and no code changes were detected.\n\nLikely causes:\n- The handler CLI binary is not on PATH in the launchd environment\n- The invoke endpoint is down or misconfigured\n- The handler raised an exception (FileNotFoundError, timeout)\n\nThis task was NOT marked ready_for_review to avoid a PM round-trip rejection. Please fix the handler/executor environment and re-dispatch.",
                'evidence': self._heal_evidence({**(result.get('evidence') or {}), 'blocked_reason': 'empty_output', 'produced_chars': len(result_stripped)}),
                'status': 'blocked',
            }
            submit = self.api('POST', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete', blocked_body)
            if submit.get('_error'):
                print(f"  ✗ blocked-submit failed: {submit.get('detail')}", flush=True)
                return False
            print(f"  ✓ submitted (status: blocked — empty-output guard)", flush=True)
            return True

        submit = self.submit_task(pid, oid, tid, result_md, result.get('evidence'))
        if submit.get('_error'):
            print(f"  ✗ submit failed: {submit.get('detail')}", flush=True)
            return False
        print(f"  ✓ submitted (status: {submit.get('status')})", flush=True)
        return True

    def _lay_out_task(self, task, pid, oid, tid):
        """Print the TASK.md content clearly so the agent body can act on it.

        This is the 'lay out TASK.md' step: claim already happened, so the task
        is assigned and readable. We surface goal + criteria + artifact refs so
        a live agent (polling this daemon's output, or the platform) sees exactly
        what to do and where to write the result.
        """
        print(f"  ── TASK.md ──────────────────────────────────────", flush=True)
        print(f"     title   : {task.get('title','')}", flush=True)
        goal = task.get('goal', '')
        print(f"     goal    : {goal[:200]}{'…' if len(goal) > 200 else ''}", flush=True)
        criteria = task.get('acceptance_criteria') or []
        if criteria:
            print(f"     criteria:", flush=True)
            for c in criteria[:8]:
                print(f"       - {c}", flush=True)
        meta = task.get('metadata') or {}
        artifacts = meta.get('md_artifacts') or {}
        if artifacts:
            print(f"     artifacts:", flush=True)
            for k in ('task', 'result', 'evidence', 'review'):
                if artifacts.get(k):
                    print(f"       {k:8}: {artifacts[k]}", flush=True)
        print(f"     get     : GET /v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}", flush=True)
        print(f"     submit  : POST /v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete", flush=True)
        print(f"  ─────────────────────────────────────────────────", flush=True)

    # ═══════════════════════════════════════════════════
    # PM: review + merge (no brain needed)
    # ═══════════════════════════════════════════════════

    def process_pm_review(self, inbox_item, pid):
        tid = inbox_item.get('task_id')
        oid = inbox_item.get('orchestration_id')
        self.ack_inbox(inbox_item.get('id'))
        print(f"  ✓ acked review notification", flush=True)

        if not tid:
            print(f"  ✗ no task_id", flush=True)
            return False

        cs_id = self.find_changeset_for_task(pid, tid)
        if cs_id:
            print(f"  📌 changeset {cs_id[:12]} ready for PM review — NOT auto-merging", flush=True)
            print(f"     PM (human/agent) must verify build + test before merge.", flush=True)
            # Do NOT auto-approve or auto-merge. Just surface it.
            # The PM (I/ZCode) will be notified via inbox and handle review manually.

        if oid:
            # Mark task as ready_for_review (already is), don't auto-approve
            print(f"  📌 task {tid[:8]} waiting for PM review", flush=True)
        return True

    def _pm_review_recovery(self, pid):
        """Scan for submitted changesets we missed via inbox and review+merge them.

        Inbox notifications can be acked/expired/missed, leaving approved tasks
        with changesets stranded in 'submitted'. This recovery path lists recent
        changesets each cycle and processes any that are still 'submitted'
        (auto-review + merge). Idempotent: merged changesets are skipped.
        """
        # Paginate to cover all submitted changesets (limit caps at ~20/page).
        submitted = []
        offset = 0
        for _ in range(10):  # cap at 200 changesets
            r = self.api('GET', f'/v1/projects/{pid}/changesets?limit=20&offset={offset}')
            page = r.get('data', [])
            if not page:
                break
            submitted.extend(c for c in page if c.get('status') == 'submitted')
            if len(page) < 20:
                break
            offset += 20
        if not submitted:
            return
        ts = time.strftime('%H:%M:%S')
        print(f"\n[{ts}] 📋 PM Recovery: {len(submitted)} submitted changeset(s) waiting for PM review", flush=True)
        for c in submitted:
            cs_id = c.get('id')
            title = (c.get('title') or '')[:50]
            code_files = [op.get('path','') for op in c.get('file_ops',[]) if not op.get('path','').startswith('.agent')]
            print(f"  📌 {cs_id[:12]}: {title} ({len(code_files)} code files) — waiting for PM review", flush=True)
            # Do NOT auto-approve, auto-merge, or auto-approve tasks.
            # PM (human/agent) must verify build + test before any merge.

    # ═══════════════════════════════════════════════════
    # MAIN CYCLE
    # ═══════════════════════════════════════════════════

    def run_cycle(self):
        # Self-update FIRST: if the platform shipped a newer executor.py, replace
        # this process before doing anything else. Returns True if we re-exec'd
        # (the rest of this function never runs in that case).
        if self.maybe_self_update():
            return

        _hb = self.heartbeat()
        pending = _hb.get('pending_inbox_count', 0) if isinstance(_hb, dict) else 0

        pid = self.get_project_id()
        if not pid:
            return

        # Surface onboarding/upgrade guidance now that project_id is known (so
        # printed commands carry the real project ID). Warns when the agent has
        # no invoke endpoint — the reason dispatched tasks never wake its brain.
        onboarding = getattr(self, '_onboarding_cache', {})
        if onboarding:
            self._surface_onboarding(onboarding)

        # Inbox may be empty (all acked) but tasks can still be dispatched/
        # changes_requested in the DB (e.g. inbox acked before claim, or task
        # reassigned). So we ALWAYS check assigned-tasks for recovery, even when
        # pending==0. The inbox pull below is only for live notifications.
        inbox_items = []
        if pending > 0:
            inbox_items = self.get_inbox()

        # Ack noise items first
        for item in inbox_items:
            etype = item.get('event_type', '')
            if etype not in ('task_dispatched', 'task_ready_for_review'):
                self.ack_inbox(item.get('id'))

        # Re-pull
        inbox_items = self.get_inbox()

        # PM: process reviews (no executor needed — pure API calls)
        # Two sources: (a) live inbox notifications, (b) recovery — submitted
        # changesets whose review notification was acked/expired/missed. Without
        # recovery, approved tasks get stranded with changesets stuck in
        # 'submitted' forever (13 cases observed in production).
        if not self.worker_only:
            reviews = [i for i in inbox_items if i.get('event_type') == 'task_ready_for_review']
            for item in reviews:
                ts = time.strftime('%H:%M:%S')
                print(f"\n[{ts}] 📋 PM Review: {item.get('title','')[:50]}", flush=True)
                self.process_pm_review(item, pid)

            # PM recovery: scan submitted changesets we haven't reviewed yet.
            # These are deliverables waiting for PM action that we may have missed
            # via inbox (acked notification, lease expiry, etc).
            self._pm_review_recovery(pid)

        # Worker: process dispatches. ALWAYS process — the executor's transport
        # job (claim + lay out TASK.md) runs regardless of whether a "brain"
        # (endpoint/handler/headless) is configured. A live agent body reads
        # TASK.md and writes RESULT.md itself; the executor just carries.
        # has_executor only gates the EXECUTE step, not the CLAIM step.
        if not self.pm_only:
            dispatches = [i for i in inbox_items if i.get('event_type') == 'task_dispatched']

            for item in dispatches:
                tid = item.get('task_id')
                oid = item.get('orchestration_id')
                item_pid = item.get('project_id') or pid
                if not tid or not oid:
                    self.ack_inbox(item.get('id'))
                    continue
                ts = time.strftime('%H:%M:%S')
                print(f"\n[{ts}] 🔧 Worker Task: {item.get('title','')[:50]}", flush=True)
                self.process_worker_task(item, item_pid, oid, tid)

            # Recovery: unclaimed assigned tasks.
            # R8 break-glass: also recover tasks stuck in `running` but never
            # actually claimed (claimed_at is null). This happens when the
            # backend auto-transitions dispatch→running on notification but the
            # worker never ran process_worker_task (e.g. invoke endpoint down,
            # executor restarted mid-cycle). Without this, such tasks are
            # orphaned forever — status=running, claimed_at=null, empty output.
            assigned = self.get_assigned_tasks()
            def _is_recoverable(t):
                s = t.get('status')
                if s in ('dispatched', 'changes_requested'):
                    return True
                # running but never claimed → re-pick (check both snake/camel)
                if s == 'running' and not (t.get('claimed_at') or t.get('claimedAt')):
                    return True
                return False
            unclaimed = [t for t in assigned if _is_recoverable(t)]
            for task in unclaimed:
                tid = task.get('id')
                oid = task.get('orchestration_id')
                task_pid = task.get('project_id') or pid
                if tid and oid:
                    ts = time.strftime('%H:%M:%S')
                    print(f"\n[{ts}] 🔧 Unclaimed: {task.get('title','')[:50]}", flush=True)
                    self.process_worker_task({'id': 'recovery', 'event_type': 'task_dispatched'}, task_pid, oid, tid)

    def run(self):
        exec_mode = 'PM' if self.pm_only else 'Worker' if self.worker_only else 'Full (PM+Worker)'
        print(f"🤖 Agent Executor Daemon (relay-first)", flush=True)
        print(f"   Mode: {exec_mode}", flush=True)
        print(f"   Interval: {self.interval}s", flush=True)
        if self.has_executor:
            print(f"   Brain : {self.executor_label}  (claim → execute → submit)", flush=True)
        else:
            print(f"   Brain : ✗ none configured — will CLAIM + lay out TASK.md, agent body acts", flush=True)
            print(f"           (a live agent reads TASK.md, writes RESULT.md, calls submit itself)", flush=True)
            print(f"           to self-execute: set endpoint_url, or --handler / --manual / --headless", flush=True)
        if self.headless and self.llm is not None and not self.llm.available:
            print(f"   ⚠ --headless set but AGENT_LLM_API_KEY missing; headless path inactive", flush=True)
        print(f"   OS: {platform.system()} {platform.machine()}", flush=True)
        print(f"   Ctrl+C to stop.", flush=True)

        # R10a: smoke-test the handler once on startup so a broken/misconfigured
        # handler is caught immediately and reported unhealthy in the first
        # heartbeat. No-op when no handler is configured.
        self._maybe_run_periodic_smoke(force=True)

        while self.running:
            try:
                self.run_cycle()
            except KeyboardInterrupt:
                print("\nStopping...", flush=True)
                self.running = False
                break
            except Exception as e:
                print(f"[{time.strftime('%H:%M:%S')}] Error: {e}", flush=True)
            self._cycle_count += 1
            # R10a: re-run the smoke test every N heartbeats (default 10 cycles,
            # ~5min at the default 30s interval). Configurable via the env var.
            if self.smoke_interval > 0 and self._cycle_count % self.smoke_interval == 0:
                self._maybe_run_periodic_smoke()
            time.sleep(self.interval)


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description='Agent Executor Daemon (relay-first)')
    p.add_argument('--base-url', required=True)
    p.add_argument('--api-key', required=True)
    p.add_argument('--handler', default='')
    p.add_argument('--interval', type=int, default=30)
    p.add_argument('--manual', action='store_true')
    p.add_argument('--pm-only', action='store_true')
    p.add_argument('--worker-only', action='store_true')
    p.add_argument('--headless', action='store_true',
                   help='Use built-in LLM fallback (only for nodes with no brain of their own)')
    p.add_argument('--no-self-update', action='store_true',
                   help='Disable automatic re-download when the platform ships a newer executor.py')
    p.add_argument('--once', action='store_true')
    args = p.parse_args()

    daemon = ExecutorDaemon(
        base_url=args.base_url, api_key=args.api_key,
        handler_cmd=args.handler, interval=args.interval,
        manual=args.manual, pm_only=args.pm_only, worker_only=args.worker_only,
        headless=args.headless, no_self_update=args.no_self_update,
    )
    if args.once:
        daemon.run_cycle()
    else:
        daemon.run()
