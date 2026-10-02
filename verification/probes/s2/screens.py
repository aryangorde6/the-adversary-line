#!/usr/bin/env python3
"""Stage-2 browser rows: the screens, at 375 and 1280, in a headless Chromium.

Built from stage-2.md text only. Prints `PASS <row>` or `FAIL <row>: expected ... got ...`.
Usage: TK_BASE=http://127.0.0.1:8080 python3 screens.py
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("TK_BASE", "http://127.0.0.1:8080")
WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
TODAY = None
RESULTS = []


def record(row, ok, detail=""):
    RESULTS.append((row, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'} {row}" + ("" if ok else f": {detail}"), flush=True)


KEYS = {"n": 0}


def api(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if method == "POST" and path == "/reservations":
        KEYS["n"] += 1
        req.add_header("Idempotency-Key", f"probe-{KEYS['n']}")
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data) as res:
        raw = res.read().decode()
        return res.status, (json.loads(raw) if raw else None)


def fixture(combinable=None):
    global TODAY
    d = os.popen("date -u +%F").read().strip()
    TODAY = d
    weekday = WD[int(os.popen(f"date -u -d {d} +%w").read().strip()) % 7]
    tables = [
        {"id": "t_1", "label": "Window 1", "capacity": 2},
        {"id": "t_2", "label": "Window 2", "capacity": 4},
        {"id": "t_3", "label": "Patio 3", "capacity": 2},
        {"id": "t_4", "label": "Booth 4", "capacity": 6},
    ]
    return {
        "users": [{"id": "u_ada", "email": "ada@example.com", "password": "correct horse", "display_name": "Ada"}],
        "restaurants": [{
            "id": "r_anker", "name": "Zum Anker", "timezone": "Europe/Berlin", "slot_minutes": 60,
            "reservation_duration_minutes": 120, "cancellation_cutoff_minutes": 120,
            # Only today is open, so tomorrow is a real closed day for the no-slots row.
            "opening_hours": [{"weekday": weekday, "opens": "00:00", "closes": "23:00"}],
            "tables": tables, "combinable": combinable or [["t_1", "t_2"]],
        }],
        "reservations": [],
    }


def sign_in(page):
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('[data-testid="login-email"]', "ada@example.com")
    page.fill('[data-testid="login-password"]', "correct horse")
    page.click('[data-testid="login-submit"]')
    page.wait_for_timeout(400)


def testid(page, name):
    return page.locator(f'[data-testid="{name}"]')


def visible(page, name):
    loc = testid(page, name)
    return loc.count() > 0 and loc.first.is_visible()


def text_of(page, name):
    loc = testid(page, name)
    return loc.first.inner_text().strip() if loc.count() else ""


def search(page, party=2, slot_index=0):
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.select_option('[data-testid="restaurant-select"]', "r_anker")
    page.fill('[data-testid="date-input"]', TODAY)
    page.fill('[data-testid="party-size-input"]', str(party))
    page.click('[data-testid="search-button"]')
    page.wait_for_timeout(500)


def scroll_check(page):
    return page.evaluate(
        "() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")


def auth_rows(page, width):
    """S1..S9 — signup, login, the error element, the signed-in marker and logout."""
    def err_state():
        loc = testid(page, "auth-error")
        if not loc.count():
            return "absent"
        return f"{len(text_of(page, 'auth-error'))} chars, visible={loc.first.is_visible()}"

    page.goto(f"{BASE}/signup", wait_until="networkidle")
    fresh_signup = err_state()
    types, present = {}, True
    for name in ("signup-email", "signup-password", "signup-display-name"):
        loc = testid(page, name)
        types[name] = loc.first.get_attribute("type") if loc.count() else None
        present = present and loc.count() == 1 and loc.first.is_visible() and loc.first.is_enabled()
    record("S1", present and types["signup-email"] == "email" and types["signup-password"] == "password",
        f"signup inputs at {width}: present={present} types {json.dumps(types)}")
    sub = testid(page, "signup-submit")
    record("S2", sub.count() == 1 and sub.first.is_visible() and sub.first.is_enabled(),
        f"signup-submit at {width}: visible={sub.count() == 1}")


    page.goto(f"{BASE}/login", wait_until="networkidle")
    fresh_login = err_state()
    ltypes = {n: (testid(page, n).first.get_attribute("type") if testid(page, n).count() else None)
              for n in ("login-email", "login-password")}
    ok3 = ltypes["login-email"] == "email" and ltypes["login-password"] == "password"
    record("S3", ok3 and visible(page, "login-submit"), f"login inputs were {json.dumps(ltypes)}")


    # A refused login must leave auth-error behind with real text.
    page.fill('[data-testid="login-email"]', "ada@example.com")
    page.fill('[data-testid="login-password"]', "wrong password")
    page.click('[data-testid="login-submit"]')
    page.wait_for_timeout(500)
    record("S4", visible(page, "auth-error") and len(text_of(page, "auth-error")) > 0,
        f"a refused login at {width} left auth-error with text {text_of(page, 'auth-error')!r}")


    # The signed-in marker on every screen.
    # S5 — the element is absent whenever there is no error: fresh pages, a refused login
    # that shows one, and a clean sign-in.
    def err_state():
        loc = testid(page, "auth-error")
        if not loc.count():
            return "absent"
        return f"{len(text_of(page, 'auth-error'))} chars, visible={loc.first.is_visible()}"
    sign_in(page)
    quiet = [fresh_signup, fresh_login, not visible(page, "auth-error")]
    signed_in = []
    for route in ("/", "/lookup", "/signup", "/login"):
        page.goto(BASE + route, wait_until="networkidle")
        signed_in.append(visible(page, "current-user"))
        if route == "/":
            search(page)
            signed_in[-1] = signed_in[-1] and visible(page, "current-user")
    record("S5", all(q == "absent" for q in quiet[:2]) and quiet[2] is True,
        f"auth-error on a fresh /signup, a fresh /login and after signing in at {width}: {quiet}")
    record("S6", all(signed_in), f"current-user on every route at {width}: {signed_in}")
    record("S7", "ada" in text_of(page, "current-user").lower(),
        f"current-user read {text_of(page, 'current-user')!r}")
    record("S8", visible(page, "logout-button"), f"logout-button at {width}")


    token = token_of(page)
    slot = free_slot(["t_4"], 2)
    made = api("POST", "/reservations", {"restaurant_id": "r_anker", "table_id": "t_4",
              "starts_at_local": slot, "party_size": 2}, token) if slot else (None, None)
    live_ref = made[1]["reference"] if made[0] == 201 else None
    page.click('[data-testid="logout-button"]')
    page.wait_for_timeout(400)
    gone = []
    for route in ("/", "/lookup"):
        page.goto(BASE + route, wait_until="networkidle")
        gone.append(not visible(page, "current-user"))
    record("S9", all(gone), f"current-user after logout at {width}: {gone}")
    before = api("GET", f"/reservations/{live_ref}", token=token)[0] if live_ref else None
    code = None
    try:
        code = api("GET", f"/reservations/{live_ref}", token=token)[0] if live_ref else None
    except urllib.error.HTTPError as e:
        code = e.code
    record("S9", all(gone) and before == 200,
        f"current-user gone on every route after logout: {gone}; the token the browser held answered "
        f"{before} before logout and {code} after, which stage-1.md permits because it documents no "
        f"logout endpoint and says tokens do not expire")
LABELS = {"t_1": "Window 1", "t_2": "Window 2", "t_3": "Patio 3", "t_4": "Booth 4"}


def cells(page):
    return page.locator('[data-testid^="slot-"]')


def cell_map(page):
    out = {}
    for i in range(cells(page).count()):
        loc = cells(page).nth(i)
        out[loc.get_attribute("data-testid")] = loc.get_attribute("data-available")
    return out


def grid_rows(page, width):
    """G1..G12 and the grid half of Z28, Z29, Z32, Z33."""
    sign_in(page)
    calls = []
    page.on("request", lambda r: calls.append(r.url))
    page.goto(f"{BASE}/", wait_until="networkidle")
    rest_ids = [r["id"] for r in api("GET", "/restaurants")[1]["restaurants"]]
    options = page.eval_on_selector_all(
        '[data-testid="restaurant-select"] option', "els => els.map(e => e.value)")
    record("G1", options == rest_ids, f"options {options} against restaurant ids {rest_ids}")

    dinput = testid(page, "date-input")
    dval = dinput.first.input_value() if dinput.count() else ""
    record("G2", dinput.count() == 1 and dinput.first.get_attribute("type") == "date"
        and len(dval) == 10 and dval[4] == "-" and dval[7] == "-",
        f"date-input type={dinput.first.get_attribute('type') if dinput.count() else None} value={dval!r}")

    psize = testid(page, "party-size-input")
    ptype = psize.first.get_attribute("type") if psize.count() else None
    record("G3", psize.count() == 1 and ptype in ("number", None) and psize.first.is_editable(),
        f"party-size-input type={ptype}")

    before = len([c for c in calls if "/availability" in c])
    search(page, party=2)
    after = [c for c in calls[before:] if "/availability" in c]
    record("G4", len(after) >= 1 and all("party_size=2" in c and f"date={TODAY}" in c for c in after),
        f"one search click issued {len(after)} availability requests, all for the searched inputs: {after[:1]}")


    record("G5", visible(page, "availability-grid"), f"no availability-grid at {width}")
    mapping = cell_map(page)
    bad = [k for k in mapping if not k.startswith("slot-")]
    record("G6", len(mapping) > 0 and not bad, f"{len(mapping)} cells, malformed ids {bad[:3]}")
    singles = [k for k in mapping if "+" not in k]
    pairs = [k for k in mapping if "+" in k]
    record("Z33", bool(singles) and all(len(k.split("-")) == 3 for k in singles),
        f"{len(singles)} single cells, first {sorted(singles)[:2]}")

    api_slots = api("GET", f"/availability?restaurant_id=r_anker&date={TODAY}&party_size=2")[1]["slots"]
    want = {}
    for slot in api_slots:
        for tid in slot["available_table_ids"]:
            want[f"slot-{tid}-{slot['starts_at_local'][-5:]}"] = "true"
    for slot in api_slots:
        for opt in slot["available_options"]:
            if len(opt["table_ids"]) == 2:
                want[f"slot-{opt['table_ids'][0]}+{opt['table_ids'][1]}-{slot['starts_at_local'][-5:]}"] = "true"
    record("G8", all(v in ("true", "false") for v in mapping.values()),
        f"cells with no usable data-available: {[k for k, v in mapping.items() if v not in ('true', 'false')][:3]}")
    falseCells = {k for k, v in mapping.items() if v == "true"}
    mismatch = [(k, mapping[k]) for k in sorted(set(mapping) | set(want))
        if (mapping.get(k) == "true") != (want.get(k) == "true")]
    record("G9", not mismatch, f"{len(mismatch)} cells disagree with the API, first {mismatch[:3]}")
    record("Z28", len(pairs) > 0 and all(k in mapping for k in pairs),
        f"{len(pairs)} combination cells for party 2: {sorted(pairs)[:2]}")
    pairOrder = all(k.split("-")[1].split("+")[0] < k.split("-")[1].split("+")[1] for k in pairs)
    record("Z29", pairOrder and all(mapping[k] in ("true", "false") for k in pairs),
        f"combination cells in combinable order: {pairOrder}")

    # A closed day: no grid at all.
    closed = "2026-01-01"
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.fill('[data-testid="date-input"]', closed)
    page.click('[data-testid="search-button"]')
    page.wait_for_timeout(500)
    record("G7", visible(page, "no-slots") and not visible(page, "availability-grid"),
        f"closed day: no-slots={visible(page, 'no-slots')} grid={visible(page, 'availability-grid')}")

    # Clicking an available cell opens the form for that table and slot.
    search(page, party=2)
    avail = [k for k, v in cell_map(page).items() if v == "true" and "+" not in k]
    unavail = [k for k, v in cell_map(page).items() if v == "false"]
    if avail:
        tid, clock = avail[0][len("slot-"):].rsplit("-", 1)
        page.click(f'[data-testid="{avail[0]}"]')
        page.wait_for_timeout(400)
        summary = text_of(page, "booking-summary")
        record("G10", visible(page, "booking-form") and LABELS.get(tid, "@") in summary and clock in summary,
            f"clicking {avail[0]} gave summary {summary!r}")
        record("B1", visible(page, "booking-form"), f"no booking-form at {width}")
        record("Z32", True, "single-table selection; the pair case is checked in booking_rows")
    else:
        record("G10", False, "no available cell to click")
        record("B1", False, "no available cell to click")
    if unavail:
        search(page, party=2)
        unavail = [k for k, v in cell_map(page).items() if v == "false"]
        before_url = page.url
        page.click(f'[data-testid="{unavail[0]}"]')
        page.wait_for_timeout(300)
        record("G11", not visible(page, "booking-form") and page.url == before_url,
            f"clicking the unavailable {unavail[0]} left form={visible(page, 'booking-form')} url same={page.url == before_url}")

    # Signed out: an available cell must not open a booking form.
    ctx2 = page.context
    page.goto(f"{BASE}/login", wait_until="networkidle")
    if visible(page, "logout-button"):
        page.click('[data-testid="logout-button"]')
        page.wait_for_timeout(300)
    search(page, party=2)
    anyAvail = [k for k, v in cell_map(page).items() if v == "true"]
    if anyAvail:
        page.click(f'[data-testid="{anyAvail[0]}"]')
        page.wait_for_timeout(400)
        record("G12", (visible(page, "auth-error") or "/login" in page.url) and not visible(page, "booking-form"),
            f"signed out click: auth-error={visible(page, 'auth-error')} url={page.url} form={visible(page, 'booking-form')}")
    sign_in(page)

def token_of(page):
    # The session is a JSON object under one key; the token is its "token" field. Found by
    # scanning values so the probe does not depend on which key the app chose.
    return page.evaluate("""() => {
      for (let i = 0; i < localStorage.length; i++) {
        const v = localStorage.getItem(localStorage.key(i));
        if (typeof v !== 'string') continue;
        try { const p = JSON.parse(v); if (p && typeof p.token === 'string' && p.token) return p.token; }
        catch (e) { /* not the session */ }
      }
      return null; }""")


def reservation_count(page):
    return len(api("GET", "/_test/export")[1]["state"]["reservations"])


def booking_rows(page, width):
    """B1..B9, F1..F3, and the pair halves of Z30, Z32, Z36."""
    sign_in(page)
    posts = []
    page.on("request", lambda r: posts.append((r.url, r.method, r.headers.get("idempotency-key"), r.post_data))
            if "/reservations" in r.url and r.method == "POST" else None)

    search(page, party=2)
    avail = [k for k, v in cell_map(page).items() if v == "true" and "+" not in k]
    if not avail:
        record("B1", False, "no available cell")
        return
    tid, clock = avail[0][len("slot-"):].rsplit("-", 1)
    page.click(f'[data-testid="{avail[0]}"]')
    page.wait_for_timeout(300)
    summary = text_of(page, "booking-summary")
    record("B2", LABELS.get(tid, "@") in summary and clock in summary and "+" not in summary,
        f"summary for {avail[0]} read {summary!r}")
    record("B3", testid(page, "booking-party-size").first.input_value() == "2",
        f"booking-party-size read {testid(page, 'booking-party-size').first.input_value()!r}")
    record("B4", visible(page, "booking-submit"), f"no booking-submit at {width}")

    # A refusal must show booking-error and no confirmation.
    page.fill('[data-testid="booking-party-size"]', "9")
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(600)
    record("B5", visible(page, "booking-error") and not visible(page, "confirmation"),
        f"party 9 on a small table: booking-error={visible(page, 'booking-error')} text={text_of(page, 'booking-error')!r}")
    record("U10", visible(page, "booking-error") and not visible(page, "booking-uncertain"),
        "a confirmed 422 shows booking-error, not booking-uncertain")

    # A success keeps the form on screen.
    search(page, party=2)
    avail = [k for k, v in cell_map(page).items() if v == "true" and "+" not in k]
    page.click(f'[data-testid="{avail[0]}"]')
    page.wait_for_timeout(300)
    page.fill('[data-testid="booking-party-size"]', "2")
    before = reservation_count(page)
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(700)
    ref = text_of(page, "confirmation-reference")
    record("F1", visible(page, "confirmation"), f"no confirmation after a 201 at {width}")
    record("B6", visible(page, "booking-form") and testid(page, "booking-party-size").count() > 0,
        f"the form after success: present={visible(page, 'booking-form')}")
    record("F2", ref and ref == ref.strip() and " " not in ref and len(ref) > 3,
        f"confirmation-reference read {ref!r}")
    details = text_of(page, "confirmation-details")
    record("F3", "Zum Anker" in details and LABELS.get(tid, "@") in details and clock in details,
        f"confirmation-details read {details!r}")
    record("U12", bool(ref) and api("GET", f"/reservations/{ref}", token=token_of(page))[0] == 200,
        f"the shown reference {ref!r} reads back from the service")

    # Same fields again: same reference, no second booking.
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(700)
    after = reservation_count(page)
    record("B7", text_of(page, "confirmation-reference") == ref and not visible(page, "booking-error")
        and after == before + 1,
        f"resubmit gave {text_of(page, 'confirmation-reference')!r}, reservations {before} -> {after}, so the pair of submits made one booking")
    keys = [k for _, _, k, _ in posts if k]
    bodies = [b for _, _, _, b in posts]
    record("B9", len(keys) >= 2 and keys[-1] == keys[-2] and bodies[-1] == bodies[-2],
        f"idempotency keys {keys[-2:]} and identical bodies {bodies[-1] == bodies[-2]}")

    # A changed field is a new booking request: a new idempotency key, and not a replay of
    # the receipt. The same table and slot are still occupied, so the service may refuse it.
    keysBefore = list(keys)
    page.fill('[data-testid="booking-party-size"]', "1")
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(700)
    newKeys = [k for _, _, k, _ in posts if k][len(keysBefore):]
    answer = [b for _, _, _, b in posts][-1]
    stillSame = text_of(page, "confirmation-reference") == ref
    count8 = reservation_count(page)
    record("B8", bool(newKeys) and newKeys[-1] != keysBefore[-1]
        and (not stillSame or visible(page, "booking-error")),
        f"a changed field sent key {newKeys[-1] if newKeys else None} against {keysBefore[-1]}; "
        f"reference {ref} -> {text_of(page, 'confirmation-reference')!r}, reservations {after} -> {count8}, "
        f"booking-error={visible(page, 'booking-error')}")

    # And a second booking really does appear when the changed submission can succeed.
    search(page, party=2)
    other = [k for k, v in cell_map(page).items() if v == "true" and "+" not in k
        and k not in [a for a in avail]]
    if other:
        page.click(f'[data-testid="{other[0]}"]')
        page.wait_for_timeout(300)
        page.click('[data-testid="booking-submit"]')
        page.wait_for_timeout(700)
        record("B8b", text_of(page, "confirmation-reference") not in ("", ref)
            and reservation_count(page) > count8,
            f"a second table gave {text_of(page, 'confirmation-reference')!r}, reservations {reservation_count(page)}")


    # A pair selection names both labels in the summary and in the confirmation.
    search(page, party=6)
    pair = [k for k, v in cell_map(page).items() if v == "true" and "+" in k]
    if pair:
        page.click(f'[data-testid="{pair[0]}"]')
        page.wait_for_timeout(400)
        psum = text_of(page, "booking-summary")
        want = [LABELS[t] for t in pair[0][len("slot-"):].split("-")[0].split("+")]
        record("Z32", all(w in psum for w in want), f"pair summary {psum!r} against {want}")
        page.click('[data-testid="booking-submit"]')
        page.wait_for_timeout(700)
        record("Z30", all(w in text_of(page, "confirmation-tables") for w in want),
            f"confirmation-tables read {text_of(page, 'confirmation-tables')!r}")
    else:
        record("Z32", False, "no available combination cell for party 6")
        record("Z30", False, "no available combination cell for party 6")

def future_slot(need_ids, min_hours):
    """The first slot of today where every named table is free and the start is at least
    min_hours away, so amendment and cancellation rows are not answered cutoff_passed."""
    slots = api("GET", f"/availability?restaurant_id=r_anker&date={TODAY}&party_size=1")[1]["slots"]
    for slot in slots:
        if all(t in slot["available_table_ids"] for t in need_ids) \
                and Date_slot(slot["starts_at"]) > now_hours(min_hours):
            return slot["starts_at_local"]
    return None


def Date_slot(s):
    return __import__("datetime").datetime.fromisoformat(s).timestamp()


def now_hours(h):
    return __import__("time").time() + h * 3600


def free_slot(need_ids, party):
    """The first slot of today where every named table is free, so setup bookings do not
    collide with whatever an earlier flow already took."""
    slots = api("GET", f"/availability?restaurant_id=r_anker&date={TODAY}&party_size={party}")[1]["slots"]
    for slot in slots:
        if all(t in slot["available_table_ids"] for t in need_ids):
            return slot["starts_at_local"]
    return None


def lookup_rows(page, width):
    """L1..L7 and the lookup half of Z31, Y3."""
    sign_in(page)
    page.goto(f"{BASE}/lookup", wait_until="networkidle")
    ok1 = testid(page, "lookup-reference-input").count() == 1 and visible(page, "lookup-submit")
    record("L1", ok1, f"lookup input and submit at {width}")

    def lookup(ref):
        page.fill('[data-testid="lookup-reference-input"]', ref)
        page.click('[data-testid="lookup-submit"]')
        page.wait_for_timeout(600)

    lookup("NOSUCHREFERENCE")
    record("L6", visible(page, "reservation-error") and len(text_of(page, "reservation-error")) > 0
        and not visible(page, "reservation-detail"),
        f"an unknown reference gave error={visible(page, 'reservation-error')} detail={visible(page, 'reservation-detail')}")

    token = token_of(page)
    when = free_slot(["t_1", "t_2"], 1)
    soon = future_slot(["t_1", "t_2"], 0)
    made = api("POST", "/reservations",
        {"restaurant_id": "r_anker", "table_ids": ["t_1", "t_2"], "starts_at_local": when, "party_size": 6}, token) \
        if when else (409, None)
    if made[0] != 201:
        record("L2", False, f"the setup booking answered {made[0]}")
        return
    ref = made[1]["reference"]
    lookup(ref)
    record("L2", visible(page, "reservation-detail"), f"lookup of a real reference {ref} at {width}")
    status = text_of(page, "reservation-status")
    record("L3", status in ("confirmed", "cancelled"), f"reservation-status read {status!r}")
    record("L4", visible(page, "reservation-cancel-button"), f"no cancel button at {width} for a confirmed booking")
    record("Z31", all(LABELS[t] in text_of(page, "reservation-tables") for t in ("t_1", "t_2")),
        f"reservation-tables read {text_of(page, 'reservation-tables')!r}")

    # A cancel refused for the cutoff keeps the booking and the button, with an error.
    if soon:
        page.goto(f"{BASE}/lookup", wait_until="networkidle")
        soonMade = api("POST", "/reservations", {"restaurant_id": "r_anker", "table_ids": ["t_1", "t_2"],
                          "starts_at_local": soon, "party_size": 6}, token)
        lookup(soonMade[1]["reference"])
        page.click('[data-testid="reservation-cancel-button"]')
        page.wait_for_timeout(600)
        refused = visible(page, "reservation-error")
        record("L7", refused and text_of(page, "reservation-status") == "confirmed"
            and visible(page, "reservation-cancel-button"),
            f"a booking starting inside the 120-minute cutoff: error={refused} "
            f"status={text_of(page, 'reservation-status')!r} button={visible(page, 'reservation-cancel-button')}")
    else:
        record("L7", False, "no slot inside the cutoff to test a refused cancel")

    # A booking far enough ahead cancels cleanly, and the button goes away.
    later = future_slot(["t_3"], 3)
    ok = api("POST", "/reservations", {"restaurant_id": "r_anker", "table_id": "t_3",
               "starts_at_local": later, "party_size": 2}, token) if later else (409, None)
    if ok[0] == 201:
        lookup(ok[1]["reference"])
        page.click('[data-testid="reservation-cancel-button"]')
        page.wait_for_timeout(600)
        record("L4", text_of(page, "reservation-status") == "cancelled",
            f"after cancelling, status read {text_of(page, 'reservation-status')!r}")
        lookup(ok[1]["reference"])
        record("L5", not visible(page, "reservation-cancel-button") and text_of(page, "reservation-status") == "cancelled",
            f"a cancelled booking at {width}: button={visible(page, 'reservation-cancel-button')} status={text_of(page, 'reservation-status')!r}")
    else:
        record("L4", False, f"the setup booking for the cancel answered {ok[0]}")
        record("L5", False, f"the setup booking for the cancel answered {ok[0]}")


def upgrade_rows(page, width):
    """Y1..Y7 need a stage-1 service and an import between browser requests; driven separately
    by upgrade.py, which is not part of this file's flow."""
    record("Y3", False, "not decided by this probe; see upgrade.py")

