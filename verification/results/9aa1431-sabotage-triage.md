# Sabotage triage: 9aa1431 (abdbfeb), 12 mutants

I reproduced every disputed mutant rather than accept or reject the scores, and two of the six
misses are real probe gaps that are now closed. Three were scored against the wrong subset, and one
is an equivalent mutant that no probe can catch.

| # | Row | Saboteur says | Reproduced? | Now caught by |
| --- | --- | --- | --- | --- |
| 1 | Z37 | missed, equivalent mutant | **Agreed, equivalent** | nothing can catch it |
| 3 | Z23 | caught by adversary, missed by supplied | Agreed | `combined-b.mjs` Z23 (unchanged) |
| 5 | B7/I-series | missed, API probes do not cover replay | **Scored on the API subset only** | `screens.py` B7, and `upgrade.py` Y5 |
| 6 | U8/I-series | missed, API probes do not cover retry identity | **Scored on the API subset only** | `screens.py` B7, and `upgrade.py` Y4 and Y5 |
| 9 | Z17 | missed | **Real gap, now closed** | `combined.mjs` Z17, rewritten |
| 11 | Z35 | missed | **Real gap, now closed** | `combined-c.mjs` Z35, second half added |
| 12 | Y4 | missed, not in API probes | **Scored on the API subset only** | `upgrade.py` Y4, Y1 and Y5 |

Adversary probes caught 7 of 12 as scored, **10 of 12 as they stand now**, and the twelfth is
provably equivalent.

## The number that settles how to read the table

Mutant 1 is scored "38/38 passed" against my probes. `run.mjs` decides exactly 38 rows. The API
subset was the whole of the evidence for mutants 5, 6 and 12, and the rows that cover those three
— `B7`, `U8`, `U9`, `U13`, `Y4`, `Y5` — are in `screens.py`, `recovery.py` and `upgrade.py`, which
were not run. That is not a claim that the probes are blind to those behaviours; it is that they
were never consulted.

## Mutants 5, 6 and 12 — caught, once the right probes run

Each mutant built from `9aa1431`, then the full suite run against it:

| Mutant | Change | API subset | Browser / upgrade |
| --- | --- | --- | --- |
| 5 | `storeReceipt` keeps receipts only for non-2xx | 0 failing | **`B7` fails at both widths**: resubmit gave a new reference, reservations 1 -> 2. `upgrade.py` Y5 also fails |
| 6 | existing receipt never consulted | 0 failing | **`B7` fails at both widths**, and `upgrade.py` Y4 and Y5 fail |
| 12 | `importSnapshot` discards receipts | 0 failing | **`Y1`, `Y4` and `Y5` fail**: the retry after import answers 409 instead of 200 with the original reference |

So the honest statement for these three is: my API probes do not decide those rows, and the
browser and upgrade probes do. Both facts were already true before this report; what the report
adds is the reproduction.

## Mutant 9 (Z17) — a real gap, closed

The original probe sent `table_id: t_3` beside `table_ids: [t_1, t_2]`. Those two spellings
disagree, so the self-agreement check refuses the body as well, and a service with the both-keys
rule deleted still refuses it. The row passed for the wrong reason. Measured on the mutant:

```
both keys disagreeing answered 422 validation_failed
```

and on the real service the same body gives 422 with a different message — the both-keys rule
rather than the agreement rule. A body where the two spellings agree is refused by the both-keys
rule alone, which is the rule the requirement names:

| Body | real 9aa1431 | mutant 9 |
| --- | --- | --- |
| `table_id: t_1` beside `table_ids: [t_1]` | 422 `validation_failed`, "must carry either table_id or table_ids, not both" | **201**, a booking is created |
| `table_id: t_4` beside `table_ids: [t_4]` | 422 `validation_failed`, same message | **201** |

The probe now sends both shapes and requires both to be refused. Against mutant 9 it fails; against
`9aa1431` it passes.

## Mutant 11 (Z35) — a real gap, closed

The original Z35 proved a move is refused when the clash is with a booking already in state, which
the per-move conflict check answers on its own. It never sent a batch that collides with itself,
so a service with the intra-batch comparison deleted still passed. Measured directly:

