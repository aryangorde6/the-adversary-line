# Sabotage triage — the two mutants the probe suite did not catch

Commit under test: `aa4382f509e8266ad8d9d008dc83f6322815523f`.
Images `tablekeeper-mutant3` and `tablekeeper-mutant11` from the sabotage report.

| Mutant | Ledger row | Caught now? | Why |
|--------|-----------|-------------|-----|
| 3 (D10) | D10, INV1 | No — and it cannot be | Equivalent mutant, see below |
| 11 (E16) | E16 | Yes, as C1b/C1c | Real probe gap, now closed |

## Mutant 11 — a real gap, now closed

The report calls this "random 5xx on `/health`". It is not. The mutant throws a bare
`new Error('random 5xx')`, and `sendError` in `server.js:117` maps any non-`AppError`
to **422 `validation_failed`**, not to a 5xx. Measured on the mutant image:

```
400 sequential GET /health -> 200x363, 422x37
 50 concurrent GET /health -> 200x47, 422x3
```

So the defect was invisible to `E16`, which only counts answers `>= 500`, and it was
invisible to `C1`, because the suite happened to call `/health` only a handful of
times before giving up on it. Nine percent of calls failing is not a small number of
missed samples; a 10% defect needs about 100 calls to be a coin flip.

`/health` answering 200 with exactly `{"status":"ok"}` is a per-request contract, and a
flaky answer breaks it whether or not the failure is a 5xx. Two new rows:

- **C1b** — 400 sequential `/health` calls, every status and body recorded. A defect
  failing a share `p` of calls is missed with probability `(1-p)^400`, which is
  `1e-18` at `p=0.1`.
- **C1c** — the same 50 calls in flight at once, tying C1 to D10's concurrency limit.

Both pass on `aa4382f` and both fail on mutant 11. The E16 framing in the sabotage
report is worth correcting for the record: the mutant does not produce a 5xx, it
produces a spurious 422 on an endpoint that must always be 200.

## Mutant 3 — an equivalent mutant

`withLock` in `store.js:36` becomes `return fn()`, dropping the serialisation. Every
observable effect of the mutex depends on the critical section containing an `await`,
and it does not:

- The only `await` in the request path is `matched.route.prepare(...)` at
  `server.js:169`, which runs **before** the lock is taken. It is the scrypt work in
  `prepareSignup`, `prepareLogin` and `prepareReset`, deliberately placed outside the
  mutex.
- Every handler inside the lock is synchronous: `src/domain.js`, `src/model.js`,
  `src/moves.js`, `src/transfer.js` and `src/time.js` contain zero `await`s, and the
  three in `src/routes.js` are all in `prepare` functions.

A synchronous critical section cannot interleave with another request on a single
Node thread, so `fn()` and `lockTail.then(fn, fn)` are observationally identical. The
mutex is load-bearing only if a handler later grows an `await`, at which point D10 and
INV1 become decidable again and D10b would catch it.

D10b was added anyway, because the original D10 was a weak witness for the requirement:
one round of 50 *identical* requests only fails if the race window happens to line up
once. D10b runs 6 rounds of 50 *mixed* in-flight requests — contending and
non-contending bookings, availability reads, an export — and checks INV1 and partial
state from what the service reports rather than from the status codes it returned.
It passes on `aa4382f` and on mutant 3, which is the expected result for an equivalent
mutant.

## Probe-suite corrections found while reproducing this

Two probe bugs surfaced during this triage, both unrelated to the mutants:

- `api2.mjs` built its cutoff fixtures by adding minutes to "minutes past midnight",
  which produced an hour of `24` when the suite ran late in the evening and a 404 from
  the service. `P33`, `P36b` and `P37` failed for that reason alone. Now the instant is
  rounded to a quarter hour in absolute time and rendered in Berlin local time, and the
  fixture opens the next fortnight rather than today only.
- The delivery group and the `X5` second instance both assume host ports that the
  primary instance can collide with. Both are now passed explicitly.

## Final state

`aa4382f`, clean clone, primary instance under `--cpus=2 --memory=2g`:

```
--- rows in ledger 164, decided 193, failures 0, undecided 0
205 PASS lines
```

New rows `C1b`, `C1c` and `D10b` are all decided. Verdicts for `aa4382f` are unchanged:
pass.