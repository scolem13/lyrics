// comp.js — piano / guitar comping for the jazz band engine (needs harmony.js).
// ctx.opts.comp picks the instrument ("piano" | "guitar"), ctx.opts.voicing the style
// (see BandHarmony.styleList: piano rootless | guide | shell | standard | drop2 | drop3; guitar
// shell3 | drop2 | drop3 | triad3) and ctx.opts.compRhythm the rhythm ("syncopated" | "four" =
// four-to-the-bar). Voicings come from BandHarmony.voicing, voice-led from one chord to the next;
// the rhythm is drawn from a small vocabulary of swing comping figures, strung together as two-bar phrases.
//
// Pinned voicings: ctx.opts.pins maps "<form bar index>:<beat>" (where a chord starts) to the exact
// MIDI notes to play for that chord, in every rhythm and including a push into the next bar's first
// chord ("<next index>:0"). Pinned notes still become the voicing the next unpinned chord is led from.
// Each event also says which chord it sounds: `of` is that chord's "<index>:<beat>" key.
//
//   var comp = BandComp.create({ rng });   // rng() -> [0,1); all randomness goes through it
//   comp.bar(ctx)    -> [{ pos, dur, midis:[low..high], vel, inst:"piano"|"guitar" }]
//   comp.ending(ctx) -> the final held chord
//   comp.reset()
//
// Meters: the figures are written for four beats and fitted to shorter bars (a push on the last
// off-beat stays a push; hits past the end are dropped). In the compound meters (ctx.compound) a
// beat is a dotted quarter and x.5 is its third eighth, so the same figures become 12/8 comping.
//
// Movement (ctx.opts.voiceMove): "hold" (or unset) keeps one voicing per chord, led to the next by
// least motion. "move" leads by the TOP NOTE instead: over a held chord each new hit may step to the
// next inversion, and a chord change continues that line by step, turning round at the edge of the
// register. "passing" adds, in the "bh" style, the passing diminished chord on a short hit between
// two hits of one chord (events carry passing:true).
// Colour (ctx.opts.extend = { amount: 0..1, six, nine, thirteen }): each time a new chord arrives, each
// kind that is switched on is added with probability `amount` (BandHarmony.colour: a major 7th as a 6th,
// a 9th on a plain 7th chord, a 13th on a plain dominant). Written 9ths and 13ths are always voiced.
// ctx.opts.maj6 is the old name for { amount: 1, six: true }.
// Style "auto" picks a style for each four-bar phrase from the tempo, the rhythm and ctx.intensity.
//
// Stop time (ctx.stop): one short chord on beat 1 and nothing else. The bar before it
// (ctx.nextStop) does not push into it and lets nothing ring over the barline.
//
// Set patterns (GRID): rhythms that sit on the changes with no anticipations and repeat exactly:
// boom-chick, driving eighths, every off-beat, bossa, tango, montuno, cha-cha, two arpeggios and two
// fingerpicking patterns (single notes of the voicing; those events carry arp:true). A two-bar pattern follows the form bar's parity.
// Several voicing styles ("a+b" in ctx.opts.voicing) are shared out by ctx.opts.voicingMix ({ id: 0..1 }, unlisted = 0.5) when the
// shares differ: each new chord is voiced in one of them. With equal shares they are drawn on as before.
// Several rhythms ("a+b+c" in ctx.opts.compRhythm): the one-bar figures among them are mixed bar by bar;
// "four", "stabs" and the set patterns are textures, and one of them (or the figures) is chosen for
// each four-bar phrase.
//
// Anticipation: a hit on the off-beat just before a chord change plays the UPCOMING chord
// and is held across the change; after a push on the "and of 4" the next bar does not
// re-attack beat 1. To time those holds, each bar's rhythm is settled one bar ahead.