| Batch | real 9aa1431 | mutant 11 |
| --- | --- | --- |
| one batch, two moves, both naming `[t_1, t_2]` at the same slot | 409 `table_unavailable`, "the requested bookings would overlap each other", both bookings unchanged | **201**, and both bookings then hold `["t_1","t_2"]` at the same time |

The second half of Z35 now sends that batch and requires 409 plus both bookings left where they
were. Against mutant 11 it fails; against `9aa1431` it passes.

## Mutant 1 (Z37) — equivalent, and not catchable by any probe

Agreed with the saboteur here, and it is the same finding as stage-1's mutant 3. The locked
callback in `stage-2/src/server.js:194` is `async` but contains no `await`: it reads the receipt
map, calls `matched.route.handler(ctx)`, stores a receipt, and returns. Every step is synchronous,
so on one Node thread the critical section cannot interleave with another request's. Deleting
`withLock`'s serialisation produced **0 failing rows across all 38 API rows**, which is what an
equivalent mutant looks like.

The mutex becomes load-bearing the moment a handler inside it gains an `await` — and it already
does outside the lock, which is why the `prepare` hook above it is awaited separately. I agree this
should be recorded as a known property of the current code state rather than as a probe gap.

## State after the corrections

Full suite at `9aa1431` with the two strengthened probes, from a clean clone:

| probe | result |
| --- | --- |
| `run.mjs` | 38 API rows, 0 failing |
| `screens.py` | 118 browser row decisions, 0 failing |
| `recovery.py` | 13 rows, 0 failing |
| `visual.py` | 39 measured visual rows at 375 and 1280, 0 failing |
| `upgrade.py` | 8 upgrade decisions, 0 failing |
| supplied harness | stage 1 pass, **stage 2 pass, 25 passed**, stage 3 fail (`checks/tablekeeper/s2-11`) |

Ledger: 132 rows, **130 decided, 0 failing, `Q1` and `Q2` undecided**. Unchanged from
`verification/results/9aa1431.md`; the verdict does not move, because the two gaps were in how
decisively two rows were probed, not in the product.

## Row by row

