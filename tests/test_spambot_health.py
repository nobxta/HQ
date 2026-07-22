import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from code.repair import (
    SPAM_ACTIVE,
    SPAM_FROZEN,
    SPAM_HARD_LIMITED,
    SPAM_TEMP_LIMITED,
    SPAM_UNKNOWN,
    classify_spambot_response_detailed,
    _check_session_spambot,
)


class SpamBotClassifierTests(unittest.TestCase):
    def test_active_official_reply(self):
        status, details = classify_spambot_response_detailed(
            "Good news, no limits are currently applied to your account. You're free as a bird!"
        )
        self.assertEqual(status, SPAM_ACTIVE)
        self.assertIsNone(details)

    def test_frozen_official_reply(self):
        status, details = classify_spambot_response_detailed(
            "Your account was blocked for violations of the Telegram Terms of Service."
        )
        self.assertEqual(status, SPAM_FROZEN)
        self.assertIsNone(details)

    def test_hard_limit_official_replies(self):
        for text in (
            "Unfortunately, we received a harsh response from our anti-spam systems.",
            "You can submit a complaint to our moderators.",
        ):
            with self.subTest(text=text):
                self.assertEqual(classify_spambot_response_detailed(text)[0], SPAM_HARD_LIMITED)

    def test_temporary_limit_preserves_expiry(self):
        status, details = classify_spambot_response_detailed(
            "Your account is now limited until 24 Jul 2026, 08:15 UTC. Please wait."
        )
        self.assertEqual(status, SPAM_TEMP_LIMITED)
        self.assertEqual(details, "24 Jul 2026, 08:15 UTC")

    def test_unknown_is_not_guessed_and_keeps_excerpt(self):
        text = "Some of your messages were reported, but this reply has no known outcome."
        status, details = classify_spambot_response_detailed(text)
        self.assertEqual(status, SPAM_UNKNOWN)
        self.assertEqual(details, text)


class _Conversation:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def send_message(self, text):
        assert text == "/start"

    async def get_response(self):
        return SimpleNamespace(text=(
            "Good news, no limits are currently applied to your account. You're free as a bird!"
        ))


class _SpamBotClient:
    async def connect(self):
        return None

    async def disconnect(self):
        return None

    async def is_user_authorized(self):
        return True

    def conversation(self, entity, **kwargs):
        assert entity == "@SpamBot"
        assert kwargs["exclusive"] is True
        return _Conversation()


class SpamBotTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_for_inbound_spambot_response(self):
        with patch("code.repair.guarded_client", return_value=_SpamBotClient()):
            name, status, details = await _check_session_spambot(Path("account.session"))
        self.assertEqual(name, "account")
        self.assertEqual(status, SPAM_ACTIVE)
        self.assertIsNone(details)


if __name__ == "__main__":
    unittest.main()
