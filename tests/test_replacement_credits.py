import unittest

from code.replacement import (
    _reset_free_replacements_on_renewal,
    consume_free_replacement,
    get_free_replacements_remaining,
)


class ReplacementCreditTests(unittest.TestCase):
    def test_remaining_combines_plan_and_admin_bonus(self):
        cfg = {
            "free_replacements_limit": 2,
            "replacements_used": 1,
            "admin_free_replacement_credits": 3,
        }
        self.assertEqual(4, get_free_replacements_remaining(cfg))

    def test_plan_credit_is_consumed_before_admin_bonus(self):
        cfg = {
            "free_replacements_limit": 2,
            "replacements_used": 1,
            "admin_free_replacement_credits": 3,
        }
        self.assertEqual("plan", consume_free_replacement(cfg))
        self.assertEqual(2, cfg["replacements_used"])
        self.assertEqual(3, cfg["admin_free_replacement_credits"])

        self.assertEqual("admin_bonus", consume_free_replacement(cfg))
        self.assertEqual(2, cfg["admin_free_replacement_credits"])

    def test_renewal_preserves_unused_admin_bonus(self):
        cfg = {
            "free_replacements_limit": 1,
            "replacements_used": 1,
            "admin_free_replacement_credits": 2,
        }
        _reset_free_replacements_on_renewal(cfg, {"free_replacements": 3})
        self.assertEqual(3, cfg["free_replacements_limit"])
        self.assertEqual(0, cfg["replacements_used"])
        self.assertEqual(2, cfg["admin_free_replacement_credits"])
        self.assertEqual(5, get_free_replacements_remaining(cfg))

    def test_unlimited_plan_does_not_consume_bonus(self):
        cfg = {
            "free_replacements_limit": -1,
            "replacements_used": 0,
            "admin_free_replacement_credits": 4,
        }
        self.assertEqual("unlimited", consume_free_replacement(cfg))
        self.assertEqual(4, cfg["admin_free_replacement_credits"])


if __name__ == "__main__":
    unittest.main()
