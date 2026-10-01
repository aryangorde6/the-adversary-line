# Stage 1 verification ledger — Tablekeeper

Source of truth: `/home/aryan/band_hack/dark-factory-wearedevs/tablekeeper/spec/stage-1.md`
(read-only; no seat may modify it). Every row below is one testable sentence from that file:
every "must", every "never", every table row, every stated error and every limit.

`Check` names the probe in `verification/probes/` that decides the row, or `supplied:<name>`
when a supplied check already decides it. A row with no probe is a row I have not decided and
therefore cannot pass.

**On the `.sh` names below.** Each `Check` cell ends in a descriptive `probes/<area>/<name>.sh`
that never became a file; the probe that decides the row is the node group that `run-all.mjs`
imports, named alongside it where the mapping is worth stating. The paths are kept as the row's
original intent so the ledger still reads against the specification, but nothing decides a row by
being read here: only `run-all.mjs` output does.

Written before any product code existed (see the commit history: the ledger commit precedes the
first stage-1 commit), so no row can have been shaped by an implementation.

Row counts by group:

| Group | Meaning | Rows |
|---|---|---|
| D | Delivery, container, resource limits | 18 |
| C | Runtime contract and conventions | 12 |
| M | Model and fixtures | 8 |
| E | Errors, status and code table | 17 |
| A | Authentication and accounts | 10 |
| I | Idempotency | 12 |
| P | Public API and reservations | 40 |
| T | Time, zones and DST | 11 |
| X | Export and import | 16 |
| V | Atomic reservation moves | 20 |
| | **Total** | **164** |

107 distinct probe scripts decide those rows.

## D — Delivery, container, resource limits

| id | Requirement (verbatim from stage-1.md) | Check |
|---|---|---|
| D1 | "Deliver an HTTP service, a `Dockerfile` and a `RUN.md` with a command that builds and starts the service without manual setup." | `probes/delivery/run_md.sh` — RUN.md exists, names a build command and a start command, and both work verbatim from a clean clone with no network at run time. |
| D2 | "The harness builds the submitted `Dockerfile`, starts the resulting image and tests only its HTTP behavior; it does not import or execute the submission's source files on the judge host." | `probes/delivery/docker_build.sh` — plain `docker build` of the stage folder succeeds. A submission that needs a host toolchain to run is a failure, so the probe runs the image alone. |
| D3 | "The image must run on its own with `-e PORT=<port>` and a port mapping." | `probes/delivery/port_env.sh` — start with `-e PORT=<free port>` and `-p`, reach `/health` on that port. |
| D4 | "Runtime networking has no outbound access." | `probes/delivery/no_network.sh` — image runs with no DNS/no route; all rows below are probes run in that state, so any outbound dependency fails the whole ledger. |
| D5 | "All runtime dependencies, initialization and seed data must work within that single container." | `probes/delivery/offline_boot.sh` — build with `--network=none`, then `/health` is 200 and `POST /_test/reset` seeds a fixture. |
| D6 | "Compose configuration is not used to start the service." | `probes/delivery/docker_build.sh` — the image alone serves everything; no compose file is read. |
| D7 | Limit: CPU `2 vCPU`. | `probes/delivery/limits.sh` — runs under `--cpus=2` for the whole suite. |
| D8 | Limit: Memory `2 GiB`. | `probes/delivery/limits.sh` — runs under `--memory=2g` for the whole suite. |
| D9 | Limit: "Start to first healthy response | 60 s". | `probes/delivery/health_timing.sh` — seconds from container start to the first 200 on `/health`. |
| D10 | Limit: "Concurrent requests | up to 50 in flight". | `probes/concurrency/overlap_50.sh` and `probes/delivery.mjs` — 50 simultaneous booking attempts on one table; at most one 201. |
| D10b | D10 and INV1 over repeated rounds of 50 mixed in-flight requests, not one round of 50 identical ones: no two confirmed reservations overlap on one table, no 5xx, and nothing left in the reservation list that is missing from the export. | `probes/delivery.mjs` — 6 rounds; overlap computed from `GET /reservations`, partial state from `GET /_test/export`. |
| D11 | Limit: "Per-request timeout | 5 s (10 s for `POST /_test/reset`)". | `probes/delivery/limits.sh` — every request in the suite answers in under 5 s; reset under 10 s. |
| D12 | Limit: "Outbound network | available during `docker build`, **none at run time**". | `probes/delivery/offline_boot.sh` — run-time container reaches nothing but its own port. |
| D13 | Limit: "Disk | ephemeral; state need not survive a container restart". | Not a must — permitted, so no probe. Recorded so it is never read as a requirement. |
| D14 | "Runtime assets and dependencies must be included in the image. This includes fonts, scripts and stylesheets; external services are unavailable at runtime." | `probes/delivery/offline_boot.sh` — any asset fetch at run time shows up as a failing row here. |
| D15 | "Listen on `0.0.0.0` using the `PORT` environment variable, default `8080`." | `probes/delivery/port_env.sh` — with `PORT` set, the mapped port answers. |
| D16 | "default `8080`" when `PORT` is unset. | `probes/delivery/default_port.sh` — no `PORT`, container publishes 8080, `/health` is 200. |
| D17 | "The submission is a containerized HTTP service, not a Python package. Python is not required in the implementation." | Not a must — a permitted choice, no probe. |
| D18 | "A `docker-compose.yml` is optional." | Not a must — no probe. |

