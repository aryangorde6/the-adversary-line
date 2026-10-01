/* Tablekeeper — the shell every screen shares: session, navigation, the API
   client, and the words. Loaded by all four routes. No dependencies, no network
   beyond this same origin. */
(function () {
  'use strict';

  var STORE_KEY = 'tablekeeper.session.v1';

  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  /* ------------------------------ session ------------------------------ */

  function readSession() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return { token: null, name: null, email: null };
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.token !== 'string' || parsed.token === '') {
        return { token: null, name: null, email: null };
      }
      return { token: parsed.token, name: parsed.name || null, email: parsed.email || null };
    } catch (err) {
      return { token: null, name: null, email: null };
    }
  }

  function writeSession(session) {
    try {
      if (!session || !session.token) window.localStorage.removeItem(STORE_KEY);
      else window.localStorage.setItem(STORE_KEY, JSON.stringify(session));
    } catch (err) {
      /* a browser that refuses storage still works for this page view */
    }
  }

  var session = readSession();

  function signedIn() {
    return Boolean(session.token);
  }

  function displayName() {
    if (session.name) return session.name;
    if (session.email) return session.email.split('@')[0];
    return 'Signed in';
  }

  function signIn(token, name, email) {
    session = { token: token, name: name || null, email: email || null };
    writeSession(session);
    renderSession();
  }

  function signOut() {
    session = { token: null, name: null, email: null };
    writeSession(session);
    renderSession();
  }

  /* ------------------------- words and numbers ------------------------- */

  /* "2026-09-24T19:00" -> "Thursday 24 September 2026 at 19:00".
     The weekday comes from the calendar date itself, never from the browser's
     clock, so it is right whatever time zone the diner happens to be in. */
  function parseLocal(value) {
    if (typeof value !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
    if (!m) return null;
    var year = Number(m[1]);
    var month = Number(m[2]);
    var day = Number(m[3]);
    var hour = m[4] === undefined ? null : Number(m[4]);
    var minute = m[5] === undefined ? null : Number(m[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return {
      year: year,
      month: month,
      day: day,
      hour: hour,
      minute: minute,
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      time: m[4] === undefined ? null : m[4] + ':' + m[5]
    };
  }

  function longDate(value) {
    var p = typeof value === 'string' ? parseLocal(value) : value;
    if (!p) return '';
    return WEEKDAYS[p.weekday] + ' ' + p.day + ' ' + MONTHS[p.month - 1] + ' ' + p.year;
  }

  function clockTime(value) {
    var p = typeof value === 'string' ? parseLocal(value) : value;
    if (!p || p.time === null) return '';
    return p.time;
  }

  function longDateTime(value) {
    var p = typeof value === 'string' ? parseLocal(value) : value;
    if (!p) return '';
    if (p.time === null) return longDate(p);
    return longDate(p) + ' at ' + p.time;
  }

  function todayInZone(timeZone) {
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(new Date());
      var got = {};
      parts.forEach(function (p) { got[p.type] = p.value; });
      if (got.year && got.month && got.day) return got.year + '-' + got.month + '-' + got.day;
    } catch (err) {
      /* fall through to the browser's own calendar date */
    }
    var now = new Date();
    var mm = String(now.getMonth() + 1);
    var dd = String(now.getDate());
    return now.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }

  /* "Table 2" for one, "Tables 1 and 2" for a pair. Never the ids. */
  function tablePhrase(labels) {
    var list = (labels || []).filter(function (label) {
      return typeof label === 'string' && label !== '';
    });
    if (list.length === 0) return 'a table';
    if (list.length === 1) return 'Table ' + list[0];
    if (list.length === 2) return 'Tables ' + list[0] + ' and ' + list[1];
    return 'Tables ' + list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  function partyPhrase(partySize) {
    var n = Number(partySize);
    if (!Number.isFinite(n) || n < 1) return '';
    return n === 1 ? 'a party of 1' : 'a party of ' + n;
  }

  /* ----------------------------- refusals ----------------------------- */
  /* Every refusal the product can show, in words a diner can act on. The code
     from the service picks the sentence; the diner never sees a code. */

  var REFUSALS = {
    unauthenticated: {
      title: 'Please sign in again',
      text: 'Your session has ended. Sign in and try once more.'
    },
    forbidden: { title: 'Not available to you', text: 'This booking belongs to another account.' },
    not_found: {
      title: 'We could not find that booking',
      text: 'Check the reference and try again. It is the six to twelve characters from your confirmation.'
    },
    email_taken: {
      title: 'That email already has an account',
      text: 'Sign in with it instead, or use a different address.'
    },
    table_unavailable: {
      title: 'That seating was just taken',
      text: 'Someone booked it while you were deciding. Pick another time or table — your party size and date are still here.'
    },
    cutoff_passed: {
      title: 'Too late to change this booking',
      text: 'This restaurant asks for changes to be made further ahead. Book a new table instead.'
    },
    reservation_cancelled: {
      title: 'That booking is already cancelled',
      text: 'You can book a new table whenever you like.'
    },
    idempotency_key_reuse: {
      title: 'We could not finish that booking',
      text: 'Start again from the times shown, then confirm the table you want.'
    },
    party_exceeds_capacity: {
      title: 'That table is too small',
      text: 'Lower the number of guests, or choose a larger table or a pair of tables.'
    },
    combination_not_allowed: {
      title: 'Those two tables cannot be joined',
      text: 'This restaurant only pairs the tables it has marked as combinable. Pick a single table or another pair.'
    },
    not_on_slot_grid: {
      title: 'That is not a seating time here',
      text: 'Choose one of the times listed in the grid.'
    },
    outside_opening_hours: {
      title: 'The restaurant is closed then',
      text: 'Choose a time inside its opening hours from the grid.'
    },
    invalid_local_time: {
      title: 'That time does not exist on that day',
      text: 'The clocks change that night. Pick another time from the grid.'
    },
    validation_failed: {
      title: 'Please check what you entered',
      text: 'One of the details is not right. Have another look and try again.'
    },
    missing_idempotency_key: {
      title: 'We could not finish that booking',
      text: 'Please try booking again.'
    },
    malformed_request: {
      title: 'We could not read that',
      text: 'Please try again.'
    }
  };

  /* A screen may hand in its own wording for the codes it can meet, so a diner
     is never told about a field they cannot see. */
  function refusal(code, overrides) {
    if (overrides && overrides[code]) return overrides[code];
    if (REFUSALS[code]) return REFUSALS[code];
    return {
      title: 'We could not do that',
      text: 'Please try again.'
    };
  }

  /* ------------------------------ the DOM ----------------------------- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (name) {
        var value = attrs[name];
        if (value === null || value === undefined || value === false) return;
        if (name === 'text') node.textContent = String(value);
        else if (name === 'html') node.innerHTML = value;
        else if (name === 'class') node.className = value;
        else if (value === true) node.setAttribute(name, '');
        else node.setAttribute(name, String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function testid(id) {
    return document.querySelector('[data-testid="' + id + '"]');
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* One message shape for every piece of feedback: a coloured, bordered note
     with a badge, so refused, uncertain, settled and plain information all read
     differently at a glance. */
  function message(tone, title, text) {
    var marks = { bad: '!', good: '✓', warn: '?', note: 'i' };
    return el('div', { class: 'msg msg--' + tone, role: tone === 'bad' ? 'alert' : 'status' }, [
      el('span', { class: 'msg__icon', 'aria-hidden': 'true', text: marks[tone] || 'i' }),
      el('span', { class: 'msg__body' }, [
        el('strong', { class: 'msg__title', text: title }),
        el('span', { class: 'msg__text', text: text })
      ])
    ]);
  }

  /* ------------------------------ the API ----------------------------- */
  /* Every answer comes back as a plain result. A request whose answer never
     arrives is reported as lost, which is different from a refusal and is
     treated differently by every screen. */

  function newKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'tk-' + window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    var hex = '';
    for (var j = 0; j < bytes.length; j += 1) hex += bytes[j].toString(16).padStart(2, '0');
    return 'tk-' + hex;
  }

  function announceSession() {
    document.dispatchEvent(new CustomEvent('tk:session', { detail: { signedIn: signedIn() } }));
  }

  function send(method, path, body, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    var init = { method: method, headers: headers, cache: 'no-store' };
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
    if (opts.token !== null) {
      if (opts.token || session.token) headers.Authorization = 'Bearer ' + (opts.token || session.token);
    }

    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = null;
          }
        }
        if (response.ok) {
          if (data === null) return { ok: false, lost: true, status: response.status, data: null };
          return { ok: true, lost: false, status: response.status, data: data };
        }
        var envelope = data && data.error ? data.error : {};
        var result = {
          ok: false,
          lost: false,
          status: response.status,
          data: data,
          code: envelope.code || '',
          serverMessage: typeof envelope.message === 'string' ? envelope.message : ''
        };
        if (response.status === 401 && !opts.token && session.token) {
          /* the service forgot us — a reset or an import. Stop pretending. */
          signOut();
          announceSession();
        }
        return result;
      });
    }, function () {
      /* the answer never arrived. The booking may or may not have been made. */
      return { ok: false, lost: true, status: 0, data: null };
    });
  }

  function get(path, options) {
    return send('GET', path, null, options);
  }

  /* --------------------------- the shell ------------------------------ */

  function renderSession() {
    var slot = testid('session-slot');
    if (!slot) return;
    clear(slot);
    if (signedIn()) {
      slot.appendChild(el('p', { class: 'session__greeting' }, [
        document.createTextNode('Signed in as '),
        el('span', { class: 'session__name', 'data-testid': 'current-user', text: displayName() })
      ]));
      var out = el('button', {
        type: 'button',
        class: 'btn btn--quiet',
        'data-testid': 'logout-button'
      }, [el('span', { class: 'btn__label', text: 'Sign out' })]);
      out.addEventListener('click', function () {
        signOut();
        announceSession();
      });
      slot.appendChild(out);
    } else {
      slot.appendChild(el('p', { class: 'session__greeting', text: 'Not signed in' }));
      slot.appendChild(el('span', { class: 'session__links' }, [
        el('a', { href: '/login', text: 'Sign in' }),
        el('a', { href: '/signup', text: 'Create an account' })
      ]));
    }
  }

  function markCurrentNav() {
    var here = window.location.pathname.replace(/\/+$/, '') || '/';
    var links = document.querySelectorAll('.mainnav a');
    Array.prototype.forEach.call(links, function (link) {
      var target = (link.getAttribute('href') || '').replace(/\/+$/, '') || '/';
      if (target === here) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function onSessionChange(handler) {
    document.addEventListener('tk:session', handler);
  }

  /* ------------------------------ boot -------------------------------- */

  function start() {
    renderSession();
    markCurrentNav();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.TK = {
    session: session,
    signedIn: signedIn,
    displayName: displayName,
    signIn: signIn,
    signOut: signOut,
    onSessionChange: onSessionChange,
    api: { send: send, get: get, newKey: newKey },
    text: {
      parseLocal: parseLocal,
      longDate: longDate,
      longDateTime: longDateTime,
      clockTime: clockTime,
      todayInZone: todayInZone,
      tablePhrase: tablePhrase,
      partyPhrase: partyPhrase,
      refusal: refusal
    },
    dom: { el: el, testid: testid, clear: clear, message: message }
  };
}());
