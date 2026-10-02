# Stage 2 verification ledger — Tablekeeper

Source of truth: `/home/aryan/band_hack/dark-factory-wearedevs/tablekeeper/spec/stage-2.md`
(read-only; no seat may modify it). Stage-1 requirements continue to apply and are already
decided in `ledger-stage-1.md`; that ledger is **not** widened. Every row below is one testable
sentence of stage-2.md: every "must", every "never", every table row, every stated error and
every limit. 127 rows.

`Check` names the probe in `verification/probes/` that decides the row. `supplied:<name>` marks a
row a supplied check already decides. `review` marks a row the specification states as a
direction rather than a behaviour, decided by me reading the screenshots and saying so. A row
with no probe is a row I have not decided and therefore cannot pass.

**Written after the stage-2 tree existed, not before.** The room asked for this ledger before any
stage-2 code was written. That is no longer possible: the stage-2 commits were reported while I
was verifying `bf4afc9`, and I had already read `stage-2/src/` and `stage-2/public/` to judge the
screens. The mitigation, and its limit: every requirement below is quoted verbatim from
stage-2.md and the row ids follow the spec's own order, so a row cannot have been shaped by an
implementation, but I cannot claim the ledger is blind to the code the way the stage-1 ledger is.
Recorded here rather than glossed.

Row counts by group:

| Group | Meaning | Rows |
|---|---|---|
| R | Required routes and rendering | 7 |
| U | Competing clients and uncertain outcomes | 15 |
| Q | Product and visual direction | 26 |
| S | Signup and login screens | 9 |
| G | Search and availability grid | 12 |
| B | Booking form | 9 |
| C | Confirmation | 3 |
| L | Lookup | 7 |
| Y | Existing clients after an upgrade | 7 |
| Z | Combined tables, API and UI | 37 |
| | **Total** | **132** |

Seven stage-1 rows are re-decided at stage-2 semantics rather than restated here: D1 (`RUN.md`),
A-series session behaviour, I-series idempotency, E-series body shape, T-series zone handling,
X-series import and P-series single-table compatibility. Their stage-2 results are recorded in
`results/<commit>.md` under the stage-2 row ids, so a stage-1 verdict is never widened.

## R — Required routes and rendering

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| R1 | "The following screens must be reachable by URL." — `/` — "Search and availability grid" | `probes/s2/routes.mjs` → GET `/` is 200 and its HTML carries `restaurant-select` and `availability-grid` once the grid is rendered. |
| R2 | "The following screens must be reachable by URL." — `/signup` — "Signup" | `probes/s2/routes.mjs` → GET `/signup` is 200 and its HTML carries `signup-email`. |
| R3 | "The following screens must be reachable by URL." — `/login` — "Login" | `probes/s2/routes.mjs` → GET `/login` is 200 and its HTML carries `login-email`. |
| R4 | "The following screens must be reachable by URL." — `/lookup` — "Look up a reservation by reference" | `probes/s2/routes.mjs` → GET `/lookup` is 200 and its HTML carries `lookup-reference-input`. |
| R5 | "Other screens must be reachable through the UI." | `probes/s2/screens.mjs` → the booking form and the confirmation are reached by clicking through from `/`, never by URL. |
| R6 | "A screen route returns HTML; §3.4's `application/json` convention is about the API, and does not govern the routes in the table above." | `probes/s2/routes.mjs` → the four routes answer `Content-Type: text/html`, and the API answers JSON. |
| R7 | "Server-side and client-side rendering are both permitted." | no probe — the specification permits both; nothing to enforce. |