## C — Runtime contract and conventions

| id | Requirement (verbatim) | Check |
|---|---|---|
| C1 | "`GET /health  ->  200  {\"status\": \"ok\"}`" | `probes/conventions/health.sh` — exact status and body. |
| C1b | C1 holds on every call, not just the first: 400 sequential `GET /health` and 50 in flight at once all answer 200 with exactly that body. | `probes/health-soak.mjs` — 400 sequential calls, every status and body recorded; a defect failing a share p of calls is missed with probability (1-p)^400. |
| C1c | The same under 50 concurrent in-flight health checks. | `probes/health-soak.mjs` — 50 concurrent `GET /health`, all must be 200. |
| C2 | "Return 200 once the service and its data store can serve requests, within 60 seconds of container start." | `probes/delivery/health_timing.sh` + `probes/conventions/health.sh` — 200 is the first answer and the store serves at once. |
| C3 | "Non-200 responses are permitted before the service is ready." | Permitted, not required — no probe. |
| C4 | "`POST /_test/reset` … `->  204 No Content`" | `probes/conventions/reset.sh` — status 204 and an empty body. |
| C5 | "Replace all service state with the fixture in the request body (§4). When reset returns 204, subsequent requests must see only that fixture. Repeated resets are supported." | `probes/conventions/reset.sh` — state from a first fixture disappears after a second reset; a third reset also works. |
| C6 | "This test endpoint must be enabled in the delivered image and requires no authentication." | `probes/conventions/reset.sh` — reset called with no `Authorization` header, in the delivered image. |
| C7 | "Requests and responses are `application/json; charset=utf-8`." | `probes/conventions/json_content_type.sh` — response charset is utf-8 on json bodies. |
| C8 | "Timestamps in responses are RFC 3339 with an explicit offset, e.g. `2026-09-24T19:00:00+02:00`." | `probes/conventions/timestamps.sh` — every timestamp field of every response parses as RFC 3339 with an offset; no bare local form and no `Z`-less value. |
| C9 | "Unknown fields in a request body are ignored, never an error." | `probes/conventions/unknown_fields.sh` — extra keys on signup, login, reset, reservations, moves. |
| C10 | "Unknown query parameters are ignored." | `probes/conventions/unknown_query.sh` — extra query keys on `/availability`. |
| C11 | "IDs are opaque strings of at most 64 characters. Their format is yours. This limit also applies to IDs supplied in reset fixtures." | `probes/conventions/id_length.sh` — no emitted id exceeds 64 characters, including after seeding ids of length 65+ and ids generated for the same fixture. |
| C12 | "Unknown fields in a request body are ignored, never an error." (repeated for `POST /reservations`) | `probes/conventions/unknown_fields.sh`. |

## M — Model and fixtures

| id | Requirement (verbatim) | Check |
|---|---|---|
| M1 | "Restaurants and tables are supplied through `POST /_test/reset` only. Restaurant and table creation endpoints are out of scope." | `probes/model/no_create_endpoints.sh` — a `POST /restaurants` attempt creates nothing; state after reset is still only the fixture. |
| M2 | "Seeded users must be able to log in with the given password immediately." | `probes/model/seeded_login.sh` — a fixture user logs in and the token works. |
| M3 | "`reservations` may seed confirmed bookings, with the same fields as a `POST /reservations` body plus `id`, `reference` and `user_id`." | `probes/model/seeded_reservations.sh` — a seeded reservation appears for its owner, blocks availability and holds its table. |
| M4 | "`weekday` is one of `mon tue wed thu fri sat sun`." | `probes/model/weekday_coverage.sh` — each of the seven names opens its own day; a `sat` entry produces no slots on any other weekday. |
| M5 | "`opens` and `closes` are local `HH:MM`, 24-hour." | `probes/model/opening_hours.sh` — first and last slot per day equal the grid from `opens` up to `closes - duration`. |
| M6 | "`closes` is always later than `opens` on the same local day — opening hours never cross midnight." | `probes/model/opening_hours.sh` — no slot is offered past `closes`, and no slot spills into the next local day. |
| M7 | "Fixtures may use any calendar date. A booking must not be rejected solely because its start is in the past; the cancellation and amendment cutoff rules still apply." | `probes/model/past_start.sh` — a start in the past is accepted (201) when the slot is free, and the cutoff rule still fires on cancel/patch. |
| M8 | "A day with no entry is closed" (`opening_hours`). | `probes/model/opening_hours.sh` — an unlisted weekday returns `"slots": []`. |

## E — Errors, status and code table

