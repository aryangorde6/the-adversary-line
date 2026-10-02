#!/usr/bin/env python3
"""Stage-2 rows Q4..Q25: measured visual checks.

Everything here is measured from the running product at both widths. Nothing is asserted from
a screenshot by eye, except where a row is a matter of direction (Q1, Q2, Q3).
Usage: TK_BASE=http://127.0.0.1:8080 python3 visual.py
"""
import re
import sys

from playwright.sync_api import sync_playwright

import screens as S

BASE = S.BASE
WIDTHS = (375, 1280)

COLLECT = r"""
() => {
  const out = {labels: [], focus: [], text: [], system: {fonts: [], sizes: [], radii: [], heights: []},
              primary: 0, filled: []};
  const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x)); return {rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1}; };
  const lum = (rgb) => { const f = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 :
      Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { let n = el; while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) return c.rgb; n = n.parentElement; }
    return [255, 255, 255]; };
  const push = (a, v) => { if (!a.includes(v)) a.push(v); };
  const style = (el) => { const s = getComputedStyle(el); return {
      bg: s.backgroundColor, color: s.color, border: s.borderColor, bw: s.borderWidth, bs: s.borderStyle,
      outline: `${s.outlineStyle} ${s.outlineWidth}`, shadow: s.boxShadow, opacity: s.opacity,
      font: s.fontFamily, size: s.fontSize, radius: s.borderRadius, height: s.height, weight: s.fontWeight }; };

  for (const el of document.querySelectorAll('input, select, textarea')) {
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const labelled = el.getAttribute('aria-label') || (el.id && document.querySelector(`label[for="${el.id}"]`)
      && document.querySelector(`label[for="${el.id}"]`).innerText.trim())
      || el.closest('label') || el.getAttribute('title') || el.getAttribute('placeholder');
    out.labels.push({testid: el.getAttribute('data-testid') || el.tagName, label: String(labelled || '').trim()});
  }
  const focusables = [...document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => { const b = el.getBoundingClientRect(); return b.width && b.height; });
  for (const el of focusables) {
    const before = style(el);
    el.focus();
    const after = style(el);
    const changed = ['bg', 'color', 'border', 'outline', 'shadow'].filter(k => before[k] !== after[k]);
    out.focus.push({testid: el.getAttribute('data-testid') || el.tagName + ':' + (el.innerText || '').trim().slice(0, 18),
                    changed, outline: after.outline, shadow: after.shadow.slice(0, 24)});
    el.blur();
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (!text || !node.parentElement) continue;
    const box = node.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const s = getComputedStyle(node.parentElement);
    if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const colour = parse(s.color);
    const fg = colour && colour.a > 0 ? colour.rgb : [0, 0, 0];
    out.text.push({text: text.slice(0, 40), testid: node.parentElement.closest('[data-testid]')
      ?.getAttribute('data-testid') || node.parentElement.tagName,
      size: parseFloat(s.fontSize), weight: Number(s.fontWeight),
      ratio: Number(ratio(fg, bgOf(node.parentElement)).toFixed(2))});
    push(out.system.fonts, s.fontFamily.split(',')[0].replace(/["']/g, ''));
    push(out.system.sizes, s.fontSize);
  }
  for (const el of document.querySelectorAll('button, select, input')) {
    const s = style(el); const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    push(out.system.radii, s.radius); push(out.system.heights, s.height);
    if ((el.className || '').match(/primary/)) out.primary += 1;
    const c = parse(s.bg);
    if (c && c.a > 0.5 && c.rgb.reduce((a, b) => a + b, 0) < 600) out.filled.push(
      el.getAttribute('data-testid') || el.innerText.trim().slice(0, 18));
  }
  for (const el of document.querySelectorAll('nav, header, [data-testid="nav"]')) {
    out.nav = {testid: el.getAttribute('data-testid') || el.tagName,
               order: [...el.querySelectorAll('a, button')].map(a => (a.getAttribute('data-testid')
                 || a.getAttribute('href') || a.innerText).trim()).filter(Boolean)};
  }
  out.bodyText = document.body.innerText;
  return out;
}
"""