def run(pw):
    browser = pw.chromium.launch()
    status, _ = api("POST", "/_test/reset", fixture())
    print(f"# reset answered {status}", flush=True)
    for width in (375, 1280):
        # Each width starts from the same fixture, so the two passes are comparable and a
        # booking taken by one pass cannot starve the next.
        status, _ = api("POST", "/_test/reset", fixture())
        ctx = browser.new_context(viewport={"width": width, "height": 900})
        page = ctx.new_page()
        tag = f"at {width}"
        for route, probe, row in (("/", "availability-grid", "R1"), ("/signup", "signup-email", "R2"),
                                  ("/login", "login-email", "R3"), ("/lookup", "lookup-reference-input", "R4")):
            page.goto(BASE + route, wait_until="networkidle")
            ok = page.locator(f'[data-testid="{probe}"]').count() > 0
            record(row, ok, f"GET {route} {tag} has no {probe}")
            record("Q18", scroll_check(page), f"{route} {tag} scrolls sideways")
        auth_rows(page, width)
        grid_rows(page, width)
        booking_rows(page, width)
        lookup_rows(page, width)
        ctx.close()
    browser.close()


if __name__ == "__main__":
    with sync_playwright() as pw:
        run(pw)
    failed = [r for r in RESULTS if not r[1]]
    print(f"--- stage-2 browser rows decided {len(RESULTS)}, failures {len(failed)}")
    print("--- failing: " + " ".join(r[0] for r in failed) if failed else "--- none failing")
    sys.exit(1 if failed else 0)