## U — Competing clients and uncertain outcomes

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| U1 | "If search A starts before search B but finishes after it, the grid, table labels and booking form must describe B." | `probes/s2/screens.mjs` → two searches with the second delayed; the late first answer is dropped and the grid, its cell testids and the booking summary all name B's restaurant/date/slot. |
| U2 | "A late response must not restore A's results." | `probes/s2/screens.mjs` → same run; after B renders, A's answer is delivered, and the grid still describes B and no A-only testid reappears. |
| U3 | "If another client takes a table after the form opens, a `409 table_unavailable` response shows `booking-error` and refreshes availability." | `probes/s2/screens.mjs` → form open for table T, a second API client books T, submit → `booking-error` present and the grid re-fetched so T's cell reads `data-available="false"`. |
| U4 | "Preserve the selected form and its inputs so the diner can change their choice." | `probes/s2/screens.mjs` → after U3 the `booking-form` is still on screen with the party size and selected slot the diner entered, editable. |
| U5 | "Do not show a confirmation for that attempt." | `probes/s2/screens.mjs` → after U3 no `confirmation` and no `confirmation-reference` exists. |
| U6 | "If a booking response is lost, including after the booking commits, show nonempty `booking-uncertain` text" | `probes/s2/screens.mjs` → the booking POST is aborted after the request leaves; `booking-uncertain` exists and its trimmed text length > 0. |
| U7 | "without `booking-error` or a new confirmation" | `probes/s2/screens.mjs` → same run; no `booking-error` and no `confirmation`. |
| U8 | "The unchanged form must retry with the same idempotency key and body." | `probes/s2/screens.mjs` → capture both requests; the second carries a byte-identical body and the identical `Idempotency-Key`, and the browser issues no third POST while it is in flight. |
| U9 | "A successful retry removes the uncertainty/error elements and shows the original reference." | `probes/s2/screens.mjs` → after the retry, `booking-uncertain` and `booking-error` are absent and `confirmation-reference` equals the reference the committed booking already had. |
| U10 | "A confirmed rejection uses `booking-error`." | `probes/s2/screens.mjs` → a refusal that is a real answer (422) shows `booking-error` and not `booking-uncertain`. |
| U11 | "These rules apply to combination bookings too." | `probes/s2/screens.mjs` → U3, U6, U8 and U9 repeated with a `table_ids` pair booking. |
| U12 | "The server remains authoritative" | `probes/s2/screens.mjs` → every confirmation the UI shows is one the service returned; the reference is read back through `GET /reservations/{reference}` and matches. |
| U13 | "the browser must not manufacture a successful result from cached data." | `probes/s2/screens.mjs` → a cached/rendered availability answer is replayed for a slot that is gone; the UI never shows `confirmation` without a 2xx from the service. |
| U14 | "No background polling, live updates, cross-tab storage synchronization, or recovery across a page reload is required." | no probe — the specification does not require them. |
| U15 | "These rules apply when import completes between browser requests; migration during an in-flight request is not required." | `probes/s2/upgrade.mjs` → Y rows hold with an import landing between two browser requests; the in-flight case is out of scope and not tested. |
## Q — Product and visual direction