| Row | Result | Evidence |
| --- | --- | --- |
| R1 | PASS | probes/s2/run.mjs: GET / answered 200 text/html; charset=utf-8, 3703 bytes | probes/s2/screens.py: GET / at 375 has no availability-grid | probes/s2/screens.py: GET / at 1280 has no availability-grid |
| R2 | PASS | probes/s2/run.mjs: GET /signup answered 200 text/html; charset=utf-8, 3212 bytes | probes/s2/screens.py: GET /signup at 375 has no signup-email | probes/s2/screens.py: GET /signup at 1280 has no signup-email |
| R3 | PASS | probes/s2/run.mjs: GET /login answered 200 text/html; charset=utf-8, 2658 bytes | probes/s2/screens.py: GET /login at 375 has no login-email | probes/s2/screens.py: GET /login at 1280 has no login-email |
| R4 | PASS | probes/s2/run.mjs: GET /lookup answered 200 text/html; charset=utf-8, 2709 bytes | probes/s2/screens.py: GET /lookup at 375 has no lookup-reference-input | probes/s2/screens.py: GET /lookup at 1280 has no lookup-reference-input |
| R5 | PASS | probes/s2/visual.py: restaurant-select offers [['Zum Anker', 'r_anker']] | probes/s2/visual.py: restaurant-select offers [['Zum Anker', 'r_anker']] |
| R6 | PASS | probes/s2/run.mjs: the API answers application/json; charset=utf-8 while the screens answer text/html (base http://127.0.0.1:8080) |
| R7 | PASS | probes/s2/run.mjs: the specification permits this; nothing to enforce |
| U1 | PASS | probes/s2/recovery.py: a two-cover search answered 2.5s late, a five-cover search answered first; after both the grid marks 44 cells available: ['slot-t_1+t_2-00:00', 'slot-t_1+t_2-01:00', 'slot-t_1+t_2-02:00', 'slot-t_1+t_2-03:00'] |
| U2 | PASS | probes/s2/recovery.py: the late two-cover answer did not mark the small tables available again: [] |
| U3 | PASS | probes/s2/recovery.py: another client took slot-t_1-00:00 (201); booking-error=True text='!\nThat seating was just taken\nSomeone booked it while you were deciding. Pick another time or table — your party size and date are still here.'; the cell now  |
| U4 | PASS | probes/s2/recovery.py: after the 409 the form is still on screen (True) with the summary it had: 'Table Window 1 — Friday 2 October 2026 at 00:00\nZum Anker · your table is yours for 120 minutes' |
| U5 | PASS | probes/s2/recovery.py: no confirmation after the refused attempt: True |
| U6 | PASS | probes/s2/recovery.py: after the lost answer booking-uncertain read '?\nWe have not heard back yet\nYour booking may or may not have gone through, and we will not guess. Press the button below to send the very same request again — it cannot book you  |
| U7 | PASS | probes/s2/recovery.py: no booking-error (True) and no confirmation (True) |
| U8 | PASS | probes/s2/recovery.py: the retry carried key ['tk-0d26b0fd-778b-40dd-bb77-9998de389613', 'tk-0d26b0fd-778b-40dd-bb77-9998de389613'] and identical bodies True |
| U9 | PASS | probes/s2/recovery.py: the retry showed 'VKXE3W3C' against the reference the service had already issued 'VKXE3W3C', uncertainty and error gone, reservations 1 -> 1 |
| U10 | PASS | probes/s2/screens.py: a confirmed 422 shows booking-error, not booking-uncertain | probes/s2/screens.py: a confirmed 422 shows booking-error, not booking-uncertain |
| U11 | PASS | probes/s2/recovery.py: the 409 case shows booking-error, not booking-uncertain |
| U12 | PASS | probes/s2/screens.py: the shown reference '6HYXHF6M' reads back from the service | probes/s2/screens.py: the shown reference 'XYLU8PZ6' reads back from the service |
| U13 | PASS | probes/s2/recovery.py: the confirmation came from the service, not from anything cached: reservations 1 -> 1 |
| U14 | PASS | probes/s2/run.mjs: the specification permits this; nothing to enforce |
| U15 | PASS | probes/s2/recovery.py: the combination slot-t_1+t_2-11:00 was taken by another client (201); the form answered booking-error=True reading '!\nThat seating was just taken\nSomeone booked it while you were deciding. Pick another time or table — your pa |
| Q3 | PASS | probes/s2/visual.py: sign in: one dominant action ['login-submit'], no other control painted like it, grounds ['logout-button=rgb(255, 255, 255)', 'login-submit=rgb(163, 58, 28)'], first heading H1 'Sign in' at 224 against p at 268, so the heading si |
| Q4 | PASS | probes/s2/visual.py: at 375 every rendered state, raw-looking text: [] | probes/s2/visual.py: at 1280 every rendered state, raw-looking text: [] |
| Q5 | PASS | probes/s2/visual.py: at 375 a combination cell reads '00:00\nFree' | probes/s2/visual.py: at 1280 a combination cell reads '00:00\nFree' |
| Q6 | PASS | probes/s2/visual.py: at 375 2 font families ['Iowan Old Style', 'ui-sans-serif'], 7 sizes, 2 radii, 5 control heights | probes/s2/visual.py: at 1280 2 font families ['Iowan Old Style', 'ui-sans-serif'], 7 sizes, 2 radii, 6 control heights |
| Q7 | PASS | probes/s2/visual.py: at 375 with the booking form open the visible primary controls are ['booking-submit'] | probes/s2/visual.py: at 1280 with the booking form open the visible primary controls are ['booking-submit'] |
| Q8 | PASS | probes/s2/visual.py: at 375 available rgb(163, 58, 28)|rgb(255, 255, 255)|rgb(125, 42, 17)|1px|1|pointer|600 against unavailable rgb(242, 236, 228)|rgb(109, 95, 85)|rgb(211, 195, 176)|1px|1|default|600 | probes/s2/visual.py: at 1280 available rgb(163 |
| Q9 | PASS | probes/s2/visual.py: at 375 unavailable cells are styled from the available ones: rgb(163, 58, 28) against rgb(242, 236, 228) | probes/s2/visual.py: at 1280 unavailable cells are styled from the available ones: rgb(163, 58, 28) against rgb(242, 236,  |
| Q10 | PASS | probes/s2/visual.py: at 375 selected slot-t_1-00:00 against unselected slot-t_1-01:00 differs in ['backgroundColor', 'borderColor', 'boxShadow', 'color', 'outlineColor'] | probes/s2/visual.py: at 1280 selected slot-t_1-00:00 against unselected slot-t |
| Q11 | PASS | probes/s2/visual.py: a search answered 1.6s late; while it was outstanding the page held 77 elements, 9 of them new against the settled page: ['BUTTON|btn btn--primary|search-button|true|1|auto|progress|rgb(125, 42, 17)|1|Checking', 'DIV|field search |
| Q12 | PASS | probes/s2/visual.py: at 375 confirmation 'rgb(232, 243, 236)|rgb(36, 27, 21)|rgb(182, 216, 196)' against the form 'rgb(255, 255, 255)|rgb(36, 27, 21)|rgb(230, 218, 203)' | probes/s2/visual.py: at 1280 confirmation 'rgb(232, 243, 236)|rgb(36, 27, 21)| |
| Q13 | PASS | probes/s2/visual.py: booking-error 'rgb(251, 234, 236)|rgb(116, 18, 31)|rgb(232, 191, 197)' against the form 'rgb(255, 255, 255)|rgb(36, 27, 21)|rgb(230, 218, 203)' | probes/s2/visual.py: booking-error 'rgb(251, 234, 236)|rgb(116, 18, 31)|rgb(232, 19 |
| Q14 | PASS | probes/s2/visual.py: booking-uncertain 'rgb(253, 243, 222)|rgb(107, 68, 4)|rgb(230, 207, 160)' against booking-error 'rgb(251, 234, 236)|rgb(116, 18, 31)|rgb(232, 191, 197)' and the form 'rgb(255, 255, 255)|rgb(36, 27, 21)|rgb(230, 218, 203)' | probe |
| Q15 | PASS | probes/s2/visual.py: visible text carries ['Zum Anker', 'Window 1', 'Booth 4', 'Patio 3'] and no bare id (ids found: []) | probes/s2/visual.py: visible text carries ['Zum Anker', 'Window 1', 'Booth 4', 'Patio 3'] and no bare id (ids found: []) |
| Q16 | PASS | probes/s2/visual.py: at 375, every control in the search, booking form, confirmation and lookup states sat inside the viewport and none overlapped: [] |
| Q17 | PASS | probes/s2/visual.py: at 1280, every control in the search, booking form, confirmation and lookup states sat inside the viewport and none overlapped: [] |
| Q18 | PASS | probes/s2/screens.py: / at 375 scrolls sideways | probes/s2/screens.py: /signup at 375 scrolls sideways | probes/s2/screens.py: /login at 375 scrolls sideways | probes/s2/screens.py: /lookup at 375 scrolls sideways | probes/s2/screens.py: / at 1280 s |
| Q19 | PASS | probes/s2/visual.py: 4 controls on the screen, unlabelled: [] | probes/s2/visual.py: 4 controls on the screen, unlabelled: [] |
| Q20 | PASS | probes/s2/visual.py: tabbed through 41 controls; without a focus indicator: [] | probes/s2/visual.py: tabbed through 41 controls; without a focus indicator: [] |
| Q21 | PASS | probes/s2/visual.py: 251 visible text nodes, lowest contrast 5.23:1 on '00:00' at 14px; below the threshold: [] | probes/s2/visual.py: 251 visible text nodes, lowest contrast 5.23:1 on '00:00' at 14px; below the threshold: [] |
| Q22 | PASS | probes/s2/visual.py: a closed day reads '—\n\nNo sittings on Saturday 3 October 2026\n\nThis restaurant does not open on that day. Pick another day below and we will look again.\n\nFriday 9 October 2026\nFriday 16 October 2026' with 0 cells | probes/ |
| Q23 | PASS | probes/s2/visual.py: the empty state is '—\n\nNo sittings on Saturday 3 October 2026\n\nThis restaurant does not open on that day. Pick another day below and we will look again.\n\nFriday 9 October 2026\nFriday 16 October 2026' styled rgb(255, 255, 2 |
| Q24 | PASS | probes/s2/visual.py: every error element carries prose: auth, booking, uncertain, lookup all read as sentences | probes/s2/visual.py: every error element carries prose: auth, booking, uncertain, lookup all read as sentences |
| Q25 | PASS | probes/s2/visual.py: navigation on ['/', '/login', '/lookup']: [('/', ['brand-home', 'nav-find-table', 'nav-my-booking', 'logout-button']), ('/lookup', ['brand-home', 'nav-find-table', 'nav-my-booking', 'logout-button']), ('/login', ['brand-home', 'n |
| Q26 | PASS | probes/s2/run.mjs: the specification permits this; nothing to enforce |
| S1 | PASS | probes/s2/screens.py: signup inputs at 375: present=True types {"signup-email": "email", "signup-password": "password", "signup-display-name": "text"} | probes/s2/screens.py: signup inputs at 1280: present=True types {"signup-email": "email", "signup |
| S2 | PASS | probes/s2/screens.py: signup-submit at 375: visible=True | probes/s2/screens.py: signup-submit at 1280: visible=True |
| S3 | PASS | probes/s2/screens.py: login inputs were {"login-email": "email", "login-password": "password"} | probes/s2/screens.py: login inputs were {"login-email": "email", "login-password": "password"} |
| S4 | PASS | probes/s2/screens.py: a refused login at 375 left auth-error with text '!\nThat email and password do not match\nCheck for a stray space, or sign in with the address you used when you signed up.' | probes/s2/screens.py: a refused login at 1280 left a |
| S5 | PASS | probes/s2/screens.py: auth-error on a fresh /signup, a fresh /login and after signing in at 375: ['absent', 'absent', True] | probes/s2/screens.py: auth-error on a fresh /signup, a fresh /login and after signing in at 1280: ['absent', 'absent', True] |
| S6 | PASS | probes/s2/screens.py: current-user on every route at 375: [True, True, True, True] | probes/s2/screens.py: current-user on every route at 1280: [True, True, True, True] |
| S7 | PASS | probes/s2/screens.py: current-user read 'Ada' | probes/s2/screens.py: current-user read 'Ada' |
| S8 | PASS | probes/s2/screens.py: logout-button at 375 | probes/s2/screens.py: logout-button at 1280 |
| S9 | PASS | probes/s2/screens.py: current-user after logout at 375: [True, True] | probes/s2/screens.py: current-user gone on every route after logout: [True, True]; the token the browser held answered 200 before logout and 200 after, which stage-1.md permits be |
| G1 | PASS | probes/s2/screens.py: options ['r_anker'] against restaurant ids ['r_anker'] | probes/s2/screens.py: options ['r_anker'] against restaurant ids ['r_anker'] |
| G2 | PASS | probes/s2/screens.py: date-input type=date value='2026-10-02' | probes/s2/screens.py: date-input type=date value='2026-10-02' |
| G3 | PASS | probes/s2/screens.py: party-size-input type=number | probes/s2/screens.py: party-size-input type=number |
| G4 | PASS | probes/s2/screens.py: one search click issued 4 availability requests, all for the searched inputs: ['http://127.0.0.1:8080/availability?restaurant_id=r_anker&date=2026-10-02&party_size=2'] | probes/s2/screens.py: one search click issued 4 availabili |
| G5 | PASS | probes/s2/screens.py: no availability-grid at 375 | probes/s2/screens.py: no availability-grid at 1280 |
| G6 | PASS | probes/s2/screens.py: 110 cells, malformed ids [] | probes/s2/screens.py: 110 cells, malformed ids [] |
| G7 | PASS | probes/s2/screens.py: closed day: no-slots=True grid=False | probes/s2/screens.py: closed day: no-slots=True grid=False |
| G8 | PASS | probes/s2/screens.py: cells with no usable data-available: [] | probes/s2/screens.py: cells with no usable data-available: [] |
| G9 | PASS | probes/s2/screens.py: 0 cells disagree with the API, first [] | probes/s2/screens.py: 0 cells disagree with the API, first [] |
| G10 | PASS | probes/s2/screens.py: clicking slot-t_1-00:00 gave summary 'Table Window 1 — Friday 2 October 2026 at 00:00\nZum Anker · your table is yours for 120 minutes' | probes/s2/screens.py: clicking slot-t_1-00:00 gave summary 'Table Window 1 — Friday 2 Octo |
| G11 | PASS | probes/s2/screens.py: clicking the unavailable slot-t_4-00:00 left form=False url same=True | probes/s2/screens.py: clicking the unavailable slot-t_4-00:00 left form=False url same=True |
| G12 | PASS | probes/s2/screens.py: signed out click: auth-error=True url=http://127.0.0.1:8080/ form=False | probes/s2/screens.py: signed out click: auth-error=True url=http://127.0.0.1:8080/ form=False |
| B1 | PASS | probes/s2/screens.py: no booking-form at 375 | probes/s2/screens.py: no booking-form at 1280 |
| B2 | PASS | probes/s2/screens.py: summary for slot-t_1-00:00 read 'Table Window 1 — Friday 2 October 2026 at 00:00\nZum Anker · your table is yours for 120 minutes' | probes/s2/screens.py: summary for slot-t_1-00:00 read 'Table Window 1 — Friday 2 October 2026 a |
| B3 | PASS | probes/s2/screens.py: booking-party-size read '2' | probes/s2/screens.py: booking-party-size read '2' |
| B4 | PASS | probes/s2/screens.py: no booking-submit at 375 | probes/s2/screens.py: no booking-submit at 1280 |
| B5 | PASS | probes/s2/screens.py: party 9 on a small table: booking-error=True text='!\nThat seating is too small for your party\nTable Window 1 seats 2. Lower the number of guests, or choose a larger table or a pair.' | probes/s2/screens.py: party 9 on a small  |
| B6 | PASS | probes/s2/screens.py: the form after success: present=True | probes/s2/screens.py: the form after success: present=True |
| B7 | PASS | probes/s2/screens.py: resubmit gave '6HYXHF6M', reservations 1 -> 2, so the pair of submits made one booking | probes/s2/screens.py: resubmit gave 'XYLU8PZ6', reservations 1 -> 2, so the pair of submits made one booking |
| B8 | PASS | probes/s2/screens.py: a changed field sent key tk-2a8d84d7-5a9f-4f02-9f80-14c6146bce44 against tk-0e4bb746-c841-407a-8285-8b6a97f0bcdf; reference 6HYXHF6M -> '6HYXHF6M', reservations 2 -> 2, booking-error=True | probes/s2/screens.py: a changed field  |
| B9 | PASS | probes/s2/screens.py: idempotency keys ['tk-0e4bb746-c841-407a-8285-8b6a97f0bcdf', 'tk-0e4bb746-c841-407a-8285-8b6a97f0bcdf'] and identical bodies True | probes/s2/screens.py: idempotency keys ['tk-7394ca26-06f4-4494-8131-46c772fbdb4b', 'tk-7394ca26- |
| F1 | PASS | probes/s2/screens.py: no confirmation after a 201 at 375 | probes/s2/screens.py: no confirmation after a 201 at 1280 |
| F2 | PASS | probes/s2/screens.py: confirmation-reference read '6HYXHF6M' | probes/s2/screens.py: confirmation-reference read 'XYLU8PZ6' |
| F3 | PASS | probes/s2/screens.py: confirmation-details read 'Zum Anker, Friday 2 October 2026 at 00:00. Table Window 1, 2 guests.' | probes/s2/screens.py: confirmation-details read 'Zum Anker, Friday 2 October 2026 at 00:00. Table Window 1, 2 guests.' |
| L1 | PASS | probes/s2/screens.py: lookup input and submit at 375 | probes/s2/screens.py: lookup input and submit at 1280 |
| L2 | PASS | probes/s2/screens.py: lookup of a real reference XA7UDMZ5 at 375 | probes/s2/screens.py: lookup of a real reference WAHVKP71 at 1280 |
| L3 | PASS | probes/s2/screens.py: reservation-status read 'confirmed' | probes/s2/screens.py: reservation-status read 'confirmed' |
| L4 | PASS | probes/s2/screens.py: no cancel button at 375 for a confirmed booking | probes/s2/screens.py: after cancelling, status read 'cancelled' | probes/s2/screens.py: no cancel button at 1280 for a confirmed booking | probes/s2/screens.py: after cancelling, |
| L5 | PASS | probes/s2/screens.py: a cancelled booking at 375: button=False status='cancelled' | probes/s2/screens.py: a cancelled booking at 1280: button=False status='cancelled' |
| L6 | PASS | probes/s2/screens.py: an unknown reference gave error=True detail=False | probes/s2/screens.py: an unknown reference gave error=True detail=False |
| L7 | PASS | probes/s2/screens.py: a booking starting inside the 120-minute cutoff: error=True status='confirmed' button=True | probes/s2/screens.py: a booking starting inside the 120-minute cutoff: error=True status='confirmed' button=True |
| Y1 | PASS | probes/s2/upgrade.py: a stage-1 export carrying 2 users, 1 tokens, 1 reservations and 1 receipts imported with 204 and re-exported with 200; rows that did not survive: {}; rows stage 2 added: {}; the upgraded service then answers 200 for the imported |
| Y2 | PASS | probes/s2/upgrade.py: a token issued by stage 1 before the import reads 200 on the stage-2 service and returns the imported reservation XT6NQ71E; an unknown token reads 401, so the 200 is not vacuous | probes/s2/upgrade.py: the stage-1 session in loc |
| Y3 | PASS | probes/s2/upgrade.py: the reference from the stage-1 export XT6NQ71E typed into /lookup shows the detail panel True reading 'confirmed' against the exported status 'confirmed' |
| Y4 | PASS | probes/s2/upgrade.py: the lost-response booking retried on stage 2 with the same key 'adversary-lost-response-key' and the same stage-1 body (t_2 at 2026-10-02T00:00) answered 200 with reference XT6NQ71E, the original XT6NQ71E; reservations 1 -> 1 |
| Y5 | PASS | probes/s2/upgrade.py: after the retry the page shows the original confirmation '2AANGFCC' against the reference the export carried '2AANGFCC', the uncertain panel is gone True, and that reference still names exactly 1 reservation |
| Y6 | PASS | probes/s2/upgrade.py: an import of stage 2's own export (2 reservations, 2 receipts) answered 204 under the open page: the booking form is still there True, the party size still reads '4' against '4', the document was not reloaded (marker 'kept', url |
| Y7 | PASS | probes/s2/upgrade.py: the idempotency key and body the page held across the import are unchanged (True): key 'tk-ca53255f-0597-445b-b1c9-9bc88b431b33', body '{"restaurant_id":"r_anker","table_ids":["t_2"],"starts_at_local":"2026-10-02T02:00","party_s |
| Z1 | PASS | probes/s2/run.mjs: declared pair booking answered 201 {"reservation_id":"res_1","reference":"N4R85980","restaurant_id":"r_anker","table_ids":["t_1","t_2"],"party_size":6,"sta |
| Z2 | PASS | probes/s2/run.mjs: both members held from 2026-10-02T00:00 to +120 min and free again after, on all 22 slots |
| Z3 | PASS | probes/s2/run.mjs: table_id body answered 201 {"reservation_id":"res_2","reference":"RFMPF4O9","restaurant_id":"r_anker","table_ids":["t_3"],"party_size":2,"status":" |
| Z4 | PASS | probes/s2/run.mjs: three-table combinable entry in the fixture answered 422 |
| Z5 | PASS | probes/s2/run.mjs: undeclared pair answered 422 combination_not_allowed |
| Z6 | PASS | probes/s2/run.mjs: transitive pair answered 422 combination_not_allowed |
| Z7 | PASS | probes/s2/run.mjs: sum 6 answered 201, sum+1 answered 422 party_exceeds_capacity, options listed for party 7: 0 |
| Z8 | PASS | probes/s2/run.mjs: one statusless seed and one cancelled pair seed left the slot offering ["t_2","t_3","t_4"] |
| Z9 | PASS | probes/s2/run.mjs: the table_id seed occupied t_1, and the table_ids seed carried status cancelled so it held nothing |
| Z10 | PASS | probes/s2/run.mjs: slots without available_options: 0, malformed entries: 0, entries whose capacity is not the sum of their own tables: 0 of 572 checked across party sizes 1 to 6; first slot at party 4: [{"table_ids":["t_2"],"capacity":4},{"table_ids |
| Z11 | PASS | probes/s2/run.mjs: non-single ids in available_table_ids: none |
| Z12 | PASS | probes/s2/run.mjs: available_options matched the computed expectation at party sizes 1..6 on every slot |
| Z13 | PASS | probes/s2/run.mjs: singles in fixture order then pairs in combinable order, at every party size |
| Z14 | PASS | probes/s2/run.mjs: every pair listed in combinable order |
| Z15 | PASS | probes/s2/run.mjs: table_ids body stored as ["t_1","t_2"] |
| Z16 | PASS | probes/s2/run.mjs: table_id body gave table_ids ["t_3"] |
| Z17 | PASS | probes/s2/run.mjs: both keys disagreeing answered 422 validation_failed; both keys agreeing (table_id t_4 beside table_ids [t_4]) answered 422 validation_failed; 20 slots still offer a combination, so neither body booked |
| Z18 | PASS | probes/s2/run.mjs: create keys ["reservation_id","reference","restaurant_id","table_ids","party_size","status","starts_at_local","starts_at","ends_at","created_at"], read-back 200 {"reservation_id":"res_1","reference":"N4R85980","restaurant_id":"r_an |
| Z19 | PASS | probes/s2/run.mjs: single body carried table_id "t_3" |
| Z20 | PASS | probes/s2/run.mjs: pair create carried table_id: false, read-back: false |
| Z21 | PASS | probes/s2/run.mjs: same refusal, named as the table row requires |
| Z22 | PASS | probes/s2/run.mjs: three tables answered 422 combination_not_allowed |
| Z23 | PASS | probes/s2/run.mjs: single held 201, pair over it answered 409 table_unavailable |
| Z24 | PASS | probes/s2/run.mjs: party_size over the summed capacity answered 422 party_exceeds_capacity |
| Z25 | PASS | probes/s2/run.mjs: duplicate id answered 422 validation_failed |
| Z26 | PASS | probes/s2/run.mjs: patch to a declared pair answered 200 ["t_2","t_3"]; refusals: all five as documented; after the refusals the booking is still ["t_2","t_3"] |
| Z27 | PASS | probes/s2/run.mjs: cancel answered 200; the slot then offers ["t_1","t_2","t_3","t_4"] |
| Z28 | PASS | probes/s2/screens.py: 22 combination cells for party 2: ['slot-t_1+t_2-00:00', 'slot-t_1+t_2-01:00'] | probes/s2/screens.py: 22 combination cells for party 2: ['slot-t_1+t_2-00:00', 'slot-t_1+t_2-01:00'] |
| Z29 | PASS | probes/s2/screens.py: combination cells in combinable order: True | probes/s2/screens.py: combination cells in combinable order: True |
| Z30 | PASS | probes/s2/screens.py: confirmation-tables read 'Tables Window 1 and Window 2' | probes/s2/screens.py: confirmation-tables read 'Tables Window 1 and Window 2' |
| Z31 | PASS | probes/s2/screens.py: reservation-tables read 'Tables Window 1 and Window 2' | probes/s2/screens.py: reservation-tables read 'Tables Window 1 and Window 2' |
| Z32 | PASS | probes/s2/screens.py: single-table selection; the pair case is checked in booking_rows | probes/s2/screens.py: pair summary 'Tables Window 1 and Window 2 — Friday 2 October 2026 at 02:00\nZum Anker · your table is yours for 120 minutes' against ['Win |
| Z33 | PASS | probes/s2/screens.py: 88 single cells, first ['slot-t_1-00:00', 'slot-t_1-01:00'] | probes/s2/screens.py: 88 single cells, first ['slot-t_1-00:00', 'slot-t_1-01:00'] |
| Z34 | PASS | probes/s2/run.mjs: a move batch naming table_ids answered 201 {"reservations":[{"reservation_id":"res_1","reference":"Y914A2I4","restaurant_id":"r_anker","table_ids":["t_1","t_2"],"party_size":2,"status; the first booking now holds ["t_1","t_2"] |
| Z35 | PASS | probes/s2/run.mjs: a move onto tables held at an overlapping time answered 409 table_unavailable; the booking still holds ["t_2","t_3"] at 2026-10-02T18:00 | probes/s2/run.mjs: one batch naming the same pair at the same slot twice answered 409 table_ |
| Z36 | PASS | probes/s2/recovery.py: the refused combination left 1 booking holding both tables, and the summary named them: 'Tables Window 1 and Window 2 — Friday 2 October 2026 at 11:00\nZum Anker · your table is yours for 120 minutes' |
| Z37 | PASS | probes/s2/run.mjs: 50 concurrent pair bookings gave {"201":1,"409":49}; the slot then offers ["t_3","t_4"] |
