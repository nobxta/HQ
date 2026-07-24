import tempfile
import unittest
import asyncio
import time
from pathlib import Path
from unittest.mock import patch

from code import replacement


class ReplacementJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.queue_path = Path(self.tmp.name) / "replacement_queue.json"
        self.path_patch = patch.object(
            replacement.config, "DATA_REPLACEMENT_QUEUE_FILE", self.queue_path
        )
        self.path_patch.start()
        self.emit_patch = patch.object(replacement, "_emit_entry_update")
        self.emit_patch.start()

    def tearDown(self):
        self.emit_patch.stop()
        self.path_patch.stop()
        self.tmp.cleanup()

    def _sessions(self):
        return [
            {"session_file": "old-a.session", "real_name": "Old A", "spam_status": "DEAD"},
            {"session_file": "old-b.session", "real_name": "Old B", "spam_status": "FROZEN"},
        ]

    def test_multi_session_request_creates_one_grouped_job(self):
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=1
        )
        self.assertEqual(2, len(entries))
        self.assertEqual(entries[0]["job_id"], entries[1]["job_id"])
        self.assertEqual("ready", entries[0]["status"])
        self.assertEqual("pending_payment", entries[1]["status"])

        job = replacement.get_replacement_job(entries[0]["job_id"])
        self.assertEqual(2, job["total"])
        self.assertEqual("awaiting_payment", job["status"])
        paid_item = next(entry for entry in entries if not entry["free_replacement"])
        self.assertEqual(0, paid_item["progress"])
        self.assertFalse(job["payment_confirmed"])

    def test_completed_legacy_job_reports_full_progress(self):
        replacement.save_replacement_queue([{
            "id": "legacy-completed",
            "bot_name": "Example Bot",
            "status": "completed",
            "progress": 0,
        }])
        job = replacement.get_replacement_job("legacy-completed")
        self.assertIsNotNone(job)
        self.assertEqual("completed", job["status"])
        self.assertEqual(100, job["progress"])

    def test_stage_update_is_persisted_in_timeline(self):
        entry = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions()[:1], free_count=1
        )[0]
        self.assertTrue(replacement.update_replacement_stage(
            entry["id"], "validating", "Checking Telegram account."
        ))
        saved = replacement.load_replacement_queue()[0]
        self.assertEqual("validating", saved["stage"])
        self.assertEqual(40, saved["progress"])
        self.assertEqual("Checking Telegram account.", saved["timeline"][-1]["message"])

    def test_payment_confirmation_is_idempotent_and_updates_job(self):
        entry = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions()[:1], free_count=0
        )[0]
        self.assertTrue(replacement.mark_replacement_paid(entry["id"], "pay-123"))
        saved = replacement.load_replacement_queue()[0]
        self.assertEqual("ready", saved["status"])
        self.assertEqual("payment_confirmed", saved["stage"])
        self.assertEqual("pay-123", saved["payment_id"])
        job = replacement.get_replacement_job(entry["job_id"])
        self.assertTrue(job["payment_confirmed"])
        self.assertEqual("processing", job["status"])

    def test_one_payment_id_confirms_every_paid_item_in_job(self):
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=0
        )
        queue = replacement.load_replacement_queue()
        for entry in queue:
            entry["payment_id"] = "shared-payment"
        replacement.save_replacement_queue(queue)
        with patch.object(
            replacement, "process_ready_replacements",
            new=unittest.mock.AsyncMock(return_value=[]),
        ):
            self.assertTrue(asyncio.run(
                replacement.confirm_replacement_payment_by_id("shared-payment")
            ))
        saved = replacement.load_replacement_queue()
        self.assertEqual({"ready"}, {entry["status"] for entry in saved})
        self.assertEqual(
            {"payment_confirmed"}, {entry["stage"] for entry in saved}
        )

    def test_grouped_invoice_covers_all_paid_items(self):
        from api.routers import user_portal
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=0
        )
        invoice = {
            "payment_id": "pay-group",
            "pay_address": "address",
            "pay_amount": 4,
            "pay_currency": "USDTTRC20",
            "invoice_expiry": "2099-01-01T00:00:00Z",
            "invoice_expires_at": "2099-01-01T00:00:00Z",
        }
        with (
            patch.object(
                user_portal, "_get_user_bot",
                new=unittest.mock.AsyncMock(return_value=("token", {})),
            ),
            patch("code.shop.payment.create_invoice", return_value=invoice) as create,
        ):
            response = asyncio.run(user_portal.portal_replacement_create_invoice(
                "Example Bot",
                user_portal.ReplacementPayRequest(
                    entry_id=entries[0]["id"], currency="USDT_TRC20"
                ),
                telegram_id=42,
            ))
            reused = asyncio.run(user_portal.portal_replacement_create_invoice(
                "Example Bot",
                user_portal.ReplacementPayRequest(
                    entry_id=entries[1]["id"], currency="USDT_TRC20"
                ),
                telegram_id=42,
            ))
        self.assertEqual(2, response["replacement_count"])
        self.assertEqual(4.0, response["amount_usd"])
        self.assertEqual(4.0, create.call_args.kwargs["amount_usd"])
        self.assertEqual(1, create.call_count)
        self.assertTrue(reused["reused"])
        saved = replacement.load_replacement_queue()
        self.assertEqual({"pay-group"}, {entry["payment_id"] for entry in saved})

    def test_grouped_invoice_is_one_admin_payment_row(self):
        from api.routers import orders
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=0
        )
        queue = replacement.load_replacement_queue()
        for entry in queue:
            entry["payment_id"] = "pay-group"
            entry["invoice_data"] = {
                "payment_id": "pay-group",
                "pay_address": "one-address",
                "pay_amount": 0.0001,
                "pay_currency": "BTC",
                "invoice_expires_at": "2099-01-01T00:00:00Z",
            }
        replacement.save_replacement_queue(queue)

        rows = orders._replacement_as_order_rows()
        self.assertEqual(1, len(rows))
        self.assertEqual(entries[0]["job_id"], rows[0]["order_id"])
        self.assertEqual(4.0, rows[0]["amount_usd"])
        self.assertEqual(2, rows[0]["replacement_count"])
        self.assertEqual(["Old A", "Old B"], rows[0]["session_names"])
        self.assertEqual("pay-group", rows[0]["payment_id"])

    def test_active_invoice_can_be_resumed_after_refresh(self):
        from api.routers import user_portal
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=0
        )
        queue = replacement.load_replacement_queue()
        for entry in queue:
            entry["payment_id"] = "pay-resume"
            entry["invoice_data"] = {
                "payment_id": "pay-resume",
                "pay_address": "same-address",
                "pay_amount": 0.0001,
                "pay_currency": "BTC",
                "invoice_expires_at": "2099-01-01T00:00:00Z",
            }
        replacement.save_replacement_queue(queue)

        with patch.object(
            user_portal, "_get_user_bot",
            new=unittest.mock.AsyncMock(return_value=("token", {})),
        ):
            active = asyncio.run(user_portal.portal_replacement_active_invoice(
                "Example Bot", entries[1]["id"], telegram_id=42
            ))
        self.assertTrue(active["active"])
        self.assertEqual("pay-resume", active["payment_id"])
        self.assertEqual("same-address", active["pay_address"])
        self.assertEqual(4.0, active["amount_usd"])
        self.assertEqual(2, active["replacement_count"])
        self.assertEqual(["Old A", "Old B"], active["sessions"])

    def test_uninvoiced_replacement_draft_can_be_cancelled(self):
        from api.routers import user_portal
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions(), free_count=0
        )
        with patch.object(
            user_portal, "_get_user_bot",
            new=unittest.mock.AsyncMock(return_value=("token", {})),
        ):
            result = asyncio.run(user_portal.portal_cancel_replacement_job(
                "Example Bot", entries[0]["job_id"], telegram_id=42
            ))
        self.assertTrue(result["ok"])
        self.assertEqual(
            {"cancelled"},
            {entry["status"] for entry in replacement.load_replacement_queue()},
        )

    def test_active_replacement_invoice_cannot_be_cancelled(self):
        from api.routers import user_portal
        from fastapi import HTTPException
        entries = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions()[:1], free_count=0
        )
        queue = replacement.load_replacement_queue()
        queue[0]["payment_id"] = "pay-live"
        queue[0]["invoice_data"] = {"pay_address": "blockchain-address"}
        replacement.save_replacement_queue(queue)
        with (
            patch.object(
                user_portal, "_get_user_bot",
                new=unittest.mock.AsyncMock(return_value=("token", {})),
            ),
            self.assertRaises(HTTPException) as raised,
        ):
            asyncio.run(user_portal.portal_cancel_replacement_job(
                "Example Bot", entries[0]["job_id"], telegram_id=42
            ))
        self.assertEqual(400, raised.exception.status_code)

    def test_legacy_entry_without_job_id_remains_readable(self):
        replacement.save_replacement_queue([{
            "id": "legacy-1",
            "bot_name": "Legacy Bot",
            "status": "awaiting_session",
            "free_replacement": True,
            "progress": 20,
        }])
        job = replacement.get_replacement_job("legacy-1")
        self.assertIsNotNone(job)
        self.assertEqual("awaiting_inventory", job["status"])
        self.assertEqual(1, job["total"])

    def test_new_rest_and_websocket_routes_are_registered(self):
        from api.app import app
        paths = {getattr(route, "path", "") for route in app.routes}
        self.assertIn("/api/portal/bot/{bot_name}/replacement-jobs", paths)
        self.assertIn("/api/portal/bot/{bot_name}/replacement-jobs/{job_id}", paths)
        self.assertIn("/api/portal/bot/{bot_name}/replacement-jobs/{job_id}/cancel", paths)
        self.assertIn("/api/portal/bot/{bot_name}/replacement/{entry_id}/invoice", paths)
        self.assertIn("/api/system/replacement-jobs", paths)
        self.assertIn("/api/system/replacement-jobs/{job_id}/continue", paths)
        self.assertIn("/ws/replacements/{job_id}", paths)

    def test_replacement_websocket_is_bound_to_job_owner(self):
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        from api.app import app
        from api.auth import create_portal_access_token

        entry = replacement.create_replacement_request(
            "token", "Example Bot", 42, self._sessions()[:1], free_count=1
        )[0]
        client = TestClient(app)
        allowed = create_portal_access_token("user:42:Example Bot")
        with client.websocket_connect(
            f"/ws/replacements/{entry['job_id']}?token={allowed}"
        ):
            pass

        denied = create_portal_access_token("user:99:Different Bot")
        with self.assertRaises(WebSocketDisconnect):
            with client.websocket_connect(
                f"/ws/replacements/{entry['job_id']}?token={denied}"
            ):
                pass

    def test_admin_does_not_reclaim_a_live_processing_lease(self):
        replacement.save_replacement_queue([{
            "id": "leased",
            "job_id": "job-leased",
            "bot_name": "Example Bot",
            "status": "processing",
            "processing_heartbeat_at": time.time(),
        }])
        with (
            patch.object(replacement, "load_pool", return_value={"free_sessions": ["new.session"]}),
            patch.object(
                replacement, "process_ready_replacements",
                new=unittest.mock.AsyncMock(return_value=[]),
            ) as process,
        ):
            result = asyncio.run(replacement.process_queue_by_admin())
        self.assertEqual(0, result["processed"])
        self.assertEqual("No queued replacements", result["message"])
        process.assert_not_awaited()

    def test_admin_recovers_only_a_stale_processing_lease(self):
        replacement.save_replacement_queue([{
            "id": "stale",
            "job_id": "job-stale",
            "bot_name": "Example Bot",
            "status": "processing",
            "processing_heartbeat_at": time.time() - replacement.PROCESSING_LEASE_SEC - 1,
        }])
        with (
            patch.object(replacement, "load_pool", return_value={"free_sessions": ["new.session"]}),
            patch.object(
                replacement, "process_ready_replacements",
                new=unittest.mock.AsyncMock(return_value=[]),
            ) as process,
        ):
            result = asyncio.run(replacement.process_queue_by_admin())
        self.assertEqual(1, result["total"])
        process.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
