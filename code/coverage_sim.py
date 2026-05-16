"""
Coverage assurance simulation for Telegram AdBot forwarding.
Uses actual assignment + FloodWait logic to estimate long-term coverage fairness.
Run: python -m code.coverage_sim  (from project root)
"""
from __future__ import annotations

import random
import time
from collections import defaultdict
from typing import Any


def _starter_assignment(
    group_ids: list[int], _session_index: int, _total_sessions: int, cycle_index: int
) -> list[int]:
    """Starter: every session gets full list, rotated by cycle for fairness."""
    n = len(group_ids)
    if n == 0:
        return []
    idx = cycle_index % n
    return list(group_ids[idx:]) + list(group_ids[:idx])


def _enterprise_assignment(
    group_ids: list[int], session_index: int, total_sessions: int
) -> list[int]:
    """Enterprise: session i gets slice [i*N/T : (i+1)*N/T]."""
    n = len(group_ids)
    t = max(1, total_sessions)
    i = max(0, min(session_index, t - 1))
    start = i * n // t
    end = (i + 1) * n // t
    return list(group_ids[start:end])


def simulate_cycles(
    groups: int,
    sessions: int,
    cycles: int,
    mode: str = "Starter",
    flood_prob_per_attempt: float = 0.0,
    seed: int | None = None,
) -> dict[str, Any]:
    """
    Simulate K cycles with N groups and T sessions.
    mode: "Starter" | "Enterprise"
    flood_prob_per_attempt: probability each attempt triggers FloodWait (then remaining skipped this cycle for that session).
    Returns: attempt_counts (group_id -> count), groups_never_attempted, per_cycle_skipped, and raw attempt matrix.
    """
    if seed is not None:
        random.seed(seed)
    group_ids = list(range(groups))
    t = max(1, sessions)
    attempt_counts: dict[int, int] = defaultdict(int)
    per_cycle_skipped: list[int] = []  # total groups skipped (due to FloodWait) per cycle

    for cycle in range(cycles):
        cycle_index = cycle  # or int(time.time() // 3600) + cycle for time-based
        skipped_this_cycle = 0

        if mode != "Enterprise":
            # Starter: each session gets full list (rotated)
            for sess in range(t):
                assigned = _starter_assignment(group_ids, sess, t, cycle_index)
                for g in assigned:
                    if random.random() < flood_prob_per_attempt:
                        # FloodWait: skip rest of this session's list this cycle
                        skipped_this_cycle += len(assigned) - assigned.index(g) - 1
                        attempt_counts[g] += 1  # this one was attempted before FloodWait
                        break
                    attempt_counts[g] += 1
        else:
            # Enterprise: sharded; on FloodWait remaining groups go to deferred; other sessions drain (one per drain step).
            deferred: list[int] = []
            for sess in range(t):
                assigned = _enterprise_assignment(group_ids, sess, t)
                for i, g in enumerate(assigned):
                    if random.random() < flood_prob_per_attempt:
                        deferred.extend(assigned[i + 1 :])  # remaining from this session (g already attempted)
                        attempt_counts[g] += 1
                        break
                    attempt_counts[g] += 1

            # Drain: process deferred one-by-one; each attempt has flood_prob_per_attempt (push-back not modeled)
            for g in deferred:
                if random.random() < flood_prob_per_attempt:
                    skipped_this_cycle += 1
                    continue
                attempt_counts[g] += 1

        per_cycle_skipped.append(skipped_this_cycle)

    never = [g for g in group_ids if attempt_counts[g] == 0]
    return {
        "attempt_counts": dict(attempt_counts),
        "groups_never_attempted": never,
        "groups_never_attempted_count": len(never),
        "per_cycle_skipped": per_cycle_skipped,
        "mode": mode,
        "groups": groups,
        "sessions": sessions,
        "cycles": cycles,
        "flood_prob_per_attempt": flood_prob_per_attempt,
    }


def estimate_attempt_distribution(attempt_counts: dict[int, int]) -> dict[str, Any]:
    """From simulate_cycles attempt_counts, return min, max, mean, variance, and histogram."""
    if not attempt_counts:
        return {"min": 0, "max": 0, "mean": 0.0, "variance": 0.0, "histogram": {}}
    values = list(attempt_counts.values())
    n = len(values)
    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / n if n else 0.0
    hist: dict[int, int] = defaultdict(int)
    for v in values:
        hist[v] += 1
    return {
        "min": min(values),
        "max": max(values),
        "mean": mean,
        "variance": variance,
        "histogram": dict(hist),
    }


def estimate_skipped_probability(
    attempt_counts: dict[int, int],
    total_cycles: int,
    sessions: int,
    mode: str = "Starter",
) -> dict[str, Any]:
    """
    Estimate probability that a group was skipped in a cycle (under the simulation model).
    For Starter, expected attempts per group per cycle = sessions (each session has full list).
    For Enterprise, expected = 1 per cycle.
    """
    if not attempt_counts:
        return {"expected_per_cycle": 0, "skip_probability_estimate": 0.0}
    groups = len(attempt_counts)
    total_attempts = sum(attempt_counts.values())
    groups_with_zero = sum(1 for c in attempt_counts.values() if c == 0)
    if mode != "Enterprise":
        expected_per_cycle = sessions  # each session tries full list
        skip_probability_estimate = groups_with_zero / groups if groups else 0.0
    else:
        expected_per_cycle = 1
        skip_probability_estimate = groups_with_zero / groups if groups else 0.0

    return {
        "expected_attempts_per_group_per_cycle": expected_per_cycle,
        "total_attempts": total_attempts,
        "groups_with_zero_attempts": groups_with_zero,
        "skip_probability_estimate": skip_probability_estimate,
        "mean_attempts_per_group": total_attempts / groups if groups else 0,
    }


def _main() -> None:
    import sys
    groups = 100
    sessions = 5
    cycles = 10
    mode = "Starter"
    flood_prob = 0.0
    if len(sys.argv) > 1:
        groups = int(sys.argv[1])
    if len(sys.argv) > 2:
        sessions = int(sys.argv[2])
    if len(sys.argv) > 3:
        cycles = int(sys.argv[3])
    if len(sys.argv) > 4:
        mode = sys.argv[4]
    if len(sys.argv) > 5:
        flood_prob = float(sys.argv[5])

    print("Coverage simulation: groups=%s sessions=%s cycles=%s mode=%s flood_prob=%s" % (groups, sessions, cycles, mode, flood_prob))
    out = simulate_cycles(groups, sessions, cycles, mode=mode, flood_prob_per_attempt=flood_prob, seed=42)
    print("groups_never_attempted:", out["groups_never_attempted_count"])
    dist = estimate_attempt_distribution(out["attempt_counts"])
    print("attempt_distribution:", dist)
    skip_est = estimate_skipped_probability(out["attempt_counts"], cycles, sessions, mode)
    print("skip_estimate:", skip_est)
    print("per_cycle_skipped (first 5):", out["per_cycle_skipped"][:5])


if __name__ == "__main__":
    _main()
