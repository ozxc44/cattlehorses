"""Smoke test for zz agent watch SDK and CLI behavior.

Covers:
- All production inbox response shapes (top-level list, {data}, {items}, nested)
- Pure JSON stdout in --format json mode
- Prompt contract completeness
- Ack ordering (--no-ack skips)
- No secrets in normal output
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from io import StringIO
from unittest.mock import MagicMock, patch

_repo_root = os.path.dirname(os.path.abspath(__file__))
_sdk_path = os.path.join(_repo_root, "sdk", "python")
_cli_path = os.path.join(_repo_root, "cli")
for p in (_sdk_path, _cli_path, _repo_root):
    if p not in sys.path and os.path.isdir(p):
        sys.path.insert(0, p)

from zz_agent import ZZClient
from zz_agent.models import HeartbeatResponse, InboxItem, InboxList, InboxMeta, WatchResult


# ─── Helpers ──────────────────────────────────────────────────────────────────

_HB_RESP = {
    "ok": True,
    "agent_id": "agent-42",
    "status": "online",
    "pending_inbox_count": 2,
}

_INBOX_ITEM_1 = {
    "id": "inbox-1",
    "project_id": "proj-1",
    "event_type": "task.assigned",
    "task_id": "task-7",
    "orchestration_id": "orch-9",
    "title": "Fix bug",
    "body": "Please fix the login bug",
    "status": "unread",
}

_INBOX_ITEM_2 = {
    "id": "inbox-2",
    "project_id": "proj-2",
    "event_type": "agent.run.queued",
    "task_id": "task-8",
    "status": "unread",
}

_INBOX_ITEM_NULL_PAYLOAD = {
    "id": "inbox-3",
    "project_id": "proj-1",
    "event_type": "task_dispatched",
    "task_id": "task-9",
    "orchestration_id": "orch-10",
    "title": "Dispatched task",
    "body": "A task has been dispatched",
    "payload": None,
    "status": "unread",
}


def _make_mock_client():
    return ZZClient(base_url="https://test.local", api_key="zzk_testkey123")


# ─── SDK Tests ────────────────────────────────────────────────────────────────


class TestInboxResponseShapes(unittest.TestCase):
    """Test that inbox() parses all production response shapes."""

    def _setup_client(self, inbox_json):
        client = _make_mock_client()

        def fake_request(method, path, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat" and method == "POST":
                resp.json.return_value = _HB_RESP
            elif path == "/v1/agent/inbox" and method == "GET":
                resp.json.return_value = inbox_json
            elif path.startswith("/v1/agent/inbox/") and path.endswith("/ack"):
                inbox_id = path.split("/")[-2]
                resp.json.return_value = {"id": inbox_id, "status": "acked"}
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]
        return client

    def test_top_level_list(self):
        """Production can return a bare list of inbox items."""
        client = self._setup_client([_INBOX_ITEM_1, _INBOX_ITEM_2])
        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")
        self.assertEqual(result.items[1].inbox_id, "inbox-2")

    def test_data_list(self):
        """Standard wrapped: {"data": [...]}."""
        client = self._setup_client({"data": [_INBOX_ITEM_1]})
        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")

    def test_items_list(self):
        """Alternative wrapper: {"items": [...]}."""
        client = self._setup_client({"items": [_INBOX_ITEM_1]})
        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")

    def test_nested_data_object(self):
        """Nested: {"data": {"data": [...], "meta": {...}}}."""
        client = self._setup_client({
            "data": {
                "data": [_INBOX_ITEM_1, _INBOX_ITEM_2],
                "meta": {"total": 2, "limit": 50, "unread_count": 2},
            }
        })
        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")

    def test_null_payload_item(self):
        """Item with payload: null must parse without error and coerce to {}."""
        client = self._setup_client([_INBOX_ITEM_NULL_PAYLOAD])
        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].inbox_id, "inbox-3")
        self.assertEqual(result.items[0].payload, {})
        self.assertEqual(
            result.items[0].required_action,
            "begin work on the dispatched task (run: zz agent resume → zz tasks claim → zz agent submit)",
        )


class TestWatchSDK(unittest.TestCase):
    """Test the SDK watch() method with mocked HTTP responses."""

    def _make_client(self) -> ZZClient:
        return _make_mock_client()

    def test_watch_heartbeat_and_ack(self) -> None:
        client = self._make_client()

        def fake_request(method: str, path: str, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat" and method == "POST":
                resp.json.return_value = _HB_RESP
            elif path == "/v1/agent/inbox" and method == "GET":
                resp.json.return_value = {
                    "data": {
                        "data": [_INBOX_ITEM_1, _INBOX_ITEM_2],
                        "meta": {"total": 2, "limit": 50, "unread_count": 2},
                    }
                }
            elif path.startswith("/v1/agent/inbox/") and path.endswith("/ack") and method == "POST":
                inbox_id = path.split("/")[-2]
                resp.json.return_value = {"id": inbox_id, "status": "acked"}
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]

        result = client.agent.watch(max_items=10, ack=True)

        self.assertIsInstance(result, WatchResult)
        self.assertEqual(result.heartbeat.agent_id, "agent-42")
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")
        self.assertEqual(result.items[0].required_action, "begin work on the assigned task")
        self.assertEqual(result.items[1].required_action, "execute the queued agent run")
        self.assertEqual(result.acked, ["inbox-1", "inbox-2"])
        self.assertEqual(result.errors, [])

    def test_watch_project_filter(self) -> None:
        client = self._make_client()

        def fake_request(method: str, path: str, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat" and method == "POST":
                resp.json.return_value = _HB_RESP
            elif path == "/v1/agent/inbox" and method == "GET":
                resp.json.return_value = {
                    "data": {
                        "data": [_INBOX_ITEM_1, _INBOX_ITEM_2],
                        "meta": {"total": 2, "limit": 50, "unread_count": 2},
                    }
                }
            elif path.startswith("/v1/agent/inbox/") and path.endswith("/ack") and method == "POST":
                inbox_id = path.split("/")[-2]
                resp.json.return_value = {"id": inbox_id, "status": "acked"}
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]

        result = client.agent.watch(project_id="proj-1", max_items=10, ack=True)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].inbox_id, "inbox-1")
        self.assertEqual(result.acked, ["inbox-1"])

    def test_watch_agent_id_validation(self) -> None:
        client = self._make_client()

        def fake_request(method: str, path: str, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat" and method == "POST":
                resp.json.return_value = {
                    "ok": True,
                    "agent_id": "agent-wrong",
                    "status": "online",
                    "pending_inbox_count": 0,
                }
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]

        result = client.agent.watch(agent_id="agent-expected", max_items=10, ack=True)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("agent_id mismatch", result.errors[0])
        self.assertEqual(len(result.items), 0)

    def test_watch_no_ack(self) -> None:
        client = self._make_client()

        def fake_request(method: str, path: str, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat" and method == "POST":
                resp.json.return_value = _HB_RESP
            elif path == "/v1/agent/inbox" and method == "GET":
                resp.json.return_value = {
                    "data": {
                        "data": [_INBOX_ITEM_1],
                        "meta": {"total": 1, "limit": 50, "unread_count": 1},
                    }
                }
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]

        result = client.agent.watch(max_items=10, ack=False)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.acked, [])


class TestPromptContract(unittest.TestCase):
    """Test prompt format includes all required fields."""

    def test_prompt_format_contains_required_fields(self):
        from zz_cli.main import _format_watch_prompt
        item = MagicMock()
        item.inbox_id = "inbox-1"
        item.event_type = "task.assigned"
        item.project_id = "proj-1"
        item.project_name = "My Project"
        item.task_id = "task-7"
        item.orchestration_id = "orch-9"
        item.title = "Fix bug"
        item.body = "Please fix"
        item.required_action = "begin work on the assigned task"
        item.payload = {}
        item.created_at = None

        text = _format_watch_prompt(item)
        # Required fields
        self.assertIn("inbox_id: inbox-1", text)
        self.assertIn("event_type: task.assigned", text)
        self.assertIn("project_id: proj-1", text)
        self.assertIn("project_name: My Project", text)
        self.assertIn("task_id: task-7", text)
        self.assertIn("orchestration_id: orch-9", text)
        self.assertIn("required_action: begin work on the assigned task", text)
        # Instruction to use platform task APIs
        self.assertIn("Complete or review this item using the platform task APIs", text)
        self.assertIn("Do NOT use social chat for task completion or review", text)

    def test_prompt_format_no_secrets(self):
        from zz_cli.main import _format_watch_prompt
        item = MagicMock()
        item.inbox_id = "inbox-1"
        item.event_type = "task.assigned"
        item.project_id = "proj-1"
        item.project_name = None
        item.task_id = None
        item.orchestration_id = None
        item.title = None
        item.body = None
        item.required_action = "process the inbox item"
        item.payload = {}
        item.created_at = None

        text = _format_watch_prompt(item)
        self.assertNotIn("zzk_", text)
        self.assertNotIn("secret", text.lower())


class TestJsonStdoutPurity(unittest.TestCase):
    """Test that --format json emits only parseable JSON on stdout."""

    def test_json_tick_stdout_is_pure_json(self):
        """Simulate _run_watch_tick --format json and verify stdout is pure JSON."""
        from zz_cli.main import _run_watch_tick
        from zz_agent.models import HeartbeatResponse, WatchOutputItem, WatchResult

        fake_result = WatchResult(
            heartbeat=HeartbeatResponse(
                agent_id="agent-42", status="online", pending_inbox_count=1,
            ),
            items=[
                WatchOutputItem(
                    inbox_id="inbox-1",
                    event_type="task.assigned",
                    project_id="proj-1",
                    project_name="Test Project",
                    task_id="task-7",
                    orchestration_id="orch-9",
                    title="Do thing",
                    required_action="begin work on the assigned task",
                ),
            ],
            acked=["inbox-1"],
            errors=[],
        )

        captured_stdout = StringIO()
        with patch("zz_cli.main._get_agent_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.agent.watch.return_value = fake_result
            mock_get_client.return_value = mock_client
            with patch("sys.stdout", captured_stdout):
                _run_watch_tick(
                    format_="json",
                    ack=True,
                    agent_id=None,
                    project_id=None,
                    max_items=50,
                )

        output = captured_stdout.getvalue()
        parsed = json.loads(output.strip())
        self.assertIn("items", parsed)
        self.assertIn("heartbeat", parsed)
        self.assertIn("acked", parsed)
        self.assertEqual(len(parsed["items"]), 1)
        self.assertEqual(parsed["items"][0]["inbox_id"], "inbox-1")

    def test_json_tick_empty_inbox(self):
        """Empty inbox still produces valid JSON on stdout."""
        from zz_cli.main import _run_watch_tick
        from zz_agent.models import HeartbeatResponse, WatchResult

        fake_result = WatchResult(
            heartbeat=HeartbeatResponse(
                agent_id="agent-42", status="online", pending_inbox_count=0,
            ),
            items=[],
            acked=[],
            errors=[],
        )

        captured_stdout = StringIO()
        with patch("zz_cli.main._get_agent_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.agent.watch.return_value = fake_result
            mock_get_client.return_value = mock_client
            with patch("sys.stdout", captured_stdout):
                _run_watch_tick(
                    format_="json",
                    ack=True,
                    agent_id=None,
                    project_id=None,
                    max_items=50,
                )

        output = captured_stdout.getvalue()
        parsed = json.loads(output.strip())
        self.assertEqual(parsed["items"], [])

    def test_json_tick_with_errors(self):
        """Errors are inside the JSON, not as separate lines on stdout."""
        from zz_cli.main import _run_watch_tick
        from zz_agent.models import HeartbeatResponse, WatchOutputItem, WatchResult

        fake_result = WatchResult(
            heartbeat=HeartbeatResponse(
                agent_id="agent-42", status="online", pending_inbox_count=1,
            ),
            items=[
                WatchOutputItem(
                    inbox_id="inbox-1",
                    event_type="task.assigned",
                    required_action="begin work on the assigned task",
                ),
            ],
            acked=[],
            errors=["ack failed for inbox-1: timeout"],
        )

        captured_stdout = StringIO()
        with patch("zz_cli.main._get_agent_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.agent.watch.return_value = fake_result
            mock_get_client.return_value = mock_client
            with patch("sys.stdout", captured_stdout):
                _run_watch_tick(
                    format_="json",
                    ack=True,
                    agent_id=None,
                    project_id=None,
                    max_items=50,
                )

        output = captured_stdout.getvalue()
        parsed = json.loads(output.strip())
        self.assertEqual(len(parsed["errors"]), 1)
        self.assertIn("ack failed", parsed["errors"][0])

    def test_json_no_secrets_in_output(self):
        """JSON output must not contain raw API keys or JWTs."""
        from zz_cli.main import _run_watch_tick
        from zz_agent.models import HeartbeatResponse, WatchOutputItem, WatchResult

        fake_result = WatchResult(
            heartbeat=HeartbeatResponse(
                agent_id="agent-42", status="online", pending_inbox_count=1,
            ),
            items=[
                WatchOutputItem(
                    inbox_id="inbox-1",
                    event_type="task.assigned",
                    project_id="proj-1",
                    required_action="begin work on the assigned task",
                ),
            ],
            acked=["inbox-1"],
            errors=[],
        )

        captured_stdout = StringIO()
        with patch("zz_cli.main._get_agent_client") as mock_get_client:
            mock_client = MagicMock()
            mock_client.agent.watch.return_value = fake_result
            mock_get_client.return_value = mock_client
            with patch("sys.stdout", captured_stdout):
                _run_watch_tick(
                    format_="json",
                    ack=True,
                    agent_id=None,
                    project_id=None,
                    max_items=50,
                )

        output = captured_stdout.getvalue()
        self.assertNotIn("zzk_", output)
        self.assertNotIn("Bearer ", output)


class TestAckOrdering(unittest.TestCase):
    """Test that ack only happens after successful output formatting."""

    def test_ack_after_format(self):
        """WatchResult should have acked ids matching items when ack=True."""
        client = _make_mock_client()
        call_order = []

        def fake_request(method, path, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat":
                resp.json.return_value = _HB_RESP
                call_order.append("heartbeat")
            elif path == "/v1/agent/inbox":
                resp.json.return_value = [_INBOX_ITEM_1]
                call_order.append("inbox")
            elif "/ack" in path:
                call_order.append("ack")
                resp.json.return_value = {"id": "inbox-1", "status": "acked"}
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]
        result = client.agent.watch(max_items=10, ack=True)

        # Order: heartbeat, inbox, ack
        self.assertEqual(call_order, ["heartbeat", "inbox", "ack"])
        self.assertEqual(result.acked, ["inbox-1"])

    def test_no_ack_skips_ack(self):
        """--no-ack should result in no ack calls."""
        client = _make_mock_client()
        call_order = []

        def fake_request(method, path, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = lambda: None
            if path == "/v1/agents/heartbeat":
                resp.json.return_value = _HB_RESP
                call_order.append("heartbeat")
            elif path == "/v1/agent/inbox":
                resp.json.return_value = [_INBOX_ITEM_1]
                call_order.append("inbox")
            elif "/ack" in path:
                call_order.append("ack")
            else:
                resp.json.return_value = {}
            return resp

        client._request = fake_request  # type: ignore[method-assign]
        result = client.agent.watch(max_items=10, ack=False)

        self.assertIn("heartbeat", call_order)
        self.assertIn("inbox", call_order)
        self.assertNotIn("ack", call_order)
        self.assertEqual(result.acked, [])


class TestCLIWatchHelp(unittest.TestCase):
    """Test CLI command parsing and lock behavior."""

    def test_watch_help_exits_zero(self) -> None:
        with patch("sys.argv", ["zz", "agent", "watch", "--help"]):
            with self.assertRaises(SystemExit) as cm:
                from zz_cli.main import app
                app()
            self.assertEqual(cm.exception.code, 0)

    def test_lock_acquire_and_release(self) -> None:
        from zz_cli.main import _acquire_watch_lock, _release_watch_lock

        _release_watch_lock()
        self.assertTrue(_acquire_watch_lock())
        self.assertFalse(_acquire_watch_lock())
        _release_watch_lock()
        self.assertTrue(_acquire_watch_lock())
        _release_watch_lock()


if __name__ == "__main__":
    unittest.main(verbosity=2)
