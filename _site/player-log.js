/* The timestamp log beside the Big Timestamp Player.
   C stamps the current time, Enter plays and pauses, and each stamp gets a
   note field beside it. Everything here talks to the player through the
   _btp handle player.js hangs on the .btp block.

   The log is kept in localStorage as it is typed, so a reload -- or a closed
   tab -- does not lose an afternoon's notes. Clear is the only thing that
   throws them away, and it asks first. */
(function () {
  "use strict";

  var STORE = 'btp-stamps';
  var AUTONOTE = 'btp-autonote';

  function boot() {
    var player = document.querySelector('.btp');
    var log = document.querySelector('.btp-log');
    if (!player || !log) return;

    var rows = log.querySelector('.btp-log-rows');
    var empty = log.querySelector('.btp-log-empty');
    var autoNote = log.querySelector('.btp-autonote');
    var err = player.querySelector('.btp-err');

    function api() { return player._btp || null; }

    function say(text) {
      if (!err) return;
      err.textContent = text;
      if (text) setTimeout(function () {
        if (err.textContent === text) err.textContent = '';
      }, 2500);
    }

    // navigator.clipboard needs a secure context; localhost counts, a file://
    // page does not, so there is a fallback for when it is missing.
    function copy(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        var box = document.createElement('textarea');
        box.value = text;
        box.setAttribute('readonly', '');
        box.style.position = 'fixed';
        box.style.left = '-9999px';
        document.body.appendChild(box);
        box.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(box);
        ok ? resolve() : reject(new Error('copy'));
      });
    }

    function stamps() {
      return Array.prototype.slice.call(rows.querySelectorAll('li'));
    }

    function entries() {
      return stamps().map(function (li) {
        return { t: li.querySelector('.btp-stamp').textContent,
                 n: li.querySelector('.btp-note').value };
      });
    }

    function save() {
      try { localStorage.setItem(STORE, JSON.stringify(entries())); }
      catch (e) { /* private window, or the quota is full: keep going */ }
    }

    function saved() {
      try {
        var list = JSON.parse(localStorage.getItem(STORE) || '[]');
        return Array.isArray(list) ? list : [];
      } catch (e) { return []; }
    }

    function asText() {
      return entries().map(function (row) {
        var text = String(row.n).trim();
        return text ? row.t + '\t' + text : row.t;
      }).join('\n');
    }

    function showEmpty() {
      var any = stamps().length > 0;
      if (empty) empty.hidden = any;
      // Stamping is always available; the rest need something to act on.
      ['.btp-copy-all', '.btp-download', '.btp-clear'].forEach(function (sel) {
        var b = log.querySelector(sel);
        if (b) b.disabled = !any;
      });
    }

    // A note field is left with Escape, or with jk / kj typed in quick
    // succession -- the second key arrives before the first has settled, so
    // the letter already in the box is taken back out.
    var GRACE = 400;

    function escapable(input) {
      var lastKey = '', lastAt = 0;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { input.blur(); e.preventDefault(); return; }
        var now = Date.now();
        var pair = (e.key === 'k' && lastKey === 'j')
                || (e.key === 'j' && lastKey === 'k');
        if (pair && now - lastAt < GRACE) {
          e.preventDefault();
          var at = input.selectionStart;
          var before = input.value.charAt(at - 1);
          if (at > 0 && (before === 'j' || before === 'k')) {
            input.value = input.value.slice(0, at - 1) + input.value.slice(at);
            input.setSelectionRange(at - 1, at - 1);
          }
          lastKey = '';
          save();
          input.blur();
          return;
        }
        lastKey = e.key;
        lastAt = now;
      });
    }

    function addRow(time, text) {
      var li = document.createElement('li');

      var stamp = document.createElement('span');
      stamp.className = 'btp-stamp';
      stamp.textContent = time;
      li.appendChild(stamp);

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'btp-note';
      input.placeholder = 'Note';
      input.spellcheck = false;
      input.value = text || '';
      input.addEventListener('input', save);
      escapable(input);
      li.appendChild(input);

      rows.appendChild(li);
      showEmpty();
      return input;
    }

    function stamp() {
      var a = api();
      var t = a && a.time();
      if (typeof t !== 'number') { say('Nothing is playing yet.'); return; }
      var text = a.format(t);
      var input = addRow(text, '');
      save();
      copy(text).then(function () { say('Copied ' + text); },
                      function () { say('Stamped ' + text + ' (clipboard refused)'); });
      input.scrollIntoView({ block: 'nearest' });
      if (autoNote && autoNote.checked) input.focus();
    }

    function toggle() {
      var a = api();
      if (!a || !a.toggle()) say('Nothing is loaded yet.');
    }

    function copyAll() {
      var text = asText();
      if (!text) return;
      copy(text).then(function () { say('Copied ' + stamps().length + ' stamps'); },
                      function () { say('The clipboard refused that.'); });
    }

    function download() {
      var text = asText();
      if (!text) return;
      var blob = new Blob([text + '\n'], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'timestamps.txt';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    var stampButton = log.querySelector('.btp-stamp-now');
    if (stampButton) stampButton.addEventListener('click', function () {
      stamp();
      stampButton.blur();
    });
    log.querySelector('.btp-copy-all').addEventListener('click', copyAll);
    log.querySelector('.btp-download').addEventListener('click', download);

    // Clear throws the lot away, so it asks first: the button becomes its own
    // confirmation for a few seconds rather than interrupting with a dialog.
    var clear = log.querySelector('.btp-clear');
    var armed = null;
    function disarm() {
      if (armed) { clearTimeout(armed); armed = null; }
      clear.textContent = 'Clear';
      clear.classList.remove('armed');
    }
    if (clear) clear.addEventListener('click', function () {
      if (!armed) {
        clear.textContent = 'Clear — sure?';
        clear.classList.add('armed');
        armed = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      rows.innerHTML = '';
      try { localStorage.removeItem(STORE); } catch (e) {}
      showEmpty();
      say('Cleared.');
      clear.blur();
    });

    // Remember whether the jump into the note field is wanted.
    if (autoNote) {
      try {
        var choice = localStorage.getItem(AUTONOTE);
        if (choice !== null) autoNote.checked = choice === 'on';
      } catch (e) {}
      autoNote.addEventListener('change', function () {
        try {
          localStorage.setItem(AUTONOTE, autoNote.checked ? 'on' : 'off');
        } catch (e) {}
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var target = e.target;
      var typing = target && target.matches
                 && target.matches('input, textarea, [contenteditable]');
      // The URL box keeps Enter for loading a video; everywhere else -- the
      // page, a note field -- Enter plays and pauses.
      var inUrl = target && target.classList
                && target.classList.contains('btp-url');

      if (e.key === 'Enter' && !inUrl) {
        toggle();
        e.preventDefault();
        return;
      }
      // C is a letter while a note is being typed, and a stamp otherwise.
      if ((e.key === 'c' || e.key === 'C') && !typing) {
        stamp();
        e.preventDefault();
      }
    });

    // Whatever was on the page last time.
    saved().forEach(function (row) {
      if (row && typeof row.t === 'string') addRow(row.t, row.n);
    });
    showEmpty();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