| id | Requirement (verbatim) | Check |
|---|---|---|
| E1 | "Every 4xx and 5xx response carries this body: `{ \"error\": { \"code\": …, \"message\": … } }`" | `probes/errors/error_body.sh` — every non-2xx answer in the suite has exactly `error.code` and `error.message`, both strings. |
| E2 | "Use the specified HTTP status and `code`. The human-readable `message` may use any wording." | `probes/errors/error_codes.sh` — status and code compared per case; message content is never asserted. |
| E3 | "400 `malformed_request` \| Unparseable body, or a field of the wrong JSON type" | `probes/errors/malformed.sh` — truncated JSON, wrong types on named fields, on auth, reservations, moves, import and reset. |
| E4 | "400 `missing_idempotency_key` \| Required `Idempotency-Key` header absent or empty" | `probes/errors/missing_key.sh` — absent header and `Idempotency-Key: ` (empty) on both write paths. |
| E5 | "401 `unauthenticated` \| Missing, malformed or unknown bearer token" | `probes/errors/auth.sh` — no header, `Bearer`, `Bearer `, garbage token, unknown token, on every protected endpoint. |
| E6 | "403 `forbidden` \| Authenticated, but not permitted to touch this resource" | `probes/errors/forbidden.sh` — a valid token on another caller's resource returns 403 `forbidden` on endpoints that name it, and never 5xx. |
| E7 | "404 `not_found` \| No such resource, or not visible to this caller" | `probes/errors/not_found.sh` — unknown ids on restaurants, tables, references and moves. |
| E8 | "409 `idempotency_key_reuse` \| Key already used by this caller with a different request body" | `probes/errors/key_reuse.sh` — same key, different JSON body. |
| E9 | "422 `validation_failed` \| A required field or query parameter is missing, or a stated rule is violated with no more specific code" | `probes/errors/validation_failed.sh` — each missing required field and query parameter of §8 and §11. |
| E10 | "A field of the correct JSON type with an invalid format or out-of-range value gives 422 `validation_failed`, unless an endpoint specifies a different error. This includes invalid dates, negative counts and values exceeding a stated maximum or length." | `probes/errors/out_of_range.sh` — bad dates, negative numbers, over-length ids, over-length idempotency keys. |
| E11 | "invalid `party_size` values (including strings and booleans) … are 422 `validation_failed`" | `probes/errors/party_size_type.sh` — `"4"`, `true`, `4.5`, `null`, `-1`, `0`. |
| E12 | "`starts_at_local` strings that are not a bare local `YYYY-MM-DDTHH:MM` are 422 `validation_failed`" | `probes/errors/starts_at_format.sh` — `Z`, offset form, seconds, space separator, date-only, `T` missing, non-string. |
| E13 | "An integer-valued **query parameter** is written as plain decimal digits: `1e9`, `4.0` and `+4` are 422 `validation_failed` whatever their numeric value." | `probes/errors/query_integer_format.sh` — `party_size=1e9`, `party_size=4.0`, `party_size=+4`. |
| E14 | "Reserve 400 `malformed_request` for a body that does not parse or a field of the wrong type." | `probes/errors/malformed.sh` — same rows as E3; this row fails if a wrong-type field anywhere answers with another code. |
| E15 | "`Idempotency-Key` \| 1 to 255 characters \| 422 `validation_failed`" | `probes/errors/key_length.sh` — empty is 400 E4; 256 characters is 422; 1 and 255 are accepted. |
| E16 | "Requests must not produce 5xx responses, including under concurrent load." | `probes/concurrency/no_5xx.sh` — every response recorded by the whole suite is asserted to be < 500, and again under 50-way load. |
| E16b | E16 over a deliberate repeat sweep rather than only the responses the rest of the suite happens to produce: every route in the ledger called 300 times, none answering 500 or above. | `probes/sweep.mjs` — 27 routes x 300 calls, every status recorded. |
| E16c | Each route produces the status the ledger documents for it at least once across its 300 repeats, so the sweep cannot pass on a route that has stopped answering its documented status altogether. A route's repeats legitimately span statuses (the create route answers 201 then 409 once its slots fill), so the set is recorded per route rather than asserted equal. | `probes/sweep.mjs` — status set observed per route across its 300 calls. |
| E1b | E1 holds across the whole 300-call sweep, not only across the paths the main suite walks: every non-2xx answer is exactly `{error:{code,message}}` with both values strings. | `probes/sweep.mjs` — body shape checked on every non-2xx answer in the sweep. |
| E17 | "Endpoint-specific field rules take precedence: … Other wrong JSON types follow the rule below." | `probes/errors/type_precedence.sh` — a wrong-typed `party_size`/`starts_at_local` answers `validation_failed`, while a wrong-typed unknown field answers `malformed_request` per E3. |

## A — Authentication and accounts