(function (global) {
  // one-bar figures: [beat position, L(ong) | S(hort)]; x.5 = the swung off-beat
  var FIG = {
    charleston: [[0, "L"], [1.5, "S"]],
    reverse:    [[0.5, "S"], [2, "L"]],
    garland:    [[1.5, "S"], [3.5, "L"]],
    offbeats:   [[0.5, "S"], [2.5, "L"]],
    pad:        [[0, "L"]],
    and2:       [[1.5, "L"]],
    push:       [[3.5, "L"]],
    oneAnd3:    [[0, "S"], [2.5, "L"]],
    space:      []
  };
  // two-bar phrases, plainer ones weighted more heavily
  var PHRASES = [
    { id: "ch-ch",     bars: ["charleston", "charleston"], w: 3.0 },
    { id: "ch-and2",   bars: ["charleston", "and2"],       w: 3.0 },
    { id: "ch-gar",    bars: ["charleston", "garland"],    w: 2.5 },
    { id: "rev-ch",    bars: ["reverse", "charleston"],    w: 2.0 },
    { id: "and2-ch",   bars: ["and2", "charleston"],       w: 2.0 },
    { id: "gar-gar",   bars: ["garland", "garland"],       w: 2.0 },
    { id: "off-push",  bars: ["offbeats", "push"],         w: 1.5 },
    { id: "pad-off",   bars: ["pad", "offbeats"],          w: 1.5 },
    { id: "one-gar",   bars: ["oneAnd3", "garland"],       w: 1.5 },
    { id: "rev-and2",  bars: ["reverse", "and2"],          w: 1.5 },
    { id: "ch-rest",   bars: ["charleston", "space"],      w: 1.6 },
    { id: "pad-rest",  bars: ["pad", "space"],             w: 1.3 },
    { id: "push-rest", bars: ["push", "space"],            w: 1.2 },
    { id: "and2-push", bars: ["and2", "push"],             w: 1.2 }
  ];
  // Set patterns. bars: one list of [beat, L | S] per bar of the pattern, or a function of the bar's
  // beat count. arp: "wave" walks up and down the voicing, "pair" alternates its lowest and highest note.
  function everyEighth(beats){ var h = []; for (var b = 0; b < beats; b += 0.5) h.push([b, "S"]); return h; }
  var GRID = {
    oompah:  { bars: function (beats){ var h = []; for (var b = 1; b < beats; b++) if (beats % 2 || b % 2) h.push([b, "S"]); return h; } },
    eighths: { bars: everyEighth, quiet: true },
    // The waltz in one: the left hand's root on 1 and light chords on 2 and 3, the third beat the lighter. The bars go
    // in fours the way the beats of a bar of 12/8 do (bar 1 leans, bar 3 leans a little, 2 and 4 are let go), and the
    // last bar of a phrase grows into the next. In other meters it is boom-chick.
    waltz:   { waltz: true, bars: function (beats){ var h = []; for (var b = 1; b < beats; b++) if (beats % 2 || b % 2) h.push([b, "S"]); return h; } },
    // The piano ballad (balladBar): left-hand octaves on the root, the right hand a first-inversion triad broken
    // into its top pair and its thumb. F = the whole right hand, P = its top two notes, T = the thumb (lowest
    // note), M = the middle note, H = the top note. mix: when several are chosen they change bar by bar.
// Kept sparse on purpose (user, 2026-10-08, on a version in running eighths: "frenetic and tasteless"): the pulse
    // is the quarter note, an eighth is a passing detail, and each pattern is two bars long and is played whole.
    ballRock:   { ballad: true, mix: true, bars: [ [[0, "F"], [1, "T"], [2, "P"], [3, "T"]],
                                                   [[0, "F"], [1, "T"], [2, "P"], [3, "T"], [3.5, "P"]] ] },
    ballBroken: { ballad: true, mix: true, bars: [ [[0, "T"], [0.5, "M"], [1, "H"], [2, "F"]],
                                                   [[0, "F"], [2, "T"], [2.5, "M"], [3, "H"]] ] },
    ballSync:   { ballad: true, mix: true, bars: [ [[0, "F"], [1.5, "P"], [3, "P"]],
                                                   [[0, "F"], [1.5, "P"], [3, "T"]] ] },
    // the hymn: every chord struck once and held until the next, three voices above the left hand's root (four parts on the piano)
    hymn:    { lh: true, hold: true, bars: function (){ return [[0, "L"]]; } },
    // lh: on the piano the left hand adds the root under each chord as it arrives
    quarters: { lh: true, bars: function (beats){ var h = []; for (var b = 0; b < beats; b++) h.push([b, "L"]); return h; } },
    // the doo-wop piano: the chord on all three eighths of every beat (12/8, or triplets over 4/4)
    triplets: { lh: true, quiet: true, bars: function (beats){ var h = []; for (var b = 0; b < beats; b++){ h.push([b, "S"]); h.push([b + 1 / 3, "S"]); h.push([b + 2 / 3, "S"]); } return h; } },
    upbeats: { bars: function (beats){ var h = []; for (var b = 0.5; b < beats; b++) h.push([b, "S"]); return h; } },
    bossa:   { bars: [ [[0, "S"], [1.5, "L"], [3, "S"]], [[1, "S"], [2.5, "L"]] ] },
    tango:   { bars: [ [[0, "L"], [1.5, "S"], [2, "S"], [3, "S"]] ] },
    montuno: { bars: [ [[0, "S"], [1, "S"], [1.5, "S"], [2.5, "S"], [3.5, "S"]], [[0.5, "S"], [1.5, "S"], [2.5, "S"], [3.5, "S"]] ] },
    chacha:  { bars: [ [[1, "S"], [2, "S"], [2.5, "S"], [3, "L"]] ] },
    // strumming: a third entry gives the stroke. D = down (the whole voicing, low string first), U = up
    // (its top three notes, high string first, lighter). Chords ring into each other. x.25 / x.75 are sixteenths.
    strumCamp:  { strum: true, bars: [ [[0, "L", "D"], [1, "L", "D"], [1.5, "L", "U"], [2.5, "L", "U"], [3, "L", "D"], [3.5, "L", "U"]] ] },
    strumFolk:  { strum: true, bars: [ [[0, "L", "D"], [1, "L", "D"], [1.5, "L", "U"], [2, "L", "D"], [3, "L", "D"], [3.5, "L", "U"]] ] },
    strumEights:{ strum: true, accent: [1, 3], bars: [ [[0, "L", "D"], [0.5, "L", "U"], [1, "L", "D"], [1.5, "L", "U"], [2, "L", "D"], [2.5, "L", "U"], [3, "L", "D"], [3.5, "L", "U"]] ] },
    // muted eighth downstrokes on power chords in the verse; open down-up eighths in the chorus bars (opts.lift). With no chorus bars, the second half of the form is open.
    strumPunk:  { strum: true, punk: true, accent: [0, 1, 2, 3], bars: [ [[0, "L", "D"], [0.5, "L", "U"], [1, "L", "D"], [1.5, "L", "U"], [2, "L", "D"], [2.5, "L", "U"], [3, "L", "D"], [3.5, "L", "U"]] ] },
    strumQuarters: { strum: true, bars: function (beats){ var h = []; for (var b = 0; b < beats; b++) h.push([b, "L", "D"]); return h; } },
    strum332:   { strum: true, accent: [0, 1.5, 3], bars: [ [[0, "L", "D"], [1, "L", "D"], [1.5, "L", "U"], [2.5, "L", "U"], [3, "L", "D"], [3.5, "L", "U"]] ] },
    strum16:    { strum: true, bars: [ [0, 2].reduce(function (h, o){ return h.concat([[o, "L", "D"], [o + 0.5, "L", "D"], [o + 0.75, "L", "U"], [o + 1.25, "L", "U"], [o + 1.5, "L", "D"], [o + 1.75, "L", "U"]]); }, []) ] },
    // So What: nothing under the bass call, then the two answering chords. A fourth entry moves the whole
    // voicing by that many semitones (the first chord is the home voicing a whole step up). exact: no hit is
    // added for a chord the pattern passes over. (Placement written from memory of the record: check by ear.)
    sowhat:  { tune: true, exact: true, bars: [ [], [[2, "L", null, 2], [3.5, "S"]] ] },
    maiden:  { tune: true, bars: [ [[0, "L"], [1.5, "L"], [3, "L"]], [[1.5, "L"], [3, "L"]] ] },      // Maiden Voyage: 1, and of 2, 4 (held over) | and of 2, 4
    takefive:{ tune: true, bars: [ [[0, "L"], [1.5, "S"], [3, "S"], [4, "S"]] ] },                   // Take Five: 1, and of 2 | 4, 5
    // Rhythms of threes and twos (Hutchinson, Music Theory for the 21st-Century Classroom, ch. 14).
    tresillo: { bars: [ [[0, "L"], [1.5, "L"], [3, "L"]] ] },                                         // 3+3+2
    clave32:  { bars: [ [[0, "S"], [1.5, "S"], [3, "S"]], [[1, "S"], [2, "S"]] ] },                    // 3-2 son clave, the Bo Diddley beat
    barbara:  { bars: [ [[0, "S"], [1, "S"], [2, "S"], [3.5, "S"]], [[0.5, "S"], [1.5, "S"], [2, "L"]] ] },   // 1 2 3 (4)& | (1)& (2)& 3
    g333322:  { bars: [ [[0, "L"], [1.5, "L"], [3, "L"]], [[0.5, "L"], [2, "S"], [3, "S"]] ] },        // 3+3+3+3+2+2 eighths
    g33433:   { bars: [ [[0, "L"], [1.5, "L"], [3, "L"]], [[1, "L"], [2.5, "L"]] ] },                  // 3+3+4+3+3 eighths
    g3x8:     { bars: [ [[0, "S"], [0.75, "S"], [1.5, "S"], [2.25, "S"], [3, "S"], [3.75, "S"]],       // eight threes then four twos, in sixteenths
                        [[0.5, "S"], [1.25, "S"], [2, "S"], [2.5, "S"], [3, "S"], [3.5, "S"]] ] },
    // Fingerpicking, after John Prine (pickBar). The thumb is not written here: it plays every beat on the low strings. The
    // entries are the fingers on the treble strings: M the lowest of them, H the next, T the top string.
    // prine: a pinch with the thumb on 2 and 4 (2 and 3 of a waltz) and the string below it on the and after.
    // travis: a pinch on 1, then between the thumb's notes: the and of 2, the and of 3, the and of 4.
    prine:   { pick: true, bars: function (beats){ var h = []; for (var b = 1; b < beats; b++) if (beats % 2 || b % 2){ h.push([b, "H"]); h.push([b + 0.5, "M"]); } return h; } },
    travis:  { pick: true, bars: function (beats){ var h = [[0, "H"]]; for (var b = 1; b < beats; b++) h.push([b + 0.5, b % 2 ? "M" : "H"]); return h; } },
    alberti: { bars: everyEighth, arp: "alberti" },                                                   // low, high, middle, high
    arp:     { bars: everyEighth, arp: "wave" },
    arp2:    { bars: everyEighth, arp: "pair" }
  };
  function isFig(id){ return !!FIG[id] && id !== "space"; }
  function isTexture(id){ return id === "four" || id === "stabs" || !!GRID[id]; }
  PHRASES.forEach(function (p){ p.hits = FIG[p.bars[0]].length + FIG[p.bars[1]].length; });

  function firstChord(chords){
    var c = chords && chords.length && chords[0].pos === 0 ? chords[0].chord : null;
    return (c && !c.nc) ? c : null;
  }
  function sigOf(chords){ return (chords || []).map(function (c){ return c.pos + "=" + c.chord.key; }).join(","); }
  function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }
  // How a set pattern is shaped, beyond its own accents (first written for the quarter notes):
  //   phraseDyn  the four-bar phrase swells towards its third bar, and its last bar grows into the next phrase
  //   leanDyn    the bar leans on beat 1 (and a little on 3 in four); the other beats are let go. Off-beats are left alone.
  //   spread     loud and soft move further apart as the band plays harder (ctx.intensity), around `mid`
  function heatOf(ctx){ return ctx.intensity == null ? 0.5 : ctx.intensity; }
  function phraseDyn(ctx, pos){
    var qp = ((ctx.phrase && ctx.phrase.bar) || 0) % 4, beats = ctx.beats || 4;
    return [0, 0.015, 0.035, 0.005][qp] + (qp === 3 ? 0.05 * (pos / Math.max(1, beats - 1)) : 0);
  }
  function leanDyn(ctx, pos, k){
    var beats = ctx.beats || 4, b = Math.round(pos); if (Math.abs(pos - b) > 1e-6) return 0;
    var lean = b === 0 ? 0.055 : beats === 4 && b === 2 ? 0.015 : beats % 2 === 0 && b % 2 ? -0.045 : -0.035;
    return lean * (0.8 + 0.6 * heatOf(ctx)) * (k == null ? 1 : k);
  }
  function spread(ctx, v, mid){ return mid + (v - mid) * (0.8 + 0.4 * heatOf(ctx)); }
  // instrument + voicing style from the page options (unknown style -> that instrument's default)
  function setup(opts){
    var H = global.BandHarmony, inst = (opts && opts.comp === "guitar") ? "guitar" : "piano";
    var style = (opts && H.hasStyle(inst, opts.voicing)) ? opts.voicing : H.defaultStyle(inst);
    // rhythm: "four" | "stabs" | a GRID pattern | one of the FIG names (that figure every bar) | several of
    // those joined by "+" | anything else = varied phrases
    var seen = {}, list = String((opts && opts.compRhythm) || "").split("+").filter(function (x){
      if (seen[x] || !(isFig(x) || isTexture(x))) return false; seen[x] = 1; return true; });
    var figs = list.filter(isFig), tex = list.filter(isTexture), r = list.length === 1 ? list[0] : list.length ? list.join("+") : (opts && opts.compRhythm);
    var mv = opts && opts.voiceMove;
    return { inst: inst, style: style, four: r === "four", stabs: r === "stabs", grid: GRID[r] ? r : null, figs: figs, tex: tex, pins: (opts && opts.pins) || null, rhythm: r,
             move: mv === "move" || mv === "passing", passing: mv === "passing", weights: (opts && opts.rhythmMix) || null, vweights: (opts && opts.voicingMix) || null,
             ext: (opts && opts.extend && opts.extend.amount > 0) ? opts.extend : (opts && opts.maj6) ? { amount: 1, six: true } : null };
  }
  // the beat where the chord sounding at `pos` started (the chord list is in beat order)
  function startAt(chords, pos){
    var s = null;
    for (var i = 0; i < (chords || []).length; i++){ if (chords[i].pos <= pos + 1e-6) s = chords[i].pos; else break; }
    return s;
  }
  // key of the chord sounding at `pos` of bar `index`; the pinned notes for it, or null
  function keyAt(index, chords, pos){ var s = startAt(chords, pos); return s == null ? null : index + ":" + s; }
  function pinOf(su, key){ var m = su.pins && key && su.pins[key]; return (m && m.length) ? m : null; }

  function create(o){
    var rng = (o && o.rng) || Math.random;
    var st;
    function reset(){ st = { prevV: null, lastKey: null, antic: false, queue: [], recent: [], plan: null, started: false, pool: "", mode: null, modeSet: "",
                             top: null, dir: 1, wasPassing: false, tint: null, auto: null, autoInst: null }; }
    reset();

    // The notes for a chord: its pin when there is one, else a voicing led from the last one. The
    // previous voicing is reused while the chord (or pin) is unchanged.
    // `mv` describes the hit: { attack: a new strike of the chord, p: chance it moves, passing: a passing chord may go here }.
    function pick(chord, su, key, mv){
      var H = global.BandHarmony, pin = pinOf(su, key);
      chord = tint(chord, su);
      var id = pin ? "pin|" + pin.join(",") : chord.key + "|" + su.style + "|" + su.inst;
      // several voicing styles with unequal shares (opts.voicingMix: { id: 0..1 }): each new chord takes one of them, as likely as its share
      var vparts = su.vweights ? String(su.style).split("+") : [];
      if (!pin && vparts.length > 1 && vparts.some(function (x){ return vShare(su, x) !== vShare(su, vparts[0]); })){
        if (st.vKey !== id || !st.vOne){ st.vKey = id; st.vOne = byWeight(vparts, su.vweights); }
        su = Object.assign({}, su, { style: st.vOne });
      }
      st.wasPassing = false;
      if (pin){ st.prevV = pin.slice(); st.lastKey = id; track(su); return st.prevV; }
      var same = id === st.lastKey && st.prevV && st.prevV.length;
      if (!su.move || !H.toward){                                           // one voicing per chord, least motion
        if (!same){ st.prevV = H.voicing(chord, oneOf(su), st.prevV, su.inst); st.lastKey = id; track(su); }
        return st.prevV;
      }
      if (!st.prevV || !st.prevV.length || st.top == null){ st.prevV = H.voicing(chord, su.style, null, su.inst); st.lastKey = id; track(su); return st.prevV; }
      if (same){
        if (!mv || !mv.attack) return st.prevV;
        if (mv.passing && su.passing){                                      // the diminished chord between two inversions
          var pv = H.toward(chord, su.style, st.prevV, su.inst, { passing: true, top: st.top + st.dir * 1.5 });
          if (pv.length){ st.prevV = pv; st.lastKey = id + "|passing"; st.wasPassing = true; track(su); return st.prevV; }
        }
        if (rng() < (mv.p == null ? 0.6 : mv.p)){ st.prevV = H.toward(chord, su.style, st.prevV, su.inst, { top: st.top + st.dir * 3, differ: true }); track(su); }
        return st.prevV;
      }
      // a new chord (or the chord after its passing chord): the top line goes on by step
      st.prevV = H.toward(chord, su.style, st.prevV, su.inst, { top: st.top + st.dir * (/\|passing$/.test(st.lastKey || "") ? 1.5 : 1) });
      st.lastKey = id; track(su);
      return st.prevV;
    }
    // the chord with its colour: settled when the chord arrives and kept until the harmony moves on
    function tint(chord, su){
      var H = global.BandHarmony, x = su.ext; if (!H.colour) return chord;
      var sig = chord.key + "|" + (x ? [x.amount, !!x.six, !!x.nine, !!x.thirteen].join(",") : "");
      if (st.tint && st.tint.sig === sig) return st.tint.chord;
      var add = {};
      if (x) ["six", "nine", "thirteen"].forEach(function (k){ if (x[k] && (x.amount >= 1 || rng() < x.amount)) add[k] = true; });
      st.tint = { sig: sig, chord: H.colour(chord, add) };
      return st.tint.chord;
    }
    // guitar events carry the fingering the voicing was chosen on: [{ string, fret, midi }]
    function grip(e){ var H = global.BandHarmony, g = e.inst === "guitar" && H.gripOf ? H.gripOf(e.midis) : null; if (g) e.strings = g; return e; }
    // follow the top note; turn the line round at the edge of the comping register, and now and then on a whim
    function track(su){
      if (!st.prevV || !st.prevV.length) return;
      var lo = su.inst === "guitar" ? 52 : 60, hi = su.inst === "guitar" ? 67 : 77;      // top notes: guitar E3..G4, piano C4..F5
      st.top = st.prevV[st.prevV.length - 1];
      if (st.top >= hi - 1) st.dir = -1; else if (st.top <= lo + 1) st.dir = 1; else if (su.move && rng() < 0.12) st.dir = -st.dir;
    }
    // "auto": a style for the moment, settled at the top of each four-bar phrase
    // Several styles ticked ("a+b"). Moving voicings draw on every shape of all of them. With "hold" the
    // shapes never change on a held chord, so each new chord takes one of the styles in turn instead,
    // which is how all of them get heard.
    function vShare(su, x){ var w = su.vweights[x]; return w == null ? 0.5 : Math.max(0, +w || 0); }
    function oneOf(su){
      var parts = String(su.style).split("+");
      if (parts.length < 2 || su.move) return su.style;
      return parts[Math.floor(rng() * parts.length)];
    }
    function autoStyle(ctx, su){
      var H = global.BandHarmony, I = ctx.intensity == null ? 0.5 : ctx.intensity, tempo = ctx.tempo || 120, g = su.inst === "guitar";
      if (st.auto && st.autoInst === su.inst && ctx.phrase && ctx.phrase.bar !== 0) return st.auto;
      var pickS = g ? (su.four ? "shell3" : (I < 0.36 || tempo > 230) ? "guide2" : I > 0.72 ? "drop2" : I > 0.56 ? "uppervl" : "shell3")
                    : ((I < 0.36) ? "guide" : tempo > 230 ? "shell" : su.rhythm === "pad" ? "drop3" : I > 0.72 ? (su.passing ? "bh" : "drop2") : "rootless");
      if (!H.hasStyle(su.inst, pickS)) pickS = H.defaultStyle(su.inst);
      st.auto = pickS; st.autoInst = su.inst;
      return pickS;
    }

    // one of `ids` at random, each as likely as its weight (opts.rhythmMix: { id: 0..1 }; unlisted = 0.5); all zero = any
    var curW = null;
    function byWeight(ids, W, group){
      var ws = ids.map(function (id){ if (id === "figs") return (group || []).reduce(function (s, f){ return s + (W[f] == null ? 0.5 : Math.max(0, +W[f] || 0)); }, 0);
        return W[id] == null ? 0.5 : Math.max(0, +W[id] || 0); }), sum = ws.reduce(function (a, b){ return a + b; }, 0);
      if (!(sum > 0)) return ids[Math.floor(rng() * ids.length)];
      var r = rng() * sum; for (var i = 0; i < ids.length - 1; i++){ r -= ws[i]; if (r < 0) return ids[i]; } return ids[ids.length - 1];
    }
    // Several rhythms in the blend: which one each bar gets, planned four bars at a time. One of them is at home
    // for the four bars (chosen by the blend sliders when there are any; otherwise mostly a different one from
    // last time). So that one pattern does not simply stop and another start, a span may also hold one visitor:
    //   a callback   - its second bar goes back to the pattern just left (35% after a change);
    //   foreshadowing - its last bar is already the pattern that comes next (40% before a change);
    //   a break      - its third bar is some other pattern, and the fourth returns (30% otherwise).
    // Only patterns with some weight take part, so one slider up and the rest at zero is still that pattern alone.
    function planSpan(ch, su){
      var W = su.weights, live = W ? ch.filter(function (m){ return m === "figs" ? su.figs.some(function (x){ return W[x] == null || W[x] > 0; }) : (W[m] == null || W[m] > 0); }) : ch;
      if (!live.length) live = ch;
      function choose(not){ if (W) return byWeight(live, W, su.figs); var pool = live.length > 1 && not != null && rng() < 0.7 ? live.filter(function (m){ return m !== not; }) : live; return pool[Math.floor(rng() * pool.length)]; }
      var home = st.nextHome && live.indexOf(st.nextHome) >= 0 ? st.nextHome : choose(st.home), next = choose(home), span = [home, home, home, home], prev = st.home;
      if (live.length > 1){
        var others = live.filter(function (m){ return m !== home; });
        if (prev && prev !== home && live.indexOf(prev) >= 0 && rng() < 0.35) span[1] = prev;
        if (next !== home && rng() < 0.4) span[3] = next;
        else if (others.length && rng() < 0.3) span[2] = W ? byWeight(others, W, su.figs) : others[Math.floor(rng() * others.length)];
      }
      st.home = home; st.nextHome = next; span.forEach(function (m){ st.modePlan.push(m); });
    }
    // keep at least this bar's and the next bar's figure queued
    function fill(tempo, busy, figs){
      while (st.queue.length < 2){
        if (figs && figs.length){                                                   // the chosen figure(s): one for each bar
          var last = st.queue.length ? st.queue[st.queue.length - 1] : st.lastFig;
          var opts = figs.filter(function (f){ return st.started || (FIG[f][0] && FIG[f][0][0] === 0); });   // state the first chord on beat 1 when one of them can
          if (!opts.length) opts = figs;
          var f;
          if (curW) f = byWeight(opts, curW);                                                               // the blend sliders decide
          else { if (opts.length > 1 && rng() < 0.6) opts = opts.filter(function (f){ return f !== last; });        // mostly a different one from the last bar
            f = opts[Math.floor(rng() * opts.length)]; }
          st.queue.push(f); st.lastFig = f; st.started = true; continue;
        }
        var fast = tempo > 200, sum = 0;
        var ws = PHRASES.map(function (p){
          var w = p.w;
          if (fast) w *= p.hits <= 2 ? 2.2 : 0.7;                       // leave more space up-tempo
          if (busy != null) w *= p.hits <= 2 ? Math.max(0.25, 2 - 2 * busy) : Math.max(0.25, 2 * busy);   // sparser when the band plays down, fuller as it builds
          if (st.recent.indexOf(p.id) >= 0) w *= 0.2;                   // don't keep repeating a phrase
          if (!st.started && !(FIG[p.bars[0]][0] && FIG[p.bars[0]][0][0] === 0)) w = 0;   // state the first chord on beat 1
          sum += w; return w;
        });
        var r = rng() * sum, k = 0;
        for (; k < ws.length - 1; k++){ r -= ws[k]; if (r <= 0) break; }
        st.queue.push(PHRASES[k].bars[0], PHRASES[k].bars[1]);
        st.recent.push(PHRASES[k].id); if (st.recent.length > 2) st.recent.shift();
        st.started = true;
      }
    }
    // a figure's hits for a particular bar: [{ pos, len }]
    function realise(figName, chords, beats, prevAntic){
      if (!chords || !chords.length) return [];
      var hits = [];
      FIG[figName].forEach(function (h){
        var pos = h[0];
        if (pos >= beats){ if (pos !== 3.5) return; pos = beats - 0.5; }                    // the push into the next bar moves with the barline
        if (!hits.some(function (x){ return x.pos === pos; })) hits.push({ pos: pos, len: h[1] });
      });
      if (prevAntic) hits = hits.filter(function (h){ return h.pos >= 0.5; });   // that chord is already ringing
      var sounding = chords.filter(function (c){ return c.chord && !c.chord.nc; });
      if (sounding.length > 1){
        // two (or more) chords in the bar: each must be heard, on its beat or pushed just before it
        chords.forEach(function (c, k){
          if (!c.chord || c.chord.nc) return;
          var p = c.pos, e = k + 1 < chords.length ? chords[k + 1].pos : beats;
          if (p === 0 && prevAntic) return;
          var heard = hits.some(function (h){ return h.pos >= p - 0.5 - 1e-6 && h.pos < e - 0.5 - 1e-6; });
          if (!heard) hits.push({ pos: (p === 0 || rng() < 0.5) ? p : p - 0.5, len: "L" });
        });
      }
      hits.sort(function (a, b){ return a.pos - b.pos; });
      return hits;
    }

    function bar(ctx){
      var H = global.BandHarmony, beats = ctx.beats, chords = ctx.chords, nextChords = ctx.nextChords || [];
      // a tune's figure asked for on the head only gives way to the band's own phrases after the first chorus
      if (ctx.opts && ctx.opts.figures === "head" && ctx.chorus > 0 && String(ctx.opts.compRhythm || "").split("+").some(function (x){ return GRID[x] && GRID[x].tune; })){
        var rest = String(ctx.opts.compRhythm).split("+").filter(function (x){ return !(GRID[x] && GRID[x].tune); });
        ctx = Object.assign({}, ctx, { opts: Object.assign({}, ctx.opts, { compRhythm: rest.length ? rest.join("+") : "auto" }) });
      }
      var su = setup(ctx.opts), inst = su.inst;
      if (su.style === "auto") su.style = autoStyle(ctx, su);
      var tempo = ctx.tempo || 120;
      if (ctx.stop){
        st.antic = false; st.plan = null; st.queue = [];
        var c0 = H.chordAt(chords, 0), k0 = keyAt(ctx.index, chords, 0);
        if (!c0) return [];
        pick(c0, su, k0); st.started = true;
        return st.prevV.length ? [{ pos: 0, dur: Math.max(0.3, 0.13 * tempo / 60), midis: st.prevV.slice(), vel: 0.68, inst: inst, of: k0 }] : [];
      }
      // several rhythms: the figures (as a group) or one of the textures, settled for each four-bar phrase
      var figs = su.figs, phraseEnds = false; curW = su.weights;
      if (su.tex.length && su.figs.length + su.tex.length > 1){
        var ch = su.tex.slice(); if (su.figs.length) ch.push("figs");
        var sig = su.rhythm + "|" + (su.weights ? ch.map(function (m){ return m + ":" + su.weights[m]; }).join(",") : "");
        if (st.modeSet !== sig || !st.modePlan){ st.modeSet = sig; st.modePlan = []; st.home = null; st.nextHome = null; }
        while (st.modePlan.length < 2) planSpan(ch, su);
        st.mode = st.modePlan.shift();
        su.four = st.mode === "four"; su.stabs = st.mode === "stabs"; su.grid = GRID[st.mode] ? st.mode : null;
        phraseEnds = st.modePlan[0] !== st.mode;                              // the next bar is another texture
      }
      if (su.four) return fourToBar(ctx, su);
      if (su.grid) return gridBar(ctx, su);
      if (su.stabs || (!figs.length && !ctx.compound && ctx.opts && ctx.opts.feel === "straight")) return straightBar(ctx, su);
      if (st.pool !== figs.join("+")){ st.pool = figs.join("+"); st.queue = []; st.plan = null; }   // rhythm choice changed: replan
      fill(tempo, ctx.intensity, figs);
      var figName = st.queue.shift();
      if (!chords || !chords.length){ st.antic = false; st.plan = null; return []; }       // N.C.

      var plan = st.plan; st.plan = null;
      var hits = (plan && plan.bar === ctx.bar && plan.sig === sigOf(chords)) ? plan.hits : realise(figName, chords, beats, st.antic);
      hits = hits.filter(function (h){ return h.pos < beats - 1e-6; });                       // the plan assumed a bar as long as the last one
      var close = ctx.last || ctx.nextStop || phraseEnds;                                     // the next bar is the ending, a stop or maybe another texture: no push into it
      if (close) hits = hits.filter(function (h){ return h.pos < beats - 0.5 - 1e-6; });      // leave that hit to the next bar

      var nextC = firstChord(nextChords);
      var lastHit = hits[hits.length - 1];
      var endsAntic = !!(lastHit && nextC && Math.abs(lastHit.pos - (beats - 0.5)) < 1e-6);
      fill(tempo, ctx.intensity, figs);
      var nextHits = close ? [] : realise(st.queue[0], nextChords, beats, endsAntic);
      var nextFirst = close ? 0 : (nextHits.length ? nextHits[0].pos : Infinity);

      var sLen = Math.max(0.3 + rng() * 0.1, 0.13 * tempo / 60);       // a stab never gets shorter than ~130 ms
      var ev = [];
      hits.forEach(function (h, i){
        var off = Math.abs(h.pos - Math.floor(h.pos) - 0.5) < 1e-6, up = h.pos + 0.5;
        var chord = H.chordAt(chords, h.pos), from = h.pos, across = false, ck = keyAt(ctx.index, chords, h.pos);
        if (off && up >= beats - 1e-6){ if (nextC){ chord = nextC; across = true; ck = (ctx.length > 0 ? (ctx.index + 1) % ctx.length : ctx.index + 1) + ":0"; } }
        else if (off){ var cu = H.chordAt(chords, up); if (cu && (!chord || cu.key !== chord.key)){ chord = cu; from = up; ck = keyAt(ctx.index, chords, up); } }
        if (!chord) return;
        // the hold ends before the next hit and before the harmony moves on
        var nextPos = i + 1 < hits.length ? hits[i + 1].pos : beats + nextFirst, changeAt;
        if (across) changeAt = beats + (nextChords.length > 1 ? nextChords[1].pos : beats);
        else {
          changeAt = beats;
          for (var k = 0; k < chords.length; k++){ if (chords[k].pos > from + 1e-6){ changeAt = chords[k].pos; break; } }
          if (changeAt === beats && nextC && nextC.key === chord.key) changeAt = beats + (nextChords.length > 1 ? nextChords[1].pos : beats);
        }
        if (close) changeAt = Math.min(changeAt, beats);
        var room = Math.min(nextPos, changeAt) - h.pos;
        var dur = h.len === "S" ? Math.min(sLen, room - 0.05) : Math.min(2.5, room - 0.12);
        dur = Math.max(0.1, Math.min(Math.max(dur, 0.15), nextPos - h.pos - 0.02));

        // a short hit with another hit of the same chord after it may be a passing chord
        // (the next hit may be the next bar's first, when that bar starts on the same chord)
        var nh = hits[i + 1], nch = null;
        if (su.passing && h.len === "S" && !across && from === h.pos)
          nch = nh ? H.chordAt(chords, nh.pos) : (!close && nextHits.length && nextHits[0].pos < 1) ? nextC : null;
        pick(chord, su, ck, { attack: true, p: 0.75, passing: !!(nch && nch.key === chord.key && rng() < 0.7) });
        if (!st.prevV.length) return;
        var v = 0.57 + (rng() - 0.5) * 0.08 + (off ? 0.06 : h.len === "L" ? -0.03 : 0);      // pushes a little louder than pads
        var e = { pos: h.pos, dur: Math.round(dur * 1000) / 1000, midis: st.prevV.slice(),
                  vel: Math.round(clamp(v, 0.45, 0.7) * 1000) / 1000, inst: inst, of: ck };
        if (st.wasPassing) e.passing = true;
        ev.push(grip(e));
      });
      st.antic = endsAntic;
      st.plan = ctx.nextStop ? null : { bar: ctx.bar + 1, sig: sigOf(nextChords), hits: nextHits };
      return ev;
    }

    // Freddie Green four-to-the-bar: one short chord on every beat, 2 and 4 leaning forward,
    // no anticipations. The voicing is only re-chosen when the chord changes.
    function fourToBar(ctx, su){
      var H = global.BandHarmony, ev = [], tempo = ctx.tempo || 120;
      var dur = Math.round(Math.max(0.5, 0.11 * tempo / 60) * 1000) / 1000;       // never under ~110 ms
      st.antic = false; st.plan = null; st.queue = [];
      for (var b = 0; b < ctx.beats; b++){
        var chord = H.chordAt(ctx.chords, b); if (!chord) continue;
        var ck = keyAt(ctx.index, ctx.chords, b), nx = b + 1 < ctx.beats ? H.chordAt(ctx.chords, b + 1) : null;
        // moving voicings: mostly stay put, sometimes shift on beat 3; a passing chord may sit on 2 or 4
        pick(chord, su, ck, { attack: b > 0, p: b === 2 ? 0.4 : 0.08, passing: !!(su.passing && b % 2 === 1 && nx && nx.key === chord.key && rng() < 0.35) });
        if (!st.prevV.length) continue;
        var v = (b % 2 ? 0.62 : 0.52) + (rng() - 0.5) * 0.05;
        var e4 = { pos: b, dur: Math.min(dur, 0.9), midis: st.prevV.slice(), vel: Math.round(clamp(v, 0.45, 0.7) * 1000) / 1000, inst: su.inst, of: ck };
        if (st.wasPassing) e4.passing = true;
        ev.push(grip(e4));
      }
      st.started = true;
      return ev;
    }

    // Straight-eighths (boogaloo / rock) comping, locked to the bass riff: a stab on 1, the
    // chord pushed on the "and" of 2, and now and then an answering stab late in the bar.
    // No anticipations across the barline: this feel sits on the changes.
    function straightBar(ctx, su){
      var H = global.BandHarmony, ev = [], tempo = ctx.tempo || 120;
      var stab = Math.max(0.35, 0.12 * tempo / 60);
      st.antic = false; st.plan = null; st.queue = [];
      var segs = [], b;
      for (b = 0; b < ctx.beats; b++){
        var c = H.chordAt(ctx.chords, b), last = segs[segs.length - 1];
        if (last && c && last.chord && c.key === last.chord.key) last.len++; else segs.push({ start: b, len: 1, chord: c });
      }
      segs.forEach(function (seg){
        var chord = seg.chord; if (!chord) return;
        var ck = keyAt(ctx.index, ctx.chords, seg.start);
        pick(chord, su, ck);
        if (!st.prevV.length) return;
        function hit(off, dur, v){
          if (off >= seg.len) return;
          if (off > 0){ pick(chord, su, ck, { attack: true, p: 0.5 }); if (!st.prevV.length) return; }
          ev.push(grip({ pos: seg.start + off, dur: Math.round(Math.min(dur, seg.len - off - 0.05) * 1000) / 1000, midis: st.prevV.slice(),
                    vel: Math.round(clamp(v + (rng() - 0.5) * 0.06, 0.45, 0.72) * 1000) / 1000, inst: su.inst, of: ck }));
        }
        hit(0, stab, 0.60);
        if (seg.len >= 2) hit(1.5, seg.len >= 4 ? 1.1 : stab, 0.66);
        if (seg.len >= 4){ var r = rng(); if (r < 0.35) hit(3, stab, 0.56); else if (r < 0.6) hit(3.5, stab, 0.58); }
      });
      st.started = true;
      return ev;
    }

    // The piano ballad, after the user's own playing (2026-10-08). On the piano with the plain "standard" voicing:
    //   Right hand: close-position triads led by the smallest motion from one chord to the next, starting from
    //     the first chord in first inversion (so I in first inversion goes to IV in root position). A seventh
    //     chord is its 3rd, 5th and 7th. The pattern (GRID) plays pieces of that voicing.
    //   Left hand: a bassist's part, rarely below A2. Octave on the root as each chord arrives, the fifth on the
    //     and of 2 after it and the upper root on beat 3.
    //   Voicing movement "move" (su.move): a chord held over from the bar before, and some later chord or top-pair
    //     hits on one chord, step to the next inversion up or down instead of staying put.
    //   With opts.variation > 0: the left hand takes other bass figures (an octave bounce, fifth on 3, a lead-in
    //     to the next root, a held bar, quarter notes) and now and then another register; the right hand often leaves its
    //     root out (the left hand is doubling it already) or brings it in late, or leaves the fifth out; and
    //     neighbour notes of the key appear (2 for the root, 6 for the 5th; less often 4 for the 3rd or the major
    //     7th under the root, only where the next hit of that voice puts the chord tone back).
    // Any other voicing style, a pin or a guitar is broken up by the pattern as it stands.
    function balladBar(ctx, su, g){
      var H = global.BandHarmony, ev = [], beats = ctx.beats, pat = g.bars[ctx.index % g.bars.length];
      var own = su.inst === "piano" && su.style === "standard", amount = Math.max(0, Math.min(1, +(ctx.opts && ctx.opts.variation) || 0));
      var K = ctx.form && ctx.form[ctx.index] && ctx.form[ctx.index].keyPcs, lift = !!(H.lifted && H.lifted(ctx));
      function pc(n){ return ((n % 12) + 12) % 12; }
      function inKey(n){ return !!K && K.indexOf(pc(n)) >= 0; }
      var hits = pat.filter(function (h){ return h[0] < beats - 1e-6; }).map(function (h){ return { pos: h[0], what: h[1] }; });
      var segs = []; (ctx.chords || []).forEach(function (c, k){ if (!c.chord || c.chord.nc) return; segs.push({ start: c.pos, end: k + 1 < ctx.chords.length ? ctx.chords[k + 1].pos : beats, chord: c.chord }); });
      function out(e){ if (lift) e.vel = Math.min(0.78, e.vel * 1.09); e.vel = Math.round(e.vel * 1000) / 1000; e.dur = Math.round(Math.max(0.12, Math.min(e.dur, beats - e.pos)) * 1000) / 1000;
        if (Math.abs(e.pos * 2 - Math.round(e.pos * 2)) > 1e-6) e.straight = true; e.inst = su.inst; ev.push(e); return e; }
      // the first chord: first inversion (the root, or a seventh chord's 7th, on top), the top note near C5
      function opening(root, ivs, seventh){
        var order = seventh ? ivs : ivs.slice(1).concat([ivs[0] + 12]), last = order[order.length - 1], top = null;
        function far(n){ return Math.abs(n - 72) + 0.8 * Math.abs(n - 70); }
        for (var n = 62; n <= 77; n++) if (pc(n - root - last) === 0 && (top == null || far(n) < far(top))) top = n;
        return order.map(function (iv){ return top - (last - iv); });
      }
      // every later chord: the inversion and octave that move the hand least, kept between E3 and A5 and drawn gently to the middle
      function ledFrom(prev, root, ivs){
        var pcs = ivs.map(function (iv){ return pc(root + iv); }).sort(function (x, y){ return x - y; }), best = null, bc = 1e9;
        for (var r = 0; r < pcs.length; r++) for (var base = 48; base <= 72; base += 12){
          var v = [], last = -1;
          for (var k = 0; k < pcs.length; k++){ var n = base + pcs[(r + k) % pcs.length]; while (n <= last) n += 12; v.push(n); last = n; }
          if (v[0] < 57 || v[v.length - 1] > 84) continue;                // (from A3 up: the left hand lives just below)
          var cost = 0; v.forEach(function (n){ cost += Math.min.apply(null, prev.map(function (p){ return Math.abs(p - n); })); });
          prev.forEach(function (p){ cost += Math.min.apply(null, v.map(function (n){ return Math.abs(p - n); })); });
          cost += 0.3 * Math.abs((v[0] + v[v.length - 1]) / 2 - 69);
          if (cost < bc - 1e-9){ bc = cost; best = v; }
        }
        return best;
      }
      // the next inversion of the same chord, up or down; the line keeps its direction until it reaches A3 or C6, and now and then turns of itself
      function turn(v0){
        var d = st.balDir || 1; if (rng() < 0.15) d = -d;
        if (d > 0 && v0[0] + 12 > 84) d = -1; else if (d < 0 && v0[v0.length - 1] - 12 < 57) d = 1;
        st.balDir = d;
        return d > 0 ? v0.slice(1).concat([v0[0] + 12]) : [v0[v0.length - 1] - 12].concat(v0.slice(0, -1));
      }
      function has(w, idx, nn){ return w === "F" || (w === "P" && idx >= nn - 2) || (w === "T" && idx === 0) || (w === "H" && idx === nn - 1) || (w === "M" && idx === Math.max(0, nn - 2)); }
      segs.forEach(function (sg){
        var ck = ctx.index + ":" + sg.start, chord = sg.chord, pin = pinOf(su, ck), v, role = null, c2 = chord;
        if (own && !pin){
          c2 = tint(chord, su);
          var sev = c2.seventh != null, third = c2.sus === 2 ? 2 : c2.sus ? 5 : c2.third != null ? c2.third : null, fifth = c2.fifth != null ? c2.fifth : 7;
          var ivs = sev ? [third == null ? 0 : third, fifth, c2.seventh] : third == null ? [0, fifth] : [0, third, fifth];
          // "Move through inversions" (su.move): a chord that is still the chord from the bar before does not sit where it was
          var again = su.move && st.balKey === c2.key && st.balV && st.balV.length === ivs.length;
          v = again ? turn(st.balV) : ((st.balV && st.balV.length && ledFrom(st.balV, c2.root, ivs)) || opening(c2.root, ivs, sev));
          st.balKey = c2.key;
          st.balV = v.slice(); st.prevV = v.slice(); st.lastKey = null; st.top = v[v.length - 1];
          function at(iv){ for (var k = 0; k < v.length; k++) if (pc(v[k] - c2.root - iv) === 0) return k; return -1; }
          var roles = function (){ return { root: sev ? -1 : at(0), third: c2.third != null && !c2.sus ? at(c2.third) : -1, fifth: at(fifth) }; };
          role = roles();
        } else { pick(chord, su, ck); v = (st.prevV || []).slice(); st.balV = null; }
        if (!v.length) return;
        var mine = hits.filter(function (h){ return h.pos >= sg.start - 1e-6 && h.pos < sg.end - 1e-6; });
        if (!mine.length || mine[0].pos > sg.start + 1e-6) mine.unshift({ pos: sg.start, what: "F" });       // every chord is stated when it arrives
        else if (mine[0].what !== "F" && sg.start > 0) mine[0] = { pos: mine[0].pos, what: "F" };
        // what the right hand does with this chord: all of it, no root, the root late, or no fifth
        var mode = "full", rm = amount > 0 && role && v.length === 3 ? rng() : 1;
        if (role && v.length === 3){
          if (role.root >= 0) mode = rm < 0.30 * amount ? "noRoot" : rm < 0.55 * amount ? "late" : rm < 0.85 * amount && role.fifth >= 0 ? "no5" : "full";
          else if (role.fifth >= 0 && rm < 0.30 * amount) mode = "no5";
        }
        var pending = null;                                             // a tension note waiting for its chord tone
        mine.forEach(function (h, i){
          // moving: a later chord or top-pair hit on the same chord may step to the next inversion (never while a tension note waits to resolve)
          if (su.move && own && !pin && role && i > 0 && (h.what === "F" || h.what === "P") && pending == null && rng() < 0.4){ v = turn(v); st.balV = v.slice(); st.prevV = v.slice(); st.top = v[v.length - 1]; role = roles(); }
          var notes = v.slice(), nn = notes.length, last = i === mine.length - 1, r = rng(), r2 = rng(), tense = false;
          function move(idx, to){                                       // a neighbour note for one voice, if the hit plays that voice and the hand keeps its order
            if (idx < 0 || !has(h.what, idx, nn) || !inKey(to) || (idx > 0 && to <= notes[idx - 1]) || (idx < nn - 1 && to >= notes[idx + 1])) return false;
            notes[idx] = to; return true;
          }
          if (pending != null){ if (!has(h.what, pending, nn)) h.what = "F"; pending = null; }             // (this hit puts the chord tone back)
          else if (mode !== "late" && role && nn === 3 && role.root >= 0 && role.third >= 0 && i > 0 && amount > 0){
            var gone = mode === "noRoot" ? role.root : mode === "no5" ? role.fifth : -1;                    // (a voice that is left out cannot be decorated)
            if (r < 0.05 * amount && !last){                            // gentle tension: the 4th for the 3rd, or the major 7th under the root
              var which = (r2 < 0.5 || gone === role.root) ? role.third : role.root;
              tense = which === role.third ? move(which, notes[which] + (c2.third === 4 ? 1 : 2)) : move(which, notes[which] - 1);
              if (tense) pending = which;
            } else if (r < 0.17 * amount){                              // colour: the 2nd above the root, or the 6th above the 5th
              if (!(r2 < 0.5 && gone !== role.root && move(role.root, notes[role.root] + 2)) && gone !== role.fifth) move(role.fifth, notes[role.fifth] + 2);
            }
          }
          var w = h.what, drop = mode === "noRoot" || (mode === "late" && i === 0) ? role.root : mode === "no5" ? role.fifth : -1;
          var cur = notes.filter(function (_, k){ return k !== drop; }), cn = cur.length, ms;
          if (mode === "late" && i === 1 && w !== "F" && w !== "P") ms = [notes[role.root]];                 // the root arrives on its own
          else ms = w === "F" ? cur : w === "P" ? cur.slice(-2) : w === "T" ? [cur[0]] : w === "H" ? [cur[cn - 1]] : [cur[Math.max(0, cn - 2)]];
          var on = h.pos === Math.floor(h.pos), base = w === "F" ? 0.58 : w === "P" ? 0.50 : 0.42;
          var e = { pos: h.pos, dur: Math.min(sg.end - h.pos - 0.03, ms.length > 1 ? 8 : 2), midis: ms, vel: clamp(base + (h.pos === 0 ? 0.03 : on ? 0 : -0.02) + phraseDyn(ctx, h.pos) + (rng() - 0.5) * 0.05, 0.4, 0.74), of: ck };
          if (w !== "F" || tense || ms.join() !== v.join()) e.arp = true;         // (a piece of the voicing, or an ornament: not the chord's voicing for the hand-off)
          out(e.arp ? e : grip(e));
        });
        if (su.inst === "piano" && !pin){
          // The left hand plays like a bassist, and rarely below A2 (user): the root sits as high as its octave still
          // fits under the right hand; if that would be below A2 it goes up an octave, plays single notes, and finds its fifth below.
          var f5 = chord.fifth != null ? chord.fifth : 7, len = sg.end - sg.start, plain = chord.bass === chord.root, room = v[0] - 2, lo = null, hi = null;
          for (var n = 33; n <= 57; n++) if (pc(n - chord.bass) === 0){ if (n + 12 <= room) lo = n; if (n <= v[0] - 3) hi = n; }
          if (lo == null || lo < 45) lo = hi != null ? hi : 36 + pc(chord.bass - 36);
          if (amount > 0){ var rj = rng();                              // now and then another register: up an octave, or (rarely) down below A2
            if (rj < 0.08 * amount && lo - 12 >= 33) lo -= 12; else if (rj < 0.30 * amount && lo + 12 <= v[0] - 3) lo += 12; }
          var up8 = lo + 12 <= room ? lo + 12 : lo, up5 = !plain ? up8 : lo + f5 <= room ? lo + f5 : lo + f5 - 12 >= 45 ? lo + f5 - 12 : up8, nextC = firstChord(ctx.nextChords);
          function lead(){                                              // a step into the next bar's root, from the key
            if (!nextC || nextC.bass === chord.bass || sg.end < beats) return up5;
            var t = lo; for (var m = lo - 6; m <= lo + 6; m++) if (pc(m - nextC.bass) === 0) t = m;
            var c = [t - 1, t - 2, t + 1, t + 2].filter(function (m){ return inKey(m) && m <= room && m >= 33; });
            return c.length ? c[0] : up5;
          }
          // root (octave) on 1, then: fifth on the and of 2 and the upper root on 3 (the plain one) | octave bounce | fifth on 3, root on 4 |
          // upper root on 3 and a lead-in | held | root, fifth, octave, fifth in quarters
          var LH = [ [[0, "O"], [1.5, "F"], [2, "E"]], [[0, "O"], [1.5, "E"], [2, "R"]], [[0, "O"], [2, "F"], [3, "E"]],
                     [[0, "O"], [2, "E"], [3.5, "A"]], [[0, "O"]], [[0, "R"], [1, "F"], [2, "E"], [3, "F"]] ], LW = [0.30, 0.12, 0.18, 0.15, 0.13, 0.12], fig = LH[0];
          if (amount > 0){ var rf = rng(), acc = 0; for (var q = 0; q < LH.length; q++){ acc += q === 0 ? LW[0] + (1 - amount) * 0.7 : LW[q] * amount; if (rf < acc){ fig = LH[q]; break; } } }       // (less variation: more of the plain figure)
          fig = fig.filter(function (x){ return x[0] < len - 1e-6; });
          fig.forEach(function (x, k){
            var end = k + 1 < fig.length ? fig[k + 1][0] : len, w = x[1];
            var ms = w === "O" ? (up8 !== lo ? [lo, up8] : [lo]) : w === "R" ? [lo] : w === "E" ? [up8] : w === "F" ? [up5] : [lead()];
            out({ hand: "L", pos: sg.start + x[0], dur: end - x[0] - 0.03, midis: ms, vel: (k === 0 ? 0.56 : 0.48) + (rng() - 0.5) * 0.04, of: ck, arp: true });
          });
        }
      });
      ev.sort(function (a, b){ return a.pos - b.pos; });
      st.started = true; st.pushed = false;
      return ev;
    }

    // Fingerpicking (GRID patterns marked pick), after John Prine: a steady thumb and one or two fingers, single notes
    // of the chord shape, nothing strummed.
    //   Thumb: every beat, a little damped. The root as each chord arrives, then an inner string (the 4th; the 3rd
    //     under a D shape), the alternate bass, and the inner string again. The alternate bass is the fifth below the
    //     root where the guitar has one (the low G under C, the open A under D, the open E under A); under a shape
    //     rooted on the 6th string it is the 5th string (6-4-5-4). In three the thumb plays root, inner, inner, and a
    //     chord held into the next bar starts that bar on its alternate bass. In 6/8 and 12/8 it is root and alternate
    //     bass on the beats, with two finger notes after each.
    //   Fingers: the pattern's entries, on the strings above the thumb's, ringing until the chord changes.
    //   The strings come from the guitar's grip (the "open" voicing style is the one this is written for). Any other
    //     voicing, or a pin, is picked by pitch: lowest note, next note, the rest. On the piano the thumb is the left
    //     hand: the root below the chord and its fifth, with the chord's lowest note as the inner string.
    //   With opts.variation > 0 a pinch sometimes takes the top string, a note between the beats is sometimes left
    //     out or changes string, and beat 1 sometimes gets a pinch of its own.
    function pickBar(ctx, su, g){
      var H = global.BandHarmony, ev = [], beats = ctx.beats, lift = !!(H.lifted && H.lifted(ctx)), amount = Math.max(0, Math.min(1, +(ctx.opts && ctx.opts.variation) || 0));
      var three = !ctx.compound && Math.round(beats) % 2 === 1, cyc = ctx.compound ? ["B", "A"] : three ? ["B", "I", "I"] : ["B", "I", "A", "I"], fing = [], b;
      function pc(n){ return ((n % 12) + 12) % 12; }
      if (ctx.compound) for (b = 0; b < beats; b++){ fing.push([b + 1 / 3, "M"]); fing.push([b + 0.5, "H"]); }
      else fing = g.bars(beats).filter(function (h){ return h[0] < beats - 1e-6; });
      function out(pos, midi, vel, dur, ck, thumb){
        var on = Math.abs(pos - Math.round(pos)) < 1e-6;
        var e = { pos: pos, dur: Math.round(Math.max(0.12, Math.min(dur, beats - pos)) * 1000) / 1000, midis: [midi], inst: su.inst, of: ck, arp: true,
                  vel: Math.round(clamp((spread(ctx, vel + (thumb && on ? leanDyn(ctx, pos, 0.5) : 0), 0.52) + phraseDyn(ctx, pos) + (rng() - 0.5) * 0.04) * (lift ? 1.09 : 1), 0.36, 0.76) * 1000) / 1000 };
        if (thumb && su.inst === "piano") e.hand = "L";
        if (Math.abs(pos * 2 - Math.round(pos * 2)) > 1e-6) e.straight = true;
        ev.push(e);
      }
      var segs = []; (ctx.chords || []).forEach(function (c, k){ if (!c.chord || c.chord.nc) return; segs.push({ start: c.pos, end: k + 1 < ctx.chords.length ? ctx.chords[k + 1].pos : beats, chord: c.chord }); });
      segs.forEach(function (sg){
        var chord = sg.chord, ck = ctx.index + ":" + sg.start, pin = pinOf(su, ck);
        pick(chord, su, ck); var v = (st.prevV || []).slice().sort(function (x, y){ return x - y; }), n = v.length; if (!n) return;
        var grip = su.inst === "guitar" && !pin && H.gripOf ? H.gripOf(st.prevV) : null, f5 = chord.fifth != null ? chord.fifth : 7, B, I, A, tr;
        if (grip && grip.length >= 3){                                  // by string (0 = the low E string)
          var gs = grip.slice().sort(function (x, y){ return x.string - y.string; }), rs = gs[0].string, ii = 0;
          for (var q = 1; q < gs.length - 1; q++) if (gs[q].string <= Math.max(2, rs + 1)) ii = q;
          if (!ii) ii = 1;
          B = gs[0].midi; I = gs[ii].midi; tr = gs.slice(ii + 1).map(function (x){ return x.midi; });
          A = pc(B - chord.root) === 0 && B - (12 - f5) >= 40 ? B - (12 - f5) : ii > 1 ? gs[1].midi : B;
        } else if (su.inst === "piano" && !pin){                        // the left hand under the chord
          B = 41 + pc(chord.bass - 41); if (B > v[0] - 4) B -= 12; if (B < 36) B += 12;
          A = chord.bass !== chord.root ? B : B - (12 - f5) >= 36 ? B - (12 - f5) : B + f5 < v[0] ? B + f5 : B;
          I = v[0]; tr = v.slice(1);
        } else {                                                        // by pitch
          B = v[0]; I = n > 2 ? v[1] : v[0]; tr = n > 2 ? v.slice(2) : v.slice(1);
          A = pc(B - chord.root) === 0 && B - (12 - f5) >= 40 ? B - (12 - f5) : B;
        }
        if (!tr.length) tr = [I];
        var role = { M: tr[0], H: tr[Math.min(1, tr.length - 1)], T: tr[tr.length - 1] }, bass = { B: B, I: I, A: A }, bv = { B: 0.60, A: 0.56, I: 0.49 };
        // the thumb: as the chord arrives, then on every beat
        var times = [sg.start]; for (b = Math.floor(sg.start + 1e-6) + 1; b < sg.end - 1e-6 && b < beats; b++) times.push(b);
        times.forEach(function (t, k){
          var w = cyc[k % cyc.length];
          if (three && k === 0 && sg.start === 0){ if (st.pkKey === chord.key && !st.pkAlt){ w = "A"; st.pkAlt = true; } else st.pkAlt = false; }
          out(t, bass[w], bv[w], Math.min(0.9, (k + 1 < times.length ? times[k + 1] : sg.end) - t - 0.03), ck, true);
        });
        // the fingers
        var mine = fing.filter(function (h){ return h[0] >= sg.start - 1e-6 && h[0] < sg.end - 1e-6; }).map(function (h){ return [h[0], h[1]]; });
        if (amount > 0 && !ctx.compound && sg.start === 0 && !mine.some(function (h){ return h[0] === 0; }) && rng() < 0.15 * amount) mine.unshift([0, "T"]);
        mine.forEach(function (h){
          var pinch = times.indexOf(h[0]) >= 0, w = h[1];
          if (amount > 0){ var r = rng();
            if (pinch){ if (r < 0.25 * amount) w = "T"; }
            else if (r < 0.12 * amount) return;
            else if (r < 0.30 * amount) w = w === "M" ? "H" : "M"; }
          if (pinch && role[w] === bass[cyc[times.indexOf(h[0]) % cyc.length]]) return;                    // (a small voicing: the thumb has that note)
          out(h[0], role[w], pinch ? 0.53 : 0.46, Math.min(2.5, sg.end - h[0] - 0.03), ck, false);
        });
        st.pkKey = chord.key;
      });
      ev.sort(function (x, y){ return x.pos - y.pos; });
      st.started = true; st.pushed = false;
      return ev;
    }

    // A set pattern (GRID): its hits exactly, each on the chord sounding there; every chord in the bar is heard.
    function gridBar(ctx, su){
      var H = global.BandHarmony, ev = [], tempo = ctx.tempo || 120, beats = ctx.beats, g = GRID[su.grid];
      st.antic = false; st.plan = null; st.queue = [];
      if (g.ballad) return balladBar(ctx, su, g);
      if (g.pick) return pickBar(ctx, su, g);
      var pat = typeof g.bars === "function" ? g.bars(beats) : g.bars[ctx.index % g.bars.length];
      var hits = pat.filter(function (h){ return h[0] < beats - 1e-6; }).map(function (h){ return { pos: h[0], len: h[1], stroke: h[2], shift: h[3] || 0 }; });
      (ctx.chords || []).forEach(function (c, k){
        if (g.exact || !c.chord || c.chord.nc) return;
        var e = k + 1 < ctx.chords.length ? ctx.chords[k + 1].pos : beats;
        if (!hits.some(function (h){ return h.pos >= c.pos - 1e-6 && h.pos < e - 1e-6; })) hits.push({ pos: c.pos, len: g.strum || g.hold ? "L" : "S", stroke: g.strum ? "D" : undefined });
      });
      // a pushed chord: the next bar's chord on the last eighth, ringing over the barline; the bar after it starts late
      var tied = st.pushed, lift = !!(H.lifted && H.lifted(ctx)), lhDone = {}, no5 = {}, firstOf = {}; st.pushed = false;
      if (tied) hits = hits.filter(function (h){ return h.pos >= 0.5 - 1e-6; });
      if (H.pushes && H.pushes(ctx) && !g.arp && !g.exact && !g.tune){
        hits = hits.filter(function (h){ return h.pos < 3.5 - 1e-6; }); hits.push({ pos: 3.5, push: true }); st.pushed = true; }
      hits.sort(function (a, b){ return a.pos - b.pos; });
      var sLen = Math.max(0.3, 0.12 * tempo / 60), n = 0;
      function out(e){ if (lift) e.vel = Math.round(Math.min(0.78, e.vel * 1.09) * 1000) / 1000; if (Math.abs(e.pos * 2 - Math.round(e.pos * 2)) > 1e-6) e.straight = true; ev.push(e); return e; }
      // the piano's left hand (patterns marked lh, and strums): the root, F2 to E3, under each chord as it arrives
      function left(e, h, chord, ck, v, changeAt){
        if (!(g.lh || g.strum) || su.inst !== "piano" || lhDone[ck] || pinOf(su, ck)) return;
        var lo = 41 + (((chord.bass - 41) % 12) + 12) % 12; if (lo > v[0] - 4) lo -= 12; lhDone[ck] = 1;
        // with variation the left hand is sometimes an octave, or the root with its fifth (from G2 up, not under a slash chord)
        var amt = Math.max(0, Math.min(1, +(ctx.opts && ctx.opts.variation) || 0)), rl = amt ? rng() : 1, f5 = chord.fifth != null ? chord.fifth : 7, lhs = [lo];
        if (rl < 0.25 * amt && lo - 12 >= 36) lhs = [lo - 12, lo];
        else if (rl < 0.45 * amt && chord.bass === chord.root && lo + f5 >= 43 && lo + f5 < v[0] - 2) lhs = [lo, lo + f5];
        if (lo >= 36) out({ pos: h.pos, dur: Math.round(Math.max(0.4, Math.min(changeAt, beats) - h.pos - 0.1) * 1000) / 1000, midis: lhs, vel: Math.round((e.vel - 0.04) * 1000) / 1000, inst: su.inst, of: ck, arp: true, hand: "L" });
      }
      // the punk strum: power chords on the guitar's low strings (root E2..D#3, fifth, octave), muted outside the chorus
      var fLen = ctx.length || (ctx.form && ctx.form.length) || 0, anyLift = !!(ctx.opts && ctx.opts.lift && ctx.opts.lift.length), seenP = {};
      var verse = !!g.punk && !ctx.intro && (anyLift ? !lift : (fLen >= 4 && ctx.index < fLen / 2));
      function power(chord, ck){ if (!g.punk || su.inst !== "guitar" || pinOf(su, ck)) return null; var lo = 40 + (((chord.root - 40) % 12) + 12) % 12, f5 = chord.fifth != null ? chord.fifth : 7; return [lo, lo + f5, lo + 12]; }
      // the waltz's left hand: the root on 1 (an octave on the first bar of four), let go before the chords
      if (g.waltz && beats === 3 && su.inst === "piano" && !tied){
        var wc = H.chordAt(ctx.chords, 0), wk = keyAt(ctx.index, ctx.chords, 0);
        if (wc && !wc.nc && !pinOf(su, wk)){
          var wlo = 41 + (((wc.bass - 41) % 12) + 12) % 12, wb = (ctx.phrase && ctx.phrase.bar) || 0, wi = ctx.intensity == null ? 0.5 : ctx.intensity;
          out({ pos: 0, dur: 0.85, midis: wb % 4 === 0 && wlo - 12 >= 36 ? [wlo - 12, wlo] : [wlo], vel: Math.round(clamp(0.54 + 0.08 * wi + [0.05, -0.02, 0.02, -0.03][wb % 4], 0.4, 0.74) * 1000) / 1000, inst: su.inst, of: wk, arp: true, hand: "L" });
        }
      }
      hits.forEach(function (h, i){
        if (h.push){
          var nk = (ctx.nextIndex != null ? ctx.nextIndex : ctx.index + 1) + ":0"; pick(ctx.nextChords[0].chord, su, nk); if (!st.prevV.length) return;
          var pe = { pos: 3.5, dur: 1.4, midis: power(ctx.nextChords[0].chord, nk) || st.prevV.slice(), vel: 0.66, inst: su.inst, of: nk }; if (g.strum) pe.strum = "down";
          out(grip(pe)); return;
        }
        var chord = H.chordAt(ctx.chords, h.pos); if (!chord) return;
        var ck = keyAt(ctx.index, ctx.chords, h.pos), slot = Math.round(h.pos * 2);
        pick(chord, su, ck, (n++ && !g.arp && !g.strum) ? { attack: true, p: 0.15 } : null);          // a strummer holds one shape per chord
        var v = st.prevV; if (!v.length) return;
        var nextPos = i + 1 < hits.length ? hits[i + 1].pos : beats, changeAt = beats;
        for (var k = 0; k < ctx.chords.length; k++){ if (ctx.chords[k].pos > h.pos + 1e-6){ changeAt = ctx.chords[k].pos; break; } }
        var on = h.pos === Math.floor(h.pos), e;
        if (g.arp){                                                     // one note of the voicing, left to ring to the chord change
          var m = v.length, per = Math.max(1, 2 * m - 2), w = slot % per, idx = g.arp === "pair" ? (slot % 2 ? m - 1 : 0) : g.arp === "alberti" ? [0, m - 1, Math.floor(m / 2), m - 1][slot % 4] : (w < m ? w : per - w);
          e = { pos: h.pos, dur: Math.round(Math.max(0.3, Math.min(1.5, changeAt - h.pos - 0.05)) * 1000) / 1000, midis: [v[idx]],
                vel: Math.round(clamp(spread(ctx, (on ? 0.58 : 0.52) + leanDyn(ctx, h.pos, 0.5), 0.55) + phraseDyn(ctx, h.pos) + (rng() - 0.5) * 0.05, 0.4, 0.72) * 1000) / 1000, inst: su.inst, of: ck, arp: true };
          out(e); return;
        }
        if (g.punk){ var pw = power(chord, ck); if (pw) v = pw;
          if (verse){                                                   // the chug: every eighth a short muted downstroke, the full chord only as it arrives
            var firstP = !seenP[ck]; seenP[ck] = 1;
            e = { pos: h.pos, dur: 0.3, midis: firstP ? v.slice() : v.slice(0, 2), strum: "down", mute: true, inst: su.inst, of: ck,
                  vel: Math.round(clamp(spread(ctx, firstP ? 0.64 : on ? 0.58 : 0.5, 0.57) + phraseDyn(ctx, h.pos) + (rng() - 0.5) * 0.04, 0.38, 0.74) * 1000) / 1000 };
            if (!firstP) e.arp = true;
            out(firstP ? grip(e) : e); if (firstP) left(e, h, chord, ck, v, changeAt); return;
          }
        }
        if (g.strum){
          var up = h.stroke === "U", acc = g.accent ? g.accent.indexOf(h.pos) >= 0 : !up && on && Math.floor(h.pos) % 2 === 1;      // lean on 2 and 4 unless the pattern says otherwise
          var ring = Math.max(0.2, Math.min(nextPos, changeAt) - h.pos - 0.02);
          e = { pos: h.pos, dur: Math.round(ring * 1000) / 1000, midis: up ? v.slice(-Math.min(3, v.length)) : v.slice(), strum: up ? "up" : "down",
                vel: Math.round(clamp(spread(ctx, acc ? (up ? 0.62 : 0.67) : up ? 0.45 : 0.53, 0.57) + phraseDyn(ctx, h.pos) + (rng() - 0.5) * 0.04, 0.38, 0.76) * 1000) / 1000, inst: su.inst, of: ck };
          if (up) e.arp = true;                                         // (part of the shape: not the chord's voicing for the hand-off)
          out(up ? e : grip(e)); if (!up) left(e, h, chord, ck, v, changeAt); return;
        }
        var room = Math.min(nextPos, changeAt) - h.pos, dur = h.len === "S" ? Math.min(sLen, room - 0.05) : g.hold ? room - 0.04 : Math.min(2.5, room - 0.1);
        var vel = (g.quiet ? (on ? 0.56 : 0.48) : h.len === "L" ? 0.60 : 0.58) + (rng() - 0.5) * 0.06;
        // the same shaping for the other patterns it suits (not the Latin ones or the tunes' own vamps, whose accents are the pattern)
        if (g.quiet) vel = spread(ctx, vel + leanDyn(ctx, h.pos), 0.52) + phraseDyn(ctx, h.pos);          // driving eighths, triplets
        else if (su.grid === "oompah") vel += phraseDyn(ctx, h.pos);                                       // (how hard it is hit is the boom-chick slider's)
        else if (g.hold) vel += phraseDyn(ctx, h.pos) + leanDyn(ctx, h.pos, 0.5);                          // the hymn
        // quarter notes are not all alike: the bar leans on its strong beats, the phrase swells towards its third bar and the
        // last beats of a phrase grow into the next one; how far apart loud and soft are follows how hard the band is playing
        if (su.grid === "quarters"){
          var qb = Math.floor(h.pos + 1e-6), qI = ctx.intensity == null ? 0.5 : ctx.intensity, qp = (ctx.phrase && ctx.phrase.bar) || 0;
          var lean = qb === 0 ? 0.055 : beats === 4 && qb === 2 ? 0.015 : beats % 2 === 0 && qb % 2 ? -0.045 : -0.035;
          var swell = [0, 0.015, 0.035, 0.005][qp % 4];
          var grow = qp % 4 === 3 ? 0.05 * (h.pos / Math.max(1, beats - 1)) : 0;
          vel = 0.54 + 0.10 * qI + lean * (0.8 + 0.6 * qI) + swell + grow + (rng() - 0.5) * 0.04;
          if (firstOf[ck] == null){ firstOf[ck] = 1; if (qb !== 0) vel += 0.03; }                  // a new chord inside the bar is placed
        }
        if (g.waltz && beats === 3){
          var wp = (ctx.phrase && ctx.phrase.bar) || 0, wI = ctx.intensity == null ? 0.5 : ctx.intensity;
          vel = (h.pos < 1.5 ? 0.50 : 0.45) + 0.08 * wI + [0.03, -0.02, 0.01, -0.03][wp % 4] + (wp % 4 === 3 && h.pos >= 1.5 ? 0.05 : 0) + (rng() - 0.5) * 0.03;
          dur = Math.min(dur, ctx.tempo > 150 ? 0.42 : 0.55);
        }
        // boom-chick strength (opts.boom, 0..1; 0.5 = as written): soft and a little longer, or short and hard
        if (su.grid === "oompah" && ctx.opts && ctx.opts.boom != null){ var bm = Math.max(0, Math.min(1, +ctx.opts.boom)); vel *= 0.72 + 0.56 * bm; dur = Math.min(room - 0.05, dur * (1.7 - 1.4 * bm)); }
        e = { pos: h.pos, dur: Math.round(Math.max(0.12, dur) * 1000) / 1000, midis: v.slice(), vel: Math.round(clamp(vel, su.grid === "quarters" || g.waltz || g.quiet ? 0.36 : 0.42, su.grid === "quarters" ? 0.78 : g.quiet || g.hold || su.grid === "oompah" ? 0.74 : 0.7) * 1000) / 1000, inst: su.inst, of: ck };
        // the piano's plain triads often go without their root or their fifth (opts.variation > 0; settled once for each chord; not in the hymn's four parts)
        var amt5 = Math.max(0, Math.min(1, +(ctx.opts && ctx.opts.variation) || 0));
        if (amt5 > 0 && su.inst === "piano" && su.style === "standard" && v.length === 3 && !g.hold && !h.shift && !pinOf(su, ck)){
          if (no5[ck] == null){ var rd = rng(); no5[ck] = rd < 0.3 * amt5 && chord.seventh == null ? "root" : rd < 0.6 * amt5 ? "fifth" : ""; }       // the root (the left hand has it) or the fifth
          var f5pc = (((chord.root + (no5[ck] === "root" ? 0 : chord.fifth != null ? chord.fifth : 7)) % 12) + 12) % 12, kept = v.filter(function (m){ return ((m % 12) + 12) % 12 !== f5pc; });
          if (no5[ck] && kept.length === 2){ e.midis = kept; e.arp = true; out(e); left(e, h, chord, ck, v, changeAt); return; }
        }
        if (h.shift){ e.midis = v.map(function (m){ return m + h.shift; }); e.arp = true; out(e); return; }      // (planed: not the chord's own voicing for the hand-off)
        out(grip(e));
        left(e, h, chord, ck, v, changeAt);
      });
      st.started = true;
      return ev;
    }

    function ending(ctx){
      var H = global.BandHarmony, c = firstChord(ctx && ctx.chords);
      if (!c) return [];
      var su = setup(ctx.opts), ck = ctx.index + ":0";
      if (su.style === "auto") su.style = H.hasStyle(su.inst, "drop2") ? "drop2" : H.defaultStyle(su.inst);   // a full chord to finish on
      st.lastKey = null; var v = pick(c, su, ck);                       // (always re-voiced for the last hit)
      st.antic = false; st.plan = null;
      return v.length ? [{ pos: 0, dur: 4, midis: v.slice(), vel: 0.62, inst: su.inst, of: ck }] : [];
    }
    return { bar: bar, ending: ending, reset: reset };
  }

  // The organist's right foot and left hand: where the swell pedal sits and when the rotary speaker changes speed, bar by
  // bar (ORGAN.md beside this file gives the reasons and the sources). The organ has no touch: all its dynamics are here.
  //   organist(ctx, method, st) -> [{ pos (beats), ctl: "swell" | "leslie", value, glide (beats) }]
  // ctx.opts.organ = { swell: "auto" | 0..1, leslie: "auto" | "slow" | "fast" | "stop" } (unset = both automatic). st is the
  // caller's to keep between bars. No random numbers.
  //   Swell: follows how hard the band is playing (about half open when it plays down, nearly open at full), a little more
  //     in a chorus. The last bar of a four-bar phrase opens through the bar into the next one; the bar after settles back.
  //     A stop bar is pulled back sharply after its chord. The last chord swells up and is let go.
  //   Leslie: slow is home. Straight-eighth music: fast through the last bar of a phrase that leads into a chorus or the top
  //     of the form, or that the band is playing hard; fast for the second half of the last bar of any other four-bar
  //     phrase when one chord has been held for two bars or more (a flick: fast and straight back, so the horn is still
  //     slowing as the next phrase starts). Swing: the speaker stays slow (jazz organists mostly leave it alone) except for
  //     the last two bars of the form on the last chorus. Fast on the final chord.
  function organist(ctx, method, st){
    var o = (ctx.opts && ctx.opts.organ) || {}, out = [], beats = ctx.beats || 4, I = ctx.intensity == null ? 0.5 : ctx.intensity, H = global.BandHarmony;
    var qp = ((ctx.phrase && ctx.phrase.bar) || 0) % 4, lift = !!(H && H.lifted && H.lifted(ctx)), swing = !!(ctx.opts && ctx.opts.feel !== "straight") && !ctx.compound;
    var nextLift = !!(ctx.opts && ctx.opts.lift && ctx.opts.lift.indexOf && ctx.nextIndex != null && ctx.opts.lift.indexOf(ctx.nextIndex) >= 0 && !lift);
    var toTop = ctx.nextIndex === 0 && ctx.length > 4 && !ctx.last, base = clamp(0.48 + 0.42 * I + (lift ? 0.07 : 0), 0.3, 0.97);
    function push(pos, ctl, value, glide){ out.push({ pos: Math.round(pos * 1000) / 1000, ctl: ctl, value: value, glide: glide || 0 }); }
    // the chord held: how many bars the first chord of this bar has now sounded
    var c0 = ctx.chords && ctx.chords[0] && ctx.chords[0].chord, one = !!c0 && ctx.chords.length === 1, key = c0 ? c0.key : "";
    st.held = one && st.heldKey === key ? (st.held || 1) + 1 : 1; st.heldKey = one ? key : "";
    if (o.swell == null || o.swell === "auto"){
      if (method === "ending"){ push(0, "swell", clamp(base + 0.15, 0, 1), 1.5); push(Math.min(2, beats - 0.5), "swell", 0.35, 2.5); }
      else if (ctx.stop){ push(0, "swell", clamp(base + 0.08, 0, 1), 0.1); push(Math.min(0.6, beats / 2), "swell", clamp(base - 0.25, 0.2, 1), 0.3); }
      else if (qp === 3 || nextLift){ push(0, "swell", base, 0.6); push(beats > 2 ? 1 : 0.5, "swell", clamp(base + (nextLift ? 0.16 : 0.1), 0, 1), beats - 1); }       // opening into the next phrase
      else push(0, "swell", qp === 0 ? clamp(base - 0.03, 0, 1) : base, qp === 0 ? 1.5 : 1);
    } else if (!st.swellSet || st.swellSet !== o.swell){ push(0, "swell", clamp(+o.swell || 0, 0, 1), 0.2); st.swellSet = o.swell; }
    if (o.leslie == null || o.leslie === "auto"){
      var want = "slow", back = null;
      if (method === "ending") want = "fast";
      else if (swing){ if (ctx.finalChorus && ctx.length - ctx.index <= 2) want = "fast"; }
      else if (ctx.stop) want = "slow";
      else if ((qp === 3 || nextLift) && (nextLift || toTop || I >= 0.66)) want = "fast";
      else if (qp === 3 && st.held >= 2 && beats >= 3) back = Math.floor(beats / 2);                 // the flick on a held chord
      if (back != null){ if (st.leslie !== "slow"){ push(0, "leslie", "slow"); } push(back, "leslie", "fast"); push(Math.min(beats - 0.25, back + 1.5), "leslie", "slow"); st.leslie = "slow"; }
      else if (st.leslie !== want){ push(0, "leslie", want); st.leslie = want; }
    } else if (st.leslie !== o.leslie){ push(0, "leslie", o.leslie); st.leslie = o.leslie; }
    return out;
  }

  // A second chord player (the player's part "comp2"): another instance of the same part, playing ctx.opts.second
  // ({ comp: "piano" | "guitar", compSound, compRhythm, voicing, voiceMove? }) on top of the band's other options.
  // Silent, and drawing no random numbers, while opts.second is unset. It has its own fretting hand, takes no pins,
  // no blend sliders and no unmarked extensions, and its events carry second:true.
  function secondOpts(opts){
    var s = opts && opts.second; if (!s || !s.comp) return null;
    return Object.assign({}, opts, { voiceMove: "hold" }, s, { second: null, pins: null, rhythmMix: null, voicingMix: null, extend: null, maj6: false });
  }
  function createSecond(o){
    var inner = create(o), H = global.BandHarmony;
    function run(method, ctx){
      var so = secondOpts(ctx && ctx.opts); if (!so) return [];
      var c2 = Object.assign({}, ctx, { opts: so }), go = function (){ return inner[method](c2) || []; };
      var evs = H && H.withHand ? H.withHand("second", go) : go();
      evs.forEach(function (e){ if (e) e.second = true; });
      return evs;
    }
    return { bar: function (ctx){ return run("bar", ctx); }, ending: function (ctx){ return run("ending", ctx); }, reset: function (){ inner.reset(); } };
  }

  global.BandComp = { create: create, organist: organist, createSecond: createSecond, secondOpts: secondOpts, FIGURES: FIG, PHRASES: PHRASES, GRID: GRID };
})(typeof window !== "undefined" ? window : globalThis);