Decided thresholds, stated here so each row is decidable rather than arguable. Contrast is
WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text (>= 24 CSS px, or >= 18.66 CSS px bold)
and for the boundary of an interactive control. "Visually distinct" means two states differ in at
least one of fill colour, border colour, text colour, or an added text glyph — measured, not felt.

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| Q1 | "The browser experience must feel like a coherent, presentation-ready restaurant product, not a test harness with controls attached." | review — screenshots of every named state at both widths, read by me, recorded with the reason. |
| Q2 | "Aim for a warm, confident hospitality character." | review — as Q1. A direction, not a behaviour. |
| Q3 | "The search, availability and booking flow should have an obvious visual hierarchy" | review — the four screens show one dominant action each and a heading above the content; recorded per screen. |
| Q4 | "a diner should be able to scan dates, times, party size and table choices without having to interpret raw API data." | `probes/s2/visual.mjs` → no rendered text node contains a JSON object, a snake_case field name, or an ISO timestamp with a UTC offset. |
| Q5 | "Combined tables should read as intentional seating options, not as concatenated technical identifiers." | `probes/s2/visual.mjs` → a pair cell's visible text carries both human table labels; a bare `t_1+t_2` may appear only in the testid or an ARIA attribute. |
| Q6 | "Use a consistent visual system for typography, spacing, colour, controls and feedback." | `probes/s2/visual.mjs` → font-family set size <= 3, font-size set size <= 6, spacing scale <= 8 values, and every button/select/input shares one border-radius and one control height across the four screens. |
| Q7 | "Primary actions must be easy to identify." | `probes/s2/visual.mjs` → on each screen exactly one control carries the primary class and it is the highest-contrast filled control; recorded per screen. |
| Q8 | "Available ... states must be visually distinct" | `probes/s2/visual.mjs` → `data-available="true"` cells differ from `false` cells by >= 1 measured property. |
| Q9 | "... unavailable ... states must be visually distinct" | as Q8, decided from the false side. |
| Q10 | "... selected ... states must be visually distinct" | `probes/s2/visual.mjs` → the selected cell differs from an unselected available cell by >= 1 measured property. |
| Q11 | "... loading ... states must be visually distinct" | `probes/s2/visual.mjs` → a slow response leaves a loading indicator whose computed style differs from the settled state, and it is not the empty state. |
| Q12 | "... successful ... states must be visually distinct" | `probes/s2/visual.mjs` → the confirmation state differs from the form state it replaced. |
| Q13 | "... refused ... states must be visually distinct" | `probes/s2/visual.mjs` → `booking-error` / `auth-error` differ from the neutral form background and from the uncertain state. |
| Q14 | "... uncertain ... states must be visually distinct" | `probes/s2/visual.mjs` → `booking-uncertain` differs from `booking-error` and from the settled form, so the diner can tell "unknown" from "no". |
| Q15 | "Use human-readable restaurant and table labels prominently; expose technical identifiers only where they help the user." | `probes/s2/visual.mjs` → restaurant and table names appear as visible text on `/`, the booking form, the confirmation and the lookup; no restaurant id is visible text. |
| Q16 | "The required flows must remain clear and usable at a 375 CSS-pixel viewport" | `probes/s2/screens.mjs` → every named state reached at width 375 with no control clipped, overlapped or pushed off-screen, recorded per state in `verification/screens/`. |
| Q17 | "and at conventional desktop widths" | as Q16 at 1280. |
| Q18 | "without horizontal page scrolling." | `probes/s2/screens.mjs` → `document.documentElement.scrollWidth <= clientWidth + 1` at 375 and 1280, on every named state. |
| Q19 | "Inputs need visible labels" | `probes/s2/visual.mjs` → every `input`, `select` and `textarea` has an associated `label` whose text is rendered, or an `aria-label`; zero unlabelled controls on all four screens. |
| Q20 | "keyboard focus must be apparent" | `probes/s2/visual.mjs` → tabbing through each screen gives every control a focus indicator that differs from its unfocused style (outline, border, shadow or background); recorded per control. |
| Q21 | "text and controls need sufficient contrast." | `probes/s2/visual.mjs` → computed foreground/background contrast >= 4.5 (>= 3 for large text and control boundaries) for every visible text node and control border on all four screens; each failure names the node and both colours. |
| Q22 | "Provide considered empty ... states" | `probes/s2/screens.mjs` → a day with no slots shows `no-slots` with real explanatory text and no empty grid frame. |
| Q23 | "... loading ... states" | as Q11, reached with a delayed response. |
| Q24 | "... error states" | `probes/s2/screens.mjs` → each of `auth-error`, `booking-error`, `booking-uncertain`, `reservation-error` appears with real text explaining what happened, not a raw code. |
| Q25 | "keep navigation consistent across the required routes." | `probes/s2/visual.mjs` → the same nav element, in the same order and position, on all four routes, and it is present on every one. |
| Q26 | "A custom illustration, brand asset or exact visual match to a reference is not required." | no probe — the specification does not require it. |

