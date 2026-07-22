import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from code.utils import (
    _SQLITE_MAGIC,
    is_inconclusive_validation_reason,
    validate_session,
    validate_session_with_reason,
)


class _FakeClient:
    def __init__(self, *, authorized=True, connect_error=None, send_error=None):
        self.authorized = authorized
        self.connect_error = connect_error
        self.send_error = send_error

    async def connect(self):
        if self.connect_error:
            raise self.connect_error

    async def is_user_authorized(self):
        return self.authorized

    async def send_message(self, *_args, **_kwargs):
        if self.send_error:
            raise self.send_error

    async def disconnect(self):
        return None


class SessionValidationSafetyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "safe.session"
        self.path.write_bytes(_SQLITE_MAGIC + b"test")

    def tearDown(self):
        self.tmp.cleanup()

    async def test_network_connect_failure_is_inconclusive_and_not_moved(self):
        fake = _FakeClient(connect_error=TimeoutError("network unavailable"))
        with patch("code.session_guard.guarded_client", return_value=fake), \
             patch("code.utils._move_session_to_dead") as move:
            ok, reason = await validate_session_with_reason(self.path)
        self.assertFalse(ok)
        self.assertTrue(is_inconclusive_validation_reason(reason))
        move.assert_not_called()

    async def test_legacy_boolean_validation_preserves_inconclusive_session(self):
        fake = _FakeClient(connect_error=ConnectionError("proxy offline"))
        with patch("code.session_guard.guarded_client", return_value=fake), \
             patch("code.utils._move_session_to_dead") as move:
            self.assertTrue(await validate_session(self.path))
        move.assert_not_called()

    async def test_authorized_session_survives_nonfatal_send_test_failure(self):
        fake = _FakeClient(send_error=TimeoutError("Telegram timeout"))
        with patch("code.session_guard.guarded_client", return_value=fake), \
             patch("code.utils.with_floodwait_retry", side_effect=TimeoutError("Telegram timeout")), \
             patch("code.utils._move_session_to_dead") as move:
            ok, reason = await validate_session_with_reason(self.path)
        self.assertTrue(ok)
        self.assertIn("send test inconclusive", reason)
        move.assert_not_called()

    async def test_explicit_unauthorized_session_is_terminal(self):
        fake = _FakeClient(authorized=False)
        with patch("code.session_guard.guarded_client", return_value=fake), \
             patch("code.utils._move_session_to_dead") as move:
            ok, reason = await validate_session_with_reason(self.path)
        self.assertFalse(ok)
        self.assertEqual(reason, "UNAUTHORIZED")
        move.assert_called_once_with(self.path.resolve())


if __name__ == "__main__":
    unittest.main()
