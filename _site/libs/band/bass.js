// bass.js — upright bass part for the jazz band engine (needs harmony.js).
// Walking quarter notes by default, or a two-feel when ctx.opts.bassFeel === "two".
// Variation (ctx.opts.variation, 0..1; unset = 0 = each pattern exactly): how freely the player
// departs from the pattern. Walking gains the odd skip note or a held half note; the two-feel a 3rd
// in place of the 5th or a dotted rhythm; the riff has relatives (a climb, an octave pop, a sparse
// bar, an approach into the next chord) that turn up away from the top of a phrase, mostly at its end.
// "riffwalk" is the riff with a little walking: the last bar of some four-bar phrases (now and then the
// last two) is walked in quarter notes into the next phrase, where the riff picks up again.
// Stop time (ctx.stop): a short root on beat 1, silence through beat 2, then a lead-in to the next
// bar's root on the last beats (eighths in the riff feel, quarters otherwise).
// Any number of beats to the bar: 3/4 walks three quarters; in the compound meters (ctx.compound:
// 6/8, 9/8, 12/8) a beat is a dotted quarter, the line walks one note per beat with some pickup
// eighths (written x.5 = the beat's third eighth), and the riff becomes a shuffle figure.
//
// Set lines (ctx.opts.bassFeel = a LINES id: roots, alt, bossa, tango, tumbao, chacha): a fixed
// rhythm of roots and fifths, the same every bar, for the Latin and dance styles.
//
//   var bass = BandBass.create({ rng });   // rng() -> [0,1); all randomness goes through it
//   bass.bar(ctx)    -> [{ pos, dur, midi, vel }]   one bar (ctx = the band's bar context)
//   bass.ending(ctx) -> the final long root
//   bass.reset()
//
// Walking line, per bar: beat 1 is the root whenever the chord changed; the last beat is an
// approach note into the next bar's beat 1 (semitone, scale step or the target's dominant);
// the beats in between are found by a small scored search that prefers steps and arpeggio
// thirds, chord tones on the strong beat, and lines that keep their direction. The best few
// lines are chosen between at random, so choruses differ but stay in the idiom.