## S — Signup and login screens

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| S1 | "`signup-email`, `signup-password`, `signup-display-name` \| Inputs" | `probes/s2/screens.mjs` → all three on `/signup`, of types email, password and text, each visible and enabled. |
| S2 | "`signup-submit` \| Button" | `probes/s2/screens.mjs` → present, enabled, and submits the form. |
| S3 | "`login-email`, `login-password`, `login-submit` \| Inputs and button" | `probes/s2/screens.mjs` → on `/login`, email and password inputs of the right types and a submit button. |
| S4 | "`auth-error` \| Error message. Present only when there is one" — the present half | `probes/s2/screens.mjs` → a refused signup and a refused login each leave `auth-error` in the DOM with nonempty text naming the failure. |
| S5 | "`auth-error` \| ... Present only when there is one" — the absent half | `probes/s2/screens.mjs` → a fresh `/signup` and `/login` carry no `auth-error` node at all, and a successful auth leaves none. |
| S6 | "`current-user` \| Visible on every screen when signed in." | `probes/s2/screens.mjs` → signed in, all four routes visited: `current-user` present and visible on each, at both widths. |
| S7 | "Text contains the display name" | `probes/s2/screens.mjs` → `current-user` text contains the display name from the account, case-insensitively. |
| S8 | "`logout-button` \| Button" | `probes/s2/screens.mjs` → present and visible when signed in on every screen. |
| S9 | "Visible on every screen when signed in." — the sign-out half | `probes/s2/screens.mjs` → clicking `logout-button` removes `current-user` from all four routes and the API rejects the old token with 401. |

## G — Search and availability grid

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| G1 | "`restaurant-select` \| Selects a restaurant. Option values are restaurant ids" | `probes/s2/screens.mjs` → options are exactly the ids from `GET /restaurants`, value attributes equal to ids, and selecting one changes the results to that restaurant. |
| G2 | "`date-input` \| Date, value `YYYY-MM-DD`" | `probes/s2/screens.mjs` → `type=date`, value matches `^\d{4}-\d{2}-\d{2}$`, and the grid is for that date. |
| G3 | "`party-size-input` \| Number" | `probes/s2/screens.mjs` → numeric input accepting 1..capacity, and the value is the party size sent to `GET /availability`. |
| G4 | "`search-button` \| Runs the search" | `probes/s2/screens.mjs` → one click issues one `GET /availability` for the current restaurant, date and party size and renders it. |
| G5 | "`availability-grid` \| Container for the results" | `probes/s2/screens.mjs` → exists and contains every cell for the searched day. |
| G6 | "`slot-{table_id}-{HH:MM}` \| One cell per table per slot, e.g. `slot-t_2-19:00`" | `probes/s2/screens.mjs` → cell testids equal the cross product of that slot's tables and slots, one cell each, no duplicates. |
| G7 | "`no-slots` \| Shown instead of the grid when the day has no slots" | `probes/s2/screens.mjs` → closed day: `no-slots` present and `availability-grid` absent. |
| G8 | "Each cell carries `data-available=\"true\"` or `data-available=\"false\"`." | `probes/s2/screens.mjs` → every cell has one of the two values, never missing, never a third value. |
| G9 | "A cell is `true` exactly when its `table_id` is in that slot's `available_table_ids` from `GET /availability` for the party size that was searched, and `false` otherwise." | `probes/s2/screens.mjs` → the whole grid compared cell-by-cell against the API answer for the same inputs; every mismatch names the cell and both sides. |
| G10 | "Clicking an available cell opens the booking form for that table and slot." | `probes/s2/screens.mjs` → click `slot-t_2-19:00` → `booking-form` present and its summary names table t_2's label and 19:00. |
| G11 | "Clicking an unavailable cell does nothing." | `probes/s2/screens.mjs` → click a `false` cell → no `booking-form`, no navigation, no request other than at most one availability read. |
| G12 | "Booking requires a signed-in user: clicking an available cell while signed out shows `auth-error` or navigates to `/login`, your choice." | `probes/s2/screens.mjs` → signed out, click an available cell → either `auth-error` is present or the location is `/login`; no `booking-form` either way. |