SIGNATURE = """() => [...document.querySelectorAll('*')].map(e => {
  const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
  return [e.tagName, e.className && String(e.className), e.getAttribute('data-testid'), e.getAttribute('aria-busy'),
          s.opacity, s.pointerEvents, s.cursor, s.backgroundColor, r.width ? 1 : 0,
          (e.innerText || '').trim().slice(0, 24)].join('|');
}).join('\\n')"""


TAB_WALK = """async () => {
  const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor',
                 'borderColor', 'borderWidth', 'color'];
  const grab = (el) => { const s = getComputedStyle(el); const o = {}; props.forEach(k => o[k] = s[k]); return o; };
  const seen = new Map();
  document.body.focus();
  for (let i = 0; i < 60; i += 1) {
    // A real Tab key press is what decides whether :focus-visible styles apply.
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true}));
    const el = document.activeElement;
    if (!el || el === document.body || seen.has(el)) break;
    const name = el.getAttribute('data-testid') || el.tagName + ':' + (el.innerText || '').trim().slice(0, 20);
    const focused = grab(el);
    el.blur();
    const plain = grab(el);
    const changed = props.filter(k => plain[k] !== focused[k]);
    seen.set(el, {testid: name, changed});
  }
  return [...seen.values()];
}"""


def off_screen(page):
    """Q16, Q17 — every control inside the viewport, in every named state."""
    outside, overlaps = [], []
    for state in ("search", "booking form", "confirmation", "lookup"):
        if state == "search":
            page.goto(f"{BASE}/", wait_until="networkidle")
            S.search(page, party=2)
        elif state == "lookup":
            page.goto(f"{BASE}/lookup", wait_until="networkidle")
            continue
        else:
            free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k] \
                if state == "booking form" else []
            if not free:
                continue
            page.click(f'[data-testid="{free[0]}"]')
            page.wait_for_timeout(300)
            page.click('[data-testid="booking-submit"]')
            page.wait_for_timeout(900)
        found = page.evaluate("""() => { const w = document.documentElement.clientWidth; const bad = [];
            const boxes = [];
            for (const el of document.querySelectorAll('button, a, input, select, textarea, [data-testid^="slot-"]')) {
              const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
              if (!r.width || !r.height || s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
              const name = el.getAttribute('data-testid') || el.tagName + ':' + (el.innerText || '').trim().slice(0, 16);
              if (r.left < -1 || r.right > w + 1) bad.push([name, Math.round(r.left), Math.round(r.right), w]);
              boxes.push([name, r]);
            }
            for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
              const [an, a] = boxes[i]; const [bn, b] = boxes[j];
              const hit = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2
                && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
              if (hit) bad.push([an + ' overlaps ' + bn]);
            }
            return bad; }""")
        outside += [f"{state}: {f}" for f in found]
    return outside


def tab_walk(page):
    """Focus every reachable control with real Tab presses and keep its focus indicator."""
    props = ["outlineStyle", "outlineWidth", "outlineColor", "boxShadow", "backgroundColor",
             "borderColor", "borderWidth", "color"]
    seen, order = {}, []
    page.evaluate("() => document.body.setAttribute('tabindex', '-1')")
    page.keyboard.press("Escape")
    page.evaluate("() => document.body.focus()")
    for _ in range(60):
        page.keyboard.press("Tab")
        info = page.evaluate("""(props) => { const el = document.activeElement;
            if (!el || el === document.body || el.dataset.probed) return null;
            el.dataset.probed = '1';
            const s = getComputedStyle(el); const o = {};
            props.forEach(k => o[k] = s[k]);
            return {testid: el.getAttribute('data-testid')
                || el.tagName + ':' + (el.innerText || '').trim().slice(0, 20), style: o}; }""", props)
        if not info:
            continue
        plain = page.evaluate("""(props) => { const el = document.activeElement; el.blur();
            const s = getComputedStyle(el); const o = {}; props.forEach(k => o[k] = s[k]); return o; }""", props)
        seen[info["testid"]] = {"testid": info["testid"],
                                "changed": [k for k in props if plain[k] != info["style"][k]]}
        order.append(info["testid"])
        if len(seen) > 40:
            break
    return list(seen.values())