(function (global) {
  var LO = 28, HI = 55, MID = 40.5;                     // E1..G3, centred around the open-string register
  // score for each melodic interval (semitones); intervals not listed are never played
  var STEP = { 1: 2.4, 2: 3.0, 3: 2.0, 4: 2.0, 5: 1.0, 7: 1.0, 8: -1.0, 9: -1.0, 12: -0.6 };

  function mod12(n){ return ((n % 12) + 12) % 12; }
  function inRange(n){ return n >= LO && n <= HI; }
  function withPc(pc){ var out = []; for (var n = LO; n <= HI; n++) if (mod12(n) === pc) out.push(n); return out; }
  function rangePen(n){ var d = n - MID; return -0.016 * d * d; }       // steer back toward the middle
  function ivOf(chord, n){ return mod12(n - chord.root); }
  function isTone(chord, n){ return chord.tones.indexOf(ivOf(chord, n)) >= 0; }
  function inScale(chord, n){ return chord.scale.indexOf(ivOf(chord, n)) >= 0; }
  // keep going the same way; a leap may turn back; no a-b-a wobble
  function dirScore(a, b, c){
    if (a == null) return 0;
    if (c === a) return -1.6;
    var d1 = b - a, d2 = c - b;
    if ((d1 > 0) === (d2 > 0)) return 0.9;
    return Math.abs(d1) >= 5 ? 0.5 : -0.7;
  }
  // approach notes into target `t`, best first: chromatic, scale step, dominant
  function approachesTo(t, from, to){
    var out = [{ n: t - 1, bonus: 3.0 }, { n: t + 1, bonus: 2.5 }];
    [t - 2, t + 2].forEach(function (x){
      if (inScale(from, x)) out.push({ n: x, bonus: 2.4 + (isTone(from, x) ? 0.4 : 0) });
      else if (to && inScale(to, x)) out.push({ n: x, bonus: 1.6 });
    });
    [t + 7, t - 5].forEach(function (x){ out.push({ n: x, bonus: 1.4 + (isTone(from, x) ? 0.4 : 0) }); });
    return out;
  }
  function firstChord(chords){
    var c = chords && chords.length && chords[0].pos === 0 ? chords[0].chord : null;
    return (c && !c.nc) ? c : null;
  }
  // the bar as runs of beats under one chord (chord null = N.C.)
  function segmentsOf(ctx){
    var segs = [], H = global.BandHarmony;
    for (var b = 0; b < ctx.beats; b++){
      var c = H.chordAt(ctx.chords, b), last = segs[segs.length - 1];
      if (last && ((!c && !last.chord) || (c && last.chord && c.key === last.chord.key))) last.len++;
      else segs.push({ start: b, len: 1, chord: c });
    }
    return segs;
  }

  // candidates for a free beat: [{ notes:[n], add, dir }] (dir = the way a chromatic passing tone must continue)
  function freeCands(u, line, mustDir, span){
    var out = [], last = line[line.length - 1], last2 = line[line.length - 2], strong = u.beat % 2 === 0;
    for (var n = Math.max(LO, last - span); n <= Math.min(HI, last + span); n++){
      var d = Math.abs(n - last), ps = STEP[d]; if (ps === undefined) continue;
      if (mustDir && n - last !== mustDir) continue;
      var ty, pd = 0;
      if (isTone(u.chord, n)) ty = strong ? 2.4 : 1.0;
      else if (inScale(u.chord, n)){
        ty = strong ? -0.6 : 0.9;
        if (u.chord.third === 4 && ivOf(u.chord, n) === 5) ty -= strong ? 1.2 : 0.3;   // the 4th rubs against a major 3rd
      } else {                                      // chromatic passing tone: arrive by step, leave by semitone the same way
        if (d > 2) continue; ty = 0.4; pd = n > last ? 1 : -1;
      }
      out.push({ notes: [n], add: ps + ty + dirScore(last2, last, n) + rangePen(n) + (line.indexOf(n, 2) >= 0 ? -1.0 : 0), dir: pd });
    }
    return out;
  }
  // candidates for reaching the next anchor: [{ notes:[approach, anchor] | [anchor], add, dir:0 }]
  function anchorCands(u, line, mustDir){
    var out = [], last = line[line.length - 1], last2 = line[line.length - 2], anchors = withPc(u.pc);
    for (var a = 0; a < anchors.length; a++){
      var t = anchors[a], d, ps;
      if (u.type === "anchor"){                     // one-beat chord: straight to the next root
        d = Math.abs(t - last); ps = STEP[d]; if (ps === undefined) continue;
        if (mustDir && t - last !== mustDir) continue;
        out.push({ notes: [t], add: ps * 0.6 + dirScore(last2, last, t) + rangePen(t), dir: 0 });
        continue;
      }
      var apps = approachesTo(t, u.from, u.chord);
      for (var k = 0; k < apps.length; k++){
        var x = apps[k].n; if (!inRange(x)) continue;
        d = Math.abs(x - last); ps = STEP[d]; if (ps === undefined) continue;
        if (mustDir && x - last !== mustDir) continue;
        out.push({ notes: [x, t], dir: 0, add: ps + apps[k].bonus + dirScore(last2, last, x) + 0.6 * dirScore(last, x, t)
          + rangePen(x) + rangePen(t) + (line.indexOf(x, 2) >= 0 ? -1.0 : 0) });
      }
    }
    return out;
  }

  // All lines from anchor `s` through the given segments. Each segment after its anchor is
  // free beats, then one approach beat, then the next anchor (the next chord's root, or
  // `target` = next bar's beat 1). Returns [{ line:[before2, before, s, ...], score }].
  function solve(segs, s, before, before2, target){
    var units = [], nFree = 0;
    segs.forEach(function (seg, si){
      var lastSeg = si === segs.length - 1;
      var nxt = lastSeg ? target : { pc: segs[si + 1].chord.bass, chord: segs[si + 1].chord };
      var k;
      if (!nxt){ for (k = 1; k < seg.len; k++){ units.push({ type: "free", chord: seg.chord, beat: seg.start + k }); nFree++; } return; }
      if (seg.len === 1){ units.push({ type: "anchor", pc: nxt.pc, chord: nxt.chord, from: seg.chord }); return; }
      for (k = 1; k < seg.len - 1; k++){ units.push({ type: "free", chord: seg.chord, beat: seg.start + k }); nFree++; }
      units.push({ type: "pair", pc: nxt.pc, chord: nxt.chord, from: seg.chord });
    });
    function cands(u, line, mustDir){ return u.type === "free" ? freeCands(u, line, mustDir, 7) : anchorCands(u, line, mustDir); }

    if (nFree <= 2 && units.length <= 6){
      // the usual bar: small enough to try every line
      var results = [], line = [before2, before, s];
      (function rec(ui, score, mustDir){
        if (ui === units.length){ results.push({ line: line.slice(), score: score }); return; }
        var cs = cands(units[ui], line, mustDir);
        for (var i = 0; i < cs.length; i++){
          var c = cs[i]; Array.prototype.push.apply(line, c.notes);
          rec(ui + 1, score + c.add, c.dir);
          line.length -= c.notes.length;
        }
      })(0, 0, 0);
      return results;
    }
    // long bars / many chords: keep only the best partial lines at each beat
    var beam = [{ line: [before2, before, s], score: 0, dir: 0 }];
    units.forEach(function (u){
      var nextBeam = [];
      beam.forEach(function (b){ cands(u, b.line, b.dir).forEach(function (c){
        nextBeam.push({ line: b.line.concat(c.notes), score: b.score + c.add, dir: c.dir }); }); });
      nextBeam.sort(function (x, y){ return y.score - x.score; });
      beam = nextBeam.slice(0, 24);
    });
    return beam;
  }

  // Set lines: [beat, length in beats, degree]. R = root, 5 = fifth, 8 = the root an octave up,
  // N = the root of whatever chord comes next (an anticipation). Notes past the end of a short bar are dropped.
  var LINES = {
    roots:  function (beats){ var l = []; for (var b = 0; b < beats; b++) l.push([b, 0.9, "R"]); return l; },
    alt:    function (beats){ return beats % 2 ? [[0, 0.9, "R"]] : beats === 2 ? [[0, 0.9, "R"], [1, 0.9, "5"]] : [[0, 0.9, "R"], [2, 0.9, "5"]]; },
    bossa:  [[0, 1.4, "R"], [1.5, 0.45, "5"], [2, 1.4, "5"], [3.5, 0.45, "N"]],
    tango:  [[0, 1.4, "R"], [1.5, 0.45, "5"], [2, 0.9, "8"], [3, 0.9, "5"]],
    tumbao: [[1.5, 1.4, "5"], [3, 0.95, "N"]],
    chacha: [[0, 1.9, "R"], [2, 0.9, "5"], [3, 0.9, "R"]],
    tresillo: [[0, 1.4, "R"], [1.5, 1.4, "R"], [3, 0.9, "5"]],                                          // 3+3+2
    // Rock and pop lines, each written against a drum groove's kick (drums.js GROOVES).
    eighths: function (beats){ var l = []; for (var b = 0; b < beats; b += 0.5) l.push([b, 0.45, "R"]); return l; },      // straight-eighth rock
    octaves: function (beats){ var l = []; for (var b = 0; b < beats; b++){ l.push([b, 0.45, "R"]); l.push([b + 0.5, 0.4, "8"]); } return l; },   // disco: the octave on every off-beat
    dotted:  { bars: [ [[0, 1.4, "R"], [1.5, 0.45, "R"], [2, 1.9, "R"]],                                // 1, the and of 2, 3: with the kick
                       [[0, 1.4, "R"], [1.5, 0.45, "R"], [2, 1.4, "R"], [3.5, 0.45, "N"]] ] },          // every second bar leads into the next root
    motown:  { rise: true, top: 12, bars: [ [[0, 1.4, "R"], [1.5, 0.45, "R"], [2, 0.9, "5"], [3, 0.45, "8"], [3.5, 0.45, "5"]],
                                            [[0, 1.4, "R"], [1.5, 0.45, "R"], [2, 0.9, "5"], [3, 0.45, "5"], [3.5, 0.45, "N"]] ] },
    // Hymns and carols. hold: each note lasts until the next one, or to the end of its chord or bar.
    held:    { hold: true, bars: [ [[0, 8, "R"]] ] },                                                   // the bass voice: the root of each chord, sustained
    halves:  function (beats){ return beats % 2 ? [[0, beats - 0.2, "R"]] : beats === 2 ? [[0, 1.8, "R"]] : [[0, 1.8, "R"], [2, 1.8, "R"]]; },   // the root on 1 and 3
    // 12/8 (or triplets over 4/4): long notes on 1 and 3, each set up by the last eighth of the beat before
    twelve8: [[0, 1.6, "R"], [1 + 2 / 3, 0.3, "R"], [2, 1.6, "5"], [3 + 2 / 3, 0.3, "N"]],
    // Lines from tunes. bars = the pattern bar by bar (it repeats). rise: every degree sits above a low
    // root (6, 7 = the chord's seventh, 9 as well as 5 and 8); below: 5 and 6 sit under the root.
    // L = a semitone under the next bar's root. These were written from memory of the records: check
    // them by ear and correct the tables here.
    songfather: { rise: true, bars: [ [[0, 1.4, "R"], [1.5, 0.45, "5"], [2, 1.9, "8"]] ] },                    // Song for My Father: root, fifth, octave
    killerjoe:  { below: true, bars: [ [[0, 1.9, "R"], [2, 0.9, "5"], [3, 0.9, "L"]],                          // Killer Joe: C . G A | Bb . G B
                                       [[0, 1.9, "R"], [2, 0.9, "6"], [3, 0.9, "L"]] ] },
    sowhat:     { rise: true, bars: [ [[0, 0.9, "R"], [1, 0.45, "5"], [1.5, 0.45, "6"], [2, 0.45, "7"], [2.5, 0.45, "8"], [3, 0.45, "9"], [3.5, 0.45, "7"]],   // So What: D, A B C D E C | D
                                      [[0, 1.4, "8"]] ] },
    // 10 = the third above the octave; top = the highest degree (semitones) the line needs above its root.
    footprints: { rise: true, top: 16, bars: [ [[0, 0.9, "R"], [1, 0.9, "5"], [2, 0.9, "8"]], [[0, 1.9, "10"], [2, 0.9, "5"]] ] },   // Footprints in 3/4: C G C | Eb . G
    allblues:   { rise: true, bars: [ [[0, 0.95, "R"], [1, 0.45, "5"], [1.5, 0.45, "6"]], [[0, 0.95, "7"], [1, 0.45, "6"], [1.5, 0.45, "5"]] ] },   // All Blues in 6/8: G. D E | F. E D
    chameleon:  { below: true, bars: [ [[0, 1.4, "R"], [3, 0.45, "L2"], [3.5, 0.45, "L"]] ] },                  // Chameleon: the root, then two chromatic eighths up into the next root
    maiden:     { bars: [ [[0, 1.4, "R"], [1.5, 1.4, "R"], [3, 1.9, "R"]], [[1.5, 1.4, "5"], [3, 0.9, "R"]] ] },  // Maiden Voyage: roots on the comping rhythm
    takefive:   { bars: [ [[0, 1.4, "R"], [1.5, 1.4, "5"], [3, 0.9, "R"], [4, 0.9, "R"]] ] }                     // Take Five: 3 + 2
  };
  // what a tune's line gives way to after the first chorus when opts.figures === "head"
  var AFTER = { sowhat: "walk", killerjoe: "walk", songfather: "bossa", footprints: "walk", allblues: "walk", chameleon: "riff", maiden: "bossa", takefive: "walk" };

  function create(o){
    var rng = (o && o.rng) || Math.random;
    var st;
    function reset(){ st = { prev: null, prev2: null, pending: null, offRoot: false, walk2: false }; }
    // "riffwalk": is this one of the bars that walks?
    function walksNow(ctx){
      var ph = ctx.phrase || { bar: ctx.index % 4 };
      if (ctx.compound || ctx.beats < 3 || ph.top) return false;
      if (ph.bar === 2){ st.walk2 = rng() < 0.2; return st.walk2; }
      if (ph.bar === 3){ var w = st.walk2 || rng() < 0.5; st.walk2 = false; return w; }
      return false;
    }
    reset();

    function vel(base){ return Math.round((base + (rng() - 0.5) * 0.07) * 1000) / 1000; }
    function vary(ctx){ var v = ctx.opts && +ctx.opts.variation; return v > 0 ? Math.min(1, v) : 0; }
    function heat(ctx){ return ctx.intensity == null ? 0.5 : ctx.intensity; }
    // Walking embellishments (simple meters): one skip note before a beat, or beats 1-2 held as a half note.
    function ornaments(ev, ctx, v){
      var r = rng(), ks = [], k;
      if (r < 0.22 * v * (0.6 + heat(ctx))){
        for (k = 1; k < ev.length; k++) if (ev[k].pos === Math.floor(ev[k].pos) && ev[k - 1].pos === ev[k].pos - 1) ks.push(k);
        if (!ks.length) return ev;
        k = ks[Math.floor(rng() * ks.length)];
        var n = (rng() < 0.6 || !inRange(ev[k].midi - 1)) ? ev[k - 1].midi : ev[k].midi - 1;      // the last note again, or a semitone under the next
        ev[k - 1].dur = 0.5;
        ev.splice(k, 0, { pos: ev[k].pos - 0.5, dur: 0.3, midi: n, vel: vel(0.58) });
      } else if (r > 1 - 0.10 * v && ev.length >= 4 && ev[0].pos === 0 && ev[1].pos === 1 && ev[2].pos === 2 && Math.abs(ev[2].midi - ev[0].midi) <= 5){
        ev[0].dur = 1.9; ev.splice(1, 1);
      }
      return ev;
    }
    // one of the best few lines, weighted toward the best
    function pick(results){
      if (!results.length) return null;
      results.sort(function (a, b){ return b.score - a.score; });
      var top = results[0].score, pool = [], sum = 0, i;
      for (i = 0; i < results.length && i < 5 && results[i].score > top - 1.8; i++){
        var w = Math.exp((results[i].score - top) / 0.9); pool.push({ r: results[i], w: w }); sum += w;
      }
      var r = rng() * sum;
      for (i = 0; i < pool.length; i++){ r -= pool[i].w; if (r <= 0) return pool[i].r; }
      return pool[pool.length - 1].r;
    }
    // the in-range note of pitch class `pc` nearest `ref`, never `ref` itself; `pull` (0..1)
    // weighs staying in the low-middle register against staying close
    function nearestNot(pc, ref, pull){
      var best = null, bd = 1e9;
      withPc(pc).forEach(function (n){ if (n === ref) return; var d = Math.abs(n - ref) + (pull || 0.3) * Math.abs(n - 38); if (d < bd){ bd = d; best = n; } });
      return best;
    }
    // beat-1 note: the one the last bar walked into, if that is still the chord we got
    function startNote(chord, atBarStart, pull){
      var p = st.pending;
      if (atBarStart && p && p.key === chord.key && inRange(p.midi) && p.midi !== st.prev) return p.midi;
      return nearestNot(chord.bass, st.prev != null ? st.prev : 38, pull);
    }
    // where the next bar starts: its root — or, when the chord simply continues, sometimes the 5th or 3rd.
    // Never two bars running off the root: on a long static chord the root keeps landing on a downbeat.
    function targetFor(chord, next){
      if (!next) return null;
      var pc = next.bass;
      if (next.key === chord.key && !st.offRoot){
        var r = rng();
        if (r > 0.88 && next.third != null) pc = mod12(next.root + next.third);
        else if (r > 0.70) pc = mod12(next.root + next.fifth);
      }
      st.offRoot = pc !== next.bass;
      return { pc: pc, chord: next };
    }
    function played(n){ st.prev2 = st.prev; st.prev = n; }
    function aim(target, next){ st.pending = (target != null && next) ? { midi: target, key: next.key } : null; }
    // last resort if the search finds nothing: nearest chord tones, root on each chord change
    function plain(seg, s){
      var out = [s], H = seg.chord;
      for (var k = 1; k < seg.len; k++){
        var last = out[out.length - 1], best = null, bd = 1e9;
        H.tones.forEach(function (iv){ withPc(mod12(H.root + iv)).forEach(function (n){
          if (n === last) return; var d = Math.abs(n - last) + 0.05 * Math.abs(n - MID); if (d < bd){ bd = d; best = n; } }); });
        out.push(best);
      }
      return out;
    }

    function walk(ctx){
      var segs = segmentsOf(ctx), ev = [], next = firstChord(ctx.nextChords), target = null, i = 0;
      while (i < segs.length){
        if (!segs[i].chord){ i++; continue; }
        var j = i; while (j < segs.length && segs[j].chord) j++;       // a run of sounding chords
        var run = segs.slice(i, j), toEnd = j === segs.length;
        var s = startNote(run[0].chord, run[0].start === 0);
        var tg = toEnd ? targetFor(run[run.length - 1].chord, next) : null;
        var res = pick(solve(run, s, st.prev, st.prev2, tg));
        var line;
        if (res){ line = res.line.slice(2); if (tg){ target = line.pop(); } }
        else { line = []; run.forEach(function (seg, k){ line = line.concat(plain(seg, k === 0 ? s : nearestNot(seg.chord.bass, line[line.length - 1]))); });
               if (tg) target = nearestNot(tg.pc, line[line.length - 1]); }
        for (var b = 0; b < line.length; b++){
          var pos = run[0].start + b;
          ev.push({ pos: pos, dur: 0.95, midi: line[b], vel: vel(pos === 0 ? 0.84 : 0.79) });
          played(line[b]);
        }
        i = j;
      }
      aim(target, next);
      if (ctx.compound) ev = pickups(ev, ctx);
      else if (vary(ctx)) ev = ornaments(ev, ctx, vary(ctx));
      return ev;
    }
    // 12/8 and 6/8: some notes are cut short and struck again on the beat's last eighth ("dum, da-dum")
    function pickups(ev, ctx){
      var p = 0.15 + 0.35 * (ctx.intensity == null ? 0.5 : ctx.intensity), out = [];
      ev.forEach(function (e){
        out.push(e);
        if (e.pos !== Math.floor(e.pos) || rng() >= p) return;
        e.dur = 0.6;
        out.push({ pos: e.pos + 0.5, dur: 0.3, midi: e.midi, vel: vel(0.66) });
      });
      return out;
    }

    function two(ctx){
      var segs = segmentsOf(ctx).filter(function (s){ return s.chord; }), beats = ctx.beats;
      var next = firstChord(ctx.nextChords), target = null, list = [];
      if (!segs.length){ st.pending = null; return []; }
      segs.forEach(function (seg, k){                                  // the root of each chord
        var n = k === 0 ? startNote(seg.chord, seg.start === 0, 0.6) : nearestNot(seg.chord.bass, list[list.length - 1].midi, 0.6);
        list.push({ pos: seg.start, midi: n });
      });
      var only = segs.length === 1 && segs[0].start === 0 && segs[0].len === beats && beats >= 4;
      var half = Math.floor(beats / 2), chord = segs[segs.length - 1].chord, root = list[0].midi;
      if (only && ctx.index % 4 === 3 && next){
        // last bar of a 4-bar phrase: walk the second half of the bar into the next one
        var tg = targetFor(chord, next);
        var res = pick(solve([{ start: half - 1, len: beats - half + 1, chord: chord }], root, st.prev, st.prev2, tg));
        if (res){ var ln = res.line.slice(3); target = ln.pop(); ln.forEach(function (n, k){ list.push({ pos: half + k, midi: n }); }); }
      }
      if (only && list.length === 1){
        // beat 3: the 5th (below, or above) — or the root again in the other octave
        var second;
        if (mod12(root) !== chord.bass) second = nearestNot(chord.bass, root);
        else {
          var fifths = withPc(mod12(chord.root + chord.fifth)).filter(function (n){ return Math.abs(n - root) <= 7; });
          var octs = [root - 12, root + 12].filter(inRange);
          // the 5th below by default; above when the root is already low
          var vt = vary(ctx), third = chord.third != null ? root + chord.third : null;
          if (vt && third != null && inRange(third) && rng() < 0.22 * vt) second = third;                 // the 3rd for a change
          else if (fifths.length && (rng() < 0.72 || !octs.length)) second = (fifths.length > 1 && (root < 36 || (root < 44 && rng() < 0.35))) ? fifths[1] : fifths[0];
          else second = octs.length > 1 ? (Math.abs(octs[0] - MID) < Math.abs(octs[1] - MID) ? octs[0] : octs[1]) : octs[0];
        }
        if (second != null) list.push({ pos: half, midi: second });
        // a dotted rhythm: the root again on the off-beat before the second note
        if (second != null && vary(ctx) && half >= 2 && rng() < 0.2 * vary(ctx) * (0.6 + heat(ctx))) list.splice(1, 0, { pos: half - 0.5, midi: root, pickup: true });
      }
      if (target == null && next){
        // sometimes a pickup into the next bar: a quarter note on the last beat, or a swung eighth
        var lastN = list[list.length - 1], r = rng(), ppos = null;
        if (r < 0.18 && lastN.pos < beats - 1) ppos = beats - 1; else if (r < 0.26) ppos = beats - 0.5;
        if (ppos != null){
          var t = nearestNot(next.bass, lastN.midi, 0.6);
          var cands = approachesTo(t, chord, next).filter(function (a){ return inRange(a.n) && a.n !== lastN.midi && Math.abs(a.n - lastN.midi) <= 9; })
            .map(function (a){ return { line: [a.n], score: a.bonus }; });
          var pk = pick(cands);
          if (pk){ list.push({ pos: ppos, midi: pk.line[0], pickup: true }); target = t; }
        }
      }
      var ev = list.map(function (e, k){
        var gap = (k + 1 < list.length ? list[k + 1].pos : beats) - e.pos, lastOne = k + 1 === list.length;
        var dur = gap >= 2 ? gap - (lastOne ? 0.4 : 0.2) : gap >= 1.5 ? gap - 0.1 : gap * (e.pickup ? 0.9 : 0.95);
        return { pos: e.pos, dur: Math.round(dur * 1000) / 1000, midi: e.midi, vel: vel(e.pos === 0 ? 0.84 : e.pickup ? 0.72 : 0.79) };
      });
      list.forEach(function (e){ played(e.midi); });
      aim(target, next);
      return ev;
    }

    // Straight-eighths (boogaloo / rock) riff: root on 1, root pushed on the "and" of 2, then a
    // 5th-b7 (or 5th-6th) pickup back into the next root. Half-bar chords get root + pushed root.
    function riff(ctx){
      var ev = [], next = firstChord(ctx.nextChords), cmp = !!ctx.compound, vr = vary(ctx), ph = ctx.phrase || { bar: 0 };
      var landOn = st.pending;
      function rootOf(chord){
        var best = null, bd = 1e9;                                       // a low root, near where we were
        withPc(chord.bass).forEach(function (n){ var d = Math.abs(n - 36) + (st.prev != null ? 0.3 * Math.abs(n - st.prev) : 0); if (d < bd){ bd = d; best = n; } });
        return best;
      }
      function put(pos, dur, n, v){ if (pos < ctx.beats && inRange(n)){ ev.push({ pos: pos, dur: dur, midi: n, vel: vel(v) }); played(n); } }
      segmentsOf(ctx).forEach(function (seg){
        var c = seg.chord; if (!c) return;
        var r = rootOf(c), s = seg.start;
        // after a walked bar ("riffwalk") the riff starts on the note that bar walked into, not an octave away from it
        if (s === 0 && landOn && landOn.key === c.key && mod12(landOn.midi) === c.bass && landOn.midi <= 48) r = landOn.midi;
        var up = r + 12 <= HI - 5;
        var fifth = r + (c.fifth != null ? c.fifth : 7), sev = r + (c.seventh === 10 ? 10 : c.seventh === 11 ? 9 : c.sixth != null ? 9 : 10);
        if (!up || fifth > HI){ fifth -= 12; sev -= 12; }                // pickup from below when the root sits high
        if (cmp){
          // shuffle: each beat struck twice (long-short), climbing root, 3rd, 5th, 6th or b7th
          var f5 = r + (c.fifth != null ? c.fifth : 7), top = f5 + (c.seventh === 10 || c.quality === "min" || c.quality === "hdim" ? 3 : 2);
          var line = seg.len <= 2 ? [r, f5] : [r, r + (c.third != null ? c.third : c.sus === 2 ? 2 : 5), f5, top];
          for (var k = 0; k < seg.len; k++){
            var n = line[k % line.length], lastBeat = k === seg.len - 1 && s + k === ctx.beats - 1;
            if (vr && lastBeat && k > 0 && next && next.key !== c.key && (ph.bar === 3 || ph.turnaround) && rng() < 0.5 * vr){
              var tn = rootOf(next), lowA = tn - 2 >= LO; put(s + k, 0.6, lowA ? tn - 2 : tn + 2, 0.80); put(s + k + 0.5, 0.3, lowA ? tn - 1 : tn + 1, 0.76); continue; }
            put(s + k, 0.6, n, k === 0 ? 0.86 : 0.80);
            if (!(vr && k > 0 && rng() < 0.2 * vr)) put(s + k + 0.5, 0.3, n, 0.70);          // now and then just the beat
          }
          return;
        }
        // relatives of the riff: never at the top of a phrase, likeliest at its end
        var kind = "base";
        if (vr && seg.len >= 4 && seg.start === 0 && ph.bar !== 0){
          var q = rng(), endP = ph.bar === 3 || ph.turnaround;
          kind = (endP && next && next.key !== c.key && q < 0.6 * vr) ? "approach" : q < 0.22 * vr ? "climb" : q < 0.40 * vr ? "octave" : q < 0.50 * vr ? "sparse" : "base";
        }
        put(s, seg.len >= 3 ? 1.4 : 0.9, r, 0.86);
        if (kind === "sparse"){ put(s + 1.5, 2.3, r, 0.80); return; }
        if (kind === "octave"){ put(s + 1.5, 0.45, r, 0.80); put(s + 2, 0.45, inRange(r + 12) ? r + 12 : r, 0.74); }
        else if (seg.len >= 2) put(s + 1.5, seg.len >= 4 ? 0.9 : 0.45, r, 0.80);
        if (kind === "climb"){ put(s + 2.5, 0.45, fifth, 0.76); put(s + 3, 0.45, fifth + 2, 0.76); put(s + 3.5, 0.45, sev, 0.78); return; }
        if (kind === "approach"){
          var t = rootOf(next), below = t - 2 >= LO;                      // walk into the next root by a whole step and a half step
          put(s + 3, 0.45, below ? t - 2 : t + 2, 0.78); put(s + 3.5, 0.45, below ? t - 1 : t + 1, 0.80); return;
        }
        if (seg.len === 3) put(s + 2, 0.9, fifth, 0.78);                 // 3/4: the 5th on beat 3
        if (seg.len >= 4){
          var same = next && next.key === c.key, v = rng();
          if (same && v < 0.3) put(s + 3, 0.9, fifth, 0.78);             // plainer bar now and then
          else { put(s + 3, 0.45, fifth, 0.78); put(s + 3.5, 0.45, sev, 0.76); }
        }
      });
      st.pending = null; st.offRoot = false;
      return ev;
    }

    // A set line: the pattern's rhythm on the chord sounding at each note. Each chord that the pattern
    // would pass over gets its root where it starts; in a waltz the root and fifth alternate bar by bar.
    function setLine(ctx, id){
      var H = global.BandHarmony, def = LINES[id], pat = typeof def === "function" ? def(ctx.beats) : def.bars ? def.bars[ctx.index % def.bars.length] : def, beats = ctx.beats;
      var next = firstChord(ctx.nextChords), list = [], ev = [], low = null;
      function rootOf(chord){
        var best = null, bd = 1e9;
        withPc(chord.bass).forEach(function (n){ if (def.rise && n + (def.top || 14) > HI) return;
          var d = Math.abs(n - 36) + (low != null && !def.rise ? 0.3 * Math.abs(n - low) : 0); if (d < bd){ bd = d; best = n; } });
        return best;
      }
      pat.forEach(function (p){ if (p[0] < beats - 1e-6) list.push({ pos: p[0], dur: p[1], deg: p[2] }); });
      if (id === "tumbao" && st.prev == null) list.push({ pos: 0, dur: 1.4, deg: "R" });            // the very first bar states the root
      segmentsOf(ctx).forEach(function (seg){
        if (seg.chord && id !== "tumbao" && !list.some(function (e){ return e.pos >= seg.start && e.pos < seg.start + seg.len; }))
          list.push({ pos: seg.start, dur: def.hold ? seg.len : Math.min(0.9, seg.len), deg: "R" });
      });
      // a pushed chord: the next bar's root on the last eighth, held over the barline (the bar after starts late)
      var tied = st.pushed; st.pushed = false;
      if (tied) list = list.filter(function (e){ return e.pos >= 0.5 - 1e-6; });
      if (H.pushes && H.pushes(ctx) && !AFTER[id] && id !== "tumbao"){
        list = list.filter(function (e){ return e.pos < 3.5 - 1e-6; }); list.push({ pos: 3.5, dur: 1.4, deg: "N" }); st.pushed = true; }
      list.sort(function (a, b){ return a.pos - b.pos; });
      var segs = segmentsOf(ctx), lift = !!(ctx.opts && ctx.opts.lift && ctx.opts.lift.indexOf(ctx.index) >= 0 && !ctx.intro);
      // the first note a chord gets is its root, whatever the pattern has there (a fifth under a chord that has just arrived is a wrong note)
      function opens(e, k){
        var s0 = 0; segs.forEach(function (sg){ if (sg.start <= e.pos + 1e-6) s0 = sg.start; });
        return s0 > 0 && !list.some(function (x, j){ return j < k && x.pos >= s0 - 1e-6; });
      }
      list.forEach(function (e, k){
        var c = H.chordAt(ctx.chords, e.pos), deg = e.deg; if (!c) return;
        if ((deg === "5" || deg === "8") && id !== "tumbao" && !AFTER[id] && opens(e, k)) deg = "R";
        if (id === "alt" && beats % 2 && ctx.index % 2 && e.pos === 0 && firstChord(ctx.chords) && ctx.chords.length === 1) deg = "5";
        var n;
        if (deg === "N"){
          var after = H.chordAt(ctx.chords, Math.floor(e.pos) + 1), tc = Math.floor(e.pos) + 1 >= beats ? next : after;
          n = rootOf(tc || c);
        } else if (def.rise || def.below){
          var r0 = rootOf(c), f5 = c.fifth != null ? c.fifth : 7;
          if (def.rise) n = r0 + (deg === "5" ? f5 : deg === "6" ? 9 : deg === "7" ? (c.seventh != null ? c.seventh : 10) : deg === "8" ? 12 : deg === "9" ? 14 : deg === "10" ? 12 + (c.third != null ? c.third : 4) : 0);
          else if (deg === "L" || deg === "L2"){ var nr = next ? rootOf(next) : r0, dn = deg === "L" ? 1 : 2; n = inRange(nr - 2) ? nr - dn : nr + 12 - dn; }
          else { var up = deg === "5" ? f5 : deg === "6" ? 9 : 0; n = up && inRange(r0 + up - 12) ? r0 + up - 12 : r0 + up; }
          low = r0;
        } else {
          var r = rootOf(c), f = r + (c.fifth != null ? c.fifth : 7);
          if (f > HI - 3 || (r >= 38 && inRange(f - 12))) f -= 12;                                   // the fifth below a root that sits high
          var up8 = inRange(r + 12) && r + 12 <= HI - 5, lowR = id === "octaves" && !up8 && inRange(r - 12);   // (octaves: when there is no room above, the pair moves down)
          n = deg === "5" ? f : deg === "8" ? (up8 ? r + 12 : r) : lowR ? r - 12 : r;
          low = r;
        }
        if (!inRange(n)) return;
        var room = (k + 1 < list.length ? list[k + 1].pos : beats + 4) - e.pos;
        // boom-chick strength (opts.boom, 0..1; 0.5 = as written): long and soft at one end, short and hard at the other
        var bm = id === "alt" && ctx.opts && ctx.opts.boom != null ? Math.max(0, Math.min(1, +ctx.opts.boom)) : null, bf = bm == null ? 1 : 0.78 + 0.44 * bm;
        var len = bm == null ? e.dur : 1.7 - 1.25 * bm;
        if (def.hold) len = Math.min(len, beats - e.pos - 0.03);                                          // (nothing held past the barline)
        var note = { pos: e.pos, dur: Math.round(Math.min(len, room - 0.03) * 1000) / 1000, midi: n, vel: Math.round(Math.min(0.98, vel((e.pos === 0 ? 0.86 : e.pos === Math.floor(e.pos) ? 0.80 : 0.76) + (lift ? 0.04 : 0)) * bf) * 1000) / 1000 };
        if (Math.abs(e.pos * 2 - Math.round(e.pos * 2)) > 1e-6) note.straight = true;               // (a triplet eighth: placed exactly, not swung)
        ev.push(note);
        played(n);
      });
      st.pending = null; st.offRoot = false;
      return ev;
    }

    // Stop time: root, a gap, then walk up into the next root from a whole step (and a 4th) below.
    function stopBar(ctx){
      var c = firstChord(ctx.chords) || global.BandHarmony.chordAt(ctx.chords, 0), next = firstChord(ctx.nextChords), beats = ctx.beats, ev = [];
      if (!c){ st.pending = null; return []; }
      var root = startNote(c, true, 0.6);
      ev.push({ pos: 0, dur: 0.45, midi: root, vel: vel(0.88) }); played(root);
      if (!next || beats < 2){ st.pending = null; return ev; }
      var t = nearestNot(next.bass, root, 0.6), up = t - 5 >= LO, line = up ? [t - 5, t - 2, t - 1] : [t + 7, t + 2, t + 1];
      var eighths = !ctx.compound && ctx.opts && (ctx.opts.bassFeel === "riff" || ctx.opts.bassFeel === "riffwalk" || ctx.opts.feel === "straight");
      var slots = beats < 3 ? [beats - 0.5] : eighths ? [beats - 1.5, beats - 1, beats - 0.5] : beats === 3 ? [2] : [beats - 2, beats - 1];
      slots = slots.filter(function (p){ return p >= 2 || (beats < 3 && p >= 1.5); });           // nothing sounds on beat 2
      line.slice(-slots.length).forEach(function (n, k){
        var gap = (k + 1 < slots.length ? slots[k + 1] : beats) - slots[k];
        ev.push({ pos: slots[k], dur: Math.round(gap * 0.92 * 1000) / 1000, midi: n, vel: vel(0.80) }); played(n);
      });
      st.offRoot = false; aim(t, next);
      return ev;
    }

    function bar(ctx){
      if (!ctx || !ctx.chords || !ctx.chords.length){ st.pending = null; return []; }     // N.C.: rest
      if (ctx.stop) return stopBar(ctx);
      if (ctx.opts && ctx.opts.bassFeel === "riffwalk") return walksNow(ctx) ? walk(ctx) : riff(ctx);
      if (ctx.opts && ctx.opts.bassFeel === "riff") return riff(ctx);
      var feel = ctx.opts && ctx.opts.bassFeel;
      if (AFTER[feel] && ctx.opts.figures === "head" && ctx.chorus > 0) feel = AFTER[feel];      // the tune's line was for the head
      if (feel === "riff") return riff(ctx);
      if (feel && LINES.hasOwnProperty(feel)) return setLine(ctx, feel);
      // playing well down (the first chorus when the band is allowed to build), a walking line starts in two
      return (feel === "two" || (ctx.intensity < 0.36 && !AFTER[ctx.opts && ctx.opts.bassFeel])) ? two(ctx) : walk(ctx);
    }
    function ending(ctx){
      var c = firstChord(ctx && ctx.chords);
      if (!c) return [];
      var n = withPc(c.bass)[0];                                       // the root, low, left to ring
      st.prev2 = st.prev; st.prev = n; st.pending = null;
      return [{ pos: 0, dur: 4, midi: n, vel: 0.86 }];
    }
    return { bar: bar, ending: ending, reset: reset };
  }

  global.BandBass = { create: create, LO: LO, HI: HI, LINES: LINES, AFTER: AFTER };
})(typeof window !== "undefined" ? window : globalThis);
