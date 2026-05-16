#!/usr/bin/env python3
"""
Concurrency simulation for AdBot creation session assignment.

Run this to verify that with a global creation-pool lock, multiple creation
jobs cannot assign the same session to two bots. Uses the same pattern as
code/admin.py: creation_pool_lock wraps load_pool + assign + save_pool.

Usage (from repo root):
  python -m scripts.concurrency_simulation_check

Expected: "PASS: No duplicate session assignment; all assigned sessions unique."
"""

import sys
import threading

# Same pattern as admin.py: one lock for load + assign + save
creation_pool_lock = threading.Lock()


def simulate_assign_from_pool(pool: dict, n: int) -> list[str]:
    """Simulate assigning n sessions from pool['free_sessions']; mutates pool in place."""
    free = list(pool.get("free_sessions", []))
    assigned: list[str] = []
    for _ in range(n):
        if not free:
            break
        s = free.pop(0)
        assigned.append(s)
    pool["free_sessions"] = free
    return assigned


def worker_job(
    worker_id: int, pool_snapshot: dict, n_assign: int, results: list, lock: threading.Lock
) -> None:
    """Simulate one creation worker: hold lock, load pool, assign n sessions, 'save' pool."""
    with lock:
        # Simulate load_adbot() -> get our own copy to mutate
        local_pool = {"free_sessions": list(pool_snapshot.get("free_sessions", []))}
        assigned = simulate_assign_from_pool(local_pool, n_assign)
        results.append((worker_id, assigned))
        # Simulate save_pool: update shared snapshot for next worker
        pool_snapshot["free_sessions"] = local_pool["free_sessions"]


def run_simulation() -> bool:
    # Shared pool: 4 sessions; one global lock (same pattern as admin.creation_pool_lock)
    shared_pool = {"free_sessions": ["s1.session", "s2.session", "s3.session", "s4.session"]}
    results: list[tuple[int, list[str]]] = []
    threads = [
        threading.Thread(target=worker_job, args=(1, shared_pool, 2, results, creation_pool_lock)),
        threading.Thread(target=worker_job, args=(2, shared_pool, 2, results, creation_pool_lock)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # Check: no session appears in more than one assignment
    all_assigned = []
    for _wid, assigned in results:
        all_assigned.extend(assigned)
    if len(all_assigned) != len(set(all_assigned)):
        print("FAIL: Duplicate session assignment detected:", all_assigned)
        return False
    # Check: remaining free_sessions should not include any assigned
    free_now = set(shared_pool.get("free_sessions", []))
    for _wid, assigned in results:
        for s in assigned:
            if s in free_now:
                print("FAIL: Assigned session still in free_sessions:", s)
                return False
    print("PASS: No duplicate session assignment; all assigned sessions unique.")
    return True


if __name__ == "__main__":
    ok = run_simulation()
    sys.exit(0 if ok else 1)
