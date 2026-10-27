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
  // The numbers the rules use, in one place (the Notation Rules page prints these).
  var RULES = {
    togetherBeats: 0.06,        // line(): notes struck within this many beats of each other are one strike (a take sets it from togetherMs)
    togetherMs: 45,             // a take's default for the same, in milliseconds
    settleMs: 70,               // a chord closes this long after its first note (live and in a take)
    gap: 0.75,                  // a gap of at least this many eighths between a note's release and the next note is written as a rest
    early: 0.5,                 // a note (or chord) struck up to this many beats before the first downbeat is taken as on it; earlier is dropped
    pedalGroup: 0.15,           // notes within this many beats count as one strike when the pedal listens for downbeats
    pedalCC: 80,                // the MIDI controller that listens for two downbeats
    ticks: [16, 12, 8, 6, 4, 3, 2, 1],   // the written lengths, in the finest grid step; anything else is split and tied
    phraseTol: 0.25,            // a long note before a rest (ends "simple"): its end may move this share of its length (at least one grid step, at most a beat) to a plainer one
    phraseKeepRest: 1.25,       // ... and a rest that was played costs this much to lose (holding the note on to the next one)
    graceBeats: 0.2,            // a grace note: a note whose next note starts within graceMs (but never more than this many beats) is a grace note of that note
    tripletMargin: 0.05,        // a beat is read as triplets when its onsets fit thirds of the beat better than the grid, by this much (in beats, summed over the onsets)
    sharpFlatMid: 1             // a note outside the key is spelled by whichever of sharp or flat is nearer centre + this on the line of fifths (flat on a tie)
  };
  // where the swung off-beat sits (0.5 = straight .. 0.67 = triplet) at a tempo: slower tempos swing harder
  function swingFor(bpm){ function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); } return 0.68 - 0.08 * clamp((bpm - 100) / 120, 0, 1) - 0.05 * clamp((bpm - 220) / 80, 0, 1); }

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
    var bassPc = mod12(low), best = null, all = [];
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
        if (o.all) all.push(c);
        if (!best || less(c.rank, best.rank)) best = c;
      }
    }
    if (best && o.all){
      all.sort(function (x, y){ return less(x.rank, y.rank) ? -1 : less(y.rank, x.rank) ? 1 : 0; });
      best.candidates = all.slice(0, 5).map(function (c){ return { symbol: symbol(c, { keyLof: centre }), exact: c.exact, rank: c.rank.slice() }; });
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
    var mode = cfg.mode || "step", settle = cfg.settle == null ? RULES.settleMs : cfg.settle;
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
  // as the band counts it (a dotted quarter in 6/8, 9/8, 12/8). Every bar has the grid's meter unless setLayout / load gave it its own.
  // geoOf(n, d): the sizes of a bar of n/d.
  function geoOf(n, d){
    var den = Math.max(8, d), per = n * den / d, compound = d === 8 && n >= 6 && n % 3 === 0, beat = compound ? 3 : den / d;
    return { n: n, d: d, per: per, beat: beat, bpb: per / beat, compound: compound };
  }
  // layout({ n, d, changes: [{ at, len }], bars }): the bars of a take in beats, from the top: the opening meter, until a change (`at` beats
  // from the start, a new bar length `len` in beats from there on). A change that falls inside a bar cuts that bar short (a 2/4 bar in a 4/4
  // tune); one less than a beat after a bar line moves back to the bar line. Stops after `bars` bars.
  //   -> [{ start, len, n, d, per, beat, bpb, compound }]
  function layout(o){
    var g0 = geoOf(o.n || 4, o.d || 4), cur = g0, out = [], t = 0, ch = (o.changes || []).slice().sort(function (a, b){ return a.at - b.at; }), ci = 0, max = o.bars || 1;
    function add(len, g){ var m = geoOf(g.compound ? Math.round(len * 3) : Math.round(len), g.d); m.start = t; m.len = len; out.push(m); t += len; }
    while (out.length < max){
      var c = ch[ci];
      while (c && c.at <= t + 1e-9){ cur = geoOf(cur.compound ? c.len * 3 : c.len, cur.compound ? 8 : cur.d); ci++; c = ch[ci]; }
      if (c && c.at < t + cur.bpb - 1e-9){
        if (c.at - t < 1 - 1e-9){ c = { at: t, len: c.len }; ch[ci] = c; continue; }
        add(c.at - t, cur); continue;
      }
      add(cur.bpb, cur);
    }
    return out;
  }
  // meterPedal(): a pedal (MIDI CC 80) held across two downbeats gives the new bar length. Feed it the pedal and the notes struck, with times in
  // beats (any origin). Notes within `group` beats make one strike. up() -> { at (the first downbeat, a whole beat), len (whole beats) } or { error }.
  function meterPedal(cfg){
    var group = cfg && cfg.group != null ? cfg.group : RULES.pedalGroup, down = false, hits = [];
    return {
      down: function (){ if (!down){ down = true; hits = []; } },
      isDown: function (){ return down; },
      hits: function (){ return hits.slice(); },
      strike: function (t){ if (!down) return; var last = hits[hits.length - 1]; if (last != null && t - last < group) return; hits.push(t); },
      up: function (){
        if (!down) return null; down = false;
        if (hits.length < 2) return { error: hits.length ? "one downbeat" : "no downbeats" };
        var a = Math.round(hits[0]), len = Math.round(hits[hits.length - 1]) - a;
        return len >= 1 ? { at: a, len: len } : { error: "the same beat" };
      }
    };
  }
  function grid(cfg){
    cfg = cfg || {};
    var base = geoOf(cfg.n || 4, cfg.d || 4), n = base.n, d = base.d, den = Math.max(8, d), per = base.per, compound = base.compound, beat = base.beat;
    var bars = [], mel = [], meters = [], cursor = { bar: 0, pos: 0 }, undo = [];
    function geo(k){ return meters[k] || base; }
    function perAt(k){ return geo(k).per; }
    function ensure(k){ while (bars.length <= k) bars.push({}); }
    function snapshot(){ undo.push(JSON.stringify({ bars: bars, mel: mel, meters: meters, cursor: cursor })); if (undo.length > 300) undo.shift(); }
    function wipe(bar, from, to){ ensure(bar); Object.keys(bars[bar]).forEach(function (p){ if (+p >= from && +p < to) delete bars[bar][p]; }); }
    // clear `span` units from (bar, pos), running on into later bars
    function wipeSpan(bar, pos, span){ while (span > 0){ var take = Math.min(span, perAt(bar) - pos); wipe(bar, pos, pos + take); span -= take; bar++; pos = 0; } }
    function advance(span){ var b = cursor.bar, p = cursor.pos + span; while (p >= perAt(b) - 1e-9){ p -= perAt(b); b++; } cursor = { bar: b, pos: p }; }
    function spanOf(name, bar){
      if (typeof name === "number") return name;
      var g = geo(bar == null ? cursor.bar : bar);
      return name === "two" ? g.per * 2 : name === "half" ? g.per / 2 : name === "beat" ? g.beat : name === "eighth" ? 1 : g.per;
    }
    function covered(){ ensure(cursor.pos ? cursor.bar : cursor.bar - 1); }
    // a short bar of `beats` beats (an anacrusis): the grid's meter, the same beat, fewer of them; it carries no meter mark of its own
    function pickupGeo(beats){
      var g = geoOf(1, 4); g.beat = base.beat; g.per = Math.round(beats * base.beat * 1e6) / 1e6; g.bpb = beats; g.compound = base.compound; g.n = base.compound ? Math.round(beats * 3) : Math.round(beats); g.d = base.compound ? 8 : base.d; g.pickup = true;
      return g;
    }
    var api = {
      n: n, d: d, unitsPerBar: per, unitsPerBeat: beat, beats: per / beat, compound: compound,
      // the grid sizes that make sense in this meter (half a bar only where it falls on a beat)
      sizes: function (){ var s = ["bar"]; if ((per / beat) % 2 === 0 && per / beat >= 2) s.push("half"); if (per / beat > 1) s.push("beat"); if (beat > 1) s.push("eighth"); return s; },
      span: spanOf,
      bars: function (){ return bars; },
      length: function (){ return bars.length; },
      // the sizes of bar k (its own meter where it has one)
      geo: geo, pickupGeo: pickupGeo,
      // a pickup bar of `beats` beats in front of the first bar (everything moves one bar along)
      insertPickup: function (beats){ snapshot(); bars.unshift({}); mel.unshift([]); var m = meters.slice(); m.unshift(pickupGeo(beats)); meters = m; cursor = { bar: cursor.bar + 1, pos: cursor.pos }; },
      geoList: function (){ return bars.map(function (b, k){ return geo(k); }); },
      setLength: function (k){ k = Math.max(0, k | 0); ensure(k - 1); bars.length = k; if (mel.length > k) mel.length = k; if (meters.length > k) meters.length = k; },
      // give the bars their own meters (from a layout): [{ n, d }] one per bar; the bars become that many
      setLayout: function (list){
        meters = list.map(function (g){ return g.n === n && g.d === d ? null : geoOf(g.n, g.d); });
        api.setLength(list.length); meters.length = list.length;
      },
      cursor: function (){ return { bar: cursor.bar, pos: cursor.pos }; },
      setCursor: function (bar, pos){ bar = Math.max(0, bar | 0); cursor = { bar: bar, pos: Math.max(0, Math.min(perAt(bar) - 1, pos | 0)) }; },
      clear: function (){ snapshot(); bars = []; mel = []; meters = []; cursor = { bar: 0, pos: 0 }; },
      // step entry: the chord takes `span` from the cursor, replacing what was there
      put: function (sym, span){
        span = spanOf(span); snapshot();
        wipeSpan(cursor.bar, cursor.pos, span); bars[cursor.bar][cursor.pos] = sym;
        advance(span); covered();
      },
      // step entry: the chord before carries on for another `span`
      hold: function (span){
        span = spanOf(span); snapshot();
        wipeSpan(cursor.bar, cursor.pos, span); advance(span); covered();
      },
      back: function (){ if (!undo.length) return false; var s = JSON.parse(undo.pop()); bars = s.bars; mel = s.mel || []; meters = (s.meters || []).map(function (m){ return m || null; }); cursor = s.cursor; return true; },
      // quantized entry: `beats` into bar `bar` (beats may run past the bar), snapped to the nearest
      // multiple of `size`. Returns where it landed, or null when that is past the last bar.
      place: function (sym, bar, beats, size){
        if (bar < 0){ while (bar < 0){ beats -= geo(0).bpb; bar++; }                          // (the last bar of the count-in: an early first chord)
          if (beats < 0){ if (Math.round(beats * geo(0).beat / spanOf(size, 0)) < 0) return null; beats = 0; } }
        if (beats < 0) beats = 0;
        while (bar >= 0 && bar < bars.length && beats >= geo(bar).bpb - 1e-9){ beats -= geo(bar).bpb; bar++; }
        if (bar < 0 || bar >= bars.length) return null;
        var g = spanOf(size, bar), u = Math.round(Math.max(0, beats) * geo(bar).beat / g) * g;
        if (u >= perAt(bar) - 1e-9){ u -= perAt(bar); bar++; if (bar >= bars.length) return null; }
        wipe(bar, u, Math.min(perAt(bar), u + g)); bars[bar][u] = sym;
        return { bar: bar, pos: u };
      },
      // take over a parsed chart (TuneChart.parse), unrolled into the order it is played
      // o.dropPickup: leave the chart's pickup bar out (the band's form has no such bar)
      load: function (parsed, lo){
        lo = lo || {}; snapshot(); bars = []; mel = []; meters = [];
        var order = parsed.playOrder && parsed.playOrder.length ? parsed.playOrder : parsed.bars.map(function (b, i){ return i; });
        order.forEach(function (bi){
          var b = parsed.bars[bi], o = {}, m = b.meter && (b.meter.n !== n || b.meter.d !== d) ? geoOf(b.meter.n, b.meter.d) : null, p = m ? m.per : per;
          if (b.anacrusis){ if (lo.dropPickup) return; var full = b.fullUnits || parsed.unitsPerBar; m = Object.assign({}, m || base); m.per = Math.round(b.lengthUnits / full * p * 1e6) / 1e6; m.bpb = m.per / m.beat; m.pickup = true; p = m.per; }
          b.chords.forEach(function (c){ if (c.nc) return; var u = Math.round(c.onset / (b.fullUnits || parsed.unitsPerBar) * (b.anacrusis ? (m.per / (b.lengthUnits / (b.fullUnits || parsed.unitsPerBar))) : p)); if (u < p) o[u] = c.sym; });
          meters[bars.length] = m; bars.push(o);
        });
        cursor = { bar: bars.length, pos: 0 };
      },
      // a melody line over the bars: for each bar, [{ pos, dur, midi, tie }] in units (an eighth, or half of one for sixteenths);
      // `tie` joins the note to the same pitch at the start of the next bar
      setMelody: function (list){ snapshot(); mel = (list || []).map(function (b){ return (b || []).map(function (n){ var o = { pos: n.pos, dur: n.dur, midi: n.midi, tie: !!n.tie }; if (n.midis && n.midis.length > 1) o.midis = n.midis.slice(); if (n.stac) o.stac = true; if (n.graces && n.graces.length) o.graces = n.graces.slice(); if (n.sp) o.sp = n.sp; if (n.spOdd) o.spOdd = true; return o; }); }); ensure(mel.length - 1); },
      clearMelody: function (){ if (!mel.length) return; snapshot(); mel = []; },
      melody: function (){ return mel; },
      hasMelody: function (){ return mel.some(function (b){ return b && b.length; }); },
      count: function (){ var k = 0; bars.forEach(function (b){ k += Object.keys(b).length; }); return k; },
      // bars a to b (0-based, inclusive) as a grid of their own, with their chords, meters and melody
      slice: function (a, b){
        var ng = grid(cfg); b = Math.min(b, bars.length - 1); a = Math.max(0, a);
        ng.restore(JSON.parse(JSON.stringify({ bars: bars.slice(a, b + 1), mel: mel.slice(a, b + 1), meters: meters.slice(a, b + 1) })));
        return ng;
      },
      // everything restore() needs, as plain data (to keep the work between visits)
      state: function (){ return JSON.parse(JSON.stringify({ bars: bars, mel: mel, meters: meters })); },
      restore: function (st){ bars = st.bars; mel = st.mel || []; meters = (st.meters || []).map(function (m){ return m || null; }); undo = []; cursor = { bar: bars.length, pos: 0 }; },
      toAbc: function (o){
        o = o || {};
        // quarter-note units when nothing sits between the beats of an x/4 bar
        var div = 1, tune = api.hasMelody(), fine = tune && mel.some(function (b){ return (b || []).some(function (m){ return needsSixteenth(m.pos) || needsSixteenth(m.dur); }); }), sp = spelling(o.key), prev = n + "/" + d;
        if (!tune && d === 4 && !meters.some(Boolean) && bars.every(function (b){ return Object.keys(b).every(function (p){ return +p % 2 === 0; }); })) div = 2;
        function z(len){ len /= div; return len <= 0 ? "" : "z" + (len === 1 ? "" : len); }
        var spelled = tune ? spellMel(bars, mel, o.key) : null;
        var out = bars.map(function (b, bi){
          var g = geo(bi), p0 = g.per, mark = "";
          if (!g.pickup && g.n + "/" + g.d !== prev){ prev = g.n + "/" + g.d; mark = "[M:" + prev + "] "; }
          if (tune) return mark + tuneBar(b, mel[bi] || [], p0, fine ? 2 : 1, sp, { beat: g.beat, beam: o.beam, tie: o.tie, spelled: spelled[bi] });
          var ps = Object.keys(b).map(Number).sort(function (x, y){ return x - y; }), s = [];
          if (!ps.length) return mark + z(p0);
          if (ps[0] > 0) s.push(z(ps[0]));
          ps.forEach(function (p, i){ s.push('"' + b[p] + '"' + z((i + 1 < ps.length ? ps[i + 1] : p0) - p)); });
          return mark + s.join(" ");
        });
        // four bars to a line; o.sections[bar] = the name of the section that starts on that bar: it gets a P: line and a line of its own
        var lines = [], row = [], full = 0, secs = o.sections || null;
        out.forEach(function (t, i){
          var named = secs && secs[i] != null;
          if (row.length && (named || full === 4)){ lines.push(row.join(" | ") + " |"); row = []; full = 0; }
          if (named) lines.push("P:" + String(secs[i]).replace(/[\r\n]+/g, " "));
          row.push(t); if (!geo(i).pickup) full++;      // (a pickup bar rides on the first line: it is not one of its four)
        });
        if (row.length) lines.push(row.join(" | ") + " |]");
        return "X:1\nT:" + (o.title || "Entered changes") + "\nM:" + n + "/" + d + "\nL:1/" + (den / div * (fine ? 2 : 1)) + "\nK:" + (o.key || "C") + "\n" + lines.join("\n");
      }
    };
    return api;
  }


  // ---- a played line: single notes into written rhythm ----
  // line(): collects note-ons and note-offs (times in beats from the start of bar 1, any fractions) into a one-voice line. Notes struck together
  //   (within `chord` beats) leave only the highest, or with cfg.poly all of them (written as a chord); a new note ends the one before it.
  function line(cfg){
    var chord = cfg && cfg.chord != null ? cfg.chord : RULES.togetherBeats, poly = !!(cfg && cfg.poly), grace = cfg && cfg.grace ? Math.min(cfg.grace, RULES.graceBeats) : 0, open = {}, notes = [];
    return {
      on: function (m, t){ open[m] = { midi: m, on: t, off: null }; notes.push(open[m]); },
      off: function (m, t){ if (open[m]){ open[m].off = t; delete open[m]; } },
      reset: function (){ open = {}; notes = []; },
      count: function (){ return notes.length; },
      setChord: function (b){ chord = b; }, setPoly: function (p){ poly = !!p; },
      // [{ midi (the top note), midis (all, low to high), on, off, dropped (notes struck with it and left out) }], sorted; notes still held end at `end`
      notes: function (end){
        var a = notes.map(function (n){ return { midi: n.midi, on: n.on, off: n.off == null ? end : n.off }; }).sort(function (x, y){ return x.on - y.on || y.midi - x.midi; }), out = [];
        if (grace) a = slides(a);
        a.forEach(function (n){
          var last = out[out.length - 1];
          if (last && n.on - last.on < chord && n.on < last.off){
            if (n.graces) last.graces = (last.graces || []).concat(n.graces);
            if (poly){ if (last.midis.indexOf(n.midi) < 0) last.midis.push(n.midi); last.off = Math.max(last.off, n.off); last.midi = Math.max(last.midi, n.midi); }
            else if (n.midi > last.midi){ last.dropped.push(last.midi); last.midi = n.midi; last.midis = [n.midi]; last.off = n.off; }
            else last.dropped.push(n.midi);
            return;
          }
          if (last && last.off > n.on){ last.off = n.on; last.cut = true; }
          out.push({ midi: n.midi, midis: [n.midi], on: n.on, off: n.off, dropped: [] }); if (n.graces) out[out.length - 1].graces = n.graces;
        });
        out.forEach(function (n){ n.midis.sort(function (x, y){ return x - y; }); });
        if (!grace) return out;
        // grace notes: a note whose next note starts within `grace` beats belongs to that note (a run of them all do)
        var res = [], pend = [];
        out.forEach(function (n, j){
          var nx = out[j + 1];
          if (nx && nx.on - n.on <= grace){ pend.push(n.midi); return; }
          if (pend.length){ n.graces = pend.concat(n.graces || []); pend = []; }
          res.push(n);
        });
        return res;
      }
    };
    // a grace note slid into a chord (Eb up to E under a G): a short note a step or less from one struck just after it, released as that one
    //   lands. It is taken out before notes are grouped into chords, and the notes struck with it (from just before it to the landing) move to
    //   the landing's first onset so they group with it, even when the slide made the chord spread wider than `chord`.
    function slides(a){
      var win = Math.min(grace * 1.3, RULES.graceBeats), gone = {};
      a.forEach(function (g, i){
        if (gone[i]) return;
        for (var j = i + 1; j < a.length && a[j].on - g.on <= win; j++){
          var x = a[j];
          if (gone[j] || x.on <= g.on || Math.abs(x.midi - g.midi) > 2 || x.midi === g.midi || g.off > x.on + chord) continue;
          gone[i] = true;
          var mates = a.filter(function (m, k){ return k !== i && !gone[k] && m.on >= g.on - chord && m.on <= x.on; }),
              t = Math.min.apply(null, mates.map(function (m){ return m.on; }));
          mates.forEach(function (m){ m.on = t; });
          x.graces = (x.graces || []).concat([g.midi]);
          return;
        }
      });
      return a.filter(function (n, i){ return !gone[i]; }).sort(function (x, y){ return x.on - y.on || y.midi - x.midi; });
    }
  }
  function r2(x){ return Math.round(x * 100) / 100; }
  // quantizeLine(notes, o): the played notes [{ midi, midis, on, off }] (beats) as written bars [[{ pos, dur, midi, midis, tie }]] in units.
  //   o.bars   the bars: a count (all o.per units long, o.beat units to a beat) or a list [{ per, beat, compound }], one per bar
  //   o.swing  where the swung off-beat sits (0.5 straight .. 0.67 triplet); 0 or leaving it out reads the playing as straight
  //   o.res    the finest grid, in units: 1 = eighths, 0.5 = sixteenths (default 1)
  //   o.trace  an array: gets one record per note, saying what each rule did
  //   o.ends   "simple" (default): a note longer than an eighth with a rest after it ends where the note and the rest are plainest to write,
  //            near its release; "played": at its release, rounded
  // A note lasts until the next one starts (written legato) unless there is a clear gap of three quarters of an eighth or more,
  // which is written as a rest. The last note stops at its release.
  function quantizeLine(notes, o){
    var res = o.res || 1, sw = o.swing || 0, GAP = RULES.gap, geo = [], k, tr = o.trace, trip = o.triplets === "auto", stacOn = o.detached === "staccato", simpleEnds = o.ends !== "played";
    if (typeof o.bars === "number" || o.bars == null){ for (k = 0; k < (o.bars || 1); k++) geo.push({ per: o.per || 8, beat: o.beat || 2 }); }
    else geo = o.bars;
    var nbars = geo.length, startB = [], startU = [], accB = 0, accU = 0;
    geo.forEach(function (g){ startB.push(accB); startU.push(accU); accB += g.per / g.beat; accU += g.per; });
    var total = accU;
    function barAt(t){ var i = 0; while (i + 1 < nbars && t >= startB[i + 1] - 1e-9) i++; return i; }
    function unsw(f){ return sw > 0.5 ? (f <= sw ? f * 0.5 / sw : 0.5 + (f - sw) * 0.5 / (1 - sw)) : f; }     // a fraction of a beat, swing taken out
    function u(t){                                                           // a time in beats -> units from the start (unswung, not rounded)
      var i = barAt(t), g = geo[i], lb = t - startB[i];
      return startU[i] + (sw > 0.5 && !g.compound ? unswing(lb, sw) : lb) * g.beat;
    }
    // Triplets: a beat (of two units) is read as three even parts when its onsets fit thirds of the beat better than the grid does
    var tcell = {};
    if (trip){
      var cellOn = {};
      notes.forEach(function (n){
        var bi = barAt(n.on), g = geo[bi], lb = n.on - startB[bi]; if (g.beat !== 2 || g.compound || lb < 0) return;
        var c = Math.floor(lb + 1e-9); (cellOn[bi + ":" + c] = cellOn[bi + ":" + c] || []).push(lb - c);
      });
      Object.keys(cellOn).forEach(function (key){
        var bi = +key.split(":")[0], step = res / geo[bi].beat, eT = 0, eB = 0;
        cellOn[key].forEach(function (f){
          eT += Math.min(Math.abs(f), Math.abs(f - 1 / 3), Math.abs(f - 2 / 3), Math.abs(f - 1));
          var fu = unsw(f); eB += Math.abs(fu - Math.round(fu / step) * step);
        });
        if (eT + RULES.tripletMargin < eB){ tcell[key] = { eT: r2(eT), eB: r2(eB) }; }
      });
    }
    function tripAt(t){ var bi = barAt(t), lb = t - startB[bi], c = Math.floor(lb + 1e-9); return trip && lb >= 0 && tcell[bi + ":" + c] ? { bi: bi, c: c, lb: lb } : null; }
    function tripUnits(x){ return startU[x.bi] + (x.c + Math.round((x.lb - x.c) * 3) / 3) * geo[x.bi].beat; }
    function snapEnd(t){ var x = tripAt(t); return x ? tripUnits(x) : Math.round(u(t) / res) * res; }
    // where a long note before a rest ends, read for plainness: the written symbols of the note and of the rest after it (a dotted one counts
    // one and a half), an end off the beat, and the distance from the release, among the grid points near the release (n.rawSnap)
    function unitBar(x){ var b = 0; while (b + 1 < nbars && x >= startU[b + 1] - 1e-9) b++; return b; }
    function symbols(a, b){
      var c = 0, f = res < 1 ? 2 : 1;
      while (b - a > 1e-9){ var bi = unitBar(a), stop = Math.min(b, startU[bi] + geo[bi].per), L = Math.round((stop - a) * f);
        while (L > 0){ var t = RULES.ticks.filter(function (x){ return x <= L; })[0] || 1; c += t === 12 || t === 6 || t === 3 ? 1.5 : 1; L -= t; }
        a = stop; }
      return c;
    }
    function offBeat(x){ var bi = unitBar(x), p = x - startU[bi], bt = geo[bi].beat; return Math.abs(p / bt - Math.round(p / bt)) < 1e-6 ? 0 : Math.abs(p - Math.round(p)) < 1e-6 ? 0.5 : 1; }
    function plainEnd(n, next, rr){
      var bi = unitBar(n.on), tol = Math.min(geo[bi].beat, Math.max(res, RULES.phraseTol * (rr - n.on))), limit = next != null ? next : total;
      var lo = Math.max(n.on + n.step, rr - tol), hi = Math.min(limit, rr + tol), best = null;
      for (var e = Math.ceil(lo / res - 1e-9) * res; e <= hi + 1e-9; e += res){
        var held = next != null && Math.abs(e - next) < 1e-6, eb = unitBar(e - 1e-6), rEnd = next != null ? next : Math.min(total, startU[eb] + geo[eb].per);
        var cost = Math.abs(e - rr) / tol + symbols(n.on, e) + symbols(e, rEnd) + (held || rEnd - e < 1e-9 ? 0 : offBeat(e)) + (held ? RULES.phraseKeepRest : 0);
        if (!best || cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && Math.abs(e - rr) < Math.abs(best.e - rr))) best = { e: Math.round(e * 1e6) / 1e6, cost: cost, held: held };
      }
      return best;
    }
    var q = [];
    notes.forEach(function (n, i){
      var bi = barAt(n.on), tx = tripAt(n.on), a = tx ? tripUnits(tx) : u(n.on), on = Math.round((tx ? a : (Math.round(a / res) * res || 0)) * 1e6) / 1e6;
      var rec = { i: i, midis: (n.midis || [n.midi]).slice(), onBeat: r2(n.on), offBeat: r2(n.off), bar: bi + 1, beatInBar: r2(n.on - startB[bi]), unswungUnits: r2(u(n.on)), snapped: r2(on), leftOut: (n.dropped || []).slice() };
      if (n.graces && n.graces.length) rec.graces = n.graces.slice();
      rec.off = r2(Math.abs((tx ? startU[bi] + (n.on - startB[bi]) * geo[bi].beat : a) - on));          // how far the note was moved to reach the grid, in units
      if (tx){ rec.triplet = "this beat fits thirds better (" + tcell[bi + ":" + tx.c].eT + " off a triplet grid, against " + tcell[bi + ":" + tx.c].eB + " off the even grid)"; }
      else if (sw > 0.5 && !geo[bi].compound) rec.swing = "off-beat read as swung (" + r2(sw) + "), put back on the even grid";
      if (tr) tr.push(rec);
      if (on < 0){ if (a < -RULES.early * geo[0].beat){ rec.out = "dropped: struck more than half a beat before the first downbeat"; return; } on = 0; rec.snapped = 0; rec.note = "just before the downbeat: moved onto it"; }
      if (on >= total){ rec.out = "dropped: after the last bar"; return; }
      var last = q[q.length - 1];
      if (last && Math.abs(last.on - on) < 1e-6){ q.pop(); last.rec.out = "dropped: the next note falls on the same grid point"; }
      q.push({ midi: n.midi, midis: (n.midis || [n.midi]).slice(), graces: n.graces, on: on, raw: u(n.off), rawSnap: snapEnd(n.off), trip: !!tx, step: tx ? geo[bi].beat / 3 : res, rec: rec });
    });
    var flat = [];
    q.forEach(function (n, i){
      var next = i + 1 < q.length ? q[i + 1].on : null, end, rec = n.rec, rr = n.rawSnap, stac = false;
      if (next != null && next - n.raw < GAP){ end = next; rec.endRule = "gap to the next note " + r2(next - n.raw) + " < " + GAP + ": held to it (written legato)"; }
      else {
        end = Math.max(n.on + n.step, rr);
        rec.endRule = next != null ? "gap to the next note " + r2(next - n.raw) + " >= " + GAP + ": a rest follows" : "last note: its release, rounded";
        if (rr < n.on + n.step - 1e-9) rec.endRule += "; shorter than one grid step, made one step";
        if (simpleEnds && !n.trip && rr - n.on > 1 + 1e-9){
          var pe = plainEnd(n, next, rr);
          if (pe && Math.abs(pe.e - end) > 1e-6){ rec.endRule += "; a long note before a rest: " + (pe.held ? "held on to the next note" : "ended at " + r2(pe.e - n.on) + " units, not " + r2(end - n.on)) + " (plainer to write)"; end = pe.e; }
        }
        if (stacOn && !n.trip && (next != null || end < total)){      // (the note and its rest within one bar: a staccato note is never tied over the bar line)
          var L = end - n.on, Rr = (next != null ? next : total) - end, tk = Math.round((L + Rr) * (res < 1 ? 2 : 1));
          if (Math.abs(Rr - L) < 1e-6 && Math.abs((L + Rr) * (res < 1 ? 2 : 1) - tk) < 1e-6 && RULES.ticks.indexOf(tk) >= 0 && unitBar(n.on) === unitBar(end + Rr - 1e-6)){ end = next != null ? next : end + Rr; stac = true; rec.endRule += "; a note and an equal rest are written as a staccato note of both"; }
        }
      }
      if (next != null && end > next + 1e-9) end = next;
      if (end > total){ end = total; rec.endRule += "; cut at the last bar line"; }
      flat.push({ midi: n.midi, midis: n.midis, graces: n.graces, on: n.on, end: end, stac: stac, rec: rec });
    });
    var out = []; for (k = 0; k < nbars; k++) out.push([]);
    flat.forEach(function (n){
      var at = n.on, parts = 0;
      while (at < n.end - 1e-9){
        var bar = 0; while (bar + 1 < nbars && at >= startU[bar + 1] - 1e-9) bar++;
        var stop = Math.min(n.end, startU[bar] + geo[bar].per), o2 = { pos: Math.round((at - startU[bar]) * 1e6) / 1e6, dur: Math.round((stop - at) * 1e6) / 1e6, midi: n.midi, midis: n.midis, tie: stop < n.end - 1e-9 };
        if (n.stac) o2.stac = true; if (n.graces && n.graces.length && !parts) o2.graces = n.graces.slice();
        out[bar].push(o2); at = stop; parts++;
      }
      n.rec.dur = r2(n.end - n.on); n.rec.out = "written" + (parts > 1 ? " over " + parts + " bars (tied)" : "") + (n.stac ? ", staccato" : "");
    });
    return out;
  }
  // how a key writes its notes: { sig: { letter: -1|0|1.. }, spell(midi) -> { letter, acc, oct } }. Notes in the key take its spelling;
  // the others take whichever of sharp or flat is nearer the middle of the key (flat on a tie: bIII, bVI, bVII in major).
  var NAT_LOF = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 }, NAT_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function spelling(key){
    var centre = keyLof(key || "C"), sig = {};
    Object.keys(NAT_LOF).forEach(function (L){ sig[L] = Math.ceil((centre - 1 - NAT_LOF[L]) / 7); });
    return { sig: sig, spell: function (midi){
      var pc = mod12(midi), l = mod12(pc * 7), best = null;
      for (var k = -3; k <= 3; k++){ var c = l + 12 * k; if (best == null || Math.abs(c - centre - RULES.sharpFlatMid) < Math.abs(best - centre - RULES.sharpFlatMid)) best = c; }
      var idx = ((best + 1) % 7 + 7) % 7, letter = LETTERS[idx], acc = Math.floor((best + 1) / 7);
      return { letter: letter, acc: acc, oct: Math.floor((midi - acc) / 12) - 1 };
    } };
  }
  // ---- spelling a line in context ----
  // A note may carry `sp` (letter + accidental: "A#", "Bb", "C", "Fx", "Ebb"), set when the ABC wrote an accidental on it; it is used while it still
  // names the note's pitch class. The others are spelled by spellNotes: a chord tone takes the chord's spelling (an altered tone only if nothing else
  // fits), then the song key where the note is diatonic to it, then the chord's own key, then the direction of travel to the next or the
  // previous note (a semitone up is written as a sharp of the note below, a semitone down as a flat of the one above), else the chord's key.
  var L7 = "CDEFGAB", ACCS = { "": 0, "#": 1, "##": 2, x: 2, b: -1, bb: -2 };
  function accStr(a){ var s = "", k; for (k = 0; k < Math.abs(a); k++) s += a > 0 ? "#" : "b"; return s; }
  function spLetter(letter, acc){ return { letter: letter, acc: acc, name: letter + (acc === 2 ? "x" : accStr(acc)) }; }
  function onLetter(letter, pc){ return spLetter(letter, mod12(pc - NAT_PC[letter] + 6) - 6); }
  function stepLetter(letter, n){ return L7[(((L7.indexOf(letter) + n) % 7) + 7) % 7]; }
  // "A#" -> { letter, acc, name } when it names the pitch class of `midi`, else null
  function parseSp(sp, midi){
    var m = /^([A-G])(##|x|bb|#|b)?$/.exec(sp || ""); if (!m) return null;
    var x = spLetter(m[1], ACCS[m[2] || ""]); return mod12(NAT_PC[x.letter] + x.acc) === mod12(midi) ? x : null;
  }
  function lofSp(l){ var i = l + 1; return spLetter(LETTERS[((i % 7) + 7) % 7], Math.floor(i / 7)); }
  function lofOf(letter, acc){ return LETTERS.indexOf(letter) - 1 + 7 * acc; }
  function spellInKey(pc, centre){
    var l0 = mod12(pc * 7), best = null, k;
    for (k = -3; k <= 3; k++){ var c = l0 + 12 * k; if (best == null || Math.abs(c - centre - RULES.sharpFlatMid) < Math.abs(best - centre - RULES.sharpFlatMid)) best = c; }
    return lofSp(best);
  }
  // the same, but never a double accidental (the nearest single-accidental name; for a note the key does not itself need)
  function spellSingle(pc, centre){
    var l0 = mod12(pc * 7), best = null, k;
    for (k = -3; k <= 3; k++){ var c = l0 + 12 * k; if (Math.abs(lofSp(c).acc) > 1) continue; if (best == null || Math.abs(c - centre - RULES.sharpFlatMid) < Math.abs(best - centre - RULES.sharpFlatMid)) best = c; }
    return lofSp(best);
  }
  var MAJ_PCS = [0, 2, 4, 5, 7, 9, 11];
  function diatonicIn(pc, centre){ return MAJ_PCS.indexOf(mod12(pc - mod12(centre * 7))) >= 0; }
  // a chord symbol -> { pcs: { pc: spelling }, soft: { pc: true }, rootLof, minor, dom } or null
  function chordSpell(sym){
    var m = /^([A-G])([#b]?)([^\/]*)(?:\/([A-G])([#b]?))?$/.exec(String(sym || "").replace(/\(.*?\)/g, "")); if (!m) return null;
    var rl = m[1], ra = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0, q = m[3], rpc = mod12(NAT_PC[rl] + ra), t = [];
    function add(deg, semis, soft){ var letter = stepLetter(rl, deg - 1), pc = mod12(rpc + semis), s = onLetter(letter, pc); if (Math.abs(s.acc) > 1) return; t.push({ pc: pc, sp: s, soft: !!soft }); }
    var minor = /^(m(?!aj|a7)|min|-)/.test(q), dim = /^(dim|o|°)/.test(q), hdim = /m7b5|ø|min7b5/.test(q), aug = /^(aug|\+)/.test(q), sus4 = /sus4|sus(?!2)/.test(q), sus2 = /sus2/.test(q);
    var maj7 = /maj|M7|Δ|ma7/.test(q.replace(/^m(?!aj|a7)/, "")) && !/^m(?!aj|a7)(?!.*maj)/.test(q) || /mM7|mMaj|m\(?maj/.test(q) || /^(maj|M|Δ|ma)/.test(q);
    add(1, 0);
    if (sus4) add(4, 5); else if (sus2) add(2, 2); else if (minor || dim || hdim) add(3, 3); else add(3, 4);
    if (dim || hdim || /b5/.test(q)) add(5, 6); else if (aug || /#5|\+5/.test(q)) add(5, 8, true); else add(5, 7);
    var n = q.replace(/maj|M|Δ|ma/g, "X");
    if (/^X?(7|9|11|13)|X7|X9|X13/.test(n) || /7|9|11|13/.test(q)){
      if (dim && /7/.test(q)) add(7, 9); else if (/X(7|9|11|13)|^X/.test(n) && !/^m7|^min7|^-7/.test(q)) add(7, 11); else add(7, 10);
    }
    if (/6/.test(q) && !/^6\/9|13/.test(q) || /6\/9|69/.test(q)) add(6, 9);
    if (/9/.test(q)) add(9, 2);
    if (/b9/.test(q)) add(9, 1, true); if (/#9/.test(q)) add(9, 3, true);
    if (/add9/.test(q)) add(9, 2); if (/11/.test(q) && !/#11/.test(q)) add(11, 5); if (/#11/.test(q)) add(11, 6, true);
    if (/13/.test(q) && !/b13/.test(q)) add(13, 9); if (/b13/.test(q)) add(13, 8, true);
    if (m[4]) t.push({ pc: mod12(NAT_PC[m[4]] + (m[5] === "#" ? 1 : m[5] === "b" ? -1 : 0)), sp: spLetter(m[4], m[5] === "#" ? 1 : m[5] === "b" ? -1 : 0) });
    var pcs = {}, soft = {}; t.forEach(function (x){ if (!pcs[x.pc]){ pcs[x.pc] = x.sp; if (x.soft) soft[x.pc] = true; } });
    var dom = !minor && !dim && !hdim && !maj7 && /7|9|11|13/.test(q) && !/maj|M7|Δ/.test(q) || /^(7|9|13)/.test(q);
    return { pcs: pcs, soft: soft, rootLof: lofOf(rl, ra), minor: minor || dim || hdim, dom: !!dom && !minor && !dim && !hdim };
  }
  // the key a chord implies: a dominant 7th its target (a fourth up), a minor chord its relative major, else its root as a major key
  function chordCentre(ci, songCentre){ return !ci ? songCentre : ci.dom ? ci.rootLof - 1 : ci.minor ? ci.rootLof - 3 : ci.rootLof; }
  function baseSpell(midi, sym, songCentre){
    var pc = mod12(midi), ci = chordSpell(sym), lc = chordCentre(ci, songCentre);
    function inKey(centre){ var x = spellInKey(pc, centre); if (Math.abs(x.acc) > 1) x = spellInKey(pc, songCentre); return Math.abs(x.acc) > 1 ? spellSingle(pc, centre) : x; }
    if (ci && ci.pcs[pc] && !ci.soft[pc]) return { sp: ci.pcs[pc] };                              // (an altered tone, #5 / b13 / #9 ..., is only a fallback: the line decides)
    if (diatonicIn(pc, songCentre)) return { sp: spellInKey(pc, songCentre) };
    if (ci && diatonicIn(pc, lc)) return { sp: inKey(lc) };
    if (ci && ci.pcs[pc]) return { sp: ci.pcs[pc], chromatic: true };
    return { sp: inKey(lc), chromatic: true };
  }
  // notes: [{ pos, midi, sp? }] of one bar; chords: [{ pos, sym }] sorted. ctx: { carry (the chord sounding at the bar's start), prev ({ midi, sp }), next ([midi | { midi, sp }]),
  // nextChord, tied ({ midi, sp }: a note tied in from the bar before) }. Returns { letter, acc, name } for each note.
  function spellNotes(notes, chords, key, ctx){
    ctx = ctx || {}; var songCentre = keyLof(key), out = [];
    var syms = notes.map(function (n){ var c = ctx.carry; (chords || []).forEach(function (x){ if (x.pos <= n.pos + 1e-6) c = x.sym; }); return c; });
    var typed = notes.map(function (n){ return parseSp(n.sp, n.midi); });
    var bases = notes.map(function (n, i){ return typed[i] ? { sp: typed[i] } : baseSpell(n.midi, syms[i], songCentre); });
    function seq(i, dir){                  // the next (dir 1) or previous (-1) note of another pitch, with its base spelling
      var j, k;
      for (j = i + dir; j >= 0 && j < notes.length; j += dir) if (notes[j].midi !== notes[i].midi) return { midi: notes[j].midi, sp: bases[j].sp };
      var outside = dir > 0 ? (ctx.next || []) : (ctx.prev ? [ctx.prev] : []);
      for (k = 0; k < outside.length; k++){ var o = outside[k], mm = typeof o === "number" ? o : o.midi; if (mm !== notes[i].midi) return { midi: mm, sp: (o && o.sp) || baseSpell(mm, dir > 0 ? (ctx.nextChord || syms[i]) : syms[i], songCentre).sp }; }
      return null;
    }
    notes.forEach(function (n, i){
      var b = bases[i], sp = b.sp, pc = mod12(n.midi);
      if (typed[i]){ out.push(typed[i]); return; }
      if (i === 0 && ctx.tied && ctx.tied.midi === n.midi && n.pos <= 1e-6){ out.push(ctx.tied.sp); return; }       // (tied over the barline: the same spelling)
      if (b.chromatic && !(sp.acc === 0 && NAT_PC[sp.letter] === pc)){
        var nx = seq(i, 1), cand = null;      // (spelled by where it goes; one that leaps on, or ends the line, keeps the chord's or the key's spelling)
        if (nx && Math.abs(nx.midi - n.midi) === 1) cand = onLetter(stepLetter(nx.sp.letter, nx.midi > n.midi ? -1 : 1), pc);
        if (cand && Math.abs(cand.acc) <= 1) sp = cand;
      }
      out.push(sp);
    });
    return out;
  }
  function chordList(ch){ return Object.keys(ch || {}).map(function (p){ return { pos: +p, sym: ch[p] }; }).sort(function (a, b){ return a.pos - b.pos; }); }
  // a whole melody: chs[i] = { unit: symbol } of bar i, mel[i] = its notes -> for each bar the spelling of each note (the chord and the neighbouring notes carry across barlines)
  function spellMel(chs, mel, key){
    var carry = null, out = [], i, j;
    for (i = 0; i < mel.length; i++){
      var notes = mel[i] || [], cl = chordList(chs[i]), prev = null, next = [], nextChord = null, tied = null;
      for (j = i - 1; j >= 0 && !prev; j--) if ((mel[j] || []).length){ var pb = mel[j], k = pb.length - 1; prev = { midi: pb[k].midi, sp: out[j][k] }; if (pb[k].tie && j === i - 1) tied = prev; }
      for (j = i + 1; j < mel.length && next.length < 3; j++) (mel[j] || []).forEach(function (n){ if (next.length < 3) next.push({ midi: n.midi, sp: parseSp(n.sp, n.midi) }); });
      for (j = i + 1; j < mel.length && !nextChord; j++){ var nc = chordList(chs[j]); if (nc.length && nc[0].pos <= 0) nextChord = nc[0].sym; }
      out.push(notes.length ? spellNotes(notes, cl, key, { carry: carry, prev: prev, next: next, nextChord: nextChord, tied: tied }) : []);
      cl.forEach(function (c){ carry = c.sym; });
    }
    return out;
  }
  // a typed spelling moved from key `from` to key `to` (names): by the same number of letter names and of semitones, so A -> Bb is one letter up and one
  // semitone, and A# becomes B. dm = the semitones moved (midiNew is the note afterwards). { sp: null } when three accidentals would be needed; odd: a double one.
  function moveSp(sp, midiNew, from, to, dm){
    var m = /^([A-G])(##|x|bb|#|b)?$/.exec(sp || ""); if (!m) return { sp: null };
    var dl = (L7.indexOf(String(to).charAt(0).toUpperCase()) - L7.indexOf(String(from).charAt(0).toUpperCase()) + 7) % 7;
    if (dm < 0 && dl > 0) dl -= 7; else if (dm === 0 && dl > 3) dl -= 7;
    var x = onLetter(stepLetter(m[1], dl), midiNew);
    return Math.abs(x.acc) > 2 ? { sp: null } : { sp: x.name, odd: Math.abs(x.acc) === 2 };
  }
  var TICKS = RULES.ticks;
  // a position that is a triplet slot (a third of a beat) and not a half beat or a beat
  function isTripPos(p, beat){ var q = p * 3 / beat; return beat === 2 && Math.abs(q - Math.round(q)) < 1e-4 && (((Math.round(q) % 3) + 3) % 3) !== 0; }
  // a length or position that needs sixteenths (a half unit), as opposed to triplets (thirds of a unit)
  function needsSixteenth(x){ return Math.abs(x * 2 - Math.round(x * 2)) < 1e-4 && Math.round(x * 2) % 2 !== 0; }
  // One bar of the tune as ABC. chords: { unit: symbol }; notes: [{ pos, dur, midi, midis, tie, stac, graces }] in units; per: units in the bar;
  // scale: ticks (written length steps) per unit, 1 or 2 for sixteenths; o: { beat (units), beam: "beat" | "half" | "none", tie: "none" | "mid" | "beat" }.
  //   beam: notes of an eighth or less are joined (no space between them) within a beat, or within half a bar; rests and a longer note end the group.
  //   tie:  "mid": a note that starts after the bar's first beat and crosses the middle of the bar is written as two tied notes;
  //         "beat": and a note that starts off the beat and crosses a beat is split at the beat as well (syncopation written the classical way).
  function tuneBar(chords, notes, per, scale, sp, o){
    o = o || {};
    var beat = o.beat || 2, bpb = per / beat, beamMode = o.beam || "beat", tieMode = o.tie || "none", i, state = {};
    function key6(x){ return Math.round(x * 1e6) / 1e6; }
    var cut = {}; function addCut(p){ cut[key6(p)] = 1; }
    addCut(0); addCut(per);
    Object.keys(chords).forEach(function (p){ addCut(+p); });
    var cells = {};                                                           // beats written as triplets
    notes.forEach(function (n){
      var e = n.pos + n.dur; addCut(n.pos); addCut(e);
      [n.pos, e].forEach(function (p){ if (isTripPos(p, beat)) cells[Math.floor(p / beat + 1e-6)] = 1; });
    });
    Object.keys(cells).forEach(function (c){ c = +c; var j; for (j = 0; j <= 3; j++) addCut(c * beat + j * beat / 3); });
    if (tieMode !== "none") notes.forEach(function (n){
      var e = n.pos + n.dur, mid = per / 2, hasMid = bpb >= 4 && bpb % 2 === 0, b, onBeat = Math.abs(n.pos / beat - Math.round(n.pos / beat)) < 1e-6;
      if (hasMid && n.pos > 1e-6 && n.pos < mid - 1e-6 && e > mid + 1e-6) addCut(mid);
      if (tieMode === "beat" && !onBeat) for (b = 1; b < bpb; b++) if (b * beat > n.pos + 1e-6 && b * beat < e - 1e-6) addCut(b * beat);
    });
    var pts = Object.keys(cut).map(Number).sort(function (a, b){ return a - b; }).filter(function (p){ return p <= per + 1e-9; });
    var groupSize = beamMode === "half" && bpb % 2 === 0 && bpb >= 4 ? per / 2 : beat;
    var toks = [], restFrom = null, lead = "";
    function lenTok(ticks){ return ticks === 1 ? "" : String(ticks); }
    function addTok(text, a, units, isNote, grp){ toks.push({ text: text, a: a, end: a + units, beam: isNote && units <= 1 + 1e-6 && beamMode !== "none", grp: grp != null ? grp : "n" + Math.floor((a + 1e-6) / groupSize) }); }
    function flushRest(to){
      if (restFrom == null) return;
      var len = Math.round((to - restFrom) * scale), at = restFrom;
      while (len > 0){ var t = TICKS.filter(function (x){ return x <= len; })[0]; addTok(lead + "z" + lenTok(t), at, t / scale, false); lead = ""; len -= t; at += t / scale; }
      restFrom = null;
    }
    // one pitch: its accidental only where it differs from what the key (or an earlier note of this bar) has for that letter and octave
    // (o.spelled: the spelling of each note, from spellMel; a note's typed sp when there is none; the other pitches of a chord and the grace notes take the key's)
    function pitchOf(midi, sx){
      sx = sx || sp.spell(midi); if (sx.oct == null) sx = { letter: sx.letter, acc: sx.acc, oct: Math.floor((midi - sx.acc) / 12) - 1 };
      var kk = sx.letter + sx.oct, cur = state[kk] == null ? sp.sig[sx.letter] : state[kk], show = cur !== sx.acc;
      state[kk] = sx.acc;
      return (show ? (sx.acc > 0 ? "^" : sx.acc < 0 ? "_" : "=").repeat(Math.max(1, Math.abs(sx.acc))) : "") + (sx.oct >= 5 ? sx.letter.toLowerCase() : sx.letter) + (sx.oct >= 6 ? "'".repeat(sx.oct - 5) : sx.oct <= 3 ? ",".repeat(4 - sx.oct) : "");
    }
    function noteAt(a, b){ var n = null; notes.forEach(function (x){ if (x.pos <= a + 1e-6 && x.pos + x.dur >= b - 1e-6) n = x; }); return n; }
    function nsp(n, m){ if (m !== n.midi) return null; var i = notes.indexOf(n); return (o.spelled && o.spelled[i]) || parseSp(n.sp, n.midi); }
    function pitchText(n, first){
      var ms = n.midis && n.midis.length > 1 ? n.midis : [n.midi], g = "";
      if (first && n.graces && n.graces.length) g = "{/" + n.graces.map(function (m){ return pitchOf(m); }).join("") + "}";
      return g + (n.stac ? "." : "") + (ms.length > 1 ? "[" + ms.map(function (m){ return pitchOf(m, nsp(n, m)); }).join("") + "]" : pitchOf(ms[0], nsp(n, ms[0])));
    }
    function more(n, b){ return b < n.pos + n.dur - 1e-6 || (n.tie && b >= n.pos + n.dur - 1e-6); }
    for (i = 0; i + 1 < pts.length; i++){
      var a = pts[i], b = pts[i + 1], cellIdx = Math.floor(a / beat + 1e-6);
      if (chords[a] != null || chords[key6(a)] != null){ flushRest(a); lead = '"' + (chords[a] != null ? chords[a] : chords[key6(a)]) + '"'; }
      if (cells[cellIdx] && Math.abs(a - cellIdx * beat) < 1e-6){
        // a beat written as triplets: its segments are the slots, joined under one (3
        flushRest(a);
        var ce = (cellIdx + 1) * beat, cellToks = [], j = i, slot = beat / 3, segs = [];
        while (j + 1 < pts.length && pts[j] < ce - 1e-6){
          var ca = pts[j], cb = pts[j + 1], cn = noteAt(ca, cb), slots = Math.round((cb - ca) / slot), pv = segs[segs.length - 1];
          if (pv && ((!cn && !pv.n) || (cn && pv.n === cn && Math.abs(ca - cn.pos) > 1e-6)) && !(j > i && chords[key6(ca)] != null)){ pv.slots += slots; pv.b = cb; }
          else segs.push({ a: ca, b: cb, n: cn, slots: slots, lead: (j > i && chords[key6(ca)] != null) ? '"' + chords[key6(ca)] + '"' : null });
          j++;
        }
        segs.forEach(function (sg){
          if (sg.lead != null) lead = sg.lead;
          if (!sg.n) cellToks.push({ text: lead + "z" + lenTok(sg.slots * scale), a: sg.a, note: false });
          else cellToks.push({ text: lead + pitchText(sg.n, Math.abs(sg.a - sg.n.pos) < 1e-6) + lenTok(sg.slots * scale) + (more(sg.n, sg.b) ? "-" : ""), a: sg.a, note: true });
          lead = "";
        });
        var cellText = cellToks.map(function (t, x){ return (x && !(cellToks[x - 1].note && t.note) ? " " : "") + t.text; }).join("");
        addTok((cellToks.length === 3 ? "(3" : "(3:2:" + cellToks.length) + cellText, a, beat, false, "c" + cellIdx);
        i = j - 1; continue;
      }
      var n = noteAt(a, b);
      if (!n){ if (restFrom == null) restFrom = a; continue; }
      flushRest(a);
      var pitch = pitchText(n, Math.abs(a - n.pos) < 1e-6), len = Math.round((b - a) * scale), at2 = a, mo = more(n, b);
      while (len > 0){
        var t = TICKS.filter(function (x){ return x <= len; })[0]; len -= t;
        addTok(lead + pitch + lenTok(t) + (len > 0 || mo ? "-" : ""), at2, t / scale, true); lead = ""; at2 += t / scale;
        pitch = (n.stac ? "." : "") + (n.midis && n.midis.length > 1 ? "[" + n.midis.map(function (m){ return pitchOf(m, nsp(n, m)); }).join("") + "]" : pitchOf(n.midi, nsp(n, n.midi)));   // (a tied piece repeats the pitch; the grace notes only once)
      }
    }
    flushRest(per);
    var out = "";
    toks.forEach(function (t, x){ var prev = toks[x - 1]; out += (x ? (prev.beam && t.beam && prev.grp === t.grp && Math.abs(prev.end - t.a) < 1e-6 ? "" : " ") : "") + t.text; });
    return out;
  }
  // the melody as the band plays it: per bar [{ pos, dur, midi }] in beats (one entry for each pitch of a chord), a tie into the next bar made one long note. `mel` may have holes.
  function playable(mel, upb){
    var out = [], skip = {}, i, k;
    mel = mel || [];
    function u(i){ return typeof upb === "number" ? upb : (upb && upb[i]) || 2; }
    for (i = 0; i < mel.length; i++){
      var b = mel[i]; if (!b){ out.push([]); continue; }
      var o = [];
      for (k = 0; k < b.length; k++){
        if (skip[i + ":" + k]) continue;
        var n = b[k], d = n.dur / u(i), at = n, bi = i;
        while (at.tie && mel[bi + 1] && mel[bi + 1][0] && mel[bi + 1][0].midi === n.midi && mel[bi + 1][0].pos === 0){ at = mel[bi + 1][0]; d += at.dur / u(bi + 1); skip[(bi + 1) + ":0"] = 1; bi++; }
        (n.midis && n.midis.length ? n.midis : [n.midi]).forEach(function (m){ var e = { pos: n.pos / u(i), dur: n.stac ? d * 0.5 : d, midi: m }; if (n.sp && m === n.midi) e.sp = n.sp; o.push(e); });
      }
      out.push(o);
    }
    return out;
  }
  // A parsed chart (TuneChart.parse) with a melody over its bars (`mel`, per source bar, in units) as ABC: the same bars, repeats, endings and
  // section names, with the notes written in. o = { title, sections: [name or null per bar] }. Written in eighths (sixteenths when the line needs them).
  function melodyAbc(parsed, mel, o){
    o = o || {};
    var n = parsed.meterN || 4, d = parsed.meterD || 4, den = Math.max(8, d), key = parsed.keyField || "C", sp = spelling(key), prev = n + "/" + d;
    var fine = false; (mel || []).concat(o.pickup ? [o.pickup.notes] : []).forEach(function (b){ (b || []).forEach(function (m){ if (needsSixteenth(m.pos) || needsSixteenth(m.dur)) fine = true; }); });
    var parts = [], cur = [], full = 0, chs = parsed.bars.map(function (bar){
      var bm = bar.meter || { n: n, d: d }, perFull = bm.n * den / bm.d, per = perFull, ch = {};
      if (bar.anacrusis) per = Math.round(bar.lengthUnits / (bar.fullUnits || parsed.unitsPerBar) * perFull * 1e6) / 1e6;
      (bar.chords || []).forEach(function (c){ if (c.nc) return; var u = Math.round(c.onset / (bar.fullUnits || parsed.unitsPerBar) * perFull); if (u < per) ch[u] = c.sym; });
      return ch; });
    var hasPick = !!(o.pickup && o.pickup.notes && o.pickup.notes.length), spelled = spellMel(hasPick ? [{}].concat(chs) : chs, hasPick ? [o.pickup.notes].concat(mel || []) : (mel || []), key);
    if (hasPick) var spPick = spelled.shift();
    // a pickup that only the melody has (the changes start on the downbeat): a short first bar of its own, on the first line after its P:
    if (o.pickup && o.pickup.notes && o.pickup.notes.length){
      var gp = geoOf(n, d), pper = Math.round(o.pickup.beats * gp.beat * 1e6) / 1e6;
      var lead = tuneBar({}, o.pickup.notes, pper, fine ? 2 : 1, sp, { beat: gp.beat, beam: o.beam, tie: o.tie, spelled: spPick }) + " |";
    }
    function flush(){ if (cur.length) parts.push(cur.join(" ")); cur = []; full = 0; }
    parsed.bars.forEach(function (bar, bi){
      var bm = bar.meter || { n: n, d: d }, perFull = bm.n * den / bm.d, per = perFull, ch = {}, mark = "";
      if (bar.anacrusis) per = Math.round(bar.lengthUnits / (bar.fullUnits || parsed.unitsPerBar) * perFull * 1e6) / 1e6;       // the chart's own pickup bar: short
      (bar.chords || []).forEach(function (c){ if (c.nc) return; var u = Math.round(c.onset / (bar.fullUnits || parsed.unitsPerBar) * perFull); if (u < per) ch[u] = c.sym; });
      if (!bar.anacrusis && bm.n + "/" + bm.d !== prev){ prev = bm.n + "/" + bm.d; mark = "[M:" + prev + "] "; }
      var sec = o.sections && o.sections[bi];
      if (sec){ flush(); parts.push("P:" + sec); }
      if (lead){ cur.push(lead); lead = null; }
      var left = bar.left === "repeat-open" ? "|: " : "", end = bar.ending ? "[" + bar.ending + " " : "";
      var text = tuneBar(ch, (mel && mel[bi]) || [], per, fine ? 2 : 1, sp, { beat: geoOf(bm.n, bm.d).beat, beam: o.beam, tie: o.tie, spelled: spelled[bi] });
      var right = bar.right === "repeat-close" ? ":|" : bar.right === "final" ? "|]" : "|";
      cur.push(left + end + mark + text + " " + right); if (!bar.anacrusis) full++;      // (a pickup bar rides on the first line: it is not one of its four)
      if (full >= 4) flush();
    });
    flush();
    var body = []; parts.forEach(function (x){ body.push(x); });
    return "X:1\nT:" + (o.title || parsed.title || "Tune") + "\nM:" + n + "/" + d + "\nL:1/" + (den * (fine ? 2 : 1)) + "\nK:" + key + "\n" + body.join("\n").replace(/\|: \[/g, "|: [") + "\n";
  }


  // ---- a take: everything played against a click, from the keys to the written bars ----
  // The page feeds it what the keyboard sends (times in ms from the first downbeat after the count-in; negative in the count-in) and it decides:
  //   which notes are chords and which melody (kind "chords", "melody", or "both" with a split key: below it chords, from it up melody),
  //   when the pedal (CC 80) changes the bar length, where each chord goes (swing, snap), and, at finish(), how the melody is written.
  // Nothing in it touches the page or the clock, so the same events give the same bars anywhere: log() is what happened, replay(log) does it again.
  //   cfg: kind, n, d (the opening meter), bars, beatSec, count (beats of count-in), key, slash, settle (ms, a chord closes this long after its first note),
  //   chordMs (melody notes this close are one strike), poly (a strike of several notes is written as a chord), res (1 eighths, 0.5 sixteenths),
  //   beam ("beat" | "half" | "none"), tie ("none" | "mid" | "beat": syncopations tied across the bar's middle / every beat), detached ("rest" | "staccato"),
  //   ends ("simple" | "played": a long note before a rest ends where it is plainest to write, or at its release),
  //   triplets ("off" | "auto"), pickup ("off" | "auto": notes before the first downbeat make a pickup bar; pickupBeats forces its length), graceMs (0 off; a note whose next starts within this many ms is a grace note of it),
  //   swing (0 straight, else where the off-beat sits), snap ("bar" "half" "beat" "eighth"), split (midi), free (false: the bars are the grid's own),
  //   grid (the grid to use when free is false), onChord(rec, placed) when one lands, onChordRec(rec) for every chord closed, onLayout(layout), baseAbc (the chords, for the log, when free is false).
  function take(cfg){
    cfg = Object.assign({ kind: "chords", n: 4, d: 4, bars: 1, beatSec: 0.5, count: 4, key: "C", slash: false, settle: RULES.settleMs, chordMs: RULES.togetherMs, poly: false, res: 1, swing: 0, snap: "half", split: 60, free: true, beam: "beat", tie: "none", detached: "rest", ends: "simple", triplets: "off", graceMs: 0, pickup: "off", pickupBeats: null }, cfg || {});
    var kl = keyLof(cfg.key), free = cfg.free !== false, g = cfg.grid || grid({ n: cfg.n, d: cfg.d }), changes = [], lay, events = [];
    var lis = listener({ mode: "live", settle: cfg.settle }), ln = line({ chord: cfg.chordMs / 1000 / cfg.beatSec, poly: cfg.poly, grace: cfg.graceMs / 1000 / cfg.beatSec }), ped = meterPedal();
    var tr = { chords: [], pedal: [], notes: [] }, done = false, pickupBeats = 0;
    function starts(list){ var t = 0; return list.map(function (x){ var o = Object.assign({}, x); o.start = t; o.len = x.bpb; t += x.bpb; return o; }); }
    if (free){ lay = layout({ n: cfg.n, d: cfg.d, bars: cfg.bars }); g.setLayout(lay); } else lay = starts(g.geoList());
    function beat(t){ return t / 1000 / cfg.beatSec; }
    function locate(b){                                                      // beats from the first downbeat -> { bar, rel } (bar -1: the last bar of the count-in)
      if (b < 0) return b < -RULES.early ? null : { bar: -1, rel: b + cfg.count };
      for (var i = 0; i < lay.length; i++) if (b < lay[i].start + lay[i].len - 1e-9) return { bar: i, rel: b - lay[i].start };
      return null;
    }
    function placeChord(c){
      var rec = { t: r2(c.t), beat: r2(beat(c.t)), midis: c.midis.slice() }; tr.chords.push(rec);
      placeRec(c, rec);
      if (rec.placed && cfg.onChord) cfg.onChord(rec, rec.placed);
      if (cfg.onChordRec) cfg.onChordRec(rec);
    }
    function placeRec(c, rec){
      var r = analyse(c.midis, { keyLof: kl, all: true });
      if (!r){ rec.out = "not a chord: fewer than two different notes"; return; }
      rec.reading = symbol(r, { keyLof: kl, slash: cfg.slash }); rec.exact = r.exact; rec.candidates = r.candidates;
      var at = locate(rec.beat); if (!at){ rec.out = "dropped: outside the bars"; return; }
      var gg = g.geo(Math.max(0, at.bar)), pos = at.rel; rec.barRel = r2(pos);
      if (cfg.swing > 0.5 && !gg.compound){ pos = unswing(pos, cfg.swing); rec.unswung = r2(pos); }
      var placed = g.place(rec.reading, at.bar, pos, cfg.snap);
      rec.out = placed ? "placed in bar " + (placed.bar + 1) + ", unit " + placed.pos + " (snap: " + cfg.snap + ")" : "dropped: outside the bars"; rec.placed = placed;
    }
    function drain(list){ list.forEach(placeChord); }
    function tick(t){ var d; while ((d = lis.due()) != null && d <= t) drain(lis.poll(d + 0.001)); }
    function toChord(m){ return cfg.kind === "chords" || (cfg.kind === "both" && m < cfg.split); }
    function toLine(m){ return cfg.kind === "melody" || (cfg.kind === "both" && m >= cfg.split); }
    var api = {
      cfg: cfg, grid: g, trace: tr,
      layout: function (){ return lay; }, changes: function (){ return changes.slice(); },
      beat: beat, hits: function (){ return ped.hits(); }, pedalDown: function (){ return ped.isDown(); },
      on: function (m, v, t){
        events.push({ t: Math.round(t * 10) / 10, k: "on", n: m, v: r2(v == null ? 0.7 : v) }); tick(t);
        if (free && ped.isDown()) ped.strike(beat(t));
        if (toChord(m)) drain(lis.noteOn(m, t));
        if (toLine(m)) ln.on(m, beat(t));
      },
      off: function (m, t){
        events.push({ t: Math.round(t * 10) / 10, k: "off", n: m }); tick(t);
        if (toChord(m)) drain(lis.noteOff(m, t));
        if (toLine(m)) ln.off(m, beat(t));
      },
      cc: function (num, val, t){
        if (num !== 80) return;
        events.push({ t: Math.round(t * 10) / 10, k: "cc", n: num, v: val }); tick(t);
        if (!free){ tr.pedal.push({ t: r2(t), out: "ignored: the bars are already entered" }); return; }
        if (val >= 64){ ped.down(); tr.pedal.push({ t: r2(t), beat: r2(beat(t)), down: true }); return; }
        var rec = tr.pedal[tr.pedal.length - 1], hs = ped.hits().map(r2), r = ped.up(); if (!r || !rec) return;
        rec.strikes = hs; rec.upBeat = r2(beat(t));
        if (r.error){ rec.out = "no change: the pedal heard " + r.error; return; }
        var prev = changes[changes.length - 1];
        if (prev && r.at <= prev.at){ rec.out = "no change: before the last change (beat " + prev.at + ")"; return; }
        changes.push({ at: r.at, len: r.len }); lay = layout({ n: cfg.n, d: cfg.d, bars: cfg.bars, changes: changes }); g.setLayout(lay);
        rec.out = "bars of " + r.len + " beat" + (r.len === 1 ? "" : "s") + " from beat " + r.at;
        if (cfg.onLayout) cfg.onLayout(lay);
      },
      tick: tick,
      // end of the take: the chord still open closes, the melody is written into the grid
      finish: function (){
        if (done) return api; done = true; tick(Infinity);
        if (cfg.kind !== "chords"){
          var last = lay[lay.length - 1], end = last ? last.start + last.len : 0, ns = ln.notes(end), geo = g.geoList(), pk = 0;
          // notes before the first downbeat (more than the early margin): with pickup "auto" they are written as a short bar in front of bar 1
          // (with pickupBeats given, a note more than half of it before the downbeat is enough: a half-beat pickup is not lost to the early margin)
          if (cfg.pickup === "auto" && ns.length && ns[0].on < (cfg.pickupBeats ? -cfg.pickupBeats / 2 : -RULES.early)){
            pk = cfg.pickupBeats || Math.min(cfg.count, Math.ceil(-ns[0].on - 1e-6));
            ns = ns.map(function (n){ return Object.assign({}, n, { on: n.on + pk, off: n.off + pk }); });
            geo = [g.pickupGeo(pk)].concat(geo); g.insertPickup(pk); pickupBeats = pk; tr.pickup = pk;
          }
          g.setMelody(quantizeLine(ns, { bars: geo, res: cfg.res, swing: cfg.swing, triplets: cfg.triplets, detached: cfg.detached, ends: cfg.ends, trace: tr.notes }));
        }
        return api;
      },
      pickup: function (){ return pickupBeats; },
      abc: function (o){ return g.toAbc(Object.assign({ key: cfg.key, beam: cfg.beam, tie: cfg.tie }, o || {})); },
      log: function (){
        var c = {}; ["kind", "n", "d", "bars", "beatSec", "count", "key", "slash", "settle", "chordMs", "poly", "res", "swing", "snap", "split", "beam", "tie", "detached", "ends", "triplets", "graceMs", "pickup", "pickupBeats"].forEach(function (k){ c[k] = cfg[k]; });
        c.free = free; if (!free) c.baseAbc = cfg.baseAbc || null;
        return { v: 1, cfg: c, events: events.slice() };
      }
    };
    return api;
  }
  // replay(log): the same take again from its log (ChordEntry.take(...).log()). Needs TuneChart when the take was over chords already entered.
  function replay(log){
    var c = Object.assign({}, log.cfg);
    if (c.free === false){ var g = grid({ n: c.n, d: c.d }); if (c.baseAbc && global.TuneChart) g.load(global.TuneChart.parse(c.baseAbc)); c.grid = g; }
    var t = take(c);
    log.events.map(function (e, i){ return { e: e, i: i }; }).sort(function (a, b){ return a.e.t - b.e.t || a.i - b.i; }).forEach(function (x){
      var e = x.e; if (e.k === "on") t.on(e.n, e.v, e.t); else if (e.k === "off") t.off(e.n, e.t); else t.cc(e.n, e.v, e.t); });
    return t.finish();
  }


  // ---- "do what I mean": the same playing, read in the other ways it could have been meant ----
  // alternatives(log, from, to, o): the bars from..to (0-based, inclusive) of a take (its log), written each way the settings allow, with only the ways
  // that come out differently kept. Each: { id, label, why, abc (those bars), score, lost (played notes not written), melody (those bars, to put in place), suggested }.
  // The score is a cost: a played note left out counts most, then how far notes were moved to reach the grid, then notes, rests, ties and tuplets (fewer is plainer). `suggested` marks the cheapest if it beats the current reading.
  var VARIANTS = [
    { id: "staccato", label: "Detached notes as staccato notes", why: "A note followed by a rest as long as itself becomes one staccato note of both: eighth notes with eighth rests read as staccato quarters.",
      on: function (c){ return c.detached !== "staccato"; }, patch: { detached: "staccato" } },
    { id: "rests", label: "Detached notes as a note and a rest", why: "Each short note is written as played, with the rest after it.",
      on: function (c){ return c.detached === "staccato"; }, patch: { detached: "rest" } },
    { id: "plain-ends", label: "Long notes before a rest: the plainest nearby length", why: "A note held and let go before a rest ends where the note and the rest are simplest to write: a quarter, not a dotted eighth and a sixteenth rest.",
      on: function (c){ return c.ends === "played"; }, patch: { ends: "simple" } },
    { id: "played-ends", label: "Long notes before a rest: as released", why: "A note held and let go before a rest ends where it was released, to the nearest grid step.",
      on: function (c){ return c.ends !== "played"; }, patch: { ends: "played" } },
    { id: "triplets", label: "Triplets where the playing fits", why: "A beat whose notes fall nearer thirds of the beat than the eighth-note grid is written as a triplet (simple meters).",
      on: function (c){ return c.triplets !== "auto"; }, patch: { triplets: "auto" } },
    { id: "no-triplets", label: "No triplets", why: "Everything is put on the eighth-note (or sixteenth) grid.",
      on: function (c){ return c.triplets === "auto"; }, patch: { triplets: "off" } },
    { id: "straight", label: "Read as straight eighths", why: "The off-beats are taken to be where they were played, not swung late.",
      on: function (c){ return c.swing > 0.5; }, patch: { swing: 0 } },
    { id: "swung", label: "Read as swung eighths", why: "Late off-beats are put back on the even half beat, as a lead sheet writes swing.",
      on: function (c){ return !(c.swing > 0.5); }, patch: function (c){ return { swing: swingFor(60 / c.beatSec) }; } },
    { id: "sixteenths", label: "Allow sixteenth notes", why: "The shortest note is a sixteenth, so quick runs keep every note.",
      on: function (c){ return c.res >= 1; }, patch: { res: 0.5 } },
    { id: "eighths", label: "Eighth notes at the shortest", why: "Nothing shorter than an eighth is written.",
      on: function (c){ return c.res < 1; }, patch: { res: 1 } },
    { id: "grace", label: "Very short notes as grace notes", why: "A note struck just before another (under 80 ms) is a grace note of it, not a note of its own.",
      on: function (c){ return !c.graceMs; }, patch: { graceMs: 80 } },
    { id: "no-grace", label: "No grace notes", why: "Short notes are written as notes where they fall.",
      on: function (c){ return c.graceMs > 0; }, patch: { graceMs: 0 } },
    { id: "chords", label: "Notes struck together as chords", why: "Notes struck together (like parallel thirds) are stacked in one chord; none is left out.",
      on: function (c){ return !c.poly; }, patch: { poly: true } },
    { id: "top-note", label: "Only the top note of notes struck together", why: "The single line: the lower notes of a pair are left out.",
      on: function (c){ return c.poly; }, patch: { poly: false } }
  ];
  function abcCost(text){
    var body = text.split("\n").slice(5).join(" "), notes = (body.replace(/"[^"]*"/g, "").match(/[A-Ga-g]/g) || []).length, rests = (body.match(/z/g) || []).length, ties = (body.match(/-/g) || []).length,
        tup = (body.match(/\(3/g) || []).length, grace = (body.match(/\{/g) || []).length;
    return notes + 0.5 * rests + 0.7 * ties + 0.5 * tup + 0.3 * grace;
  }
  function alternatives(log, from, to, o){
    o = o || {};
    var c0 = log.cfg, base = replay(log), nb = base.grid.length(), ab = { key: c0.key, beam: o.beam || c0.beam, tie: o.tie || c0.tie };
    from = Math.max(0, Math.min(nb - 1, from | 0)); to = Math.max(from, Math.min(nb - 1, to == null ? from : to | 0));
    function view(t){
      var text = t.grid.slice(from, to).toAbc(ab), tr = t.trace.notes.filter(function (n){ return n.bar - 1 >= from && n.bar - 1 <= to; });
      var lost = tr.filter(function (n){ return /^dropped/.test(n.out || ""); }).length;
      var moved = tr.filter(function (n){ return !/^dropped/.test(n.out || ""); }).reduce(function (a, n){ return a + (n.off || 0); }, 0);
      return { abc: text, lost: lost, score: 3 * lost + 3 * moved + abcCost(text), melody: JSON.parse(JSON.stringify(t.grid.melody().slice(from, to + 1))) };
    }
    var cur = view(base), out = [];
    VARIANTS.forEach(function (v){
      if (!v.on(c0)) return;
      if (c0.kind === "chords") return;
      var patch = typeof v.patch === "function" ? v.patch(c0) : v.patch, r = view(replay({ v: 1, cfg: Object.assign({}, c0, patch), events: log.events }));
      if (r.abc === cur.abc) return;
      out.push({ id: v.id, label: v.label, why: v.why, patch: patch, abc: r.abc, score: r.score, lost: r.lost, melody: r.melody });
    });
    out.sort(function (x, y){ return x.score - y.score; });
    if (out.length && out[0].score < cur.score) out[0].suggested = true;
    return { from: from, to: to, current: { abc: cur.abc, score: cur.score, lost: cur.lost }, variants: out };
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
        var d = e.data, cmd = d[0] & 0xf0, now = global.performance.now(), t = e.timeStamp;
        if (!(t > 0) || Math.abs(t - now) > 1000) t = now;   // some systems stamp MIDI from another clock: hours off, a take of thousands of bars
        if (cmd === 0x90 && d[2] > 0) h.on(d[1], d[2] / 127, t); else if (cmd === 0x80 || cmd === 0x90) h.off(d[1], t);
      }
      function bind(){ var names = []; a.inputs.forEach(function (i){ i.onmidimessage = msg; names.push(i.name || "MIDI input"); }); if (h.inputs) h.inputs(names); }
      a.onstatechange = bind; bind();
      return a;
    });
  }

  global.ChordEntry = { spellNotes: spellNotes, spellMel: spellMel, moveSp: moveSp, chordSpell: chordSpell, connect: connect, QUALITIES: QUALITIES, analyse: analyse, symbol: symbol, keyLof: keyLof, lofName: lofName,
    listener: listener, grid: grid, unswing: unswing, line: line, quantizeLine: quantizeLine, spelling: spelling, geoOf: geoOf, layout: layout, meterPedal: meterPedal, take: take, replay: replay, alternatives: alternatives, RULES: RULES, swingFor: swingFor, playable: playable, melodyAbc: melodyAbc };
})(typeof window !== "undefined" ? window : globalThis);
