import unittest
from datetime import datetime
from unittest.mock import patch

from code.shop.renewals import effective_renewal_options, resolve_renewal_price


PLANS = {
    "starter": [
        {"id": "silver", "price_week": 18, "price_month": 55, "sessions": 4},
    ]
}


class RenewalPricingTests(unittest.TestCase):
    def cfg(self, **extra):
        base = {
            "plan_name": "silver",
            "mode": "starter",
            "valid_till": "30/08/2026",
            "renewal_prices": {"7d": None, "30d": None},
        }
        base.update(extra)
        return base

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_plan_default_7d_price(self, _plans):
        price = resolve_renewal_price(self.cfg(), 7)
        self.assertEqual(str(price["amount"]), "18.00")
        self.assertEqual(price["pricing_source"], "plan")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_plan_default_30d_price(self, _plans):
        price = resolve_renewal_price(self.cfg(), 30)
        self.assertEqual(str(price["amount"]), "55.00")
        self.assertEqual(price["pricing_source"], "plan")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_per_bot_7d_override(self, _plans):
        price = resolve_renewal_price(self.cfg(renewal_prices={"7d": "12.83", "30d": None}), 7)
        self.assertEqual(str(price["amount"]), "12.83")
        self.assertEqual(price["pricing_source"], "override")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_per_bot_30d_override(self, _plans):
        price = resolve_renewal_price(self.cfg(renewal_prices={"7d": None, "30d": "49.99"}), 30)
        self.assertEqual(str(price["amount"]), "49.99")
        self.assertEqual(price["pricing_source"], "override")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_one_override_other_uses_plan_default(self, _plans):
        cfg = self.cfg(renewal_prices={"7d": "10", "30d": None})
        self.assertEqual(str(resolve_renewal_price(cfg, 7)["amount"]), "10.00")
        self.assertEqual(str(resolve_renewal_price(cfg, 30)["amount"]), "55.00")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_early_renewal_preserves_remaining_time(self, _plans):
        opts = effective_renewal_options(self.cfg(valid_till="30/08/2026"), now=datetime(2026, 8, 24, 12, 0, 0))
        self.assertEqual(opts["options"]["7d"]["new_valid_till"], "06/09/2026")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_expired_renewal_starts_from_now(self, _plans):
        opts = effective_renewal_options(self.cfg(valid_till="01/08/2026"), now=datetime(2026, 8, 24, 12, 0, 0))
        self.assertEqual(opts["options"]["30d"]["new_valid_till"], "23/09/2026")

    @patch("code.shop.renewals.load_plans", return_value=PLANS)
    def test_unsupported_duration_rejected(self, _plans):
        with self.assertRaises(ValueError):
            resolve_renewal_price(self.cfg(), 14)


if __name__ == "__main__":
    unittest.main()
