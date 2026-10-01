/* Tablekeeper — look up a booking by its reference, and cancel it. */
(function () {
  'use strict';

  var TK = window.TK;
  var el = TK.dom.el;
  var testid = TK.dom.testid;
  var clear = TK.dom.clear;
  var message = TK.dom.message;
  var T = TK.text;

  var dom = {
    form: document.getElementById('lookup-form'),
    input: testid('lookup-reference-input'),
    submit: testid('lookup-submit'),
    messages: document.getElementById('lookup-messages'),
    host: document.getElementById('reservation-host')
  };

  var state = { reservation: null, details: {} };

  var WORDS = {
    unauthenticated: {
      title: 'Sign in to see your bookings',
      text: 'A booking belongs to the account that made it. Sign in with that account and try the reference again.'
    },
    cutoff_passed: {
      title: 'Too late to cancel this booking',
      text: 'This restaurant asks for changes to be made further ahead, so the table stays yours. Book something else if your plans have changed.'
    }
  };

  function clearError() {
    clear(dom.messages);
    dom.input.removeAttribute('aria-invalid');
  }

  function showError(title, text, focusField) {
    clear(dom.messages);
    var node = message('bad', title, text);
    node.setAttribute('data-testid', 'reservation-error');
    if (focusField) {
      dom.input.setAttribute('aria-invalid', 'true');
      dom.input.setAttribute('aria-describedby', 'reservation-error');
      dom.input.focus();
    }
    dom.messages.appendChild(node);
  }

  function rememberRestaurant(detail) {
    if (detail && detail.id) state.details[detail.id] = detail;
    return detail;
  }

  function restaurantOf(id) {
    if (state.details[id]) return Promise.resolve(state.details[id]);
    return TK.api.get('/restaurants/' + encodeURIComponent(id)).then(function (result) {
      if (result.lost || !result.ok) return null;
      return rememberRestaurant(result.data);
    });
  }

  function tableIdsOf(reservation) {
    if (Array.isArray(reservation.table_ids)) return reservation.table_ids;
    if (typeof reservation.table_id === 'string') return [reservation.table_id];
    return [];
  }

  function labelsFor(reservation, restaurant) {
    var tables = (restaurant && restaurant.tables) || [];
    return tableIdsOf(reservation).map(function (id) {
      for (var i = 0; i < tables.length; i += 1) {
        if (tables[i].id === id) return tables[i].label ? String(tables[i].label) : '';
      }
      return '';
    });
  }

  /* ------------------------------ the detail -------------------------- */

  function renderDetail(reservation, restaurant) {
    clear(dom.host);
    state.reservation = reservation;
    var phrase = T.tablePhrase(labelsFor(reservation, restaurant));
    var guests = Number(reservation.party_size);
    var cancelled = reservation.status === 'cancelled';
    var party = Number.isFinite(guests)
      ? guests + (guests === 1 ? ' guest' : ' guests')
      : '';

    var detail = el('div', { class: 'panel panel--flat lookupdetail', 'data-testid': 'reservation-detail' }, [
      el('div', { class: 'panel__head' }, [
        el('h2', { class: 'panel__title', text: restaurant && restaurant.name ? restaurant.name : 'Your booking' }),
        el('p', { class: 'status status--' + (cancelled ? 'cancelled' : 'confirmed') }, [
          el('span', { class: 'status__dot', 'aria-hidden': 'true' }),
          el('span', { 'data-testid': 'reservation-status', text: reservation.status })
        ])
      ]),
      el('p', { class: 'lookupdetail__ref' }, [
        el('span', { class: 'receipt__label', text: 'Reference' }),
        el('span', { class: 'ref-inline', text: reservation.reference })
      ]),
      el('dl', { class: 'deflist deflist--twocol' }, [
        el('div', {}, [
          el('dt', { text: 'When' }),
          el('dd', { class: 'is-strong', text: T.longDateTime(reservation.starts_at_local) })
        ]),
        el('div', {}, [
          el('dt', { text: 'Table' }),
          el('dd', { class: 'is-strong', 'data-testid': 'reservation-tables', text: phrase })
        ]),
        el('div', {}, [
          el('dt', { text: 'Guests' }),
          el('dd', { text: party })
        ]),
        el('div', {}, [
          el('dt', { text: 'Seated until' }),
          el('dd', { text: endClock(reservation) })
        ])
      ]),
      el('p', { class: 'lookupdetail__foot', text: cancelled
        ? 'This booking was cancelled, so the table is free for someone else. You can book another one whenever you like.'
        : 'Keep this reference somewhere safe. You can come back to this page with it at any time.' })
    ]);

    if (!cancelled) {
      var actions = el('div', { class: 'actions lookupdetail__actions' });
      var cancel = el('button', { type: 'button', class: 'btn btn--danger', 'data-testid': 'reservation-cancel-button' },
        [el('span', { class: 'btn__label', text: 'Cancel this booking' })]);
      cancel.addEventListener('click', function () { cancelBooking(reservation.reference, cancel); });
      actions.appendChild(cancel);
      detail.appendChild(actions);
    }
    dom.host.appendChild(detail);
  }

  /* The service answers the local end of the sitting as well as the start, in
     the restaurant's own wall clock, so the two always agree on the page. */
  function endClock(reservation) {
    return T.clockTime(reservation.ends_at) || '';
  }

  function showNothingFound() {
    clear(dom.host);
    state.reservation = null;
  }

  /* -------------------------------- look up ---------------------------- */

  function lookup(event) {
    event.preventDefault();
    var reference = dom.input.value.trim().toUpperCase();
    dom.input.value = reference;

    if (!reference) {
      showNothingFound();
      showError('We need your booking reference',
        'It is the six to twelve letters and numbers on your confirmation.', true);
      return;
    }

    clearError();
    setBusy(dom.submit, true, 'Looking', 'Find my booking');

    TK.api.get('/reservations/' + encodeURIComponent(reference)).then(function (result) {
      setBusy(dom.submit, false, 'Looking', 'Find my booking');

      if (result.lost) {
        showNothingFound();
        showError('We did not hear back',
          'Nothing was changed. Check your connection and try again.', null);
        return;
      }
      if (!result.ok) {
        showNothingFound();
        var refusal = T.refusal(result.code, WORDS);
        showError(refusal.title, refusal.text, result.code !== 'unauthenticated');
        return;
      }
      var reservation = result.data;
      return restaurantOf(reservation.restaurant_id).then(function (restaurant) {
        clearError();
        renderDetail(reservation, restaurant);
      });
    });
  }

  function cancelBooking(reference, button) {
    clearError();
    setBusy(button, true, 'Cancelling', 'Cancel this booking');

    TK.api.send('POST', '/reservations/' + encodeURIComponent(reference) + '/cancel')
      .then(function (result) {
        setBusy(button, false, 'Cancelling', 'Cancel this booking');

        if (result.lost) {
          showError('We did not hear back',
            'Nothing was changed. Check your connection and try again.', null);
          return;
        }
        if (!result.ok) {
          var refusal = T.refusal(result.code, WORDS);
          showError(refusal.title, refusal.text, null);
          return;
        }
        return restaurantOf(result.data.restaurant_id).then(function (restaurant) {
          clearError();
          renderDetail(result.data, restaurant);
        });
      });
  }

  function setBusy(button, on, busyText, idleText) {
    var label = button.querySelector('.btn__label');
    if (on) {
      button.setAttribute('aria-busy', 'true');
      clear(label);
      label.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
      label.appendChild(document.createTextNode(' ' + busyText));
    } else {
      button.removeAttribute('aria-busy');
      label.textContent = idleText;
    }
  }

  dom.form.addEventListener('submit', lookup);
  dom.input.addEventListener('input', function () {
    var upper = dom.input.value.toUpperCase();
    if (upper !== dom.input.value) dom.input.value = upper;
    if (dom.messages.firstChild) clearError();
  });
}());
