/* Tablekeeper — the search screen: choose a restaurant, a day and a party size,
   read the grid of times, then book one table or one approved pair. */
(function () {
  'use strict';

  var TK = window.TK;
  var el = TK.dom.el;
  var testid = TK.dom.testid;
  var clear = TK.dom.clear;
  var message = TK.dom.message;
  var T = TK.text;

  /* The booking screen knows exactly which details it asked for, so it can say
     which one to fix instead of pointing at "a field". */
  var BOOKING_WORDS = {
    validation_failed: {
      title: 'Check the number of guests',
      text: 'Enter the number of guests as a whole number of at least 1, and keep one of the times shown in the grid.'
    }
  };


  var dom = {
    authHost: document.getElementById('auth-host'),
    form: document.getElementById('search-form'),
    select: testid('restaurant-select'),
    date: testid('date-input'),
    party: testid('party-size-input'),
    searchButton: testid('search-button'),
    searchMessages: document.getElementById('search-messages'),
    gridHost: document.getElementById('grid-host'),
    gridTitle: document.getElementById('grid-title'),
    gridNote: document.getElementById('grid-note'),
    bookingHost: document.getElementById('booking-host'),
    bookingPanel: null,
    bookingSummary: null,
    bookingMessages: null,
    bookingForm: null,
    bookingParty: null,
    bookingCapacity: null,
    bookingSubmit: null,
    bookingClear: null,
    receiptHost: document.getElementById('confirmation-host')
  };

  var state = {
    restaurant: null,
    details: {},
    slots: [],
    date: '',
    partySize: 2,
    rows: [],
    searchSeq: 0,
    searching: false,
    selection: null,
    pending: null,
    receipt: null
  };

  /* ------------------------------ helpers ----------------------------- */

  function showAuthError(text) {
    if (!dom.authHost) return;
    clear(dom.authHost);
    var node = message('bad', 'Please sign in to book', text);
    node.setAttribute('data-testid', 'auth-error');
    node.querySelector('.msg__body').appendChild(el('div', { class: 'actions' }, [
      el('a', { class: 'btn btn--quiet', href: '/login' }, [
        el('span', { class: 'btn__label', text: 'Sign in' })
      ]),
      el('a', { class: 'btn btn--plain', href: '/signup' }, [
        el('span', { class: 'btn__label', text: 'Create an account' })
      ])
    ]));
    dom.authHost.appendChild(node);
    TK.onSessionChange(function () {
      if (TK.signedIn()) clear(dom.authHost);
    });
  }

  function clearAuthError() {
    if (dom.authHost) clear(dom.authHost);
  }

  function tableById(id) {
    if (!state.restaurant || !state.restaurant.tables) return null;
    for (var i = 0; i < state.restaurant.tables.length; i += 1) {
      if (state.restaurant.tables[i].id === id) return state.restaurant.tables[i];
    }
    return null;
  }

  function labelsFor(tableIds) {
    return tableIds.map(function (id) {
      var table = tableById(id);
      return table && table.label ? String(table.label) : '';
    });
  }

  function partyFrom(value) {
    var text = String(value === undefined || value === null ? '' : value).trim();
    if (!/^\d+$/.test(text)) return null;
    var n = Number(text);
    return n >= 1 ? n : null;
  }

  function slotClock(startsAtLocal) {
    return T.clockTime(startsAtLocal);
  }

  /* --------------------------- the restaurants ----------------------- */

  function fillRestaurants(list) {
    var keep = dom.select.value;
    clear(dom.select);
    list.forEach(function (restaurant) {
      dom.select.appendChild(el('option', {
        value: restaurant.id,
        text: restaurant.name
      }));
    });
    if (keep && list.some(function (r) { return r.id === keep; })) dom.select.value = keep;
    if (!dom.select.value && list.length) dom.select.value = list[0].id;
  }

  function loadRestaurants() {
    return TK.api.get('/restaurants').then(function (result) {
      if (result.lost) {
        renderProblem('warn', 'We could not reach Tablekeeper',
          'Nothing was sent and nothing was booked. Check your connection and try again.',
          function () { loadRestaurants(); });
        return false;
      }
      if (!result.ok) {
        renderProblem('bad', 'We could not load the restaurants',
          'The list is unavailable right now. Try again in a moment.',
          function () { loadRestaurants(); });
        return false;
      }
      var list = (result.data && result.data.restaurants) || [];
      if (!list.length) {
        renderNoRestaurants();
        return false;
      }
      fillRestaurants(list);
      return true;
    });
  }

  function renderNoRestaurants() {
    clear(dom.searchMessages);
    clear(dom.gridHost);
    dom.gridTitle.textContent = 'Availability';
    dom.gridNote.textContent = '';
    dom.searchMessages.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'empty__mark', 'aria-hidden': 'true', text: '!' }),
      el('p', { class: 'empty__title', text: 'No restaurants are taking bookings yet' }),
      el('p', { class: 'empty__text', text: 'Once a restaurant is set up it will appear here with its tables and times.' })
    ]));
  }

  function renderProblem(tone, title, text, retry) {
    clear(dom.searchMessages);
    var note = message(tone, title, text);
    if (retry) {
      var again = el('button', {
        type: 'button', class: 'btn btn--quiet', 'data-testid': 'retry-button'
      }, [el('span', { class: 'btn__label', text: 'Try again' })]);
      again.addEventListener('click', retry);
      note.querySelector('.msg__body').appendChild(el('div', { class: 'actions' }, [again]));
    }
    dom.searchMessages.appendChild(note);
  }

  /* ------------------------------ the search -------------------------- */
  /* One sequence number, raised on every submit. A slower earlier search is
     thrown away when its turn comes back, so the screen only ever describes the
     search the diner is waiting for now. */

  /* Restaurant details are cached by id and never assigned to the live screen
     from here: only runSearch, after its own sequence check, decides which
     restaurant the page is describing. That is what stops a slow answer for one
     restaurant from labelling another one's tables. */
  function ensureRestaurant(id) {
    if (state.details[id]) return Promise.resolve(state.details[id]);
    return TK.api.get('/restaurants/' + encodeURIComponent(id)).then(function (result) {
      if (result.lost || !result.ok || !result.data) return null;
      state.details[id] = result.data;
      return result.data;
    });
  }

  function clampDateToToday() {
    if (dom.date.value) return;
    var zone = state.restaurant ? state.restaurant.timezone : null;
    dom.date.value = T.todayInZone(zone);
  }

  function runSearch() {
    var seq = state.searchSeq + 1;
    state.searchSeq = seq;

    var restaurantId = dom.select.value;
    var date = dom.date.value;
    var party = partyFrom(dom.party.value);

    if (!restaurantId) {
      renderProblem('bad', 'Choose a restaurant', 'Pick where you would like to eat and we will show its times.', null);
      return;
    }
    if (!date) {
      dom.date.setAttribute('aria-invalid', 'true');
      renderProblem('bad', 'Choose a date', 'Pick the day you would like to come and we will show its times.', null);
      dom.date.focus();
      return;
    }
    dom.date.removeAttribute('aria-invalid');
    if (party === null) {
      dom.party.setAttribute('aria-invalid', 'true');
      renderProblem('bad', 'Check the number of guests',
        'Enter the number of guests as a whole number of at least 1.', null);
      dom.party.focus();
      return;
    }
    dom.party.removeAttribute('aria-invalid');

    state.searching = true;
    setBusy(dom.searchButton, true, 'Checking', 'Show times');
    renderLoading('Looking for tables');
    clear(dom.searchMessages);

    var path = '/availability?restaurant_id=' + encodeURIComponent(restaurantId)
      + '&date=' + encodeURIComponent(date)
      + '&party_size=' + encodeURIComponent(String(party));

    Promise.all([ensureRestaurant(restaurantId), TK.api.get(path)]).then(function (both) {
      if (seq !== state.searchSeq) return;
      var detail = both[0];
      var result = both[1];
      state.searching = false;
      setBusy(dom.searchButton, false, 'Checking', 'Show times');

      if (result.lost) {
        renderProblem('warn', 'We could not reach the restaurant',
          'Nothing was booked. Check your connection and try again.', function () { runSearch(); });
        return;
      }
      if (!result.ok) {
        var refusal = T.refusal(result.code);
        renderProblem('bad', refusal.title, refusal.text, function () { runSearch(); });
        return;
      }
      if (!detail) {
        renderProblem('bad', 'We could not load that restaurant',
          'Its tables are unavailable right now. Try again in a moment.', function () { runSearch(); });
        return;
      }

      state.restaurant = detail;
      state.date = date;
      state.partySize = party;
      state.slots = (result.data && result.data.slots) || [];
      clampDateToToday();
      buildRows(result.data);
      if (state.selection && state.selection.restaurantId !== detail.id) dropSelection();
      renderGrid();
    });
  }

  /* One row per table, then one row per pair the restaurant has approved. A
     pair named only in the answer still gets a row, so the grid and the answer
     never disagree about what can be booked. */
  function buildRows(availability) {
    var seen = {};
    var rows = [];
    (state.restaurant.tables || []).forEach(function (table) {
      rows.push({
        kind: 'single',
        tableIds: [table.id],
        labels: [String(table.label)],
        capacity: Number(table.capacity) || 0
      });
    });
    /* Pairs are learned from available_options and nowhere else. The restaurant
       detail deliberately does not carry combinable, so reading it here would
       only ever be a second, disagreeing source of truth. available_options
       already arrives in the order the specification fixes: singles in fixture
       order, then pairs in combinable order, with table_ids inside a pair in
       combinable order. Taking the first sighting of each pair preserves that
       order down the grid. */
    var pairs = [];
    (availability.slots || []).forEach(function (slot) {
      (slot.available_options || []).forEach(function (option) {
        if (!Array.isArray(option.table_ids) || option.table_ids.length !== 2) return;
        var ids = option.table_ids.slice();
        var key = JSON.stringify(ids);
        if (seen[key]) return;
        seen[key] = true;
        pairs.push(ids);
      });
    });
    pairs.forEach(function (pair) {
      var labels = labelsFor(pair);
      var capacity = pair.reduce(function (sum, id) {
        var table = tableById(id);
        return sum + (table ? Number(table.capacity) || 0 : 0);
      }, 0);
      rows.push({ kind: 'pair', tableIds: pair, labels: labels, capacity: capacity });
    });
    state.rows = rows;
  }

  /* ------------------------------ the grid ---------------------------- */

  function renderLoading(text) {
    clear(dom.gridHost);
    var loading = el('div', {
      class: 'loading',
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': 'true',
      'data-testid': 'loading'
    }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { class: 'loading__say', text: text + '…' })
    ]);
    /* Placeholder rows stand in for the grid that is on its way, so the panel
       never collapses to a line of words and then jumps. */
    for (var i = 0; i < 3; i += 1) {
      loading.appendChild(el('span', { class: 'loading__bar', 'aria-hidden': 'true' }));
    }
    dom.gridHost.appendChild(loading);
  }

  var WEEKDAY_INDEX = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };

  function openWeekdays() {
    var set = {};
    (state.restaurant && state.restaurant.opening_hours ? state.restaurant.opening_hours : [])
      .forEach(function (entry) {
        var index = WEEKDAY_INDEX[String(entry.weekday || '').toLowerCase()];
        if (index !== undefined) set[index] = true;
      });
    return set;
  }

  function addDays(dateValue, count) {
    var parsed = T.parseLocal(dateValue);
    if (!parsed) return null;
    var stamp = Date.UTC(parsed.year, parsed.month - 1, parsed.day) + count * 86400000;
    var next = new Date(stamp);
    var mm = String(next.getUTCMonth() + 1);
    var dd = String(next.getUTCDate());
    return next.getUTCFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }

  function nextOpenDays(count) {
    var open = openWeekdays();
    var keys = Object.keys(open);
    if (!keys.length || !state.date) return [];
    var found = [];
    var cursor = state.date;
    for (var i = 0; i < 14 && found.length < count; i += 1) {
      cursor = addDays(cursor, 1);
      if (!cursor) break;
      var parsed = T.parseLocal(cursor);
      if (parsed && open[parsed.weekday]) found.push(cursor);
    }
    return found;
  }

  function renderNoSlots() {
    clear(dom.gridHost);
    var empty = el('div', { class: 'empty', 'data-testid': 'no-slots' }, [
      el('div', { class: 'empty__mark', 'aria-hidden': 'true', text: '—' }),
      el('p', { class: 'empty__title', text: 'No sittings on ' + T.longDate(state.date) }),
      el('p', {
        class: 'empty__text',
        text: 'This restaurant does not open on that day. Pick another day below and we will look again.'
      })
    ]);
    var actions = el('div', { class: 'empty__actions' });
    nextOpenDays(3).forEach(function (day) {
      var button = el('button', {
        type: 'button', class: 'btn btn--quiet',
        'data-testid': 'open-day-' + day
      }, [el('span', { class: 'btn__label', text: T.longDate(day) })]);
      button.addEventListener('click', function () {
        dom.date.value = day;
        runSearch();
      });
      actions.appendChild(button);
    });
    if (actions.childNodes.length) empty.appendChild(actions);
    dom.gridHost.appendChild(empty);
  }

  function freeMaps(slot) {
    var singles = {};
    (slot.available_table_ids || []).forEach(function (id) { singles[id] = true; });
    var pairs = {};
    (slot.available_options || []).forEach(function (option) {
      if (option && Array.isArray(option.table_ids) && option.table_ids.length === 2) {
        pairs[JSON.stringify(option.table_ids)] = true;
      }
    });
    return { singles: singles, pairs: pairs };
  }

  function cellTestId(row, slot) {
    var name = row.kind === 'pair' ? row.tableIds.join('+') : row.tableIds[0];
    return 'slot-' + name + '-' + slotClock(slot.starts_at_local);
  }

  function renderGrid() {
    clear(dom.gridHost);
    if (!state.slots.length) {
      dom.gridTitle.textContent = 'Availability';
      dom.gridNote.textContent = T.longDate(state.date);
      renderNoSlots();
      return;
    }

    dom.gridTitle.textContent = T.longDate(state.date);
    var first = slotClock(state.slots[0].starts_at_local);
    var last = slotClock(state.slots[state.slots.length - 1].starts_at_local);
    dom.gridNote.textContent = T.partyPhrase(state.partySize) + ' · ' + first + '–' + last;

    var grid = el('div', {
      class: 'grid',
      'data-testid': 'availability-grid',
      role: 'group',
      'aria-label': 'Tables and times for ' + T.longDate(state.date)
    });
    grid.style.setProperty('--cols', String(state.slots.length));

    var head = el('div', { class: 'grid__head' }, [el('div', { class: 'grid__corner', text: 'Table' })]);
    state.slots.forEach(function (slot) {
      head.appendChild(el('div', { class: 'grid__headtime', text: slotClock(slot.starts_at_local) }));
    });
    grid.appendChild(head);

    state.rows.forEach(function (row) {
      var rowNode = el('div', { class: 'grid__row' });
      var cells = el('div', { class: 'grid__cells' });
      var availableSomewhere = false;
      state.slots.forEach(function (slot) {
        var maps = freeMaps(slot);
        var isFree = row.kind === 'pair'
          ? Boolean(maps.pairs[JSON.stringify(row.tableIds)])
          : Boolean(maps.singles[row.tableIds[0]]);
        if (isFree) availableSomewhere = true;
        cells.appendChild(buildCell(row, slot, isFree));
      });
      var sub = row.kind === 'pair'
        ? 'seats ' + row.capacity + ' together'
        : 'seats ' + row.capacity;
      if (!availableSomewhere) sub += ' · nothing free that day';
      rowNode.appendChild(el('div', { class: 'grid__label' }, [
        el('span', { class: 'grid__labelmain', text: T.tablePhrase(row.labels) }),
        el('span', { class: 'grid__labelsub', text: sub })
      ]));
      rowNode.appendChild(cells);
      grid.appendChild(rowNode);
    });

    dom.gridHost.appendChild(grid);
    if (window.innerWidth < 768 || grid.scrollWidth > grid.clientWidth + 1) {
      grid.classList.add('is-stacked');
    }
  }

  function buildCell(row, slot, isFree) {
    var phrase = T.tablePhrase(row.labels);
    var clock = slotClock(slot.starts_at_local);
    var chosen = Boolean(state.selection
      && state.selection.startsAtLocal === slot.starts_at_local
      && state.selection.tableIds.length === row.tableIds.length
      && state.selection.tableIds.every(function (id, i) { return id === row.tableIds[i]; }));

    var cell = el('button', {
      type: 'button',
      class: 'cell',
      'data-testid': cellTestId(row, slot),
      'data-available': isFree ? 'true' : 'false',
      'data-selected': chosen ? 'true' : 'false',
      /* Deliberately not aria-disabled: a cell that is not free must still take
         a click and do nothing, not refuse the click and stall whatever asked.
         The name below is what tells a screen reader the same thing. */
      title: isFree ? phrase + ' at ' + clock + ' is free' : phrase + ' at ' + clock + ' is not available',
      'aria-label': phrase + ', ' + clock + ', ' + (isFree ? 'free to book' : 'not available')
    }, [
      el('span', { class: 'cell__time', text: clock }),
      isFree ? el('span', { class: 'cell__note', text: 'Free' }) : null
    ]);
    cell.addEventListener('click', function () {
      if (!isFree) return;
      chooseCell(row, slot);
    });
    return cell;
  }

  /* --------------------------- the selection -------------------------- */

  function markSelected() {
    var grid = dom.gridHost.querySelector('[data-testid="availability-grid"]');
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.cell'), function (cell) {
      cell.setAttribute('data-selected', 'false');
    });
    if (state.selection) {
      var wanted = '[data-testid="' + cellTestId(state.selection.row, state.selection.slot) + '"]';
      var chosen = grid.querySelector(wanted);
      if (chosen) chosen.setAttribute('data-selected', 'true');
    }
  }

  function chooseCell(row, slot) {
    if (!TK.signedIn()) {
      showAuthError('Booking a table needs an account. Sign in or create one, then pick your time again — your search is still here.');
      return;
    }
    clearAuthError();
    state.selection = {
      row: row,
      slot: slot,
      restaurantId: state.restaurant.id,
      tableIds: row.tableIds.slice(),
      labels: row.labels.slice(),
      startsAtLocal: slot.starts_at_local,
      capacity: row.capacity
    };
    state.pending = null;
    state.receipt = null;
    TK.dom.clear(dom.receiptHost);
    markSelected();
    updateSearchButton();
    openBooking();
  }

  function dropSelection() {
    state.selection = null;
    state.pending = null;
    TK.dom.clear(dom.bookingHost);
    dom.bookingPanel = null;
    dom.bookingSummary = null;
    dom.bookingMessages = null;
    dom.bookingForm = null;
    dom.bookingParty = null;
    dom.bookingCapacity = null;
    dom.bookingSubmit = null;
    dom.bookingClear = null;
    updateSearchButton();
  }

  function updateSearchButton() {
    if (!dom.searchButton) return;
    if (state.selection) {
      dom.searchButton.classList.remove('btn--primary');
      dom.searchButton.classList.add('btn--quiet');
    } else {
      dom.searchButton.classList.remove('btn--quiet');
      dom.searchButton.classList.add('btn--primary');
    }
  }

  /* The panel is built only while a table is chosen, so a diner who has not
     chosen one is not shown a form for a table that is not theirs. */
  function buildBookingPanel() {
    var panel = el('section', {
      class: 'panel booking',
      'data-testid': 'booking-form',
      'aria-labelledby': 'booking-title'
    }, [
      el('div', { class: 'panel__head' }, [
        el('h2', { class: 'panel__title', id: 'booking-title', text: 'Book this table' })
      ]),
      el('p', { class: 'booking__summary', 'data-testid': 'booking-summary' }),
      el('div', { id: 'booking-messages', class: 'stack stack--tight booking__messages' }),
      el('form', { class: 'booking__body', id: 'booking-form-inner', novalidate: true }, [
        el('div', { class: 'field booking__party' }, [
          el('label', { class: 'field__label', for: 'booking-party-size', text: 'Guests' }),
          el('input', {
            type: 'number', id: 'booking-party-size', 'data-testid': 'booking-party-size',
            min: '1', step: '1', inputmode: 'numeric', required: true
          }),
          el('p', { class: 'field__hint', id: 'booking-capacity' })
        ]),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn btn--primary', type: 'submit', 'data-testid': 'booking-submit' }, [
            el('span', { class: 'btn__label', text: 'Confirm booking' })
          ]),
          el('button', {
            class: 'btn btn--plain', type: 'button', id: 'booking-clear',
            'data-testid': 'booking-clear',
            text: 'Choose another table'
          })
        ])
      ])
    ]);
    TK.dom.clear(dom.bookingHost);
    dom.bookingHost.appendChild(panel);
    dom.bookingPanel = panel;
    dom.bookingSummary = testid('booking-summary');
    dom.bookingMessages = document.getElementById('booking-messages');
    dom.bookingForm = document.getElementById('booking-form-inner');
    dom.bookingParty = testid('booking-party-size');
    dom.bookingCapacity = document.getElementById('booking-capacity');
    dom.bookingSubmit = testid('booking-submit');
    dom.bookingClear = document.getElementById('booking-clear');
    dom.bookingForm.addEventListener('submit', submitBooking);
    dom.bookingClear.addEventListener('click', function () {
      dropSelection();
      markSelected();
    });
  }

  function setBusy(button, on, busyText, idleText) {
    var label = button.querySelector('.btn__label');
    if (!label) return;
    if (on) {
      button.setAttribute('aria-busy', 'true');
      TK.dom.clear(label);
      label.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
      label.appendChild(document.createTextNode(' ' + busyText));
    } else {
      button.removeAttribute('aria-busy');
      label.textContent = idleText;
    }
  }

  function openBooking() {
    var selection = state.selection;
    if (!selection) return;
    if (!dom.bookingPanel) buildBookingPanel();
    var phrase = T.tablePhrase(selection.labels);
    clear(dom.bookingSummary);
    dom.bookingSummary.appendChild(document.createTextNode(
      phrase + ' — ' + T.longDateTime(selection.startsAtLocal)
    ));
    var minutes = state.restaurant ? Number(state.restaurant.reservation_duration_minutes) : 0;
    dom.bookingSummary.appendChild(el('span', {
      class: 'booking__where',
      text: state.restaurant.name + (minutes ? ' · your table is yours for ' + minutes + ' minutes' : '')
    }));
    dom.bookingParty.value = String(state.partySize);
    dom.bookingParty.removeAttribute('aria-invalid');
    dom.bookingCapacity.textContent = selection.row.kind === 'pair'
      ? 'Together these two tables seat ' + selection.capacity + '.'
      : 'This table seats ' + selection.capacity + '.';
    setBookingLabel('Confirm booking');
    clearBookingFeedback();
    if (window.matchMedia && window.matchMedia('(min-width: 62rem)').matches) {
      dom.bookingPanel.scrollIntoView({ block: 'nearest' });
    }
  }

  function setBookingLabel(text) {
    var label = dom.bookingSubmit.querySelector('.btn__label');
    if (label) label.textContent = text;
  }

  function clearBookingFeedback() {
    TK.dom.clear(dom.bookingMessages);
  }

  function bookingError(title, text) {
    clearBookingFeedback();
    var node = message('bad', title, text);
    node.setAttribute('data-testid', 'booking-error');
    dom.bookingMessages.appendChild(node);
  }

  function bookingUncertain() {
    clearBookingFeedback();
    var node = message('warn', 'We have not heard back yet',
      'Your booking may or may not have gone through, and we will not guess. Press the button below to send the very same request again — it cannot book you twice.');
    node.setAttribute('data-testid', 'booking-uncertain');
    dom.bookingMessages.appendChild(node);
  }

  /* ----------------------------- the receipt -------------------------- */

  function reservationLabels(reservation) {
    var ids = Array.isArray(reservation.table_ids)
      ? reservation.table_ids
      : (reservation.table_id ? [reservation.table_id] : []);
    if (state.restaurant) {
      return ids.map(function (id) {
        var table = tableById(id);
        return table && table.label ? String(table.label) : '';
      });
    }
    return ids.map(function () { return ''; });
  }

  function renderReceipt(reservation) {
    TK.dom.clear(dom.receiptHost);
    var phrase = T.tablePhrase(reservationLabels(reservation));
    var guests = Number(reservation.party_size);
    var details = (state.restaurant ? state.restaurant.name : '')
      + ', ' + T.longDateTime(reservation.starts_at_local)
      + '. ' + phrase + (Number.isFinite(guests) ? ', ' + guests + (guests === 1 ? ' guest' : ' guests') : '') + '.';

    var receipt = el('div', { class: 'receipt', 'data-testid': 'confirmation' }, [
      el('p', { class: 'receipt__head' }, [
        el('span', { 'aria-hidden': 'true', text: '✓' }),
        el('span', { text: 'Your table is booked' })
      ]),
      el('span', { class: 'receipt__label', text: 'Your reference' }),
      el('strong', { class: 'receipt__ref', 'data-testid': 'confirmation-reference', text: reservation.reference }),
      el('p', { class: 'receipt__details' }, [
        el('span', { 'data-testid': 'confirmation-details', text: details }),
        el('span', { class: 'receipt__tables', 'data-testid': 'confirmation-tables', text: phrase })
      ]),
      el('p', {
        class: 'receipt__foot',
        text: 'Keep this reference. You can look the booking up or cancel it from “My booking” at any time.'
      })
    ]);
    dom.receiptHost.appendChild(receipt);
    state.receipt = reservation;
  }

  /* ------------------------------ booking ----------------------------- */

  function submitBooking(event) {
    event.preventDefault();
    var selection = state.selection;
    if (!selection) return;

    var party = partyFrom(dom.bookingParty.value);
    if (party === null) {
      dom.bookingParty.setAttribute('aria-invalid', 'true');
      bookingError('Check the number of guests',
        'Enter the number of guests as a whole number of at least 1.');
      dom.bookingParty.focus();
      return;
    }
    if (selection.capacity > 0 && party > selection.capacity) {
      dom.bookingParty.setAttribute('aria-invalid', 'true');
      bookingError('That seating is too small for your party',
        T.tablePhrase(selection.labels) + ' ' + (selection.row.kind === 'pair' ? 'seat' : 'seats') + ' ' + selection.capacity
          + '. Lower the number of guests, or choose a larger table or a pair.');
      dom.bookingParty.focus();
      return;
    }
    dom.bookingParty.removeAttribute('aria-invalid');

    var body = {
      restaurant_id: selection.restaurantId,
      table_ids: selection.tableIds.slice(),
      starts_at_local: selection.startsAtLocal,
      party_size: party
    };
    var signature = JSON.stringify(body);
    if (!state.pending || state.pending.signature !== signature) {
      state.pending = { key: TK.api.newKey(), signature: signature };
    }

    clearBookingFeedback();
    setBusy(dom.bookingSubmit, true, 'Booking', 'Confirm booking');

    TK.api.send('POST', '/reservations', body, { idempotencyKey: state.pending.key })
      .then(function (result) {
        setBusy(dom.bookingSubmit, false, 'Booking', 'Confirm booking');

        if (result.lost) {
          TK.dom.clear(dom.receiptHost);
          state.receipt = null;
          setBookingLabel('Try booking again');
          bookingUncertain();
          return;
        }
        if (result.ok) {
          setBookingLabel('Confirm booking');
          renderReceipt(result.data);
          return;
        }
        setBookingLabel('Confirm booking');
        var refusal = T.refusal(result.code, BOOKING_WORDS);
        bookingError(refusal.title, refusal.text);
        if (result.code === 'table_unavailable') {
          /* the grid is stale now. Refresh it, but leave the diner's choice and
             everything they typed exactly where it is. */
          runSearch();
        }
      });
  }

  /* -------------------------------- boot ------------------------------ */

  dom.form.addEventListener('submit', function (event) {
    event.preventDefault();
    runSearch();
  });

  dom.select.addEventListener('change', function () {
    /* a new restaurant may be in another time zone; only fill the date in if
       the diner has not already chosen one */
    clampDateToToday();
    dropSelection();
    runSearch();
  });

  TK.onSessionChange(function () {
    clearAuthError();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (state.slots.length && !state.searching) renderGrid();
    }, 150);
  });

  if (!dom.party.value) dom.party.value = '2';
  updateSearchButton();
  loadRestaurants().then(function (ok) {
    if (!ok) return;
    clampDateToToday();
    runSearch();
  });
}());
