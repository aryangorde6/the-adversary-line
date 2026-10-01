# Tablekeeper stage 1 — verification of `ad00f9b`

Target: `ad00f9bfb84b7d226417573ea2a7522b363c6813` (supersedes `ddc90bf` and `b607739`).
Spec: `dark-factory-wearedevs/tablekeeper/spec/stage-1.md`, 472 lines, read only.
Verdict: **BLOCKED** on three spec violations.

## What was run

- Clean checkout at `/tmp/check-ad00f9b` at `ad00f9b`, image `tk-adv2`, run on port 8080 with
  `--cpus=2 --memory=2g`; a second instance of the same image on 8081 for the two-instance checks.
  No product file was read or written while verifying; nothing outside `verification/` was touched.
- Supplied checks, host mode: `harness run --track tablekeeper --repo /tmp/check-ad00f9b --stage 1
  --out .../checks/tablekeeper/s1-a-1` → **stage 1: pass**, stage 2: fail (expected, out of scope).
- Supplied checks, isolated mode: same with `--mode isolated --out .../s1-a-2` → **stage 1: pass**.
- Own suite: `node verification/probes/run-all.mjs` → `rows in ledger 164, decided 183,
  failures 8, undecided 0`. Every one of the 164 ledger rows is decided; the 19 extra ids are the
  new DST probes (T12–T16) and the open-question probes (O1–O7). No 5xx, no slow request, no
  error-shape violation and no code/status mismatch was seen anywhere else, including the
  idempotent replays, the amendment and batch-move paths, the import round trip, and the
  concurrent-booking race.

## Blocking findings

### F1 — wrong JSON type on the fixture path answers 422, not 400 (E3, E14)

`POST /_test/reset` with a known field of the wrong JSON type:

| fixture | answer |
|---|---|
| `{"restaurants": 7}` | `422 {"error":{"code":"validation_failed","message":"restaurants must be an array"}}` |
| `{"users": "ada"}` | `422 … "users must be an array"` |
| `{"reservations": 3}` | `422 … "reservations must be an array"` |
| `{"restaurants": [7]}` | `422 … "restaurant must be an object"` |
| nested `"tables": 7` | `422 … "tables must be an array"` |

§5, line 160: `400 | malformed_request | Unparseable body, or a field of the wrong JSON type`.
§5, line 177: "Reserve 400 `malformed_request` for a body that does not parse or a field of the
wrong type." All five bodies parse, and every field is present with the wrong type.

This is confined to the fixture validator: `POST /reservations` with `restaurant_id: 5` or
`table_id: []` answers `400 malformed_request` as required, so the rule is implemented on the
product path and missed on `/_test/reset`.

### F2 — a `cancellation_cutoff_minutes` of 0 cannot be seeded (O1, O2)

`POST /_test/reset` answers `422 {"error":{"code":"validation_failed","message":"restaurant
r_cut cancellation_cutoff_minutes must be a positive whole number of minutes"}}` for `0`.
The same value is accepted by the other test endpoint: an export with that field set to `0`
imports with `204` and reads back as `0`.

Nothing in stage-1.md states a range for this field. §4, line 103 only describes it
("A booking cannot be cancelled or changed within this many minutes of its start"), and the only
shared range in the document is `Idempotency-Key`, 1 to 255 characters (§5, line 182). §5 allows
422 for a correct-type field only for "an invalid format or out-of-range value … invalid dates,
negative counts and values exceeding a stated maximum or length". Zero is none of those, so the
floor the fixture validator invents is not in the spec, and the service's own import path proves
the model accepts it.

The cutoff arithmetic itself is correct once 0 is installed (minute-granularity restaurant):
a booking starting exactly now → cancel `409 cutoff_passed`; a booking starting in an hour →
`200 cancelled`; a booking that already started → `409 cutoff_passed`. So the refusal is a
validator artefact, not a semantic requirement. A negative value (`-1`, `-30`) answers
`422 validation_failed`, which is right under §5's "negative counts", and the string `"0"`
answers 422 where §5 line 177 requires 400 — the same F1 defect on this field.

### F3 — import installs states carrying impossible local times (O5, O6)

`POST /_test/import` answers `204` and changes the destination for each of these, where the only
change from a genuine export is one reservation's `starts_at_local`:

| `starts_at_local` | answer | destination afterwards |
|---|---|---|
| `"2026-02-30T19:00"` | `204` | holds `2026-02-30T19:00` |
| `"25:00"`-style value `"2026-12-10T25:00"` | `204` | holds it |
| `"2026-12-10T19:00:00Z"` | `204` | holds it |
| `"not a date"` | `204` | holds it |

§10: "missing fields, wrong track/version or an invalid state give 422 `validation_failed`
without changing the destination." §5 fixes the only valid form: a bare local
`YYYY-MM-DDTHH:MM`, and anything else is `422 validation_failed`. The "accepted unchanged"
guarantee covers exports this service produced, which can never carry these values, so the two
rules do not conflict.

The installed state is also internally incoherent: after importing `2026-02-30T19:00` over a
December booking, `GET /reservations/{reference}` answers `200` with `starts_at_local
"2026-02-30T19:00"` next to `starts_at "2026-12-10T19:00:00+01:00"`, and cancelling it succeeds
with `200`. No 5xx appears, but the destination now holds a booking no booking path could create.

## Non-blocking discrepancy with Decision 2

Decision 2 states that a local time which is both off the slot grid and outside opening hours —
"or would end after closes" — answers `422 outside_opening_hours` rather than
`422 not_on_slot_grid`. Measured on a 15-minute grid with a 90-minute duration, 18:00–23:45
(O7):

| start | answer | situation |
|---|---|---|
| `17:37`, `17:45` | `422 outside_opening_hours` | off grid and before opens |
| `00:07` | `422 outside_opening_hours` | off grid and after closes |
| `18:07`, `22:20` | `422 not_on_slot_grid` | off grid, inside the hours |
| `22:30`, `23:30`, `23:45` | `422 outside_opening_hours` | on grid, would end after closes |
| `23:07`, `23:20` | `422 not_on_slot_grid` | off grid **and** would end after closes |

So the service checks "outside the opening interval" before the grid and "would end after closes"
after it. stage-1.md states no precedence between the two 422 codes, so this is not a spec
violation and is not part of the block; but Decision 2's premise that the implementation returns
`outside_opening_hours` in both-fault cases holds only on the first half of that sentence.

## Everything else

The other 162 ledger rows pass on `ad00f9b`, including the copy change this target was sent for:
nonexistent local minutes are refused with `422 invalid_local_time` and never appear in
availability (Berlin 2026-03-29 and New York 2026-03-08, four grid starts each), ambiguous local
times resolve to the earlier instant (Berlin 2026-10-25 `02:30` → `+02:00`, New York 2026-11-01
`01:30` → `-04:00`), plain days resolve to a single offset, availability lists every slot exactly
once, and a booking that ends exactly at closing is accepted while `23:30` on a 90-minute duration
is refused.

## Note on the tree

While this run was in progress the repository advanced to `6b470d7` ("answer 400 malformed_request
for a fixture field of the wrong JSON type") with further uncommitted edits under `stage-1/src/`.
Those are the builder's; this result covers `ad00f9b` as requested and has not been re-run against
them.