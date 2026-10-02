#!/usr/bin/env python3
"""Stage-2 rows U1..U13: competing clients, out-of-order answers and lost responses.

Built from stage-2.md's "Competing clients and uncertain outcomes" section only.
Usage: TK_BASE=http://127.0.0.1:8080 python3 recovery.py
"""
import json
import os
import time

from playwright.sync_api import sync_playwright

import screens as S

BASE = S.BASE


def free_slot(need_ids, party=1):
    slots = S.api("GET", f"/availability?restaurant_id=r_anker&date={S.TODAY}&party_size={party}")[1]["slots"]
    for slot in slots:
        if all(t in slot["available_table_ids"] for t in need_ids):
            return slot["starts_at_local"]
    return None


def booking_for(page, tid, when):
    """The reference the service holds for that table and slot, read back from the state."""
    res = S.api("GET", "/_test/export")[1]["state"]["reservations"]
    hits = [r for r in res if tid in r.get("table_ids", []) and r.get("starts_at_local") == when]
    return hits[-1]["reference"] if hits else None


def taken_by_another_client(page):
    """U3, U4, U5 — a 409 after the form is open keeps the form and refreshes availability."""
    S.sign_in(page)
    S.search(page, party=2)
    free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    if not free:
        S.record("U3", False, "no available cell")
        return
    tid, clock = free[0][len("slot-"):].rsplit("-", 1)
    page.click(f'[data-testid="{free[0]}"]')
    page.wait_for_timeout(300)
    S.testid(page, "booking-party-size").first.fill("2")
    kept = S.text_of(page, "booking-summary")
    token = S.token_of(page)
    stolen = S.api("POST", "/reservations", {"restaurant_id": "r_anker", "table_id": tid,
                   "starts_at_local": f"{S.TODAY}T{clock}", "party_size": 2}, token)
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(900)
    err = S.visible(page, "booking-error")
    form = S.visible(page, "booking-form")
    conf = S.visible(page, "confirmation")
    cell = page.locator(f'[data-testid="{free[0]}"]').first.get_attribute("data-available")
    S.record("U3", stolen[0] == 201 and err and cell == "false",
        f"another client took {free[0]} ({stolen[0]}); booking-error={err} text={S.text_of(page, 'booking-error')!r}; the cell now reads data-available={cell!r}")
    S.record("U4", form and S.testid(page, "booking-party-size").count() == 1
        and S.testid(page, "booking-party-size").first.is_editable()
        and S.text_of(page, "booking-summary") == kept,
        f"after the 409 the form is still on screen ({form}) with the summary it had: {S.text_of(page, 'booking-summary')!r}")
    S.record("U5", not conf, f"no confirmation after the refused attempt: {not conf}")
    S.record("U11", err and not S.visible(page, "booking-uncertain"),
        "the 409 case shows booking-error, not booking-uncertain")


