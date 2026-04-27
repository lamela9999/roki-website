/* ROKI Docs — password gate. Cosmetic only; trivially bypassable. */
(function () {
  var KEY = 'roki_docs_unlocked';
  var PASS = '095095';

  function unlocked() {
    try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }

  // If hash is #lock, force re-authentication (clear unlock flag).
  if (location.hash === '#lock') {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    // Strip the hash so subsequent navigation within docs doesn't keep re-prompting
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (unlocked()) {
    document.documentElement.classList.remove('docs-locked');
    return;
  }

  document.documentElement.classList.add('docs-locked');

  function render() {
    var overlay = document.createElement('div');
    overlay.id = 'docs-gate';
    overlay.innerHTML =
      '<div class="dg-card">' +
        '<div class="dg-stamp">CLASSIFIED</div>' +
        '<div class="dg-mark"><img src="' + relAsset('assets/logo-head.png') + '" alt=""/></div>' +
        '<div class="dg-eyebrow">ROKI · INTERNAL // EYES ONLY</div>' +
        '<h1 class="dg-title">Authorized Access Only</h1>' +
        '<p class="dg-sub">This terminal hosts the ROKI Project Bible. Unauthorized access is logged. Enter your clearance code to proceed.</p>' +
        '<form id="dg-form" autocomplete="off">' +
          '<input type="password" id="dg-input" inputmode="numeric" pattern="[0-9]*" maxlength="12" placeholder="ENTER CLEARANCE CODE" autofocus />' +
          '<button type="submit">AUTHENTICATE</button>' +
        '</form>' +
        '<div class="dg-msg" id="dg-msg"><span class="dg-dot"></span>SECURE CHANNEL · STANDBY</div>' +
        '<div class="dg-meta">' +
          '<span>SESSION ID · ' + sessionId() + '</span>' +
          '<span>NODE · DOCS-' + (Math.floor(Math.random()*900)+100) + '</span>' +
        '</div>' +
        '<a class="dg-back" href="../Roki.html">← RETURN TO PUBLIC SITE</a>' +
      '</div>' +
      '<div class="dg-grain"></div>' +
      '<a class="dg-home" href="../Roki.html" aria-label="Return home">' +
        '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M2 7 L8 2 L14 7 L14 14 L10 14 L10 9 L6 9 L6 14 L2 14 Z"/></svg>' +
        '<span>HOME</span>' +
      '</a>' +
      '<div class="dg-corner dg-corner-tl">// SECTOR A</div>' +
      '<div class="dg-corner dg-corner-tr">REV 3.0</div>' +
      '<div class="dg-corner dg-corner-bl">' + new Date().toISOString().slice(0,10) + '</div>' +
      '<div class="dg-corner dg-corner-br">SYS://ROKI-DOCS</div>';
    document.body.appendChild(overlay);

    var form = document.getElementById('dg-form');
    var input = document.getElementById('dg-input');
    var msg = document.getElementById('dg-msg');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (input.value === PASS) {
        try { sessionStorage.setItem(KEY, '1'); } catch (err) {}
        overlay.classList.add('dg-pass');
        setTimeout(function () {
          overlay.remove();
          document.documentElement.classList.remove('docs-locked');
        }, 420);
      } else {
        msg.innerHTML = '<span class="dg-dot dg-dot-err"></span>ACCESS DENIED · CODE INVALID';
        overlay.querySelector('.dg-card').classList.remove('dg-shake');
        // Force reflow so animation re-triggers
        void overlay.offsetWidth;
        overlay.querySelector('.dg-card').classList.add('dg-shake');
        input.value = '';
        input.focus();
      }
    });
  }

  function relAsset(p) {
    // Always reference assets in the parent project's assets folder
    var base = location.pathname.replace(/\/docs\/[^/]*$/, '/');
    return base + p;
  }

  function sessionId() {
    var hex = '';
    for (var i = 0; i < 8; i++) hex += Math.floor(Math.random()*16).toString(16);
    return hex.toUpperCase();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