| id | Requirement (verbatim) | Check |
|---|---|---|
| A1 | "`POST /auth/signup` … `->  201  { \"user_id\": \"u_1\", \"display_name\": \"Ada\", \"token\": \"...\" }`" | `probes/auth/signup.sh` — status 201 and the three fields, non-empty. |
| A2 | "`POST /auth/login` … `->  200  { \"user_id\": \"u_1\", \"display_name\": \"Ada\", \"token\": \"...\" }`" | `probes/auth/login.sh` — status 200 and the same three fields. |
| A3 | "Email already registered \| 409 `email_taken`" | `probes/auth/email_taken.sh` — same address, any password change. |
| A4 | "Password shorter than 8 characters \| 422 `validation_failed`" | `probes/auth/password_length.sh` — 7 characters rejected, 8 accepted. |
| A5 | "`email` not of the form `local@domain` \| 422 `validation_failed`" | `probes/auth/email_format.sh` — `ada`, `ada@`, `@example.com`, `a b@example.com`, `ada@example`, empty. |
| A6 | "Wrong password or unknown email on login \| 401 `unauthenticated`" | `probes/auth/login.sh` — both cases. |
| A7 | "Every other endpoint requires a bearer token, except `/health`, `/_test/reset`, the two above, and the three public endpoints named at the top of §8" | `probes/auth/token_required.sh` — every other route answers 401 `unauthenticated` without a token, and the six exceptions answer without one. |
| A8 | "Tokens do not expire. An account may have multiple valid tokens and concurrent sessions." | `probes/auth/multiple_tokens.sh` — two tokens from two logins both work; no clock or count invalidates either. |
| A9 | "Passwords must be stored using a password-hashing function such as bcrypt, scrypt or Argon2, or an equivalent. Plaintext password storage is not permitted." | `probes/auth/password_hashing.sh` — no state file, export or response body contains the fixture password in plaintext; the exported state holds a hash. |
| A10 | "Authentication supports signup and login." | `probes/auth/signup.sh` + `probes/auth/login.sh` — both work from a fresh reset. |

## I — Idempotency

| id | Requirement (verbatim) | Check |
|---|---|---|
| I1 | "Two write paths require an idempotency key: **`POST /reservations`** (§8) and **`POST /reservation-moves`** (§11)." | `probes/idempotency/required_paths.sh` — both 400 without a key (E4); no other mutating endpoint demands one. |
| I2 | "The key is scoped to **the authenticated user**. Two different users may use the same key string with no interaction between them." | `probes/idempotency/user_scope.sh` — user A's key reused by user B returns 201, not 200 or 409. |
| I3 | "A replay means the same user sending the **same method, the same path and the same body**. The same key with the same body on a different path is a different request, not a replay, and must succeed normally." | `probes/idempotency/path_scope.sh` — key used on `/reservations` then on `/reservation-moves` with an equivalent body returns 201. |
| I4 | "After the body has been parsed as a JSON object and the caller authenticated, idempotency is resolved before endpoint-specific field validation or current-resource checks. Thus a used key with a different JSON body returns `409 idempotency_key_reuse` even when that new body would otherwise be invalid." | `probes/idempotency/ordering.sh` — used key + unknown restaurant + bad `party_size` + bad time answers 409 `idempotency_key_reuse`, not 404 or 422. |
| I5 | "Header absent or empty \| 400 `missing_idempotency_key`" | `probes/errors/missing_key.sh`. |
| I6 | "First use of the key \| The normal response, **201**" | `probes/idempotency/first_use.sh`. |
| I7 | "Replay: same key, same body \| **200**, body identical to the original response as a JSON value" | `probes/idempotency/replay.sh` — deep-equal JSON, including `reservation_id`, `reference` and timestamps. |
| I8 | "Same key, different body \| 409 `idempotency_key_reuse`" | `probes/errors/key_reuse.sh`. |
| I9 | "Key reused after the original request failed with 4xx \| Treated as a first use" | `probes/idempotency/failed_then_reuse.sh` — a key burned by a 422 answers 201 with a fresh reservation when the body is then valid. |
| I10 | "\"Same body\" means the same JSON value after parsing — key order and whitespace do not matter." | `probes/idempotency/replay.sh` — same value with reordered keys and different spacing is a replay (200). |
| I11 | "For concurrent identical requests with an unused key, exactly one returns 201. The others return 200 with the same body. The operation takes effect only once." | `probes/idempotency/concurrent_same_key.sh` — 8 identical simultaneous posts: one 201, seven 200, one reservation in `GET /reservations`. |
| I12 | "A successful replay returns the original response, even after the resource changes or is cancelled. It makes no further state changes." | `probes/idempotency/replay_after_change.sh` — replay after `PATCH` and after `cancel` still returns the stored 201 body, with no extra occupancy. |

## P — Public API and reservations

