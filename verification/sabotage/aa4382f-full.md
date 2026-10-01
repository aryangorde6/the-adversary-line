# Sabotage Report for `aa4382f` — Tablekeeper stage 1

**Accepted commit:** `aa4382f509e8266ad8d9d008dc83f6322815523f` (short: `aa4382f`)

| # | Defect (one line) | Clone Path | Clone Commit | Requirement Broken (verbatim) | Supplied Checks (host) | Supplied Checks (isolated) | Adversary Probes | Ledger Rows Failed | Missed By |
|---|-------------------|------------|--------------|-------------------------------|------------------------|----------------------------|------------------|-------------------|-----------|
| 1 | `overlaps()` uses closed interval (`<=`) instead of half-open (`<`) | `/tmp/sabotage/mutant-1` | `mutant-1` | "Two `confirmed` reservations must never occupy the same table at overlapping times, including during concurrent requests. Occupancy is the half-open interval `[starts_at, starts_at + reservation_duration)`." | **FAIL** (3 failures) | **FAIL** (3 failures) | **CAUGHT** | P22, P23, P33, P36b, P37, P9, V4, V5, V6, X5 | — |
| 2 | `tableIsFree()` always returns `true` | `/tmp/sabotage/mutant-2` | `mutant-2` | "The table is taken for an overlapping interval \| 409 `table_unavailable`" | **FAIL** (9 failures) | **FAIL** (9 failures) | **CAUGHT** | P15, P22, P23, P31, P33, P36b, P37, P38, P39, P9, V13, V14, V15, X10, X12, X5 | — |
| 3 | Write mutex removed (`withLock` → direct call) | `/tmp/sabotage/mutant-3` | `mutant-3` | "Concurrent requests \| up to 50 in flight" | **PASS** (120/120) | **PASS** (120/120) | **MISSED** | D10 (UNDECIDED) | **Both** |
| 4 | Idempotency check moved AFTER handler execution | `/tmp/sabotage/mutant-4` | `mutant-4` | "After the body has been parsed as a JSON object and the caller authenticated, idempotency is resolved before endpoint-specific field validation or current-resource checks. Thus a used key with a different JSON body returns `409 idempotency_key_reuse` even when that new body would otherwise be invalid." | **FAIL** (2 failures) | **FAIL** (2 failures) | **CAUGHT** | I4, I7, I10, I11, I12, V17, X13 | — |
| 5 | Replay returns mutated response (new `reservation_id`, `reference`, `created_at`) | `/tmp/sabotage/mutant-5` | `mutant-5` | "Replay: same key, same body \| **200**, body identical to the original response as a JSON value" | **FAIL** (2 failures) | **FAIL** (2 failures) | **CAUGHT** | I7, I10, I11, I12, V17, V19, X13 | — |
| 6 | Failed (4xx) requests store idempotency receipt, burning the key | `/tmp/sabotage/mutant-6` | `mutant-6` | "Key reused after the original request failed with 4xx \| Treated as a first use" | **PASS** (120/120) | **PASS** (120/120) | **CAUGHT** | I9, V15, X12, X13, X14, X3, X4 | **Supplied checks** |
| 7 | `reservation_duration_minutes` treated as wall-clock (local time + minutes then re-resolve) | `/tmp/sabotage/mutant-7` | `mutant-7` | "`reservation_duration_minutes` is **absolute time**, not wall-clock. A 90-minute reservation starting at 01:30 on a fall-back night ends 90 real minutes later, and its local `ends_at` will read 02:00, not 03:00." | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | T10 | — |
| 8 | Fall-back resolves to second occurrence (later instant) | `/tmp/sabotage/mutant-8` | `mutant-8` | "Fall back. Local times in the repeated hour occur twice. **Always resolve to the first occurrence — the one before the clocks change.**" | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | T4, T10, T13 | — |
| 9 | Spring-forward gap times accepted (fallback to nearby valid time) | `/tmp/sabotage/mutant-9` | `mutant-9` | "Spring forward. Local times in the skipped hour do not exist. They never appear in availability, and booking one is 422 `invalid_local_time`" | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | T3, T7, T12.gap-berlin, T12.gap-ny, P20 | — |
| 10 | Import discards tokens and receipts (replaces with empty arrays) | `/tmp/sabotage/mutant-10` | `mutant-10` | "Preserve accounts and hashed-password login, existing bearer tokens, fixture configuration, reservations, references, all completed idempotent request bodies and original responses." | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | X10, X11, X12, X13, X14, V19, X6, X9 | — |
| 11 | Random 5xx (10% chance) on `/health` | `/tmp/sabotage/mutant-11` | `mutant-11` | "Requests must not produce 5xx responses, including under concurrent load." | **PASS** (120/120) | **PASS** (120/120) | **MISSED** | (none triggered) | **Both** |
| 12 | Past bookings rejected (`starts_instant < Date.now()` throws) | `/tmp/sabotage/mutant-12` | `mutant-12` | "Fixtures may use any calendar date. A booking must not be rejected solely because its start is in the past; the cancellation and amendment cutoff rules still apply." | **PASS** (120/120) | **PASS** (120/120) | **CAUGHT** | M7, M7b, M7c, T12.gap-berlin, T12.gap-ny, T12.plain-berlin, T12.plain-ny | **Supplied checks** |
| 13 | Idempotency key scoped globally (removed `userId` from `receiptKey`) | `/tmp/sabotage/mutant-13` | `mutant-13` | "The key is scoped to **the authenticated user**. Two different users may use the same key string with no interaction between them." | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | I2 | — |
| 14 | Availability grid uses `m < closeMinutes` instead of `m + duration <= closeMinutes` | `/tmp/sabotage/mutant-14` | `mutant-14` | "A slot appears for every `slot_minutes` step from `opens` such that `slot + reservation_duration_minutes <= closes`." | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | M5 | — |
| 15 | Cutoff comparison uses `>` instead of `>=` | `/tmp/sabotage/mutant-15` | `mutant-15` | "Now is within `cancellation_cutoff_minutes` of `starts_at`, or later \| 409 `cutoff_passed`" | **PASS** (120/120) | **PASS** (120/120) | **MISSED** | (none — P33/P36b/P37 fail for unrelated reasons) | **Both** |
| 16 | Cancel returns cancelled view but doesn't update state (table not freed) | `/tmp/sabotage/mutant-16` | `mutant-16` | "Frees the table immediately: the next `GET /availability` must offer that slot again." | **FAIL** (2 failures) | **FAIL** (4 failures) | **CAUGHT** | P29, P31, P33, P34, P36b, P37 | — |
| 17 | Import regenerates `reference` and `created_at` for reservations | `/tmp/sabotage/mutant-17` | `mutant-17` | "Identities, statuses and timestamps must not be regenerated." | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | X11, X13, X9 | — |
| 18 | `GET /reservations/{reference}` returns any user's reservation (no owner check) | `/tmp/sabotage/mutant-18` | `mutant-18` | "**404 if it is not the caller's** — do not leak the existence of other people's bookings." | **FAIL** (1 failure) | **FAIL** (5 failures) | **CAUGHT** | P29 | — |
| 19 | `POST /reservation-moves` applies moves sequentially (not atomically) | `/tmp/sabotage/mutant-19` | `mutant-19` | "Either every move commits or nothing changes: occupancy, reservation records and retry keys." | **PASS** (120/120) | **PASS** (120/120) | **CAUGHT** | V13, V15 | **Supplied checks** |
| 20 | Passwords stored in plaintext (`plaintext$password`) | `/tmp/sabotage/mutant-20` | `mutant-20` | "Passwords must be stored using a password-hashing function such as bcrypt, scrypt or Argon2, or an equivalent. Plaintext password storage is not permitted." | **PASS** (120/120) | **PASS** (120/120) | **MISSED** | (A9 passes — only checks fixture passwords) | **Both** |
| 21 | `party_size` accepts string `"4"` and boolean `true` | `/tmp/sabotage/mutant-21` | `mutant-21` | "`party_size` below 1, or not an integer \| 422 `validation_failed`" | **FAIL** (2 failures) | **FAIL** (2 failures) | **CAUGHT** | E11, E17, R1, P36 | — |
| 22 | Missing `Idempotency-Key` returns 422 `validation_failed` instead of 400 `missing_idempotency_key` | `/tmp/sabotage/mutant-22` | `mutant-22` | "Required `Idempotency-Key` header absent or empty \| 400 `missing_idempotency_key`" | **FAIL** (1 failure) | **FAIL** (1 failure) | **CAUGHT** | E4, I1, I5, V2 | — |

