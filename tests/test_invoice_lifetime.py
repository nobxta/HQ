import json
import asyncio
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch


class InvoiceLifetimeTests(unittest.TestCase):
    def test_admin_setting_controls_label_and_stored_deadline(self):
        from code.shop import payment_constants, storage

        with tempfile.TemporaryDirectory() as tmp:
            settings_file = Path(tmp) / "admin_settings.json"
            settings_file.write_text(json.dumps({"invoice_lifetime_hours": 1}), "utf-8")
            with patch.object(payment_constants, "ADMIN_SETTINGS_FILE", settings_file):
                self.assertEqual(payment_constants.get_invoice_lifetime_hours(), 1)
                self.assertEqual(payment_constants.format_invoice_lifetime(), "1 hour")
                created = "2030-01-01T10:00:00Z"
                expires = storage._expiry_from_created(created)
                self.assertEqual(
                    datetime.fromisoformat(expires.replace("Z", "")),
                    datetime(2030, 1, 1, 11, 0, 0),
                )

    def test_invalid_or_missing_setting_uses_twelve_hour_default(self):
        from code.shop import payment_constants

        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.json"
            with patch.object(payment_constants, "ADMIN_SETTINGS_FILE", missing):
                self.assertEqual(payment_constants.get_invoice_lifetime_hours(), 12)

            invalid = Path(tmp) / "admin_settings.json"
            invalid.write_text(json.dumps({"invoice_lifetime_hours": 0}), "utf-8")
            with patch.object(payment_constants, "ADMIN_SETTINGS_FILE", invalid):
                self.assertEqual(payment_constants.get_invoice_lifetime_hours(), 12)

    def test_admin_api_persists_the_single_global_value(self):
        from api.routers import system

        with tempfile.TemporaryDirectory() as tmp:
            settings_file = Path(tmp) / "admin_settings.json"
            with (
                patch.object(system, "ADMIN_SETTINGS_FILE", settings_file),
                patch.object(system.wrappers, "log_admin_action", new=AsyncMock()),
            ):
                asyncio.run(system.update_admin_settings({"invoice_lifetime_hours": 3}))
                response = asyncio.run(system.get_admin_settings())

            self.assertEqual(response["invoice_lifetime_hours"], 3)
            self.assertEqual(json.loads(settings_file.read_text("utf-8"))["invoice_lifetime_hours"], 3)

    def test_admin_api_rejects_fractional_hours(self):
        from api.routers import system
        from fastapi import HTTPException

        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(system, "ADMIN_SETTINGS_FILE", Path(tmp) / "admin_settings.json"):
                with self.assertRaises(HTTPException):
                    asyncio.run(system.update_admin_settings({"invoice_lifetime_hours": 1.5}))


if __name__ == "__main__":
    unittest.main()