| id | Requirement (verbatim) | Check |
|---|---|---|
| P1 | "`GET /restaurants`, `GET /restaurants/{id}` and `GET /availability` are **public** — no bearer token." | `probes/api/public.sh` — all three answer without a token. |
| P2 | "`{ \"restaurants\": [ { \"id\": \"r_anker\", \"name\": \"Zum Anker\", \"timezone\": \"Europe/Berlin\" } ] }`" | `probes/api/restaurants_list.sh` — every fixture restaurant present with its three fields. |
| P3 | "The restaurant with its `slot_minutes`, `reservation_duration_minutes`, `cancellation_cutoff_minutes`, `opening_hours` and `tables`, in the fixture's shape. 404 if unknown." | `probes/api/restaurant_detail.sh` — values round-trip unchanged; unknown id is 404 `not_found`. |
| P4 | "All three parameters are required; a missing one is 422 `validation_failed`." | `probes/api/availability_required.sh` — each of `restaurant_id`, `date`, `party_size` alone removed answers 422 `validation_failed`. |
| P5 | "`date` is a local calendar date at the restaurant." | `probes/api/availability_shapes.sh` — slots carry the requested local date and the zone's real offset. |
| P6 | The `GET /availability` body carries `restaurant_id`, `date`, `timezone`, and `slots[]` of `starts_at_local`, `starts_at`, `available_table_ids`. | `probes/api/availability_shapes.sh` — exact field set, no offset-less `starts_at`. |
| P7 | "`starts_at_local` is the full `YYYY-MM-DDTHH:MM` and goes into `POST /reservations` unchanged." | `probes/api/roundtrip_local_time.sh` — a slot string from the response is posted back and accepted verbatim. |
| P8 | "A slot appears for every `slot_minutes` step from `opens` such that `slot + reservation_duration_minutes <= closes`." | `probes/api/slot_grid.sh` — exact list of slot starts for 15-, 30- and 45-minute grids. |
| P9 | "`available_table_ids` lists the tables of that restaurant with `capacity >= party_size` and no overlapping confirmed reservation, in fixture order." | `probes/api/availability_filter.sh` — capacity filter, occupancy filter, and fixture order (a `capacity 4` table listed before a later `capacity 8` one, and only one slot change after a booking). |
| P10 | "A slot with no available table still appears, with an empty list." | `probes/api/slot_grid.sh` — a fully booked slot is present with `available_table_ids: []`. |
| P11 | "A closed day returns `\"slots\": []`." | `probes/api/closed_day.sh`. |
| P12 | "`starts_at_local` is wall-clock at the restaurant, with no offset and no `Z`. Resolve it against the restaurant's `timezone`." | `probes/api/roundtrip_local_time.sh` + `probes/time/zone_resolution.sh` — the same local string resolves to different instants in two zones. |
| P13 | The 201 create body carries `reservation_id`, `reference`, `restaurant_id`, `table_id`, `party_size`, `status`, `starts_at_local`, `starts_at`, `ends_at`, `created_at`. | `probes/api/create_shape.sh` — exact field set and types. |
| P14 | "`reference` is 6 to 12 characters of `A-Z0-9`, unique across all reservations, and never changes." | `probes/api/reference_format.sh` — 40 created reservations: charset and length hold, all unique. |
| P15 | "The table is taken for an overlapping interval \| 409 `table_unavailable`" | `probes/api/table_unavailable.sh` — partial overlap at the front and at the tail, and full overlap. |
| P16 | "`starts_at_local` is not on the slot grid \| 422 `not_on_slot_grid`" | `probes/api/not_on_grid.sh` — `19:10` against a 30-minute grid, and `18:07` against a 15-minute grid. |
| P17 | "Slot outside opening hours, or the reservation would end after `closes` \| 422 `outside_opening_hours`" | `probes/api/outside_hours.sh` — before `opens`, after `closes`, and the last on-grid slot that would end after `closes`. |
| P18 | "`party_size` exceeds the table's `capacity` \| 422 `party_exceeds_capacity`" | `probes/api/party_exceeds.sh` — 5 on a 4-seat table. |
| P19 | "`party_size` below 1, or not an integer \| 422 `validation_failed`" | `probes/errors/party_size_type.sh`. |
| P20 | "`starts_at_local` is a local time that does not exist (see §9) \| 422 `invalid_local_time`" | `probes/time/nonexistent_local.sh`. |
| P21 | "Unknown restaurant, unknown table, or the table belongs to another restaurant \| 404 `not_found`" | `probes/api/not_found_table.sh` — all three cases. |
| P22 | "Two `confirmed` reservations must never occupy the same table at overlapping times, including during concurrent requests. Occupancy is the half-open interval `[starts_at, starts_at + reservation_duration)`." | `probes/concurrency/overlap_50.sh` + `probes/api/slot_grid.sh` — 50-way single-table race leaves exactly one winner and no partial state; boundary equality is non-overlap. |
| P23 | "A 90-minute booking at 19:00 therefore does not overlap a booking starting at 20:30." | `probes/api/adjacent_slots.sh` — second booking 201, first occupancy intact. |
| P24 | "Retries and rejected requests must not create duplicate or partial bookings." | `probes/idempotency/failed_then_reuse.sh` + `probes/api/no_partial.sh` — after every rejected request in the suite the reservation count and availability are unchanged. |
| P25 | "The caller's reservations, `starts_at` descending, confirmed and cancelled alike." | `probes/api/my_reservations.sh` — mixed statuses present; order is strictly descending by `starts_at`. |
| P26 | "Return `200` with `{\"reservations\": [...]}`; each entry has the same shape as the create response." | `probes/api/my_reservations.sh`. |
| P27 | "An empty list is `{\"reservations\": []}`." | `probes/api/my_reservations.sh`. |
| P28 | "One reservation." | `probes/api/get_by_reference.sh`. |
| P29 | "**404 if it is not the caller's** — do not leak the existence of other people's bookings." | `probes/api/not_found_table.sh` — another user's known reference is 404 `not_found` on `GET`, `PATCH` and `cancel`. |
| P30 | "`200` `{ \"reference\": \"K3P7QW\", \"status\": \"cancelled\", ... }`" | `probes/api/cancel.sh`. |
| P31 | "Frees the table immediately: the next `GET /availability` must offer that slot again." | `probes/api/cancel.sh` — the cancelled slot's `available_table_ids` contains the table again. |
| P32 | "Already cancelled \| 200 with the current state — cancelling twice is not an error" | `probes/api/cancel_twice.sh`. |
| P33 | "Now is within `cancellation_cutoff_minutes` of `starts_at`, or later \| 409 `cutoff_passed`" | `probes/api/cutoff.sh` — 1 minute inside the window and a start already in the past. |
| P34 | "Not the caller's reservation \| 404 `not_found`" | `probes/api/not_found_table.sh`. |
| P35 | "Change the time, the table or the party size. Any subset of `table_id`, `starts_at_local`, `party_size`. No idempotency key is required here." | `probes/api/patch.sh` — each single field, all three together, and each pair; a `PATCH` with no `Idempotency-Key` header succeeds. |
| P36 | "Validation is identical to `POST /reservations`, and the same cutoff rule as cancel applies (409 `cutoff_passed`), measured against the **current** start time." | `probes/api/patch.sh` + `probes/api/cutoff.sh` — the same bad inputs give the same codes as `POST`; a booking moved into the cutoff window can no longer be patched. |
| P37 | "A cancelled reservation is 409 `reservation_cancelled`." | `probes/api/patch.sh`. |
| P38 | "A successful amendment releases the old slot and reserves the new one together." | `probes/api/patch.sh` — old slot free again, new slot blocked, old occupancy gone. |
| P39 | "A failed amendment leaves the original booking and its occupancy unchanged." | `probes/api/patch_atomicity.sh` — every rejected `PATCH` leaves the same fields, the same occupancy and the same availability. |
| P40 | "`reference` and `reservation_id` survive a change." | `probes/api/patch.sh`. |

