import os
import subprocess
from typing import Any, Dict, List, Optional


class Executor:
    """Local worker executor that detects code changes, submits changesets,
    and (best-effort) commits the result to a worker git branch.
    """

    def __init__(self, base_url: str = "http://localhost:3000", project_dir: str = "."):
        self.base_url = base_url
        self.project_dir = os.path.abspath(project_dir)

    def detect_code_changes(self, task_id: str) -> List[Dict[str, Any]]:
        """Detect local code changes produced for the given task.

        Returns a list of file operations, each with at least a ``path`` key.
        """
        # Placeholder: subclasses or callers can override with real change detection.
        print(f"[executor] detect_code_changes for task {task_id}")
        return []

    def submit_code_changeset(
        self, task_id: str, file_ops: List[Dict[str, Any]]
    ) -> Optional[str]:
        """Submit a changeset to the platform and return the changeset id."""
        # Placeholder: subclasses or callers can override with real backend submission.
        print(f"[executor] submit_code_changeset for task {task_id} ({len(file_ops)} file ops)")
        return None

    def submit_task(self, task_id: str, result: Any) -> bool:
        """Submit the final task result to the platform."""
        # Placeholder: subclasses or callers can override with real backend submission.
        print(f"[executor] submit_task for task {task_id}")
        return True

    def _run_git(
        self, args: List[str], cwd: Optional[str] = None, check: bool = False
    ) -> subprocess.CompletedProcess:
        """Run a git command and return the completed process."""
        return subprocess.run(
            ["git", *args],
            cwd=cwd or self.project_dir,
            capture_output=True,
            text=True,
            check=check,
        )

    def _get_origin_url(self) -> Optional[str]:
        """Try to read the origin URL from an existing git repository."""
        try:
            result = self._run_git(["remote", "-v"])
            if result.returncode != 0:
                return None
            for line in result.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "origin":
                    return parts[1]
        except Exception:
            pass
        return None

    def _ensure_git_repo(self, origin_url: Optional[str]) -> bool:
        """Initialize a git repo if needed and add the origin remote."""
        git_dir = os.path.join(self.project_dir, ".git")
        if os.path.isdir(git_dir):
            return True

        init = self._run_git(["init"])
        if init.returncode != 0:
            print(f"[executor] git init failed: {init.stderr.strip()}")
            return False

        if origin_url:
            add_remote = self._run_git(["remote", "add", "origin", origin_url])
            if add_remote.returncode != 0:
                print(f"[executor] git remote add failed: {add_remote.stderr.strip()}")
        return True

    def git_commit_and_push(
        self, task_id: str, file_ops: List[Dict[str, Any]]
    ) -> Optional[str]:
        """Best-effort git commit + push of the changed files to a worker branch.

        - Creates/checks out ``worker/<task_id[:8]>``.
        - Stages the file paths present in ``file_ops``.
        - Commits with message ``worker: <task_id[:8]> code changes``.
        - Force-pushes the branch to ``origin``.

        Returns the commit SHA on success, or ``None`` if git is unavailable or
        any step fails. Failures are logged but not raised.
        """
        short_id = task_id[:8]
        branch = f"worker/{short_id}"
        commit_message = f"worker: {short_id} code changes"

        # Extract file paths from file_ops. Supports both dicts with a 'path' key
        # and plain strings.
        file_paths: List[str] = []
        for op in file_ops:
            path = op.get("path") if isinstance(op, dict) else op
            if isinstance(path, str) and path:
                file_paths.append(path)

        if not file_paths:
            print(f"[executor] git_commit_and_push: no file paths to stage")
            return None

        try:
            # Verify git is available.
            version = self._run_git(["--version"])
            if version.returncode != 0:
                print("[executor] git not available, skipping commit/push")
                return None

            # Discover origin URL from an existing repo (e.g. the original project dir).
            origin_url = self._get_origin_url()

            # Initialize a repo in the working directory if one does not exist.
            if not self._ensure_git_repo(origin_url):
                return None

            # Configure a fallback user identity so commits succeed even in fresh repos.
            for key, value in [("user.email", "worker@zz-agent.local"), ("user.name", "ZZ Worker")]:
                existing = self._run_git(["config", "--local", key])
                if existing.returncode != 0 or not existing.stdout.strip():
                    self._run_git(["config", "--local", key, value])

            # Create and check out the worker branch.
            checkout = self._run_git(["checkout", "-B", branch])
            if checkout.returncode != 0:
                print(f"[executor] git checkout -B {branch} failed: {checkout.stderr.strip()}")
                return None

            # Stage the changed files.
            add = self._run_git(["add", "--"] + file_paths)
            if add.returncode != 0:
                print(f"[executor] git add failed: {add.stderr.strip()}")
                return None

            # Commit.
            commit = self._run_git(["commit", "-m", commit_message])
            if commit.returncode != 0:
                # Nothing to commit is acceptable; still try to push if there is history.
                if "nothing to commit" in (commit.stdout + commit.stderr).lower():
                    print(f"[executor] nothing to commit on {branch}")
                else:
                    print(f"[executor] git commit failed: {commit.stderr.strip()}")
                    return None

            # Read the commit SHA of the branch tip.
            rev = self._run_git(["rev-parse", branch])
            commit_sha = rev.stdout.strip() if rev.returncode == 0 else None

            # Push (best-effort; may fail if no remote is configured).
            push = self._run_git(["push", "origin", branch, "--force"])
            if push.returncode == 0:
                print(f"[executor] pushed {branch} (sha {commit_sha})")
            else:
                print(f"[executor] git push skipped/failed: {push.stderr.strip()}")

            return commit_sha
        except Exception as exc:
            print(f"[executor] git_commit_and_push error: {exc}")
            return None

    def execute_task(self, task_id: str) -> Any:
        """Run the full worker flow for a task.

        1. Detect local code changes.
        2. Submit a changeset to the platform.
        3. Best-effort commit + push to a worker branch (only if there are file ops).
        4. Submit the final task result.
        """
        file_ops = self.detect_code_changes(task_id)
        changeset_id = self.submit_code_changeset(task_id, file_ops)

        if file_ops:
            self.git_commit_and_push(task_id, file_ops)

        result = self.submit_task(task_id, {"changeset_id": changeset_id})
        return result


if __name__ == "__main__":
    import sys

    task_id = sys.argv[1] if len(sys.argv) > 1 else "ddcb47ac-b247-4095-8d06-ed9646f2b663"
    executor = Executor()
    executor.execute_task(task_id)
