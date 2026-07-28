import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from telethon.tl.types import Channel, Chat, User

from code.users import _get_eligible_dm_sender


def _event(sender, **overrides):
    values = {
        "out": False,
        "is_private": True,
        "is_group": False,
        "is_channel": False,
        "sender_id": getattr(sender, "id", 123),
        "get_sender": AsyncMock(return_value=sender),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class AutoreplySenderFilterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = SimpleNamespace(get_entity=AsyncMock())

    async def test_accepts_human_in_private_chat(self):
        human = User(id=123, first_name="Alice", bot=False)
        self.assertIs(await _get_eligible_dm_sender(_event(human), self.client), human)

    async def test_rejects_bot_even_in_private_chat(self):
        bot = User(id=456, first_name="Robot", bot=True)
        self.assertIsNone(await _get_eligible_dm_sender(_event(bot), self.client))

    async def test_rejects_group_and_channel_before_resolution(self):
        human = User(id=123, first_name="Alice", bot=False)
        group_event = _event(human, is_private=False, is_group=True)
        channel_event = _event(human, is_private=False, is_channel=True)

        self.assertIsNone(await _get_eligible_dm_sender(group_event, self.client))
        self.assertIsNone(await _get_eligible_dm_sender(channel_event, self.client))
        group_event.get_sender.assert_not_awaited()
        channel_event.get_sender.assert_not_awaited()

    async def test_rejects_non_user_entities(self):
        chat = Chat(id=10, title="Group", photo=None, participants_count=2, date=None, version=1)
        channel = Channel(id=11, title="Channel", photo=None, date=None)
        self.assertIsNone(await _get_eligible_dm_sender(_event(chat), self.client))
        self.assertIsNone(await _get_eligible_dm_sender(_event(channel), self.client))

    async def test_rejects_outgoing_missing_and_unresolved_senders(self):
        human = User(id=123, first_name="Alice", bot=False)
        self.assertIsNone(await _get_eligible_dm_sender(_event(human, out=True), self.client))
        self.assertIsNone(await _get_eligible_dm_sender(_event(human, sender_id=None), self.client))

        unresolved = _event(None, sender_id=999)
        unresolved.get_sender.side_effect = RuntimeError("cannot resolve")
        self.assertIsNone(await _get_eligible_dm_sender(unresolved, self.client))

    async def test_falls_back_to_client_entity_resolution(self):
        human = User(id=123, first_name="Alice", bot=False)
        event = _event(None, sender_id=123)
        self.client.get_entity.return_value = human
        self.assertIs(await _get_eligible_dm_sender(event, self.client), human)
        self.client.get_entity.assert_awaited_once_with(123)


if __name__ == "__main__":
    unittest.main()