## T — Time, zones and DST

| id | Requirement (verbatim) | Check |
|---|---|---|
| T1 | "Local dates and times follow the restaurant's `timezone`, including daylight-saving transitions." | `probes/time/zone_resolution.sh` — the same local string in `Europe/Berlin` and `America/New_York` produces different `starts_at` offsets. |
| T2 | "**Spring forward.** Local times in the skipped hour do not exist. They never appear in availability" | `probes/time/availability_dst.sh` — Berlin 2026-03-29 and New York 2026-03-08: the skipped local times are absent from every `slots[]` list. |
| T3 | "booking one is 422 `invalid_local_time`" | `probes/time/nonexistent_local.sh`. |
| T4 | "**Fall back.** Local times in the repeated hour occur twice. **Always resolve to the first occurrence — the one before the clocks change.** The slot appears once in availability, and the second occurrence is not bookable." | `probes/time/fallback_resolution.sh` — the repeated local time appears once in `slots[]`; a booking for it returns the pre-transition offset, and the second instant of that local time is not bookable. |
| T5 | "Transition `Europe/Berlin` \| Spring forward \| 2026-03-29, 02:00 → 03:00" | `probes/time/availability_dst.sh` + `probes/time/nonexistent_local.sh`. |
| T6 | "Transition `Europe/Berlin` \| Fall back \| 2026-10-25, 03:00 → 02:00" | `probes/time/fallback_resolution.sh`. |
| T7 | "Transition `America/New_York` \| Spring forward \| 2026-03-08, 02:00 → 03:00" | `probes/time/availability_dst.sh` + `probes/time/nonexistent_local.sh`. |
| T8 | "Transition `America/New_York` \| Fall back \| 2026-11-01, 02:00 → 01:00" | `probes/time/fallback_resolution.sh`. |
| T9 | "Offsets must follow the IANA rules for the specified zone and date." | `probes/time/iana_offsets.sh` — offsets compared against Node's own `Intl` computation for the same zone and date, at least four dates per zone. |
| T10 | "`reservation_duration_minutes` is **absolute time**, not wall-clock. A 90-minute reservation starting at 01:30 on a fall-back night ends 90 real minutes later, and its local `ends_at` will read 02:00, not 03:00." | `probes/time/absolute_duration.sh` — Berlin 2026-10-25 01:30 local: `starts_at` is +02:00 and `ends_at` is +01:00 exactly 90 minutes later, i.e. `02:00+01:00`, not `03:00`. |
| T11 | "`starts_at_local` … goes into `POST /reservations` unchanged" (fall-back night) | `probes/time/absolute_duration.sh` — the booked local string is echoed back unchanged. |

## X — Export and import