## B — Booking form

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| B1 | "`booking-form` \| Container" | `probes/s2/screens.mjs` → present after clicking an available cell and gone on a fresh search. |
| B2 | "`booking-summary` \| Text contains the table label and the local start time" | `probes/s2/screens.mjs` → text contains the human table label and the local time in the restaurant's zone as `HH:MM`, and not a UTC-offset ISO string. |
| B3 | "`booking-party-size` \| Number input, pre-filled from the search" | `probes/s2/screens.mjs` → value equals `party-size-input`'s value when the form opened. |
| B4 | "`booking-submit` \| Button" | `probes/s2/screens.mjs` → present and enabled while the form is open. |
| B5 | "`booking-error` \| Error message, when the booking fails" | `probes/s2/screens.mjs` → a refused booking leaves `booking-error` with nonempty text and no `confirmation`. |
| B6 | "Keep the booking form on screen after success." | `probes/s2/screens.mjs` → after a 201 the `booking-form` is still in the DOM and still holds the diner's inputs. |
| B7 | "Submitting it again without changing a field must return the same `confirmation-reference`, without `booking-error` or another booking." | `probes/s2/screens.mjs` → second submit: same reference text, no `booking-error`, and the reservation count read back from the service is unchanged. |
| B8 | "Changing a field makes the next submission a new booking request." | `probes/s2/screens.mjs` → change `booking-party-size`, submit: a second distinct reference, and the service holds two reservations. |
| B9 | "Retries follow §7." | `probes/s2/booking-retry.mjs` → the retry body carries an `Idempotency-Key`, repeating it never creates a second reservation, and a changed body creates a new one. |

## C — Confirmation

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| C1 | "`confirmation` \| Container" — "Shown after a successful booking." | `probes/s2/screens.mjs` → present after a 201 and absent before any booking and after a refusal. |
| C2 | "`confirmation-reference` \| Text is exactly the reference, no surrounding words" | `probes/s2/screens.mjs` → trimmed text equals the reference the service returned and matches `GET /reservations/{reference}`; no surrounding punctuation or words. |
| C3 | "`confirmation-details` \| Text contains the restaurant name, table label and local start time" | `probes/s2/screens.mjs` → all three present as text, the time as local `HH:MM` on the chosen date. |
## L — Lookup

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| L1 | "`lookup-reference-input`, `lookup-submit` \| Input and button" | `probes/s2/screens.mjs` → both present on `/lookup`, and submitting runs the lookup for the typed reference. |
| L2 | "`reservation-detail` \| Container, shown when found" | `probes/s2/screens.mjs` → a real reference fills it; an unknown one leaves it absent. |
| L3 | "`reservation-status` \| Text is exactly `confirmed` or `cancelled`" | `probes/s2/screens.mjs` → trimmed text is one of the two words and nothing else, before and after a cancel. |
| L4 | "`reservation-cancel-button` \| Cancels." | `probes/s2/screens.mjs` → clicking it cancels: `reservation-status` becomes `cancelled` and `GET /reservations/{reference}` agrees. |
| L5 | "`reservation-cancel-button` \| ... Absent once cancelled" | `probes/s2/screens.mjs` → after L4 the node is gone, including after a page revisit. |
| L6 | "`reservation-error` \| Shown when not found" | `probes/s2/screens.mjs` → unknown reference leaves `reservation-error` with nonempty text and no `reservation-detail`. |
| L7 | "`reservation-error` \| ... or when a cancel is refused" | `probes/s2/screens.mjs` → a cancel refused by the service (past the cutoff) leaves `reservation-error`, the status unchanged, and the button still offered. |

## Y — Existing clients after an upgrade

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| Y1 | "A stage-2 service must accept an export produced by the same team's stage-1 service." | `probes/s2/upgrade.mjs` → export from the stage-1 image at `aa4382f`, import into the stage-2 service, every row in that export readable back unchanged. |
| Y2 | "A browser signed in before that export/import upgrade must remain signed in afterwards." | `probes/s2/upgrade.mjs` → a browser token issued before the import still authenticates after it, on `/`, `/lookup`, `/signup`, `/login`. |
| Y3 | "A retained booking reference still works through the lookup screen." | `probes/s2/screens.mjs` + `probes/s2/upgrade.mjs` → a reference from the stage-1 export typed into `/lookup` shows `reservation-detail` and its status. |
| Y4 | "A booking whose response was lost before export remains retryable after import with the same body and key" | `probes/s2/upgrade.mjs` → the lost-response booking is committed, exported, imported, then retried with the same key and body: 200 with the original reference, no second reservation. |
| Y5 | "the UI must recover the original confirmation." | `probes/s2/screens.mjs` → after Y4 the page shows `confirmation-reference` equal to the original and no `booking-uncertain`. |
| Y6 | "The form and pending retry identity must survive the upgrade." — the form | `probes/s2/screens.mjs` → the `booking-form` and the values the diner entered are still on screen after the import, with no reload and no new screen. |
| Y7 | "The form and pending retry identity must survive the upgrade." — the retry identity | `probes/s2/upgrade.mjs` → the idempotency key and body held in the page are unchanged by the import and are what the next submit sends. |

