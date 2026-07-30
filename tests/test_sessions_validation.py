import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from api.routers import sessions


class SessionValidationTests(unittest.IsolatedAsyncioTestCase):
    def test_physical_location_wins_over_stale_duplicate_pool_membership(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            for bucket in ("free", "dead", "frozen", "limited", "unauth"):
                (root / bucket).mkdir()
            actual = root / "limited" / "alive.session"
            actual.write_bytes(b"session")
            pool = {
                "free_sessions": ["alive.session"],
                "dead_sessions": ["alive.session"],
                "limited_sessions": ["alive.session"],
            }

            with patch.object(sessions, "_bucket_dir", side_effect=lambda b: root / b):
                path, bucket = sessions._physical_pool_location("alive.session", pool)

        self.assertEqual(path, actual)
        self.assertEqual(bucket, "limited")

    async def test_missing_file_is_not_recorded_as_dead(self):
        pool = {
            "free_sessions": ["missing.session"],
            "dead_sessions": [],
            "session_meta": {},
        }

        with (
            patch.object(sessions.wrappers, "load_pool", AsyncMock(return_value=pool)),
            patch.object(sessions.wrappers, "log_admin_action", AsyncMock()),
            patch.object(sessions, "_assignment_map", AsyncMock(return_value={})),
            patch("code.utils.record_session_meta") as record_meta,
            patch.object(
                sessions,
                "_validation_path_for",
                return_value=(Path("definitely-not-present.session"), "free"),
            ),
        ):
            result = await sessions.validate_sessions({"filenames": ["missing.session"]})

        self.assertEqual(result["sessions"][0]["status"], "missing")
        self.assertEqual(result["dead"], 0)
        self.assertEqual(result["missing"], 1)
        self.assertEqual(result["dead_moved"], [])
        record_meta.assert_not_called()

    async def test_valid_dead_session_is_checked_in_dead_and_restored_to_ready(self):
        with tempfile.TemporaryDirectory() as td:
            dead_dir = Path(td) / "dead"
            dead_dir.mkdir()
            session_path = dead_dir / "alive.session"
            session_path.write_bytes(b"session")
            pool = {
                "free_sessions": [],
                "dead_sessions": ["alive.session"],
                "session_meta": {
                    "alive.session": {
                        "validation_status": "invalid",
                        "validation_reason": "Session file missing",
                    }
                },
            }
            record_meta = Mock()
            move = Mock(return_value=(True, "moved"))

            with (
                patch.object(sessions.wrappers, "load_pool", AsyncMock(return_value=pool)),
                patch.object(sessions.wrappers, "log_admin_action", AsyncMock()),
                patch.object(sessions, "_assignment_map", AsyncMock(return_value={})),
                patch.object(sessions, "_bucket_dir", return_value=dead_dir),
                patch.object(sessions, "_locked_session_move", move),
                patch(
                    "code.utils.validate_session_with_reason",
                    AsyncMock(return_value=(True, "")),
                ) as validate,
                patch(
                    "code.utils.probe_session_identity",
                    AsyncMock(return_value={"status": "active", "authorized": True}),
                ),
                patch("code.utils.record_session_meta", record_meta),
            ):
                result = await sessions.validate_sessions({"filenames": ["alive.session"]})

        validate.assert_awaited_once_with(session_path, ignore_active_hint=True)
        move.assert_called_once_with("alive.session", "dead", "free")
        self.assertEqual(result["active"], 1)
        self.assertEqual(result["dead"], 0)
        self.assertEqual(result["sessions"][0]["status"], "active")
        self.assertEqual(record_meta.call_args.kwargs["validation_status"], "valid")
        self.assertEqual(record_meta.call_args.kwargs["validation_reason"], "")

    async def test_valid_session_clears_invalid_cache_when_identity_probe_is_busy(self):
        with tempfile.TemporaryDirectory() as td:
            session_path = Path(td) / "alive.session"
            session_path.write_bytes(b"session")
            pool = {
                "free_sessions": ["alive.session"],
                "dead_sessions": [],
                "session_meta": {
                    "alive.session": {
                        "validation_status": "invalid",
                        "validation_reason": "old failure",
                    }
                },
            }
            record_meta = Mock()

            with (
                patch.object(sessions.wrappers, "load_pool", AsyncMock(return_value=pool)),
                patch.object(sessions.wrappers, "log_admin_action", AsyncMock()),
                patch.object(sessions, "_assignment_map", AsyncMock(return_value={})),
                patch.object(
                    sessions,
                    "_validation_path_for",
                    return_value=(session_path, "free"),
                ),
                patch(
                    "code.utils.validate_session_with_reason",
                    AsyncMock(return_value=(True, "")),
                ),
                patch(
                    "code.utils.probe_session_identity",
                    AsyncMock(return_value={"status": "busy"}),
                ),
                patch("code.utils.record_session_meta", record_meta),
            ):
                result = await sessions.validate_sessions({"filenames": ["alive.session"]})

        self.assertEqual(result["sessions"][0]["status"], "active")
        record_meta.assert_called_once()
        self.assertIsNone(record_meta.call_args.args[1])
        self.assertEqual(record_meta.call_args.kwargs["validation_status"], "valid")
        self.assertEqual(record_meta.call_args.kwargs["validation_reason"], "")


if __name__ == "__main__":
    unittest.main()