| id | Requirement (verbatim) | Check |
|---|---|---|
| X1 | "The service must support `GET /_test/export` and `POST /_test/import`. Like reset, these are unauthenticated test endpoints." | `probes/xport/endpoints.sh` — both work with no `Authorization` header. |
| X2 | "Return 200 from export with a JSON object containing `track: \"tablekeeper\"`, `format_version: 1` and `state`" | `probes/xport/export_shape.sh`. |
| X3 | "The state format is opaque to the caller and must be accepted unchanged by import." | `probes/xport/roundtrip.sh` — the exported object is posted back byte-for-byte. |
| X4 | "Import takes that entire object and atomically replaces the service's state, returning 204." | `probes/xport/roundtrip.sh` — 204, empty body. |
| X5 | "It must accept an unchanged export produced by this service. No dependency on the source process, files, volume, port or network address is allowed." | `probes/xport/cross_instance.sh` — export from instance A, import into a separately started instance B on another port. |
| X6 | "Import is replacement, not merge; repeating it restores the exported state without duplicating anything." | `probes/xport/roundtrip.sh` — importing the same export three times leaves the same reservation count and no duplicated reference. |
| X7 | "Invalid JSON follows §5; missing fields, wrong track/version or an invalid state give 422 `validation_failed` without changing the destination." | `probes/xport/invalid.sh` — unparseable body (400 `malformed_request`), missing `state`, wrong `track`, `format_version: 2`, `state: "text"`, and a full state check after each attempt. |
| X8 | "Test control calls have a 10-second timeout." | `probes/xport/timing.sh` — reset, export and import each answer inside 10 s under the container limits. |
| X9 | "Export is an atomic, read-only snapshot; subsequent source writes do not change it." | `probes/xport/snapshot.sh` — export, then book and cancel, then the already-captured export body is unchanged and imports to the pre-write state. |
| X10 | "Preserve accounts and hashed-password login, existing bearer tokens, fixture configuration, reservations, references, all completed idempotent request bodies and original responses." | `probes/xport/preserve.sh` — old token works after import; old password still logs in; fixture restaurants and tables unchanged; reservations, references and receipts survive. |
| X11 | "Identities, statuses and timestamps must not be regenerated." | `probes/xport/preserve.sh` — `reservation_id`, `reference`, `status`, `starts_at`, `created_at` byte-identical before and after. |
| X12 | "Failed request keys remain reusable." | `probes/xport/preserve.sh` — a key that failed with 422 before the export still works after import. |
| X13 | "Existing receipts, references, tokens and retries must remain valid after import; replacing the state with a fresh fixture does not satisfy this requirement." | `probes/xport/replay_after_import.sh` — a replay after import returns 200 with the original body and changes nothing. |
| X14 | "Import removes all previous destination data and credentials." | `probes/xport/roundtrip.sh` — a reservation, token and idempotency key that existed only in the destination are gone afterwards. |
| X15 | "Reset continues to clear all state, including imported state." | `probes/xport/roundtrip.sh` — reset after import empties everything. |
| X16 | "Exports may contain credentials and session tokens; handle them as private test artifacts." | Handling note, not a behaviour — no probe; exports live only in `verification/` and are never committed or messaged. |

## V — Atomic reservation moves

| id | Requirement (verbatim) | Check |
|---|---|---|
| V1 | "A diner may change several bookings in one request." | `probes/moves/success.sh` — two bookings moved in one call. |
| V2 | "`POST /reservation-moves` requires authentication and an idempotency key." | `probes/moves/auth.sh` — no token is 401 `unauthenticated`; no key is 400 `missing_idempotency_key`. |
| V3 | Body `{ \"moves\": [ { \"reference\": \"BOOK01\", \"table_id\": \"t_2\" }, { \"reference\": \"BOOK02\", \"table_id\": \"t_1\" } ] }` | `probes/moves/success.sh` — the documented shape is accepted. |
| V4 | "`moves` contains 1..8 objects with distinct string references. Invalid shape or duplicate references gives 422 `validation_failed`." | `probes/moves/shape.sh` — 0 moves, 9 moves, `moves` not a list, an item not an object, a non-string reference, a missing reference, a duplicate reference, and 8 moves accepted. |
| V5 | "Every booking must belong to the caller and the same restaurant." | `probes/moves/shape.sh` — a move mixing two restaurants is 422 `validation_failed`. |
| V6 | "Unknown/another owner's reference gives 404 `not_found`" | `probes/moves/not_found.sh`. |
| V7 | "different restaurants give 422 `validation_failed`" | `probes/moves/shape.sh`. |
| V8 | "Each item accepts the ordinary PATCH fields `table_id`, `starts_at_local`, `party_size`; omitted fields retain their current values and unknown fields are ignored." | `probes/moves/fields.sh` — each field alone, all three in one item, omission keeps the old value, an unknown key changes nothing. |
| V9 | "The booking's identity, owner and creation time never change." | `probes/moves/preserve_identity.sh` — `reservation_id`, `reference`, `user_id` and `created_at` identical after a successful move. |
| V10 | "Cancelled bookings give 409 `reservation_cancelled`." | `probes/moves/cancelled.sh`. |
| V11 | "Each booking's existing cutoff applies." | `probes/moves/cutoff.sh` — a listed booking inside its cutoff window answers 409 `cutoff_passed`. |
| V12 | "Non-occupancy errors use ordinary amendment codes and take precedence in input order, with cutoff errors preceding other changes for that booking." | `probes/moves/error_precedence.sh` — three bookings, three different faults, the earliest input item's fault is the answer; a booking with both a cutoff fault and a bad field answers `cutoff_passed`. |
| V13 | "An overlap among resulting bookings or with an unlisted booking gives 409 `table_unavailable`." | `probes/moves/conflict.sh` — two listed bookings onto one overlapping table, and a listed booking onto a table an unlisted booking holds. |
| V14 | "Unchanged listed bookings retain their occupancy." | `probes/moves/conflict.sh` — after a batch, an unchanged item still blocks its slot. |
| V15 | "Either every move commits or nothing changes: occupancy, reservation records and retry keys." | `probes/moves/atomicity.sh` — every failing batch leaves both bookings' fields, occupancy and availability exactly as before, and the same key can then succeed. |
| V16 | "On success return 201 with `{\"reservations\": [...]}` in input order, including unchanged items." | `probes/moves/success.sh` — order matches the request, length matches, unchanged item included. |
| V17 | "Replays return that original response with 200, even after amendments or cancellations." | `probes/moves/replay.sh` — replay after a later `PATCH` and after a `cancel` returns the stored 201 body with 200. |
| V18 | "No-op moves retain all existing values." | `probes/moves/noop.sh` — a batch whose items restate the current values changes no field. |
| V19 | "Export/import preserves successful batch receipts as well as the resulting bookings." | `probes/moves/replay_after_import.sh` — batch receipt survives an import and still replays with 200. |
| V20 | "No batch UI is required." | Not a requirement — no probe. |

