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
  var LOG_W = 'btp-log-width';

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

      var stamp = document.createElement('button');
      stamp.type = 'button';
      stamp.className = 'btp-stamp';
      stamp.textContent = time;
      stamp.title = 'Jump to ' + time;
      stamp.addEventListener('click', function () {
        jump(time);
        stamp.blur();
      });
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
      say('Stamped ' + text);
      input.scrollIntoView({ block: 'nearest' });
      if (autoNote && autoNote.checked) input.focus();
    }

    // "MM:SS" (minutes may run past 59) or "H:MM:SS" back into seconds.
    function seconds(text) {
      var parts = String(text).split(':').map(Number);
      if (!parts.length || parts.some(isNaN)) return NaN;
      return parts.reduce(function (acc, n) { return acc * 60 + n; }, 0);
    }

    function jump(time) {
      var a = api();
      if (!a || !a.seek || !a.seek(seconds(time))) say('Nothing is loaded yet.');
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

    // Bring back earlier work: a .txt from Download, or the same text pasted.
    // Each line is a time, then optionally a tab (or spaces, or a dash) and the
    // note -- "01:23\tChorus", "1:02:03 - bridge", "[04:10] key change".
    // Lines without a time at the front are skipped. Imported stamps are
    // added to what is already there, in time order, leaving out exact repeats.
    var LINE = /^\s*\[?(\d+(?::\d{1,2}){1,2})\]?(?:\s*[-\u2013\u2014|]\s*|\s+|$)(.*)$/;

    function importText(text) {
      var have = {};
      entries().forEach(function (row) { have[row.t + '\t' + row.n] = true; });
      var found = [], skipped = 0;
      String(text).split(/\r?\n/).forEach(function (line) {
        if (!line.trim()) return;
        var m = line.match(LINE);
        if (!m) { skipped++; return; }
        var t = m[1], n = m[2].trim();
        if (have[t + '\t' + n]) return;
        have[t + '\t' + n] = true;
        found.push({ t: t, n: n });
      });
      if (!found.length) {
        say(skipped ? 'No timestamps found in that text.' : 'Nothing new to import.');
        return;
      }
      var all = entries().concat(found);
      all.sort(function (a, b) { return seconds(a.t) - seconds(b.t); });
      rows.innerHTML = '';
      all.forEach(function (row) { addRow(row.t, row.n); });
      save();
      showEmpty();
      say('Imported ' + found.length + (found.length === 1 ? ' stamp' : ' stamps')
          + (skipped ? ' (' + skipped + ' lines skipped)' : ''));
    }

    var importFile = log.querySelector('.btp-import-file');
    if (importFile) importFile.addEventListener('change', function () {
      var f = importFile.files[0];
      importFile.value = '';            // so choosing the same file again still fires
      if (!f) return;
      f.text().then(importText, function () { say('Could not read that file.'); });
    });

    var pasteBox = log.querySelector('.btp-paste');
    var pasteButton = log.querySelector('.btp-paste-go');
    function togglePaste(open) {
      pasteBox.hidden = !open;
      if (open) pasteBox.querySelector('textarea').focus();
    }
    log.querySelector('.btp-paste-open').addEventListener('click', function () {
      togglePaste(pasteBox.hidden);
    });
    pasteButton.addEventListener('click', function () {
      var area = pasteBox.querySelector('textarea');
      importText(area.value);
      area.value = '';
      togglePaste(false);
    });
    pasteBox.querySelector('.btp-paste-cancel').addEventListener('click', function () {
      pasteBox.querySelector('textarea').value = '';
      togglePaste(false);
    });
    pasteBox.querySelector('textarea').addEventListener('keydown', function (e) {
      e.stopPropagation();              // Enter is a newline here, not play/pause
      if (e.key === 'Escape') togglePaste(false);
    });

    // A .txt dropped on the log imports too (a video dropped there is left alone).
    log.addEventListener('dragover', function (e) { e.preventDefault(); });
    log.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (f && (/^text\//.test(f.type) || /\.txt$/i.test(f.name))) {
        f.text().then(importText);
      }
    });

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

    // The sticky log sits just under the fixed navbar, whatever its height.
    var layout = log.closest('.btp-layout');
    var header = document.getElementById('quarto-header');
    function measureTop() {
      if (!layout) return;
      var h = header ? header.getBoundingClientRect().height : 0;
      layout.style.setProperty('--btp-top', (h + 8) + 'px');
    }
    measureTop();
    window.addEventListener('resize', measureTop);

    // Dragging the splitter sets the notes column's width, in pixels, kept
    // between a usable minimum and most of the layout.
    var splitter = layout && layout.querySelector('.btp-splitter');
    if (splitter) {
      var MIN_LOG = 224, MIN_PLAYER = 320;
      var clampWidth = function (w) {
        var max = layout.getBoundingClientRect().width - MIN_PLAYER;
        return Math.round(Math.max(MIN_LOG, Math.min(w, max)));
      };
      var setWidth = function (w, keep) {
        if (w == null) layout.style.removeProperty('--btp-log-w');
        else layout.style.setProperty('--btp-log-w', clampWidth(w) + 'px');
        if (!keep) return;
        try {
          if (w == null) localStorage.removeItem(LOG_W);
          else localStorage.setItem(LOG_W, String(clampWidth(w)));
        } catch (e) {}
      };
      try {
        var stored = parseFloat(localStorage.getItem(LOG_W));
        if (isFinite(stored)) setWidth(stored, false);
      } catch (e) {}

      splitter.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        splitter.setPointerCapture(e.pointerId);
        splitter.classList.add('dragging');
        document.body.classList.add('btp-resizing');
        var right = layout.getBoundingClientRect().right;
        var move = function (ev) { setWidth(right - ev.clientX, false); };
        var up = function (ev) {
          splitter.removeEventListener('pointermove', move);
          splitter.removeEventListener('pointerup', up);
          splitter.removeEventListener('pointercancel', up);
          splitter.classList.remove('dragging');
          document.body.classList.remove('btp-resizing');
          setWidth(right - ev.clientX, true);
        };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
        splitter.addEventListener('pointercancel', up);
      });
      splitter.addEventListener('dblclick', function () { setWidth(null, true); });
      // Arrow keys nudge it, for anyone not using a pointer.
      splitter.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        var w = log.getBoundingClientRect().width;
        setWidth(w + (e.key === 'ArrowLeft' ? 32 : -32), true);
      });
    }

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
