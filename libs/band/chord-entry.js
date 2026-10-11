// ChordEntry: turn notes played on a keyboard into chord symbols, and chord symbols into ABC changes.
// Plain script, one global; loads in Node for tests. No dependencies.
//
//   ChordEntry.analyse(midis, { keyLof })        -> { rootPc, bassPc, quality, suffix, exact } | null
//   ChordEntry.symbol(result, { keyLof, slash }) -> "Bbm7", "C/E"
//   ChordEntry.keyLof("Bb" | "Am")               -> where the key sits on the line of fifths (C = 0)
//   ChordEntry.listener({ mode, settle })        -> groups note-ons / note-offs into chords
//   ChordEntry.grid({ n, d })                    -> bars of chord symbols; step entry, quantized entry, ABC out
//   ChordEntry.connect({ on, off, inputs })      -> Web MIDI: every input, note-ons and note-offs
//
// The chord table and the key-based tie-break started from the Director page's analysis. Two things
// differ: a chord must account for every note played (Director accepts extra notes), and when two
// readings fit equally (C6 / Am7) the lowest note decides before the key does.
(function (global){
  "use strict";
  function mod12(n){ return ((n % 12) + 12) % 12; }

  // id, intervals, symbol suffix. Earlier rows win a tie. A perfect fifth may be left out of any
  // chord of four or more notes.
  var QUALITIES = [
    ["maj", [0,4,7], ""], ["min", [0,3,7], "m"], ["7", [0,4,7,10], "7"], ["maj7", [0,4,7,11], "maj7"], ["min7", [0,3,7,10], "m7"],
    ["6", [0,4,7,9], "6"], ["m6", [0,3,7,9], "m6"], ["m7b5", [0,3,6,10], "m7b5"], ["dim7", [0,3,6,9], "dim7"],
    ["dim", [0,3,6], "dim"], ["aug", [0,4,8], "aug"], ["sus4", [0,5,7], "sus4"], ["sus2", [0,2,7], "sus2"], ["7sus4", [0,5,7,10], "7sus4"],
    ["9", [0,4,7,10,2], "9"], ["7b9", [0,4,7,10,1], "7b9"], ["7#9", [0,4,7,10,3], "7#9"], ["maj9", [0,4,7,11,2], "maj9"], ["m9", [0,3,7,10,2], "m9"],
    ["13", [0,4,7,10,9], "13"], ["69", [0,4,7,9,2], "6/9"], ["add9", [0,4,7,2], "add9"],
    ["mmaj7", [0,3,7,11], "mMaj7"], ["7#5", [0,4,8,10], "7#5"], ["7b5", [0,4,6,10], "7b5"], ["maj7#5", [0,4,8,11], "maj7#5"],
    ["5", [0,7], "5"]
  ];

  // ---- spelling on the line of fifths (F = -1, C = 0, G = 1 ...) ----
  var LETTERS = "FCGDAEB";
  function lofName(lof){ var i = lof + 1, acc = Math.floor(i / 7), s = LETTERS[((i % 7) + 7) % 7];
    for (var k = 0; k < Math.abs(acc); k++) s += acc > 0 ? "#" : "b"; return s; }
  // the spelling of pc nearest the centre; a tie (F# / Gb) leans sharp in sharp keys and C, flat in flat keys
  function lofFor(pc, centre){
    var best = null;
    for (var l = centre - 6; l <= centre + 6; l++) if (mod12(l * 7) === mod12(pc)){
      var d = Math.abs(l - centre);
      if (best == null || d < Math.abs(best - centre) || (d === Math.abs(best - centre) && centre >= 0 && l > best)) best = l;
    }
    return best;
  }
  function keyLof(name){
    var m = /^\s*([A-Ga-g])([#b]*)\s*(m(?!aj)|min)?/.exec(name || "C"); if (!m) return 0;
    var l = LETTERS.indexOf(m[1].toUpperCase()) - 1;
    for (var i = 0; i < m[2].length; i++) l += m[2][i] === "#" ? 7 : -7;
    return m[3] ? l - 3 : l;                                   // a minor key is spelled like its relative major
  }

  // ---- analysis ----
  function analyse(midis, o){
    o = o || {};
    if (!midis || !midis.length) return null;
    var centre = o.keyLof || 0, pcs = {}, n = 0, low = Infinity, i;
    for (i = 0; i < midis.length; i++){ var pc = mod12(midis[i]); if (!pcs[pc]){ pcs[pc] = true; n++; } if (midis[i] < low) low = midis[i]; }
    if (n < 2) return null;
    var bassPc = mod12(low), best = null;
    for (var root = 0; root < 12; root++) if (pcs[root]){
      for (var q = 0; q < QUALITIES.length; q++){
        var iv = QUALITIES[q][1], missing = 0, omitted = 0, matched = 0;
        for (i = 0; i < iv.length; i++){
          if (pcs[mod12(root + iv[i])]) matched++;
          else if (iv[i] === 7 && iv.length >= 4) omitted++;
          else missing++;
        }
        var extra = n - matched, exact = !missing && !extra, onBass = root === bassPc;
        if (matched < 2) continue;
        var c = { rootPc: root, bassPc: bassPc, quality: QUALITIES[q][0], suffix: QUALITIES[q][2], exact: exact,
          rank: [exact ? 0 : 1, exact ? omitted : missing + extra + 0.25 * omitted + (onBass ? 0 : 0.5), onBass ? 0 : 1,
                 Math.abs(lofFor(root, centre) - centre), q] };
        if (!best || less(c.rank, best.rank)) best = c;
      }
    }
    if (best) delete best.rank;
    return best;
  }
  function less(a, b){ for (var i = 0; i < a.length; i++){ if (a[i] !== b[i]) return a[i] < b[i]; } return false; }

  function symbol(r, o){
    if (!r) return "";
    o = o || {};
    var centre = o.keyLof || 0, s = lofName(lofFor(r.rootPc, centre)) + r.suffix;
    if (o.slash && r.bassPc !== r.rootPc) s += "/" + lofName(lofFor(r.bassPc, centre));
    return s;
  }

  // ---- grouping notes into chords ----
  // mode "step": a chord is every note pressed from the first key down until all keys are up; it is
  //   reported when the last key lifts, so notes can go down one at a time.
  // mode "live": a chord is reported `settle` ms after its first note, timed at that first note. Notes
  //   still held from the chord before count as part of it unless three or more new notes arrived.
  // Times are in ms on any one clock. noteOn / noteOff / poll return the chords completed: [{ midis, t }].
  function listener(cfg){
    cfg = cfg || {};
    var mode = cfg.mode || "step", settle = cfg.settle == null ? 70 : cfg.settle;
    var held = {}, gest = null, clus = null;
    function heldList(){ return Object.keys(held).map(Number).sort(function (a, b){ return a - b; }); }
    function list(set){ return Object.keys(set).map(Number).sort(function (a, b){ return a - b; }); }
    function closeCluster(){
      var fresh = list(clus.notes), all = {}, t = clus.t0; clus = null;
      fresh.forEach(function (m){ all[m] = 1; });
      if (fresh.length < 3) heldList().forEach(function (m){ all[m] = 1; });
      return [{ midis: list(all), t: t }];
    }
    function poll(t){ return (mode === "live" && clus && t >= clus.t0 + settle) ? closeCluster() : []; }
    return {
      setMode: function (m){ mode = m; gest = null; clus = null; },
      noteOn: function (m, t){
        var out = poll(t);
        held[m] = 1;
        if (mode === "step"){ if (!gest) gest = { t0: t, notes: {} }; gest.notes[m] = 1; }
        else { if (!clus) clus = { t0: t, notes: {} }; clus.notes[m] = 1; }
        return out;
      },
      noteOff: function (m, t){
        var out = poll(t);
        delete held[m];
        if (mode === "step" && gest && !heldList().length){ out.push({ midis: list(gest.notes), t: gest.t0 }); gest = null; }
        return out;
      },
      poll: poll,
      due: function (){ return mode === "live" && clus ? clus.t0 + settle : null; },   // when poll() next has something
      sounding: function (){ return mode === "step" && gest ? list(gest.notes) : heldList(); },
      reset: function (){ held = {}; gest = null; clus = null; }
    };
  }

  // ---- the bars being entered ----
  // Positions are counted in units: eighth notes (sixteenths in x/16). `beat` is the units in one beat
  // as the band counts it (a dotted quarter in 6/8, 9/8, 12/8).
  function grid(cfg){
    cfg = cfg || {};
    var n = cfg.n || 4, d = cfg.d || 4, den = Math.max(8, d), per = n * den / d;
    var compound = d === 8 && n >= 6 && n % 3 === 0, beat = compound ? 3 : den / d;
    var bars = [], cursor = { bar: 0, pos: 0 }, undo = [];
    function ensure(k){ while (bars.length <= k) bars.push({}); }
    function snapshot(){ undo.push(JSON.stringify({ bars: bars, cursor: cursor })); if (undo.length > 300) undo.shift(); }
    function wipe(bar, from, to){ ensure(bar); Object.keys(bars[bar]).forEach(function (p){ if (+p >= from && +p < to) delete bars[bar][p]; }); }
    // clear `span` units from (bar, pos), running on into later bars
    function wipeSpan(bar, pos, span){ while (span > 0){ var take = Math.min(span, per - pos); wipe(bar, pos, pos + take); span -= take; bar++; pos = 0; } }
    function advance(span){ var p = cursor.bar * per + cursor.pos + span; cursor = { bar: Math.floor(p / per), pos: p % per }; }
    function spanOf(name){
      if (typeof name === "number") return name;
      return name === "two" ? per * 2 : name === "half" ? per / 2 : name === "beat" ? beat : name === "eighth" ? 1 : per;
    }
    var api = {
      n: n, d: d, unitsPerBar: per, unitsPerBeat: beat, beats: per / beat, compound: compound,
      // the grid sizes that make sense in this meter (half a bar only where it falls on a beat)
      sizes: function (){ var s = ["bar"]; if ((per / beat) % 2 === 0 && per / beat >= 2) s.push("half"); if (per / beat > 1) s.push("beat"); if (beat > 1) s.push("eighth"); return s; },
      span: spanOf,
      bars: function (){ return bars; },
      length: function (){ return bars.length; },
      setLength: function (k){ k = Math.max(0, k | 0); ensure(k - 1); bars.length = k; },
      cursor: function (){ return { bar: cursor.bar, pos: cursor.pos }; },
      setCursor: function (bar, pos){ cursor = { bar: Math.max(0, bar | 0), pos: Math.max(0, Math.min(per - 1, pos | 0)) }; },
      clear: function (){ snapshot(); bars = []; cursor = { bar: 0, pos: 0 }; },
      // step entry: the chord takes `span` from the cursor, replacing what was there
      put: function (sym, span){
        span = spanOf(span); snapshot();
        wipeSpan(cursor.bar, cursor.pos, span); bars[cursor.bar][cursor.pos] = sym;
        ensure(Math.ceil((cursor.bar * per + cursor.pos + span) / per) - 1);
        advance(span);
      },
      // step entry: the chord before carries on for another `span`
      hold: function (span){
        span = spanOf(span); snapshot();
        wipeSpan(cursor.bar, cursor.pos, span); ensure(Math.ceil((cursor.bar * per + cursor.pos + span) / per) - 1);
        advance(span);
      },
      back: function (){ if (!undo.length) return false; var s = JSON.parse(undo.pop()); bars = s.bars; cursor = s.cursor; return true; },
      // quantized entry: `beats` into bar `bar` (beats may run past the bar), snapped to the nearest
      // multiple of `size`. Returns where it landed, or null when that is past the last bar.
      place: function (sym, bar, beats, size){
        var g = spanOf(size), u = Math.round(beats * beat / g) * g;
        if (u < 0) u = 0;
        bar += Math.floor(u / per); u = u % per;
        if (bar < 0 || bar >= bars.length) return null;
        wipe(bar, u, Math.min(per, u + g)); bars[bar][u] = sym;
        return { bar: bar, pos: u };
      },
      // take over a parsed chart (TuneChart.parse), unrolled into the order it is played
      load: function (parsed){
        snapshot(); bars = [];
        var order = parsed.playOrder && parsed.playOrder.length ? parsed.playOrder : parsed.bars.map(function (b, i){ return i; });
        order.forEach(function (bi){
          var b = parsed.bars[bi], o = {};
          b.chords.forEach(function (c){ if (c.nc) return; var u = Math.round(c.onset / parsed.unitsPerBar * per); if (u < per) o[u] = c.sym; });
          bars.push(o);
        });
        cursor = { bar: bars.length, pos: 0 };
      },
      count: function (){ var k = 0; bars.forEach(function (b){ k += Object.keys(b).length; }); return k; },
      toAbc: function (o){
        o = o || {};
        // quarter-note units when nothing sits between the beats of an x/4 bar
        var div = 1;
        if (d === 4 && bars.every(function (b){ return Object.keys(b).every(function (p){ return +p % 2 === 0; }); })) div = 2;
        function z(len){ len /= div; return len <= 0 ? "" : "z" + (len === 1 ? "" : len); }
        var out = bars.map(function (b){
          var ps = Object.keys(b).map(Number).sort(function (x, y){ return x - y; }), s = [];
          if (!ps.length) return z(per);
          if (ps[0] > 0) s.push(z(ps[0]));
          ps.forEach(function (p, i){ s.push('"' + b[p] + '"' + z((i + 1 < ps.length ? ps[i + 1] : per) - p)); });
          return s.join(" ");
        });
        var lines = [];
        for (var i = 0; i < out.length; i += 4) lines.push(out.slice(i, i + 4).join(" | ") + (i + 4 >= out.length ? " |]" : " |"));
        return "X:1\nT:" + (o.title || "Entered changes") + "\nM:" + n + "/" + d + "\nL:1/" + (den / div) + "\nK:" + (o.key || "C") + "\n" + lines.join("\n");
      }
    };
    return api;
  }

  // a swung off-beat sits late in the beat: put a played position back on the even grid before snapping
  function unswing(pos, s){ var b = Math.floor(pos), f = pos - b; return b + (f <= s ? f * 0.5 / s : 0.5 + (f - s) * 0.5 / (1 - s)); }

  // Listen to every MIDI input the browser offers (new ones as they are plugged in).
  //   connect({ on(midi, vel 0..1, ms), off(midi, ms), inputs(names) }) -> Promise (rejects when there is no Web MIDI or it is refused)
  function connect(h){
    var nav = global.navigator;
    if (!nav || !nav.requestMIDIAccess) return Promise.reject(new Error("no-web-midi"));
    return nav.requestMIDIAccess().then(function (a){
      function msg(e){
        var d = e.data, cmd = d[0] & 0xf0, t = e.timeStamp || global.performance.now();
        if (cmd === 0x90 && d[2] > 0) h.on(d[1], d[2] / 127, t); else if (cmd === 0x80 || cmd === 0x90) h.off(d[1], t);
      }
      function bind(){ var names = []; a.inputs.forEach(function (i){ i.onmidimessage = msg; names.push(i.name || "MIDI input"); }); if (h.inputs) h.inputs(names); }
      a.onstatechange = bind; bind();
      return a;
    });
  }

  global.ChordEntry = { connect: connect, QUALITIES: QUALITIES, analyse: analyse, symbol: symbol, keyLof: keyLof, lofName: lofName,
    listener: listener, grid: grid, unswing: unswing };
})(typeof window !== "undefined" ? window : globalThis);