## How a row is decided

- A row passes only when its probe is run against a clean build of the reported commit and the
  expectation written in the probe holds. "Not run" is not a pass.
- Probes assert what the specification states, never what an implementation happens to do. Where
  the specification allows any wording — error `message`, id format, `state` internals, `reference`
  charset within A-Z0-9/6..12 — the probe asserts only the stated constraint.
- A probe that fails for an environmental reason (port clash, slow machine) is re-run once from a
  fresh container before it is reported as a failing row.
- The supplied checks are run first, through the command given to me, and I read only their output.
  I never open, copy or imitate them, and I never shape a probe to match one.
- Screen rows exist from stage 2 onwards; stage 1 has no screens, so no row here concerns a UI.

## Rows that are not requirements

Recorded so that a later stage or a defect report cannot turn a permitted behaviour into a
pass/fail claim: D13 (state need not survive a restart), D17 (not a Python package), D18 (compose
optional), C3 (non-200 before ready), X16 (export holds credentials), V20 (no batch UI).

## Band invariants (recorded at the room owner's request, 2d3d9ef6)

Six invariants the room owner states as the things the saboteur will attack. They are not extra
requirements; each is the specification's own wording gathered into one place. `Decided by` lists
the ledger rows that actually decide it, so a mutant cannot pass by being agreed with in prose.

| id | Invariant (verbatim from the room owner's plan message) | Decided by |
|---|---|---|
| INV1 | "Two confirmed reservations never occupy the same table over overlapping half-open intervals, including under 50 concurrent in-flight requests, and no partial state is ever left behind." | P22, P23, P15, D10, P24, P39, V15, V13 |
| INV2 | "Never a 5xx. Every 4xx uses exactly the status and code named in the specification's error table." | E16, E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E13, E15, E17 and every row that names a status and code |
| INV3 | "Idempotency is resolved after body parse and authentication but before any endpoint-specific validation; a replay returns the stored original response verbatim; a key whose original request failed with 4xx stays reusable; keys are scoped per authenticated user." | I4, I12, I9, I2, I7, I10, I11 |
| INV4 | "`reservation_duration_minutes` is absolute time, not wall clock. A DST fall-back local time resolves to the first occurrence only. A spring-forward gap time is 422 `invalid_local_time`." | T10, T11, T4, T6, T8, T3, T5, T7 |
| INV5 | "Export and import round-trip accounts, hashed passwords, bearer tokens, references, histories, idempotency receipts and counters without regenerating or duplicating anything." | X10, X11, X13, X14, X6, X12, X9, A9, I11, V19 |
| INV6 | "A booking is never rejected solely because its start is in the past." | M7, P33, P36 |

Two mappings worth stating, because a mutant could otherwise sit on the gap between the invariant's
words and the specification's:

- INV5 says "histories" and "counters". The specification's words are "Identities, statuses and
  timestamps must not be regenerated" (row X11) together with references, tokens and receipts
  (X10). So `probes/xport/preserve.sh` compares the whole reservation field set and the whole
  receipt set across an import, field by field, rather than checking a single identifier. Any
  value that changes across an import fails X11, whichever word the invariant used for it.
- INV6 says "solely because its start is in the past". A past start is accepted (M7), while the
  cutoff rules still apply to cancel and patch (P33, P36). Both halves are probed, so a service
  that accepts past starts by dropping the cutoff rule fails INV6's second clause rather than
  passing it.

## Reading the specification against itself

Two points in stage-1.md that a probe must pin down rather than guess, because the text allows
more than one reading. They are not contradictions, and neither is left unprobed:

1. §8 `POST /reservations` names `not_on_slot_grid` and `outside_opening_hours` as separate 422
   codes, while §5 says a rule violation with no more specific code is `validation_failed`. A time
   that is both off-grid and outside opening hours is checked against both codes in
   `probes/api/not_on_grid.sh` and `probes/api/outside_hours.sh`; each probe uses a time that
   violates exactly one rule, so the ledger never has to pick a winner.
2. §5 requires 400 `malformed_request` for "a field of the wrong JSON type", while §3.4 says
   unknown fields are "ignored, never an error". An unknown field of a wrong type is therefore
   probed as ignored (row C9) and a *known* field of a wrong type as `malformed_request`
   (rows E3, E14); `probes/errors/type_precedence.sh` covers both sides of that line.