def pair_refused(page):
    """U15, Z36 — a combination cell that is gone by the time the form is submitted."""
    S.sign_in(page)
    S.search(page, party=6)
    pairs = [k for k, v in S.cell_map(page).items() if v == "true" and "+" in k]
    if not pairs:
        S.record("U15", False, "no combination cell was offered")
        S.record("Z36", False, "no combination cell was offered")
        return
    pair = pairs[len(pairs) // 2]
    a, b = pair[len("slot-"):].split("+")[0], pair[len("slot-"):].split("+")[1].split("-")[0]
    clock = pair.rsplit("-", 1)[1]
    page.click(f'[data-testid="{pair}"]')
    page.wait_for_timeout(300)
    summary = S.text_of(page, "booking-summary")
    token = S.token_of(page)
    stolen = S.api("POST", "/reservations", {"restaurant_id": "r_anker", "table_ids": [a, b],
                   "starts_at_local": f"{S.TODAY}T{clock}", "party_size": 6}, token)
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(900)
    err = S.visible(page, "booking-error")
    unc = S.visible(page, "booking-uncertain")
    S.record("U15", err and not unc and not S.visible(page, "confirmation"),
        f"the combination {pair} was taken by another client ({stolen[0]}); the form answered "
        f"booking-error={err} reading {S.text_of(page, 'booking-error')!r}, uncertain={unc}")
    held = [r for r in S.api("GET", "/_test/export")[1]["state"]["reservations"]
            if set([a, b]).issubset(set(r.get("table_ids", [])))]
    S.record("Z36", len(held) == 1,
        f"the refused combination left {len(held)} booking holding both tables, and the summary named "
        f"them: {summary!r}")


def lost_response(page):
    """U6, U7, U8, U9, U12, U13 — the request reaches the service and the answer never arrives."""
    S.sign_in(page)
    S.search(page, party=2)
    free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    if not free:
        for row in ("U6", "U7", "U8", "U9"):
            S.record(row, False, "no available cell")
        return
    tid, clock = free[0][len("slot-"):].rsplit("-", 1)
    page.click(f'[data-testid="{free[0]}"]')
    page.wait_for_timeout(300)
    seen = []
    state = {"drop": True}

    def drop_once(route):
        if route.request.method != "POST":
            route.continue_()
            return
        seen.append((route.request.headers.get("idempotency-key"), route.request.post_data))
        if state["drop"]:
            state["drop"] = False
            # The service sees the request and commits; the browser never gets the answer.
            try:
                route.fetch()
            finally:
                route.abort()
        else:
            route.continue_()

    page.route("**/reservations", drop_once)
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(1200)
    uncertain = page.locator('[data-testid="booking-uncertain"]')
    text = S.text_of(page, "booking-uncertain")
    ref = booking_for(page, tid, f"{S.TODAY}T{clock}")
    S.record("U6", uncertain.count() > 0 and len(text) > 0,
        f"after the lost answer booking-uncertain read {text!r}")
    S.record("U7", not S.visible(page, "booking-error") and not S.visible(page, "confirmation"),
        f"no booking-error ({not S.visible(page, 'booking-error')}) and no confirmation "
        f"({not S.visible(page, 'confirmation')})")
    count_before = len(S.api("GET", "/_test/export")[1]["state"]["reservations"])
    page.click('[data-testid="booking-submit"]')
    page.wait_for_timeout(1200)
    count_after = len(S.api("GET", "/_test/export")[1]["state"]["reservations"])
    keys = [k for k, _ in seen]
    bodies = [b for _, b in seen]
    S.record("U8", len(seen) == 2 and keys[0] == keys[1] and bodies[0] == bodies[1],
        f"the retry carried key {keys} and identical bodies {bodies[0] == bodies[1]}")
    shown = S.text_of(page, "confirmation-reference")
    S.record("U9", shown == ref and not S.visible(page, "booking-uncertain")
        and not S.visible(page, "booking-error") and count_after == count_before,
        f"the retry showed {shown!r} against the reference the service had already issued {ref!r}, "
        f"uncertainty and error gone, reservations {count_before} -> {count_after}")
    S.record("U13", shown == ref and count_after == count_before,
        f"the confirmation came from the service, not from anything cached: reservations {count_before} -> {count_after}")


def out_of_order(page):
    """U1, U2 — a slow first search must not overwrite a fast second one."""
    S.sign_in(page)
    page.goto(f"{BASE}/", wait_until="networkidle")
    slow = {"first": True}

    def slow_first(route):
        if slow["first"] and "/availability" in route.request.url:
            slow["first"] = False
            response = route.fetch()
            time.sleep(2.5)
            route.fulfill(response=response)
        else:
            route.continue_()

    page.route("**/availability*", slow_first)
    page.fill('[data-testid="date-input"]', S.TODAY)
    S.testid(page, "party-size-input").first.fill("2")
    page.click('[data-testid="search-button"]')
    time.sleep(0.3)
    # A five-cover search can only be served by the six-seat booth, so the two answers
    # describe different tables and a stale overwrite is visible.
    S.testid(page, "party-size-input").first.fill("5")
    page.click('[data-testid="search-button"]')
    page.wait_for_timeout(2000)
    mid = S.cell_map(page)
    page.wait_for_timeout(3000)
    cells = S.cell_map(page)
    # A cell is true exactly when the service reported that table free for the party size
    # searched, so a stale two-cover answer flips the small tables back to true.
    open_now = sorted(c for c, v in cells.items() if v == "true")
    S.record("U1", bool(cells) and mid == cells,
        f"a two-cover search answered 2.5s late, a five-cover search answered first; after both the grid "
        f"marks {len(open_now)} cells available: {open_now[:4]}")
    S.record("U2", cells == mid and all(
        c.startswith(("slot-t_4-", "slot-t_1+t_2-")) for c in open_now),
        f"the late two-cover answer did not mark the small tables available again: "
        f"{[c for c in open_now if not c.startswith(('slot-t_4-', 'slot-t_1+t_2-'))][:4]}")


def run(pw):
    browser = pw.chromium.launch()
    S.api("POST", "/_test/reset", S.fixture())
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    page = ctx.new_page()
    out_of_order(page)
    S.api("POST", "/_test/reset", S.fixture())
    page = ctx.new_page()
    taken_by_another_client(page)
    S.api("POST", "/_test/reset", S.fixture())
    page = ctx.new_page()
    pair_refused(page)
    S.api("POST", "/_test/reset", S.fixture())
    page = ctx.new_page()
    lost_response(page)
    ctx.close()
    browser.close()


if __name__ == "__main__":
    with sync_playwright() as pw:
        run(pw)
    failed = [r for r in S.RESULTS if not r[1]]
    print(f"--- recovery rows decided {len(S.RESULTS)}, failures {len(failed)}")
    raise SystemExit(1 if failed else 0)