## Summary

| Metric | Count |
|--------|-------|
| Total mutants tested | 22 |
| Supplied checks (host) caught | 14 / 22 |
| Supplied checks (isolated) caught | 14 / 22 |
| Adversary probes caught | 17 / 22 |
| **Missed by BOTH** | **3** (mutants 3, 11, 15) |
| Missed by supplied checks only | 3 (mutants 6, 12, 19) |

## Critical Findings (Missed by Both)

1. **Mutant 3 — Concurrency mutex removed** (defect 6): The write mutex protecting concurrent reservations was removed. Neither the supplied checks nor adversary probes detected this because the concurrency test only runs 10 clients (not 50) and the adversary's `overlap_50.sh` is a shell script not executed by `run-all.mjs`. **Requirement**: "Concurrent requests \| up to 50 in flight" (D10) and INV1.

2. **Mutant 11 — Random 5xx on `/health`** (defect 11): A 10% chance of 5xx on health checks. Neither test suite triggered it due to deterministic execution. **Requirement**: "Requests must not produce 5xx responses, including under concurrent load" (E16).

3. **Mutant 15 — Cutoff boundary uses `>` instead of `>=`** (defect 11): A booking exactly at the cutoff boundary becomes cancellable. The test fixtures use cutoff=120, so the exact boundary is not exercised. **Requirement**: "Now is within `cancellation_cutoff_minutes` of `starts_at`, or later \| 409 `cutoff_passed`" (P33).

## Missed by Supplied Checks, Caught by Adversary Probes

4. **Mutant 6 — Failed key burns idempotency key** (defect 4): Harness doesn't test failed-key-reuse; adversary probe I9 catches it.

5. **Mutant 12 — Past bookings rejected** (defect 17): Harness doesn't test past bookings; adversary probes M7/M7b/M7c catch it.

6. **Mutant 19 — Non-atomic reservation moves** (defect 16): Harness doesn't test partial batch failure; adversary probes V13/V15 catch it.

## Missed by Adversary Probes, Caught by Supplied Checks

None — adversary probes caught all mutants that supplied checks caught, plus 3 more.