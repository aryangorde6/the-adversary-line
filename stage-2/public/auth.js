/* Tablekeeper — signup and login. One file for both: they refuse the same ways
   and say the same things, and only the fields differ. */
(function () {
  'use strict';

  var TK = window.TK;
  var el = TK.dom.el;
  var testid = TK.dom.testid;
  var clear = TK.dom.clear;
  var message = TK.dom.message;
  var T = TK.text;

  var isSignup = Boolean(testid('signup-submit'));
  var path = isSignup ? '/auth/signup' : '/auth/login';

  var dom = {
    form: document.getElementById('auth-form'),
    email: testid(isSignup ? 'signup-email' : 'login-email'),
    password: testid(isSignup ? 'signup-password' : 'login-password'),
    displayName: testid('signup-display-name'),
    submit: testid(isSignup ? 'signup-submit' : 'login-submit'),
    messages: document.getElementById('auth-messages'),
    sessionNote: document.getElementById('session-note')
  };

  var WORDS = {
    validation_failed: {
      title: 'Please check those details',
      text: 'An email address needs an @ and a domain, and a password needs at least 8 characters.'
    },
    email_taken: {
      title: 'That email already has an account',
      text: 'Sign in with it instead, or use a different address.'
    },
    unauthenticated: {
      title: 'That email and password do not match',
      text: 'Check for a stray space, or sign in with the address you used when you signed up.'
    }
  };

  function clearError() {
    clear(dom.messages);
    [dom.email, dom.password, dom.displayName].forEach(function (field) {
      if (field) field.removeAttribute('aria-invalid');
    });
  }

  function showError(title, text, field) {
    clear(dom.messages);
    var node = message('bad', title, text);
    node.setAttribute('data-testid', 'auth-error');
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'auth-error');
      field.focus();
    }
    dom.messages.appendChild(node);
  }

  function setBusy(on, busyText, idleText) {
    var label = dom.submit.querySelector('.btn__label');
    if (on) {
      dom.submit.setAttribute('aria-busy', 'true');
      clear(label);
      label.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
      label.appendChild(document.createTextNode(' ' + busyText));
    } else {
      dom.submit.removeAttribute('aria-busy');
      label.textContent = idleText;
    }
  }

  /* The field the refusal is about, so the note sits against the thing the
     diner has to change. */
  function fieldFor(code) {
    if (code === 'email_taken' || code === 'unauthenticated') return dom.email;
    if (code === 'validation_failed') {
      if (isSignup && dom.displayName && !dom.displayName.value.trim()) return dom.displayName;
      if (!dom.password.value || dom.password.value.length < 8) return dom.password;
      return dom.email;
    }
    return null;
  }

  function submit(event) {
    event.preventDefault();
    var email = dom.email.value.trim();
    var password = dom.password.value;
    var body = isSignup
      ? { email: email, password: password, display_name: dom.displayName.value.trim() }
      : { email: email, password: password };

    if (!email) {
      showError('We need your email address',
        'Type the address you would like to use, then try again.', dom.email);
      return;
    }
    if (isSignup && !body.display_name) {
      showError('We need a name for the booking',
        'Tell us what to call you on the booking.', dom.displayName);
      return;
    }
    if (!password) {
      showError('We need your password',
        'Type your password, then try again.', dom.password);
      return;
    }

    clearError();
    setBusy(true, 'One moment', isSignup ? 'Create my account' : 'Sign me in');

    TK.api.send('POST', path, body).then(function (result) {
      setBusy(false, 'One moment', isSignup ? 'Create my account' : 'Sign me in');

      if (result.lost) {
        showError('We did not hear back',
          'Nothing was changed. Check your connection and try again.', null);
        return;
      }
      if (!result.ok) {
        var refusal = T.refusal(result.code, WORDS);
        showError(refusal.title, refusal.text, fieldFor(result.code));
        return;
      }
      TK.signIn(result.data.token, result.data.display_name, email);
      window.location.href = '/';
    });
  }

  /* Someone already signed in who came here on purpose gets told what will
     happen rather than being quietly signed out from under them. */
  function showSessionNote() {
    if (!TK.signedIn()) return;
    clear(dom.sessionNote);
    dom.sessionNote.appendChild(message('note', 'You are signed in as ' + TK.displayName(),
      'Signing in or creating an account here will replace that session on this device.'));
  }

  dom.form.addEventListener('submit', submit);
  [dom.email, dom.password, dom.displayName].forEach(function (field) {
    if (!field) return;
    field.addEventListener('input', function () {
      if (dom.messages.firstChild) clearError();
    });
  });
  TK.onSessionChange(showSessionNote);
  showSessionNote();
}());