## Z — Combined tables, API and UI

| id | Requirement (verbatim from stage-2.md) | Check |
|---|---|---|
| Z1 | "A party may book two tables that the restaurant has declared combinable." | `probes/s2/combined.mjs` → `POST /reservations` with a declared pair returns 201. |
| Z2 | "The booking occupies both tables for its full duration." | `probes/s2/combined.mjs` → every slot overlapping the reservation reports both members absent from `available_table_ids` and from `available_options` pairs. |
| Z3 | "Existing single-table request formats remain supported." | `probes/s2/combined.mjs` → a stage-1 shaped body with `table_id` still returns 201 with a reference. |
| Z4 | "**Pairs only** — never three or more." | `probes/s2/combined.mjs` → a fixture declaring a three-table entry is rejected at load, and no three-table request ever yields 201. |
| Z5 | "A pair not listed cannot be combined, whatever the table sizes are." | `probes/s2/combined.mjs` → an undeclared pair of adequate capacity is 422 `combination_not_allowed` and absent from `available_options`. |
| Z6 | "Combining is not transitive: `[t_1,t_2]` and `[t_2,t_3]` do not make `{t_1,t_3}` bookable." | `probes/s2/combined.mjs` → with those two declared, `{t_1,t_3}` is 422 and never listed. |
| Z7 | "A combination's capacity is the sum of its tables' capacities." | `probes/s2/combined.mjs` → `party_size` equal to the sum is 201, sum+1 is 422 `party_exceeds_capacity`, and `available_options` lists the pair only when the sum covers the party. |
| Z8 | "Seeded `reservations` are `confirmed` unless they carry a `status` of `cancelled`" | `probes/s2/combined.mjs` → a seeded entry with no status occupies its table; one with `cancelled` does not. |
| Z9 | "and may hold either `table_id` or `table_ids`." | `probes/s2/combined.mjs` → both shapes seed correctly and occupy every table they name. |
| Z10 | "Slots gain `available_options`." | `probes/s2/combined.mjs` → every slot carries the field, each entry has `table_ids` and an integer `capacity`. |
| Z11 | "`available_table_ids` stays exactly as it was — single tables only." | `probes/s2/combined.mjs` → every entry is one of the fixture's table ids; no pair ever appears. |
| Z12 | "`available_options` lists every single table and every declared pair with `capacity >= party_size` and no overlapping confirmed reservation on any member." | `probes/s2/combined.mjs` → for party sizes 1..max, the listed set equals the computed expectation exactly, in both directions, with each missing or extra entry named. |
| Z13 | "Singles first in fixture order, then pairs in `combinable` order." | `probes/s2/combined.mjs` → the id sequence is exactly fixture singles then declared pairs, in order, at every party size. |
| Z14 | "`table_ids` within a pair is in `combinable` order." | `probes/s2/combined.mjs` → each pair's `table_ids` equals the `combinable` entry, never reversed. |
| Z15 | "The body takes `table_ids` instead of `table_id`" | `probes/s2/combined.mjs` → a two-member `table_ids` body is honoured and stored. |
| Z16 | "`table_id` is still accepted and means a set of one." | `probes/s2/combined.mjs` → a `table_id` body returns 201 and `table_ids` of length one. |
| Z17 | "Sending both is 422 `validation_failed`." | `probes/s2/combined.mjs` → both keys present is 422 with code `validation_failed` and no reservation created. |
| Z18 | "Responses always carry `table_ids`." | `probes/s2/combined.mjs` → every 200/201 reservation body and every read-back has `table_ids` matching the stored set. |
| Z19 | "They also carry `table_id` **when the set has exactly one member**" | `probes/s2/combined.mjs` → single-table create and read-back carry `table_id` equal to that member. |
| Z20 | "and omit it otherwise." | `probes/s2/combined.mjs` → a two-member create and read-back have no `table_id` key at all. |
| Z21 | "The pair is not in `combinable` \| 422 `combination_not_allowed`" | `probes/s2/combined.mjs` → status and code both exact, no reservation created. |
| Z22 | "More than two tables \| 422 `combination_not_allowed`" | `probes/s2/combined.mjs` → a three-member set is 422 `combination_not_allowed` even when every pair is declared. |
| Z23 | "Any table in the set is taken for an overlapping interval \| 409 `table_unavailable`" | `probes/s2/combined.mjs` → one member occupied, the pair is 409, and neither table is double-booked afterwards. |
| Z24 | "`party_size` exceeds the combination's summed capacity \| 422 `party_exceeds_capacity`" | `probes/s2/combined.mjs` → sum+1 is 422 with that code. |
| Z25 | "Duplicate table id in the set \| 422 `validation_failed`" | `probes/s2/combined.mjs` → `["t_1","t_1"]` is 422 `validation_failed`, including as a declared-pair duplicate. |
| Z26 | "`PATCH /reservations/{reference}` accepts `table_ids` under the same rules." | `probes/s2/combined.mjs` → a patch to a declared pair moves both tables; the same five refusals hold on patch as on create. |
| Z27 | "Cancelling frees every table in the set." | `probes/s2/combined.mjs` → after cancel, both members return to `available_table_ids` for every slot they had covered. |
| Z28 | "The availability grid gains combination cells, shown when a declared pair is available for the searched party size:" | `probes/s2/screens.mjs` → a pair cell exists for the searched party size when the pair is available, and not when it is not. |
| Z29 | "`slot-{t_a}+{t_b}-{HH:MM}` \| A combination cell, e.g. `slot-t_1+t_2-19:00`. Ids in `combinable` order. Carries `data-available` like a single cell" | `probes/s2/screens.mjs` → testid shape, `combinable` order, and a `data-available` attribute that agrees with `available_options` cell by cell. |
| Z30 | "`confirmation-tables` \| Text contains every table label in the reservation" | `probes/s2/screens.mjs` → both member labels present in the text. |
| Z31 | "`reservation-tables` \| On the lookup screen. Same" | `probes/s2/screens.mjs` → both member labels present on `/lookup`. |
| Z32 | "`booking-summary` must name every table in the selection." | `probes/s2/screens.mjs` → a pair selection's summary names both labels, not one and not the raw ids alone. |
| Z33 | "A single-table booking's cell testid, confirmation and lookup are unchanged." | `probes/s2/screens.mjs` → `slot-t_2-19:00` style, no `+`, `confirmation-reference` still exactly the reference, lookup unchanged. |
| Z34 | "Atomic reservation moves from stage 1 also accept `table_ids` per move." | `probes/s2/combined.mjs` → a stage-1 move request whose bodies carry `table_ids` applies and returns 200. |
| Z35 | "No table may belong to overlapping resulting bookings." | `probes/s2/combined.mjs` → a move to a set sharing a table with a resulting booking is refused, and no overlap exists after any accepted move. |
| Z36 | "The existing browser recovery and original-receipt requirements also apply to combined-table bookings." | `probes/s2/screens.mjs` → U3, U6, U8, U9 re-run for pairs. |
| Z37 | "Concurrent requests must produce the same results as executing them one at a time in some order, and the requirements above hold at every read." | `probes/s2/combined.mjs` → 50 in-flight pair bookings over one member produce exactly one 201 and the rest 409, and every read afterwards satisfies Z2 and Z12. |