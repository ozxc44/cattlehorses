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
        r = self.api('POST', '/v1/agents/heartbeat', {})
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
        return pending

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
        return self.api('POST', f'/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete', {
            'result_md': result_md, 'evidence': evidence or {'files_changed': []}, 'status': 'ready_for_review',
        })

    def detect_code_changes(self):
        """Detect uncommitted file changes in the working directory via git.

        Returns a list of {path, content} for changed/added files (not deletions).
        Uses git diff against HEAD so it captures both staged and unstaged changes.
        """
        import os as _os
        cwd = _os.getcwd()
        try:
            # Get list of changed files (added/modified, not deleted)
            r = subprocess.run(
                ['git', 'diff', '--name-only', '--diff-filter=AM', 'HEAD'],
                capture_output=True, text=True, timeout=10, cwd=cwd,
            )
            changed = [f.strip() for f in r.stdout.strip().split('\n') if f.strip()]
            # Also check untracked files
            r2 = subprocess.run(
                ['git', 'ls-files', '--others', '--exclude-standard'],
                capture_output=True, text=True, timeout=10, cwd=cwd,
            )
            untracked = [f.strip() for f in r2.stdout.strip().split('\n') if f.strip()]
            all_changed = changed + untracked
            print(f"  🔍 detect_code_changes: cwd={cwd} changed={len(changed)} untracked={len(untracked)}", flush=True)
            if not all_changed:
                return []

            # Read content of each changed file
            file_ops = []
            for path in all_changed:
                try:
                    abs_path = _os.path.join(cwd, path) if not _os.path.isabs(path) else path
                    with open(abs_path, 'r') as f:
                        content = f.read()
                    file_ops.append({'path': path, 'content': content})
                except (IOError, UnicodeDecodeError):
                    pass  # skip binary or unreadable files
            return file_ops
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
            print(f"  ⚠ detect_code_changes error: {e}", flush=True)
            return []

    def submit_code_changeset(self, pid, oid, tid, file_ops):
        """Submit actual code changes as a changeset before completing the task.

        Returns the changeset id, or None if submission failed.
        """
        if not file_ops:
            return None
        # Fetch base_revision_id for each existing file
        enriched_ops = []
        for op in file_ops:
            path = op['path']
            # Check if file exists on platform (need base_revision_id)
            r = self.api('GET', f'/v1/projects/{pid}/files?exact_path={path}')
            data = r.get('data', [])
            base_rev = data[0].get('current_revision_id') if data else None
            new_op = {'op': 'upsert', 'path': path, 'content': op['content']}
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

        # Detect and submit code changes (if the handler's CLI modified files)
        code_changes = self.detect_code_changes()
        if code_changes:
            self.submit_code_changeset(pid, oid, tid, code_changes)
        else:
            print(f"  (no code changes detected in working dir)", flush=True)

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
            print(f"  → reviewing changeset {cs_id[:12]}", flush=True)
            self.review_changeset(pid, cs_id, 'approved', 'Auto-approved by PM executor')
            print(f"  ✓ changeset approved", flush=True)
            merge = self.merge_changeset(pid, cs_id)
            if merge.get('commit'):
                print(f"  ✓ merged (sha: {merge['commit'].get('git_sha','')[:12]})", flush=True)
            elif merge.get('_error'):
                print(f"  ⚠ merge: {merge.get('detail','')}", flush=True)

        if oid:
            task_rev = self.review_task(pid, oid, tid, 'approved', 'Auto-approved by PM executor')
            if not task_rev.get('_error'):
                print(f"  ✓ task approved", flush=True)
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
        print(f"\n[{ts}] 📋 PM Recovery: {len(submitted)} submitted changeset(s) waiting", flush=True)
        for c in submitted:
            cs_id = c.get('id')
            title = (c.get('title') or '')[:50]
            tid = c.get('task_id')
            print(f"  → changeset {cs_id[:12]}: {title}", flush=True)
            # Approve the changeset
            self.review_changeset(pid, cs_id, 'approved', 'Auto-approved by PM executor (recovery)')
            merge = self.merge_changeset(pid, cs_id)
            if merge.get('commit'):
                print(f"  ✓ merged (sha: {merge['commit'].get('git_sha','')[:12]})", flush=True)
            elif merge.get('_error'):
                detail = merge.get('detail', '')
                # 'already merged' / 409 conflict are not fatal — skip silently.
                if 'merge' in detail.lower() or 'conflict' in detail.lower() or merge.get('_error') in (409, 422):
                    print(f"  ⚠ skip: {detail[:60]}", flush=True)
                else:
                    print(f"  ⚠ merge failed: {detail[:60]}", flush=True)
            # Also approve the underlying task if it's ready_for_review
            oid = c.get('orchestration_id')
            if tid and oid:
                task = self.get_task(pid, oid, tid)
                if task.get('status') == 'ready_for_review':
                    self.review_task(pid, oid, tid, 'approved', 'Auto-approved by PM executor (recovery)')
                    print(f"  ✓ task approved", flush=True)

    # ═══════════════════════════════════════════════════
    # MAIN CYCLE
    # ═══════════════════════════════════════════════════

    def run_cycle(self):
        # Self-update FIRST: if the platform shipped a newer executor.py, replace
        # this process before doing anything else. Returns True if we re-exec'd
        # (the rest of this function never runs in that case).
        if self.maybe_self_update():
            return

        pending = self.heartbeat()

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

            # Recovery: unclaimed assigned tasks
            assigned = self.get_assigned_tasks()
            unclaimed = [t for t in assigned if t.get('status') in ('dispatched', 'changes_requested')]
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
        while self.running:
            try:
                self.run_cycle()
            except KeyboardInterrupt:
                print("\nStopping...", flush=True)
                self.running = False
                break
            except Exception as e:
                print(f"[{time.strftime('%H:%M:%S')}] Error: {e}", flush=True)
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