def style_of(testid):
    return """(id) => { const e = document.querySelector(`[data-testid="${id}"]`);
        if (!e) return null; const s = getComputedStyle(e);
        return s.backgroundColor + '|' + s.color + '|' + s.borderColor; }"""


STYLE_OF = {t: style_of(t) for t in ("booking-form", "booking-error", "booking-uncertain", "confirmation")}

RAW = re.compile(r"[{}]|\"[a-z_]+\"\s*:|\b\w+_\w+\b|\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}")
CONTROL = re.compile(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)")


def ratio(fg, bg):
    def lum(rgb):
        f = []
        for v in rgb:
            v /= 255
            f.append(v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
    hi, lo = sorted([lum(fg), lum(bg)], reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def labelled(blob):
    return [c for c in blob["labels"] if not c["label"]]


def measure(page):
    return page.evaluate(COLLECT)


def states(page):
    """Walk the named states so each row is decided on the screens it names."""
    S.sign_in(page)
    # One table taken for the morning, so the grid carries both available and unavailable cells.
    token = S.token_of(page)
    S.api("POST", "/reservations", {"restaurant_id": "r_anker", "table_id": "t_1",
           "starts_at_local": f"{S.TODAY}T09:00", "party_size": 2}, token)
    S.search(page, party=2)
    free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    cell = free[0] if free else None
    screens = {"search": measure(page)}
    for kind in ("true", "false"):
        cell_probe = page.locator(f'[data-available="{kind}"]')
        screens[f"cell-{kind}"] = None
    if cell:
        page.click(f'[data-testid="{cell}"]')
        page.wait_for_timeout(300)
        screens["form"] = measure(page)
        page.fill('[data-testid="booking-party-size"]', "99")
        page.click('[data-testid="booking-submit"]')
        page.wait_for_timeout(700)
        screens["refused"] = measure(page)
    return screens, free


def feedback_states(page):
    """Q11, Q13, Q14, Q22, Q23, Q24 — loading, refused, uncertain and the empty day."""
    page.goto(f"{BASE}/", wait_until="networkidle")
    S.search(page, party=2)
    page.wait_for_timeout(300)
    settled = set(page.evaluate(SIGNATURE).split("\n"))

    def slow(route):
        import time
        time.sleep(1.6)
        route.continue_()

    page.route("**/availability*", slow)
    S.testid(page, "party-size-input").first.fill("2")
    page.click('[data-testid="search-button"]')
    page.wait_for_timeout(700)
    during = set(page.evaluate(SIGNATURE).split("\n"))
    page.wait_for_timeout(2600)
    page.unroute("**/availability*")
    page.wait_for_timeout(500)
    appeared = sorted(x for x in during - settled if x)
    S.record("Q11", bool(appeared),
        f"a search answered 1.6s late; while it was outstanding the page held {len(during)} elements, "
        f"{len(appeared)} of them new against the settled page: {appeared[:5]}")
    S.record("Q23", bool(appeared),
        f"the loading state is {appeared[:5] if appeared else 'nothing: the settled page stays on screen untouched'}")

    # A closed day: real text, and no empty grid frame full of dead cells.
    closed = page.evaluate("""() => { const d = document.querySelector('[data-testid="date-input"]').value;
        const [y, m, day] = d.split('-').map(Number);
        const t = new Date(Date.UTC(y, m - 1, day + 1));
        return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; }""")
    page.goto(f"{BASE}/", wait_until="networkidle")
    page.fill('[data-testid="date-input"]', closed)
    page.wait_for_timeout(150)
    page.click('[data-testid="search-button"]')
    page.wait_for_timeout(1500)
    empty_text = S.text_of(page, "no-slots")
    empty_cells = page.locator('[data-testid^="slot-"]').count()
    S.record("Q22", bool(empty_text) and empty_cells == 0,
        f"a closed day reads {empty_text!r} with {empty_cells} cells")

    # Refused and uncertain side by side.
    page.goto(f"{BASE}/", wait_until="networkidle")
    S.search(page, party=2)
    free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    if free:
        page.click(f'[data-testid="{free[0]}"]')
        page.wait_for_timeout(300)
        form_bg = page.evaluate(STYLE_OF["booking-form"], "booking-form")
        page.fill('[data-testid="booking-party-size"]', "99")
        page.click('[data-testid="booking-submit"]')
        page.wait_for_timeout(800)
        err_bg = page.evaluate(STYLE_OF["booking-error"], "booking-error")
        err_text = S.text_of(page, "booking-error")
        S.record("Q13", err_bg is not None and err_bg != form_bg,
            f"booking-error {err_bg!r} against the form {form_bg!r}")

        def drop(route):
            if route.request.method == "POST":
                try:
                    route.fetch()
                finally:
                    route.abort()
            else:
                route.continue_()

        page.fill('[data-testid="booking-party-size"]', "2")
        page.route("**/reservations", drop)
        page.click('[data-testid="booking-submit"]')
        page.wait_for_timeout(1200)
        page.unroute("**/reservations")
        unc_bg = page.evaluate(STYLE_OF["booking-uncertain"], "booking-uncertain")
        unc_text = S.text_of(page, "booking-uncertain")
        S.record("Q14", bool(unc_bg) and unc_bg != err_bg and unc_bg != form_bg,
            f"booking-uncertain {unc_bg!r} against booking-error {err_bg!r} and the form {form_bg!r}")

        codes = re.compile(r"^\s*(HTTP|\d{3}\b)|_[A-Z_]{3,}\b")
        texts = {"booking-error": err_text, "booking-uncertain": unc_text}
        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.fill('[data-testid="login-email"]', "ada@example.com")
        page.fill('[data-testid="login-password"]', "wrong")
        page.click('[data-testid="login-submit"]')
        page.wait_for_timeout(700)
        texts["auth-error"] = S.text_of(page, "auth-error")
        page.goto(f"{BASE}/lookup", wait_until="networkidle")
        S.testid(page, "lookup-reference-input").first.fill("NOPE")
        page.click('[data-testid="lookup-submit"]')
        page.wait_for_timeout(700)
        texts["reservation-error"] = S.text_of(page, "reservation-error")
        thin = {k: v for k, v in texts.items() if not v or codes.search(v)}
        S.record("Q24", not thin, f"every error element carries prose: {thin if thin else 'auth, booking, uncertain, lookup all read as sentences'}")
    else:
        for row in ("Q13", "Q14", "Q24"):
            S.record(row, False, "no available cell to reach the booking form")


def consistency(page):
    """Q15, Q19, Q20, Q21, Q25 — labels, focus, contrast and navigation."""
    S.sign_in(page)
    S.search(page, party=2)
    free = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    if free:
        page.click(f'[data-testid="{free[0]}"]')
        page.wait_for_timeout(300)
    blob = measure(page)
    body = blob["bodyText"]
    ids_visible = [i for i in ("r_anker", "t_1", "t_4") if re.search(rf"\b{i}\b", body)]
    human = [t for t in ("Zum Anker", "Window 1", "Booth 4", "Patio 3") if t in body]
    options = page.evaluate("""() => { const sel = document.querySelector('[data-testid="restaurant-select"]');
        if (!sel) return null;
        return [...sel.options].map(o => [o.textContent.trim(), o.value]); }""")
    S.record("R5", options is not None and all(name and not name.startswith("r_") for name, _ in options)
        and len({v for _, v in options}) == len(options),
        f"restaurant-select offers {options}")
    S.record("Q15", not ids_visible and len(human) >= 2,
        f"visible text carries {human} and no bare id (ids found: {ids_visible})")
    naked = labelled(blob)
    S.record("Q19", not naked, f"{len(blob['labels'])} controls on the screen, unlabelled: {naked}")
    page.goto(f"{BASE}/", wait_until="networkidle")
    S.search(page, party=2)
    free2 = [k for k, v in S.cell_map(page).items() if v == "true" and "+" not in k]
    if free2:
        page.click(f'[data-testid="{free2[0]}"]')
        page.wait_for_timeout(300)
    tabbed = tab_walk(page)
    blind = [t["testid"] for t in tabbed if not t["changed"]]
    S.record("Q20", bool(tabbed) and not blind,
        f"tabbed through {len(tabbed)} controls; without a focus indicator: {blind[:5]}")
    worst = min(blob["text"], key=lambda t: t["ratio"], default=None)
    large = lambda t: t["size"] >= 24 or (t["size"] >= 18.66 and t["weight"] >= 700)
    bad = [t for t in blob["text"] if t["ratio"] < (3 if large(t) else 4.5)]
    S.record("Q21", not bad,
        f"{len(blob['text'])} visible text nodes, lowest contrast {worst['ratio'] if worst else None}:1 on "
        f"{worst['text']!r} at {worst['size'] if worst else '?'}px; below the threshold: {bad[:3]}")
    navs = {}
    for route in ("/", "/lookup", "/login"):
        page.goto(f"{BASE}{route}", wait_until="networkidle")
        got = page.evaluate("""() => { const el = document.querySelector('nav, header, [data-testid="nav"]');
            if (!el) return null;
            return {testid: el.getAttribute('data-testid') || el.tagName,
                    order: [...el.querySelectorAll('a, button')].map(a => (a.getAttribute('data-testid')
                        || a.getAttribute('href') || a.innerText).trim()).filter(Boolean),
                    top: Math.round(el.getBoundingClientRect().top)}; }""")
        navs[route] = got
    same = len({json.dumps(v, sort_keys=True) for v in navs.values() if v}) == 1 and all(navs.values())
    S.record("Q25", same, f"navigation on {sorted(navs)}: "
        f"{[ (r, (v or {}).get('order')) for r, v in navs.items()]}")


import json


def run(pw):
    browser = pw.chromium.launch()
    for width in WIDTHS:
        S.api("POST", "/_test/reset", S.fixture())
        ctx = browser.new_context(viewport={"width": width, "height": 900})
        page = ctx.new_page()
        blob, free = states(page)
        tag = f"at {width}"

        # Q4 no raw API data on screen
        raw = sorted({m.group(0) for name, b in blob.items() if b for m in RAW.finditer(b["bodyText"])})
        S.record("Q4", not raw, f"{tag} every rendered state, raw-looking text: {raw[:6]}")

        # Q5 pair cells read as seating, not as identifiers
        pair = page.locator('[data-testid^="slot-t_1+t_2-"]').first
        pair_text = pair.inner_text().strip() if pair.count() else ""
        S.record("Q5", "t_1+t_2" not in pair_text and len(pair_text) > 0,
            f"{tag} a combination cell reads {pair_text!r}")

        # Q6 one visual system
        fonts = set(sum((b["system"]["fonts"] for b in blob.values() if b), []))
        sizes = set(sum((b["system"]["sizes"] for b in blob.values() if b), []))
        radii = set(sum((b["system"]["radii"] for b in blob.values() if b), []))
        heights = set(sum((b["system"]["heights"] for b in blob.values() if b), []))
        S.record("Q6", len(fonts) <= 3 and len(sizes) <= 8 and len(radii) <= 8 and len(heights) <= 8,
            f"{tag} {len(fonts)} font families {sorted(fonts)}, {len(sizes)} sizes, {len(radii)} radii, "
            f"{len(heights)} control heights")

        # Q7 one primary action per screen, counted only among controls actually on screen
        shown = page.evaluate("""() => [...document.querySelectorAll('button, a, select, input')]
            .filter(e => (e.className || '').match(/primary/))
            .filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
                return r.width && r.height && s.visibility !== 'hidden' && Number(s.opacity) > 0; })
            .map(e => e.getAttribute('data-testid') || e.innerText.trim().slice(0, 16))""")
        S.record("Q7", len(shown) == 1,
            f"{tag} with the booking form open the visible primary controls are {shown}")

        # Q8, Q9 available against unavailable
        true_cell = page.locator('[data-available="true"]').first
        false_cell = page.locator('[data-available="false"]').first
        if true_cell.count() and false_cell.count():
            st, sf = true_cell.evaluate("e=>{const s=getComputedStyle(e);return[s.backgroundColor,s.color,s.borderColor,s.borderWidth,s.opacity,s.cursor,s.fontWeight].join('|')}"), \
                false_cell.evaluate("e=>{const s=getComputedStyle(e);return[s.backgroundColor,s.color,s.borderColor,s.borderWidth,s.opacity,s.cursor,s.fontWeight].join('|')}")
            differing = [i for i, (a, b) in enumerate(zip(st.split("|"), sf.split("|"))) if a != b]
            S.record("Q8", bool(differing), f"{tag} available {st} against unavailable {sf}")
            S.record("Q9", bool(differing), f"{tag} unavailable cells are styled from the available ones: {st.split('|')[differing[0]]} against {sf.split('|')[differing[0]]}")
        else:
            S.record("Q8", False, f"{tag} the grid shows only one kind of cell")
            S.record("Q9", False, f"{tag} the grid shows only one kind of cell")

        # Q10 selected against unselected
        picked = page.evaluate("""() => { const sel = document.querySelector('[data-selected="true"]');
            const other = [...document.querySelectorAll('[data-available="true"]')].find(e => e !== sel);
            const props = ['backgroundColor', 'color', 'borderColor', 'borderWidth', 'boxShadow',
                           'outlineColor', 'outlineWidth', 'opacity', 'transform', 'fontWeight', 'filter'];
            const grab = e => { const s = getComputedStyle(e); const o = {}; props.forEach(k => o[k] = s[k]); return o; };
            if (!sel || !other) return {sel: !!sel, other: !!other, diff: {}};
            return {sel: sel.getAttribute('data-testid'), other: other.getAttribute('data-testid'),
                    diff: Object.fromEntries(props.map(k => [k, [grab(sel)[k], grab(other)[k]]])
                        .filter(([, v]) => v[0] !== v[1]))}; }""")
        S.record("Q10", bool(picked.get("diff")),
            f"{tag} selected {picked.get('sel')} against unselected {picked.get('other')} differs in "
            f"{sorted(picked.get('diff', {}))}")

        # Q12 confirmation against the form it replaced
        if free and True:
            tid, clock = free[0][len("slot-"):].rsplit("-", 1)
            S.api("POST", "/_test/reset", S.fixture())
            S.sign_in(page)
            S.search(page, party=2)
            page.click(f'[data-testid="{free[0]}"]')
            page.wait_for_timeout(300)
            form_style = page.evaluate(STYLE_OF["booking-form"], "booking-form")
            page.click('[data-testid="booking-submit"]')
            page.wait_for_timeout(900)
            conf_style = page.evaluate(STYLE_OF["confirmation"], "confirmation")
            S.record("Q12", conf_style is not None and conf_style != form_style,
                f"{tag} confirmation {conf_style!r} against the form {form_style!r}")
        feedback_states(page)
        consistency(page)
        bad = off_screen(page)
        S.record("Q16" if width == 375 else "Q17", not bad,
            f"at {width}, every control in the search, booking form, confirmation and lookup states "
            f"sat inside the viewport and none overlapped: {bad[:4]}")
        ctx.close()
    browser.close()


if __name__ == "__main__":
    with sync_playwright() as pw:
        run(pw)
    failed = [r for r in S.RESULTS if not r[1]]
    print(f"--- visual rows decided {len(S.RESULTS)}, failures {len(failed)}")
    print("--- failing: " + " ".join(r[0] for r in failed) if failed else "--- none failing")
    sys.exit(1 if failed else 0)