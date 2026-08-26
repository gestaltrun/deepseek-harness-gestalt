#!/usr/bin/env python3
"""Tests for skill-doctor session collection."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from collect_sessions import (
    find_claude_session_files,
    find_codex_session_files,
    parse_claude_session,
    parse_codex_session,
    parse_warp_conversation,
)
from warp_decoder import decode_task


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def protobuf_varint(value):
    encoded = bytearray()
    while value > 0x7F:
        encoded.append((value & 0x7F) | 0x80)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def protobuf_bytes(field, value):
    return protobuf_varint((field << 3) | 2) + protobuf_varint(len(value)) + value


class ClaudeSessionTests(unittest.TestCase):
    def test_discovers_parent_sessions_and_optional_subagents(self):
        with tempfile.TemporaryDirectory() as tmp:
            claude_home = Path(tmp)
            parent = claude_home / "projects" / "-repo" / "parent.jsonl"
            subagent = (
                claude_home
                / "projects"
                / "-repo"
                / "parent"
                / "subagents"
                / "agent-child.jsonl"
            )
            old = claude_home / "projects" / "-repo" / "old.jsonl"
            for path in (parent, subagent, old):
                write_jsonl(path, [{"type": "user"}])
            old_time = (datetime.now(timezone.utc) - timedelta(days=10)).timestamp()
            os.utime(old, (old_time, old_time))
            cutoff = datetime.now(timezone.utc) - timedelta(days=1)

            parents = find_claude_session_files(claude_home, cutoff, False)
            with_subagents = find_claude_session_files(claude_home, cutoff, True)

            self.assertEqual([path for _, path in parents], [parent])
            self.assertEqual(
                {path for _, path in with_subagents},
                {parent, subagent},
            )

    def test_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            common = {
                "sessionId": "session-1",
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "version": "1.0.0",
            }
            write_jsonl(path, [
                {
                    **common,
                    "type": "user",
                    "uuid": "user-1",
                    "message": {"role": "user", "content": "Improve my skill"},
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-1",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "I will inspect it."},
                            {
                                "type": "tool_use",
                                "name": "Skill",
                                "input": {"skill": "update-skill"},
                            },
                        ],
                    },
                },
                {
                    **common,
                    "type": "assistant",
                    "uuid": "assistant-2",
                    "message": {
                        "id": "message-1",
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "Edit",
                                "input": {"file_path": "/tmp/repo/SKILL.md"},
                            }
                        ],
                    },
                },
                {
                    **common,
                    "type": "user",
                    "uuid": "result-1",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "is_error": True,
                                "content": "permission denied",
                            }
                        ],
                    },
                },
            ])

            meta, stats, entries, skills = parse_claude_session(
                path,
                {"update-skill"},
                False,
            )

            self.assertEqual(meta["id"], "session-1")
            self.assertEqual(meta["cwd"], "/tmp/repo")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 2)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["update-skill"])
            self.assertIn(("user", "Improve my skill"), entries)
            self.assertIn(("assistant", "I will inspect it."), entries)

    def test_excludes_sidechains_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agent-child.jsonl"
            write_jsonl(path, [{
                "type": "user",
                "sessionId": "session-1",
                "agentId": "child-1",
                "isSidechain": True,
                "cwd": "/tmp/repo",
                "timestamp": "2026-08-20T10:00:00Z",
                "message": {"role": "user", "content": "Investigate"},
            }])

            self.assertIsNone(parse_claude_session(path, set(), False))
            parsed = parse_claude_session(path, set(), True)
            self.assertEqual(parsed[0]["id"], "session-1-child-1")
            self.assertEqual(parsed[0]["thread_source"], "subagent")


class CodexSessionTests(unittest.TestCase):
    def test_discovers_and_parses_messages_tools_skills_and_stats(self):
        with tempfile.TemporaryDirectory() as tmp:
            codex_home = Path(tmp)
            path = codex_home / "sessions" / "2026" / "rollout-session.jsonl"
            write_jsonl(path, [
                {
                    "type": "session_meta",
                    "timestamp": "2026-08-20T10:00:00Z",
                    "payload": {
                        "id": "codex-1",
                        "cwd": "/tmp/repo",
                        "originator": "codex",
                    },
                },
                {
                    "type": "event_msg",
                    "payload": {"type": "user_message"},
                },
                {
                    "type": "event_msg",
                    "payload": {"type": "agent_message"},
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Grade the skill"}],
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "arguments": json.dumps({
                            "cmd": "apply_patch .agents/skills/skill-doctor/SKILL.md",
                        }),
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "output": "failed to apply patch",
                    },
                },
            ])

            cutoff = datetime.now(timezone.utc) - timedelta(days=1)
            files = find_codex_session_files(codex_home, cutoff)
            self.assertEqual([candidate for _, candidate in files], [path])

            meta, stats, entries, skills = parse_codex_session(
                path,
                {"skill-doctor"},
                False,
            )
            self.assertEqual(meta["id"], "codex-1")
            self.assertEqual(stats["user_turns"], 1)
            self.assertEqual(stats["assistant_turns"], 1)
            self.assertEqual(stats["tool_calls"], 1)
            self.assertEqual(stats["error_outputs"], 1)
            self.assertTrue(stats["has_code_edits"])
            self.assertEqual(skills, ["skill-doctor"])
            self.assertIn(("user", "Grade the skill"), entries)


class WarpSessionTests(unittest.TestCase):
    def test_decodes_a_user_query_from_the_protobuf_task_envelope(self):
        user_query = protobuf_bytes(1, b"Grade Warp skills")
        message = protobuf_bytes(1, b"message-1") + protobuf_bytes(2, user_query)
        task = (
            protobuf_bytes(1, b"task-1")
            + protobuf_bytes(2, b"Skill review")
            + protobuf_bytes(5, message)
        )

        decoded = decode_task(task)

        self.assertEqual(decoded["id"], "task-1")
        self.assertEqual(decoded["messages"][0]["kind"], "user_query")
        self.assertEqual(decoded["messages"][0]["text"], "Grade Warp skills")

    def test_normalizes_messages_tools_skills_and_stats(self):
        record = {
            "conversation_id": "warp-1",
            "conversation_data": "{}",
            "summary": json.dumps({"initial_working_directory": "/tmp/repo"}),
            "channel": "stable",
        }
        task = {
            "messages": [
                {
                    "kind": "invoke_skill",
                    "timestamp": "2026-08-20T10:00:00+00:00",
                    "order_key": (1, 0),
                    "skill": {"name": "skill-doctor"},
                    "user_query": {"text": "Grade Warp skills", "cwd": "/tmp/repo"},
                },
                {
                    "kind": "agent_output",
                    "timestamp": "2026-08-20T10:00:01+00:00",
                    "order_key": (2, 0),
                    "text": "Inspecting sessions",
                },
                {
                    "kind": "tool_call",
                    "timestamp": "2026-08-20T10:00:02+00:00",
                    "order_key": (3, 0),
                    "name": "apply_file_diffs",
                    "payload": "patch",
                    "skill": None,
                },
                {
                    "kind": "tool_call_result",
                    "timestamp": "2026-08-20T10:00:03+00:00",
                    "order_key": (4, 0),
                    "payload": "failed to apply patch",
                    "cwd": "/tmp/repo",
                },
            ],
        }

        with patch(
            "collect_sessions.load_warp_conversation_data",
            return_value=([b"task"], datetime(2026, 8, 20, tzinfo=timezone.utc), "/tmp/repo"),
        ), patch("collect_sessions.decode_task", return_value=task):
            meta, stats, entries, skills = parse_warp_conversation(
                record,
                {"skill-doctor"},
                False,
            )

        self.assertEqual(meta["id"], "warp-1")
        self.assertEqual(meta["originator"], "warp")
        self.assertEqual(stats["user_turns"], 1)
        self.assertEqual(stats["assistant_turns"], 1)
        self.assertEqual(stats["tool_calls"], 1)
        self.assertEqual(stats["error_outputs"], 1)
        self.assertTrue(stats["has_code_edits"])
        self.assertEqual(skills, ["skill-doctor"])
        self.assertIn(("assistant", "Inspecting sessions"), entries)


if __name__ == "__main__":
    unittest.main()
