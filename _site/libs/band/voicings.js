// voicings.js — shared chord-voicing library (ChordVoicings).
// The one registry of voicing styles: piano close-position / shell / guide-tone / rootless /
// drop-2 / drop-3, guitar drop-2 / drop-3 / three-string triads and no-5th sevenths. Pure
// functions on a neutral chord description, so the Chord Sheet tool and the backing-band
// engine list and draw the same shapes.
//
//   chord = { root: <pitch class 0-11>, intervals: [semitones above the root, e.g. 0,4,7,10] }
//           Extensions may be written above the octave (14 = 9th, 17 = 11th, 21 = 13th).
//
//   ChordVoicings.styles("piano" | "guitar")        -> [{ id, label, sheetOnly? }]   the menu, in order
//        guitar "standard" / "shell" are the Chord Sheet's own fret-position search
//        (sheetOnly: true): ChordVoicings.guitar() does not draw them, other pages skip them.
//   ChordVoicings.piano(chord, style, opts)         -> [candidate]
//        style: "standard" | "shell" | "guide" | "rootless" | "drop2" | "drop3"
//        opts { lo, hi, center, allOctaves:false }   register defaults per style (drop: 43-79,
//        rootless / guide: 48-74); allOctaves lists every placement in range, not just the
//        one nearest `center`
//        candidate { midis:[low..high], inversion, label, bass, tones:[names low..high], note }
//   ChordVoicings.guitar(chord, style, opts)        -> [candidate]   style: "drop2" | "drop3" | "triad3" | "shell3"
//                                                                    | "triadvl" | "uppervl" | "guide2"
//        opts { tuning:[40,45,50,55,59,64], maxFret:15, maxSpan:4, stringSets:[[idx..]..], allPositions:false }
//        candidate adds { strings:[{ string, fret, midi }], stringSet:[idx..], span, order }
//   ChordVoicings.nearest(candidates, prevMidis, target) -> candidate with the least voice motion
//        (prevMidis null/empty -> the one centred nearest `target`, default 60)
//   ChordVoicings.motion(prevMidis, midis)          -> the cost nearest() minimises
//   ChordVoicings.lead(candidates, prevMidis, target) -> candidate each of whose voices moves least
//        from the same voice of prevMidis (string by string when both sit on one string set),
//        pulled gently toward `target` so a long tune does not climb the neck. Falls back to
//        nearest() when the note counts differ.
//   ChordVoicings.handMotion(prevStrings, strings)  -> how far the fretting HAND moves between two shapes
//        ([{ string, fret }] each): frets the hand position shifts, plus half the fret change on each
//        string both shapes use, plus 0.75 for each string picked up or let go. 0 = the same grip.
//   ChordVoicings.easiest(candidates, prevStrings, prevMidis, target) -> the candidate that is the smallest
//        move for the hand (voice motion only breaks near-ties); with no previous shape, the one
//        nearest fret `target` (default 5). This is how fretted instruments are voice-led.
//   ChordVoicings.analyze(chord) / .reduce(chord, n) / .intervalsFromFormula("1 b3 5 b7")
//
//   standard  every chord tone in close position, one candidate per inversion (extensions
//             written above the octave stay there); shell  root-3rd-7th (6th) close position,
//             inversions as above (a chord with no 7th/6th/extension gets its triad);
//   guide     3rd + 7th (6th) only, 3rd or 7th below; rootless  four-note A/B left-hand shapes
//             (3-5-7-9 / 7-9-3-5 and the dominant 3-13-7-9 / 7-9-3-13, ...), recipes shared
//             with the band engine (band/harmony.js). Extensions arrive as intervals above
//             the octave or as altered in-octave tones (b9 = 1 or 13, #9 = 3 beside a major
//             3rd or 15, #11 = 6 beside a 5th, b13 = 8 beside a 5th or 20); a plain 7th chord
//             gets the natural 9th and 13th. A few classes keep the root, as the band does
//             (half-diminished, diminished, sus, augmented, power); `note` says "no root"
//             when it is left out. For these two `inversion` is the form index (0 = A, 1 = B).
//
// `inversion` is the index of the BASS tone among the voiced chord tones in ascending
// order (0 = root in the bass when the root is voiced), which is how drop voicings and
// triad inversions are normally named. String indices count from the lowest string (0);
// labels use string NUMBERS (1 = highest), e.g. "Strings 4-3-2 · 1st inv".
//
// Guitar shapes are searched from the tuning, never hard-coded, so other tunings and
// instruments work; a style that needs more strings than the tuning has returns [].
//   drop2   adjacent four-string sets          drop3   bass string, one skipped, then three
//   triad3  close triads on adjacent three-string sets
//   shell3  root-3rd-7th (6th) with NO 5th, every playable order, on adjacent three-string
//           sets plus the skipped-string (Freddie Green) sets
//   triadvl three-note triads for voice leading on ONE string set: root-3rd-5th of every chord
//           (a 7th chord gives its plain triad, a sus chord R-4-5), named by tone order
//   uppervl the same, but a 7th chord gives the triad on its 3rd (3-5-7: Cmaj7 -> E minor,
//           C7 -> E dim, Dm7 -> F, Bm7b5 -> D minor); a 6th chord its relative triad (6-R-3),
//           a 7sus the triad a tone below the root (b7-9-4). Chords with no 7th give triads.
//   Ask for these with allPositions and one stringSets entry, then pick with lead().
//   guide2  two-note chords on the adjacent string PAIRS 4-5, 3-4 and 2-3 (never the outer strings):
//           the 3rd and 7th (6th) of a 7th chord in either order, root and 3rd of a plain triad,
//           4th and b7th of a 7sus, root and 5th of a power chord
// triad3 and shell3 answer for each other (a 7th chord asked for as triad3 gives shells, a
// triad asked for as shell3 gives triads), so either always yields something. One shape per
// string set and inversion (the lowest on the neck) unless allPositions is set. A fret span
// of maxSpan+1 is used only where a bass note has no shape within maxSpan.
//
// Chords with more tones than voices are reduced by how characteristic each tone is:
// the natural 5th goes first, then the root, then the plainer extensions; the 3rd and
// 7th always stay (a 9th chord keeps R-3-7-9, a 13th becomes rootless 3-7-9-13). `note`
// says what was left out ("no 5th", "no root, no 5th"). Triads under drop2/drop3 give
// open (spread) triads, and a power chord gives root-5th-root, so no style comes back
// empty for a plain chord.

(function (global) {
  function mod12(n){ return ((n % 12) + 12) % 12; }

  // ---- chord tones: which interval plays which role, and how much it matters ----
  var EXT_NAME = { 1:"b9", 2:"9", 3:"#9", 5:"11", 6:"#11", 8:"b13", 9:"13", 10:"b7", 11:"7", 7:"5", 4:"3" };
  var EXT_RANK = { "#9":60, "b13":58, "#11":56, "b9":54, "13":50, "11":45, "9":40 };
  var THIRD_NAME = { 4:"3", 3:"b3", 5:"4", 2:"2" };
  var FIFTH_NAME = { 7:"5", 6:"b5", 8:"#5" };

  function analyze(chord){
    var ivs = (chord && chord.intervals) || [], core = {}, ext = {}, i;
    for (i = 0; i < ivs.length; i++){ if (ivs[i] >= 0 && ivs[i] < 12) core[ivs[i]] = true; else ext[mod12(ivs[i])] = true; }
    var tones = [], used = {};
    function add(off, role, name, rank){
      if (used[off]) return null;
      var t = { off:off, role:role, name:name, rank:rank }; used[off] = true; tones.push(t); return t;
    }
    var third = core[4] ? 4 : core[3] ? 3 : core[5] ? 5 : core[2] ? 2 : null;
    var fifth = core[7] ? 7 : core[6] ? 6 : core[8] ? 8 : null;
    var seventh = core[11] ? 11 : core[10] ? 10 : core[9] ? 9 : null;
    var nat11 = (core[5] && third !== 5) || ext[5];
    var out = { root: mod12(chord && chord.root || 0), tones: tones, rootTone:null, third:null, fifth:null, seventh:null };
    if (core[0]) out.rootTone = add(0, "root", "R", 20);
    // A dominant/major 11th is played as a sus sound: the natural 11 pushes the major 3rd out.
    if (third != null) out.third = add(third, "third", THIRD_NAME[third], (third === 4 && nat11) ? 5 : 100);
    if (fifth != null) out.fifth = add(fifth, "fifth", FIFTH_NAME[fifth], fifth === 7 ? 10 : fifth === 8 ? 58 : 57);
    if (seventh != null) out.seventh = add(seventh, "seventh", seventh === 11 ? "7" : seventh === 10 ? "b7" : (third === 3 && fifth === 6) ? "bb7" : "6", 99);
    var k, name;
    for (k = 1; k < 12; k++){                    // leftover in-octave tones and written-out extensions
      if (!(core[k] || ext[k]) || used[k]) continue;
      name = EXT_NAME[k]; if (!name) continue;
      add(k, "ext", name, EXT_RANK[name] || 30);
    }
    tones.sort(function (a, b){ return a.off - b.off; });
    return out;
  }

  // Keep the n most characteristic tones (in ascending order) and say what went.
  function reduceTones(a, n){
    if (a.tones.length <= n) return { tones: a.tones.slice(), dropped: [], note: "" };
    var byRank = a.tones.slice().sort(function (x, y){ return y.rank - x.rank || x.off - y.off; });
    var keep = byRank.slice(0, n).sort(function (x, y){ return x.off - y.off; });
    var dropped = byRank.slice(n).sort(function (x, y){ return x.off - y.off; });
    return { tones: keep, dropped: dropped, note: dropped.map(function (t){ return "no " + ordinalName(t.name); }).join(", ") };
  }
  function reduce(chord, n){
    var r = reduceTones(analyze(chord), n == null ? 4 : n);
    return { intervals: r.tones.map(function (t){ return t.off; }), names: r.tones.map(function (t){ return t.name; }),
             dropped: r.dropped.map(function (t){ return t.name; }), note: r.note };
  }

  // ---- naming ----
  function pretty(name){ return name.replace(/b/g, "♭").replace(/#/g, "♯"); }
  function ordinalName(name){                    // "b7" -> "♭7th", "R" -> "root"
    if (name === "R") return "root";
    var m = /^([b#]*)(\d+)$/.exec(name); if (!m) return name;
    var n = parseInt(m[2], 10), suf = n === 2 ? "nd" : n === 3 ? "rd" : "th";
    return pretty(m[1]) + n + suf;
  }
  function cap(s){ return s.charAt(0).toUpperCase() + s.slice(1); }
  function bassLabel(name){ return cap(ordinalName(name)) + " in bass"; }
  var INV_NAME = ["Root position", "1st inv", "2nd inv", "3rd inv"];

  function intervalsFromFormula(formula){
    var BASE = [0, 2, 4, 5, 7, 9, 11], out = [];
    String(formula || "").trim().split(/\s+/).forEach(function (tok){
      var m = /^([b#]*)(\d+)$/.exec(tok); if (!m) return;
      var d = parseInt(m[2], 10), acc = 0, i;
      for (i = 0; i < m[1].length; i++) acc += m[1][i] === "#" ? 1 : -1;
      out.push(BASE[(d - 1) % 7] + 12 * Math.floor((d - 1) / 7) + acc);
    });
    return out;
  }

  // The three tones a voice-led triad style plays (ascending offsets), or null when the chord
  // has no third or fourth to build one on.
  function leadTriad(a, upper){
    function tone(off, name){ return { off: off, role: "lead", name: name, rank: 50 }; }
    var th = a.third, fi = a.fifth || tone(7, "5"), sv = a.seventh, out;
    if (!th) return null;
    if (!upper || !sv) out = [a.rootTone || tone(0, "R"), th, fi];
    else if (sv.off === 9 && !(th.off === 3 && fi.off === 6)) out = [a.rootTone || tone(0, "R"), th, sv];   // 6th chord: its relative triad
    else if (th.off === 5 || th.off === 2) out = [tone(2, "9"), tone(5, "4"), sv];                           // 7sus: the triad a tone below
    else out = [th, fi, sv];
    return out.sort(function (x, y){ return x.off - y.off; });
  }

  // ---- which voices a style puts on the instrument ----
  // kind: "four" (4-note drop voicing), "three" (triad, or a shell for the 3-string styles),
  // "shell" (root-3rd-7th), "dyad" (power chord: root-5th-root).
  function voicesFor(chord, style){
    var a = analyze(chord), T = a.tones;
    var isTriad = T.length === 3 && !!a.fifth;
    function shell(){
      var r = a.rootTone, th = a.third || a.fifth, sv = a.seventh;
      if (!sv){ var exts = T.filter(function (t){ return t.role === "ext"; }).sort(function (x, y){ return y.rank - x.rank; }); sv = exts[0] || null; }
      if (!r || !th || !sv || th === sv) return null;
      return [r, th, sv].sort(function (x, y){ return x.off - y.off; });
    }
    if (T.length < 2) return { kind: "none", tones: T, note: "" };
    if (style === "guide2"){
      var lo2 = a.third && a.seventh ? a.third : a.rootTone, hi2 = a.third && a.seventh ? a.seventh : (a.third || a.fifth);
      if (lo2 && hi2 && lo2 !== hi2) return { kind: "pair", tones: [lo2, hi2].sort(function (x, y){ return x.off - y.off; }), note: "" };
      return { kind: "pair", tones: T.slice(0, 2), note: "" };
    }
    if (T.length === 2) return { kind: "dyad", tones: T, note: "" };
    if (style === "triadvl" || style === "uppervl"){
      var tr = leadTriad(a, style === "uppervl");
      if (tr) return { kind: "three", tones: tr, note: "" };
      var r3v = reduceTones(a, 3); return { kind: "three", tones: r3v.tones, note: r3v.note };
    }
    if (style === "triad3" || style === "shell3"){
      if (isTriad) return { kind: "three", tones: T, note: "" };
      var sh = shell();
      if (sh){
        var left = T.filter(function (t){ return sh.indexOf(t) < 0; });
        return { kind: "shell", tones: sh, note: left.map(function (t){ return "no " + ordinalName(t.name); }).join(", ") };
      }
      var r3 = reduceTones(a, 3); return { kind: "three", tones: r3.tones, note: r3.note };
    }
    if (T.length === 3) return { kind: "three", tones: T, note: "" };
    var r4 = reduceTones(a, 4); return { kind: "four", tones: r4.tones, note: r4.note };
  }

  // ---- PIANO ----
  // Close-position inversion i (tone i lowest), with the `which`-th voice from the top
  // dropped an octave. Returns semitone offsets above the new bass plus who is in the bass.
  function dropShape(offs, i, which){
    var n = offs.length, close = [], k;
    for (k = 0; k < n; k++) close.push(k ? mod12(offs[(i + k) % n] - offs[i]) : 0);
    var idx = Math.max(0, n - which);            // triad + drop 3: the bottom voice drops
    var voices = close.map(function (v, j){ return { rel: j === idx ? v - 12 : v, tone: (i + j) % n }; });
    voices.sort(function (x, y){ return x.rel - y.rel; });
    var low = voices[0].rel;
    return { rels: voices.map(function (v){ return v.rel - low; }), order: voices.map(function (v){ return v.tone; }), bass: voices[0].tone };
  }
  function centreOf(midis){ var s = 0; for (var i = 0; i < midis.length; i++) s += midis[i]; return midis.length ? s / midis.length : 0; }
  function ordinalInv(i){ return i === 0 ? "Root position" : (i === 1 ? "1st" : i === 2 ? "2nd" : i === 3 ? "3rd" : i + "th") + " inversion"; }

  // Close-position rotations of items [{ off: semitones above the root, ascending, name }]:
  // rotation i puts item i in the bass and lifts the ones below it an octave.
  function rotations(items){
    var n = items.length, out = [], i, k;
    for (i = 0; i < n; i++){
      var vs = [];
      for (k = 0; k < n; k++){
        var it = items[(i + k) % n], off = it.off;
        if (i + k >= n) while (off <= items[i].off) off += 12;       // below the bass: up to the nearest place above it
        vs.push({ rel: off - items[i].off, name: it.name });
      }
      vs.sort(function (x, y){ return x.rel - y.rel; });
      out.push({ rels: vs.map(function (v){ return v.rel - vs[0].rel; }), names: vs.map(function (v){ return v.name; }),
                 bass: i, bassOff: items[i].off, label: ordinalInv(i), note: "" });
    }
    return out;
  }

  // ---- jazz chord reading: neutral { root, intervals } -> the flags the band's recipes use ----
  // Mirrors BandHarmony.parseChord (third, fifth, seventh, sixth, sus, b9, s9, s11, b5, s5, b13).
  function jazzChord(chord){
    var ivs = (chord && chord.intervals) || [], core = {}, ext = {}, i, iv;
    for (i = 0; i < ivs.length; i++){ iv = ivs[i]; if (iv >= 0 && iv < 12) core[iv] = 1; else ext[mod12(iv)] = 1; }
    var has = function (k){ return !!(core[k] || ext[k]); };
    var c = { root: mod12(chord && chord.root || 0) };
    var third = core[4] ? 4 : core[3] ? 3 : null;
    c.s9 = !!(ext[3] || (core[3] && core[4]));
    c.b9 = has(1);
    c.fifth = core[7] ? 7 : core[6] ? 6 : core[8] ? 8 : null;
    c.s11 = !!(ext[6] || (core[6] && core[7]));
    c.b5 = !!(core[6] && !core[7]);
    c.s5 = !!(core[8] && !core[7]);
    c.b13 = !!(ext[8] || (core[8] && core[7]));
    c.seventh = core[11] ? 11 : core[10] ? 10 : null;
    var dim7 = third === 3 && c.fifth === 6 && !!core[9] && c.seventh == null;
    if (dim7) c.seventh = 9;
    c.sixth = (!dim7 && c.seventh == null && (core[9] || ext[9])) ? 9 : null;
    var nat11 = !!(ext[5] || (core[5] && core[4])), only = true;
    for (i = 0; i < ivs.length; i++) if (mod12(ivs[i]) !== 0 && mod12(ivs[i]) !== 7) only = false;
    c.sus = 0;
    if (third == null) c.sus = core[5] ? 4 : core[2] ? 2 : 0;
    else if (third === 4 && nat11 && c.seventh !== 11 && !c.b9 && !c.s9) { c.sus = 4; third = null; }   // C11 is played as C9sus4
    c.third = third;
    var power = only && third == null && !c.sus;
    var quality = power ? "power" : c.sus ? "sus"
      : (third === 3 && c.fifth === 6) ? (c.seventh === 10 ? "hdim" : "dim")
      : third === 3 ? "min"
      : c.seventh === 10 ? "dom"
      : ((c.b9 || c.s9) && !power) ? "dom"
      : (c.fifth === 8 && c.seventh == null) ? "aug" : "maj";
    if (quality === "dom" && c.seventh == null) c.seventh = 10;
    c.quality = quality;
    var isDom = quality === "dom" || (quality === "sus" && c.seventh === 10);
    c.b9 = c.b9 && (isDom || quality === "min");
    c.s9 = c.s9 && isDom;
    return c;
  }
  function jazzClass(c){
    switch (c.quality){
      case "dom":  return "dom";
      case "sus":  return c.seventh != null ? "sus7" : c.sus === 2 ? "sus2" : "sus";
      case "maj":  return c.seventh === 11 ? "maj7" : "maj6";
      case "min":  return (c.sixth != null && c.seventh == null) ? "min6" : "min7";
      case "hdim": return "hdim";
      case "dim":  return "dim";
      case "aug":  return "aug";
      default:     return "power";
    }
  }
  // Forms: chord degrees from the bottom note up (resolved per chord, so one "dom" row covers
  // 7, 9, 13, 7b9, 7#9, 7#5, 7#11 and alt). Same tables as BandHarmony.STYLES.
  var JAZZ_FORMS = {
    rootless: {
      dom:   [["3","13","7","9"], ["7","9","3","13"]],
      sus7:  [["4","13","7","9"], ["7","9","4","13"]],
      maj7:  [["3","5","7","9"],  ["7","9","3","5"]],
      maj6:  [["3","5","6","9"],  ["6","9","3","5"]],      // also bare major triads
      min7:  [["3","5","7","9"],  ["7","9","3","5"]],      // also bare minor triads
      min6:  [["3","5","6","9"],  ["6","9","3","5"]],
      hdim:  [["3","5","7","R"],  ["7","R","3","5"]],
      dim:   [["R","3","5","bb7"], ["3","5","bb7","R"], ["5","bb7","R","3"], ["bb7","R","3","5"]],
      aug:   [["3","5","R"], ["5","R","3"], ["R","3","5"]],
      sus:   [["4","5","R","9"],  ["R","9","4","5"]],
      sus2:  [["R","2","5"], ["5","R","2"]],
      power: [["R","9","5"], ["5","R","9"]]
    },
    guide: {
      dom:   [["3","7"], ["7","3"]],
      sus7:  [["4","7"], ["7","4"]],
      maj7:  [["3","7"], ["7","3"]],
      maj6:  [["3","6"], ["6","3"]],
      min7:  [["3","7"], ["7","3"]],
      min6:  [["3","6"], ["6","3"]],
      hdim:  [["3","7"], ["7","3"]],
      dim:   [["3","bb7"], ["bb7","3"]],
      aug:   [["3","5"], ["5","3"]],
      sus:   [["4","5"], ["5","4"]],
      sus2:  [["2","5"], ["5","2"]],
      power: [["R","5"], ["5","R"]]
    }
  };
  // degree token -> { iv: semitones above the root, name }. `fi` = form index: a dominant
  // carrying both b9 and #9 (alt) takes the #9 in form A and the b9 in form B.
  function jazzDegree(c, tok, fi){
    switch (tok){
      case "R":   return { iv: 0, name: "R" };
      case "2":   return { iv: 2, name: "2" };
      case "4":   return { iv: 5, name: "4" };
      case "3":   return c.third != null ? { iv: c.third, name: c.third === 4 ? "3" : "b3" } : c.sus === 2 ? { iv: 2, name: "2" } : { iv: 5, name: "4" };
      case "5":   if (c.quality === "maj" && c.s11) return { iv: 6, name: "#11" };       // maj7#11: #11 replaces the 5th
                  if (c.fifth === 6) return { iv: 6, name: "b5" };
                  if (c.fifth === 8) return { iv: 8, name: "#5" };
                  return { iv: 7, name: "5" };
      case "6":   return { iv: 9, name: "6" };
      case "bb7": return { iv: 9, name: "bb7" };
      case "7":   return c.seventh === 11 ? { iv: 11, name: "7" } : c.seventh === 9 ? { iv: 9, name: "bb7" }
                    : c.seventh === 10 ? { iv: 10, name: "b7" } : c.quality === "maj" ? { iv: 11, name: "7" } : { iv: 10, name: "b7" };
      case "9":   if (c.b9 && c.s9) return fi === 0 ? { iv: 3, name: "#9" } : { iv: 1, name: "b9" };
                  return c.b9 ? { iv: 1, name: "b9" } : c.s9 ? { iv: 3, name: "#9" } : { iv: 2, name: "9" };
      case "13":  return (c.b13 || c.s5) ? { iv: 8, name: c.s5 && !c.b13 ? "#5" : "b13" } : (c.s11 || c.b5) ? { iv: 6, name: "#11" } : { iv: 9, name: "13" };
    }
    return { iv: 0, name: "R" };
  }
  function jazzShapes(chord, style){
    var c = jazzChord(chord), cls = jazzClass(c), forms = JAZZ_FORMS[style][cls] || JAZZ_FORMS[style].power;
    // a bare triad's guide tones are its 3rd and 5th (the 6th would make it a 6 chord)
    if (style === "guide" && c.seventh == null && c.sixth == null && (cls === "maj6" || cls === "min7")) forms = [["3","5"], ["5","3"]];
    var out = [];
    forms.forEach(function (form, fi){
      var seen = {}, items = [], prev = null;
      form.forEach(function (tok){
        var d = jazzDegree(c, tok, fi); if (seen[d.iv]) return; seen[d.iv] = 1;
        var rel = prev == null ? 0 : prev.rel + (mod12(d.iv - prev.iv) || 12);
        prev = { iv: d.iv, name: d.name, rel: rel }; items.push(prev);
      });
      // a #9 sits above the major 3rd, never a semitone under it
      if (c.s9 && c.third === 4){
        var i9 = -1, i3 = -1;
        items.forEach(function (it, k){ if (it.iv === 3) i9 = k; if (it.iv === 4) i3 = k; });
        if (i9 >= 0 && i3 >= 0 && items[i9].rel < items[i3].rel){
          var top = Math.max.apply(null, items.map(function (it){ return it.rel; }));
          while (items[i9].rel < top) items[i9].rel += 12;
        }
      }
      items.sort(function (x, y){ return x.rel - y.rel; });
      var low = items[0].rel, hasRoot = items.some(function (it){ return it.iv === 0; });
      var shape = { rels: items.map(function (it){ return it.rel - low; }), names: items.map(function (it){ return it.name; }),
                    bass: fi, bassOff: items[0].iv, note: style === "rootless" && !hasRoot ? "no root" : "" };
      shape.label = (style === "rootless" ? "ABCD".charAt(fi) + " form (" : "") + bassLabel(items[0].name) + (style === "rootless" ? ")" : "");
      out.push(shape);
    });
    return out;
  }

  // Register each style is placed in unless opts.lo / hi / center say otherwise.
  var PIANO_REG = {
    standard: { lo: 48, hi: 84, center: 64 }, shell: { lo: 48, hi: 80, center: 60 },
    guide:    { lo: 48, hi: 74, center: 58 }, rootless: { lo: 48, hi: 74, center: 60 },
    drop2:    { lo: 43, hi: 79 },             drop3: { lo: 43, hi: 79 }
  };

  // The voicing shapes of a style: [{ rels, names, bass, bassOff, label, note }], rels =
  // semitones above the bass note, bassOff = the bass note's interval above the root, names =
  // chord-tone names low to high.
  function pianoShapes(chord, style){
    var out = [];
    if (style === "rootless" || style === "guide") return jazzShapes(chord, style);
    var a = analyze(chord);
    if (style === "standard"){
      var ivs = (chord.intervals || []).slice().sort(function (x, y){ return x - y; }), seen = {}, names = {};
      a.tones.forEach(function (t){ names[t.off] = t.name; });
      var items = [];
      ivs.forEach(function (iv){ var pc = mod12(iv); if (seen[pc] || !names[pc]) return; seen[pc] = 1; items.push({ off: iv, name: names[pc] }); });
      return items.length < 2 ? out : rotations(items);
    }
    var v = voicesFor(chord, style === "shell" ? "shell3" : style === "drop3" ? "drop3" : "drop2"), tones = v.tones;
    if (v.kind === "none") return out;
    if (style === "shell"){
      var sh = rotations(tones.map(function (t){ return { off: t.off, name: t.name }; }));
      sh.forEach(function (s){ s.note = v.note; });
      return sh;
    }
    var which = style === "drop3" ? 3 : 2;
    if (v.kind === "dyad"){                      // power chord: root-5th-root and 5th-root-5th
      var d = mod12(tones[1].off - tones[0].off);
      out.push({ rels:[0, d, 12], order:[0, 1, 0], bass:0 });
      out.push({ rels:[0, 12 - d, 12], order:[1, 0, 1], bass:1 });
    } else {
      var offs = tones.map(function (t){ return t.off; });
      for (var i = 0; i < offs.length; i++) out.push(dropShape(offs, i, which));
      out.sort(function (x, y){ return x.bass - y.bass; });
    }
    return out.map(function (sh){
      return { rels: sh.rels, names: sh.order.map(function (ti){ return tones[ti].name; }), bass: sh.bass, bassOff: tones[sh.bass].off, note: v.note,
               label: bassLabel(tones[sh.bass].name) + (v.note ? " (" + v.note + ")" : "") };
    });
  }

  function piano(chord, style, opts){
    opts = opts || {};
    style = style || "drop2";
    var reg = PIANO_REG[style]; if (!reg) return [];
    var lo = opts.lo == null ? reg.lo : opts.lo, hi = opts.hi == null ? reg.hi : opts.hi;
    var center = opts.center == null ? (opts.lo == null && opts.hi == null && reg.center != null ? reg.center : (lo + hi) / 2) : opts.center;
    var root = mod12(chord.root || 0), out = [];
    pianoShapes(chord, style).forEach(function (sh){
      var pc = mod12(root + sh.bassOff), span = sh.rels[sh.rels.length - 1], places = [], b;
      for (b = pc; b <= 127; b += 12) if (b >= lo && b + span <= hi) places.push(b);
      if (!places.length) for (b = pc; b + span <= 127; b += 12) if (b >= lo && b + span <= hi + 5) places.push(b);   // a little over the top
      if (!places.length) for (b = pc; b + span <= 127; b += 12) places.push(b);   // range too tight: ignore it rather than return nothing
      var mk = function (b0){ return sh.rels.map(function (r){ return b0 + r; }); };
      if (!opts.allOctaves){
        places.sort(function (x, y){ return Math.abs(centreOf(mk(x)) - center) - Math.abs(centreOf(mk(y)) - center); });
        places = places.slice(0, 1);
      }
      places.forEach(function (b0){
        out.push({ midis: mk(b0), inversion: sh.bass, bass: sh.names[0], tones: sh.names.slice(), note: sh.note, style: style, label: sh.label });
      });
    });
    return out;
  }

  // ---- GUITAR ----
  var DEFAULT_TUNING = [40, 45, 50, 55, 59, 64];

  // String sets a style uses, as index arrays (0 = lowest string), in menu order.
  function stringSets(style, kind, n){
    var sets = [], i;
    function push(a){ if (a[a.length - 1] < n && a[0] >= 0) sets.push(a); }
    if (kind === "pair"){                                                                        // two-note chords: inner adjacent pairs, highest first
      for (i = n - 3; i >= 1; i--) push([i, i + 1]);
      if (!sets.length) for (i = n - 2; i >= 0; i--) push([i, i + 1]);                           // fewer than four strings: any pair
    } else if (kind === "dyad"){                                                                 // power chord: same grips in every style
      for (i = n - 3; i >= 0; i--) push([i, i + 1, i + 2]);
    } else if (kind === "four"){
      if (style === "drop3") for (i = 0; i + 4 < n; i++) push([i, i + 2, i + 3, i + 4]);          // one skipped string above the bass
      else for (i = n - 4; i >= 0; i--) push([i, i + 1, i + 2, i + 3]);                          // adjacent, top set first
    } else if (style === "drop3"){                                                               // triad, bottom voice dropped
      for (i = 0; i + 4 < n; i++) push([i, i + 3, i + 4]);
    } else if (style === "drop2"){                                                               // open triads
      for (i = 0; i + 3 < n; i++){ push([i, i + 2, i + 3]); push([i, i + 1, i + 3]); }
    } else if (kind === "shell"){
      for (i = 0; i + 2 < n; i++){ push([i, i + 1, i + 2]); if (i + 3 < n) push([i, i + 2, i + 3]); }   // adjacent + Freddie Green skips
    } else {
      for (i = n - 3; i >= 0; i--) push([i, i + 1, i + 2]);                                      // close triads, top set first
    }
    return sets;
  }

  // Does this pitch stack (ascending) have the structure the style asks for?
  function fits(style, kind, m){
    var n = m.length, a = m[0] + 12;
    if (kind === "shell") return true;
    if (kind === "pair") return m[1] - m[0] < 12;
    if (kind === "dyad") return m[n - 1] - m[0] === 12;
    if (kind === "four"){
      if (m[3] - m[1] >= 12) return false;
      return style === "drop3" ? (m[1] < a && a < m[2]) : (m[2] < a && a < m[3]);
    }
    if (style === "drop2") return m[1] < a && a < m[2] && m[2] - m[1] < 12;
    if (style === "drop3") return a < m[1] && m[2] - a < 12;
    return m[n - 1] - m[0] < 12;                 // close triad
  }

  // Every way of putting one voice on each string of the set within a fret-span limit.
  function shapesOnSet(pcs, set, tuning, maxFret, limit){
    var n = set.length, found = [], seen = {}, usedV = [], cur = [];
    function rec(j, minF, maxF){
      if (j === n){
        var key = cur.map(function (c){ return c.fret; }).join(",");
        if (seen[key]) return; seen[key] = true;
        found.push({ notes: cur.map(function (c){ return { string:c.string, fret:c.fret, midi:c.midi, voice:c.voice }; }), span: maxF - minF + 1 });
        return;
      }
      for (var v = 0; v < n; v++){
        if (usedV[v]) continue;
        for (var f = mod12(pcs[v] - tuning[set[j]]); f <= maxFret; f += 12){
          var lo = Math.min(minF, f), hi = Math.max(maxF, f);
          if (hi - lo + 1 > limit) continue;     // open strings count as fret 0, so shapes stay movable
          usedV[v] = true; cur.push({ string:set[j], fret:f, midi:tuning[set[j]] + f, voice:v });
          rec(j + 1, lo, hi);
          cur.pop(); usedV[v] = false;
        }
      }
    }
    rec(0, Infinity, -Infinity);
    return found;
  }

  function guitar(chord, style, opts){
    opts = opts || {};
    var tuning = opts.tuning || DEFAULT_TUNING, nStr = tuning.length;
    var maxFret = opts.maxFret == null ? 15 : opts.maxFret, maxSpan = opts.maxSpan == null ? 4 : opts.maxSpan;
    if (["drop2", "drop3", "triad3", "shell3", "triadvl", "uppervl", "guide2"].indexOf(style) < 0) return [];
    var led = style === "triadvl" || style === "uppervl" || style === "guide2";   // named by tone order
    var v = voicesFor(chord, style), tones = v.tones, root = mod12(chord.root || 0), out = [];
    if (v.kind === "none") return out;
    var voices = v.kind === "dyad" ? [0, 1, 0] : tones.map(function (_, i){ return i; });   // tone index per voice
    var pcs = voices.map(function (ti){ return mod12(root + tones[ti].off); });
    var sets = stringSets(style, v.kind, nStr);
    if (opts.stringSets) sets = sets.filter(function (s){ return opts.stringSets.some(function (w){ return w.join(",") === s.join(","); }); });

    // `open`: accept any spread of the tones and name shapes by tone order (shells always;
    // triads only as the fallback below).
    function collect(open){
      sets.forEach(function (set){
        var byBass = {};
        shapesOnSet(pcs, set, tuning, maxFret, maxSpan + 1).forEach(function (sh){
          var asc = sh.notes.slice().sort(function (x, y){ return x.midi - y.midi; });
          for (var i = 1; i < asc.length; i++) if (asc[i].midi === asc[i - 1].midi) return;
          if (!open && !fits(style, v.kind, asc.map(function (x){ return x.midi; }))) return;
          sh.asc = asc; sh.bass = voices[asc[0].voice];
          sh.order = asc.map(function (x){ return pretty(tones[voices[x.voice]].name); }).join("-");
          sh.top = Math.max.apply(null, sh.notes.map(function (x){ return x.fret; }));
          (byBass[sh.bass] = byBass[sh.bass] || []).push(sh);
        });
        Object.keys(byBass).map(Number).sort(function (x, y){ return x - y; }).forEach(function (bass){
          var list = byBass[bass];
          // A five-fret stretch is allowed only when this bass note has no four-fret shape on
          // this set — and never on the skipped-string shell sets, which exist for the easy grips.
          var skipSet = v.kind === "shell" && set[set.length - 1] - set[0] !== set.length - 1;
          if (skipSet || list.some(function (s){ return s.span <= maxSpan; })) list = list.filter(function (s){ return s.span <= maxSpan; });
          var groups = {}, keys = [];
          list.forEach(function (s){ var k = (open || led) ? s.order : "*"; if (!groups[k]){ groups[k] = []; keys.push(k); } groups[k].push(s); });
          keys.sort().forEach(function (k){
            var g = groups[k].sort(function (x, y){ return x.top - y.top || x.span - y.span; });
            (opts.allPositions ? g : g.slice(0, 1)).forEach(function (s){
              var nums = set.map(function (i){ return nStr - i; }).join("-");   // string numbers: 1 = highest
              var closeTriad = v.kind === "three" && (style === "triad3" || style === "shell3");
              var what = (open || led) ? s.order                                         // named by tone order, low to high
                : closeTriad ? (INV_NAME[bass] || bassLabel(tones[bass].name))
                : ordinalName(tones[bass].name) + " in bass";
              var showNote = v.note && v.kind !== "shell";                      // a shell's missing 5th goes without saying
              out.push({
                midis: s.asc.map(function (x){ return x.midi; }),
                strings: s.notes.slice().sort(function (x, y){ return x.string - y.string; }).map(function (x){ return { string:x.string, fret:x.fret, midi:x.midi }; }),
                stringSet: set.slice(), inversion: bass, bass: tones[bass].name, order: s.order,
                tones: s.asc.map(function (x){ return tones[voices[x.voice]].name; }),
                span: s.span, note: v.note, style: style,
                label: "Strings " + nums + " · " + what + (showNote ? " (" + v.note + ")" : "")
              });
            });
          });
        });
      });
    }
    collect(v.kind === "shell");
    // Tunings in fifths (mandolin) cannot reach a close triad on three strings: fall back
    // to whatever spread of the three tones is playable rather than return nothing.
    if (!out.length && (v.kind === "dyad" || (v.kind === "three" && (led || style === "triad3" || style === "shell3")))) collect(true);
    // Last resorts, so a plain chord never comes back empty: a triad with no open (drop)
    // shape in this tuning uses the three-string triads; a power chord with no
    // root-5th-root grip uses two adjacent strings.
    if (!out.length && v.kind === "three" && (style === "drop2" || style === "drop3")){
      var t3opts = {}; for (var key in opts) if (Object.prototype.hasOwnProperty.call(opts, key) && key !== "stringSets") t3opts[key] = opts[key];
      return guitar(chord, "triad3", t3opts);
    }
    if (!out.length && v.kind === "dyad"){
      var allowed = sets; sets = []; voices = [0, 1];
      pcs = voices.map(function (ti){ return mod12(root + tones[ti].off); });
      for (var p2 = nStr - 2; p2 >= 0; p2--){
        if (!opts.stringSets || allowed.some(function (a){ return a.indexOf(p2) >= 0 && a.indexOf(p2 + 1) >= 0; })) sets.push([p2, p2 + 1]);
      }
      collect(true);
    }
    return out;
  }

  // ---- voice leading ----
  // Sum of each new note's distance to its nearest old note, plus half the reverse
  // (so notes left behind cost a little). Same measure the Chord Sheet tool uses.
  function motion(prev, cur){
    if (!prev || !prev.length || !cur || !cur.length) return 0;
    var total = 0, i, j, min, d;
    for (i = 0; i < cur.length; i++){ min = Infinity; for (j = 0; j < prev.length; j++){ d = Math.abs(cur[i] - prev[j]); if (d < min) min = d; } total += min; }
    for (i = 0; i < prev.length; i++){ min = Infinity; for (j = 0; j < cur.length; j++){ d = Math.abs(prev[i] - cur[j]); if (d < min) min = d; } total += 0.5 * min; }
    return total;
  }
  function nearest(cands, prev, target){
    if (!cands || !cands.length) return null;
    var t = typeof target === "number" ? target : (target && target.target != null ? target.target : 60);
    var hasPrev = !!(prev && prev.length), ref = hasPrev ? centreOf(prev) : t, best = null, bestCost = Infinity, bestTie = Infinity;
    cands.forEach(function (c){
      var ctr = centreOf(c.midis), cost = hasPrev ? motion(prev, c.midis) : Math.abs(ctr - t), tie = Math.abs(ctr - ref);
      if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) <= 1e-9 && tie < bestTie)){ best = c; bestCost = cost; bestTie = tie; }
    });
    return best;
  }

  // Voice by voice: the same string keeps the same voice when both shapes sit on one string set.
  function lead(cands, prev, target){
    if (!cands || !cands.length) return null;
    var n = cands[0].midis.length;
    if (!prev || prev.length !== n) return nearest(cands, prev, target);
    var t = typeof target === "number" ? target : 60, best = null, bestCost = Infinity;
    cands.forEach(function (c){
      if (c.midis.length !== n) return;
      var cost = 0.4 * Math.abs(centreOf(c.midis) - t);
      for (var i = 0; i < n; i++) cost += Math.abs(c.midis[i] - prev[i]);
      if (cost < bestCost - 1e-9){ best = c; bestCost = cost; }
    });
    return best || nearest(cands, prev, target);
  }

  // ---- the fretting hand ----
  function handPos(strings){ var p = Infinity; strings.forEach(function (s){ if (s.fret > 0 && s.fret < p) p = s.fret; }); return p === Infinity ? 0 : p; }
  function handMotion(prev, cur){
    if (!prev || !prev.length || !cur || !cur.length) return 0;
    var cost = Math.abs(handPos(cur) - handPos(prev)), at = {}, used = {};
    prev.forEach(function (s){ at[s.string] = s.fret; });
    cur.forEach(function (s){ used[s.string] = 1; cost += at[s.string] == null ? 0.75 : 0.5 * Math.abs(s.fret - at[s.string]); });
    prev.forEach(function (s){ if (!used[s.string]) cost += 0.75; });
    return cost;
  }
  // o (optional): { pull: how hard the hand is drawn back to fret `target` (default 0.12),
  //   centre + pitch: also prefer shapes whose middle lies near MIDI note `centre`, weighted by `pitch` }
  function easiest(cands, prevStrings, prevMidis, target, o){
    if (!cands || !cands.length) return null;
    var t = typeof target === "number" ? target : 5, has = !!(prevStrings && prevStrings.length), best = null, bestCost = Infinity;
    var pull = o && o.pull != null ? o.pull : 0.12, pw = (o && o.pitch) || 0, centre = (o && o.centre) || 55;
    cands.forEach(function (c){
      var pos = handPos(c.strings || []), reg = pw ? pw * Math.abs((c.midis[0] + c.midis[c.midis.length - 1]) / 2 - centre) : 0;
      var cost = (has ? handMotion(prevStrings, c.strings || []) + 0.2 * motion(prevMidis || [], c.midis) + pull * Math.abs(pos - t) : Math.abs(pos - t)) + reg;
      if (cost < bestCost - 1e-9){ best = c; bestCost = cost; }
    });
    return best;
  }

  // The menu both pages list from. sheetOnly = drawn by the Chord Sheet's own fret-position
  // search, not by guitar() here.
  var STYLES = {
    piano:  [ { id:"standard", label:"Standard (close position)" }, { id:"shell", label:"Shell (R-3-7)" },
              { id:"guide", label:"Guide tones (3rd & 7th)" }, { id:"rootless", label:"Rootless (A/B forms)" },
              { id:"drop2", label:"Drop 2" }, { id:"drop3", label:"Drop 3" } ],
    guitar: [ { id:"standard", label:"Standard", sheetOnly:true }, { id:"shell", label:"Shell (R-3-7)", sheetOnly:true },
              { id:"drop2", label:"Drop 2" }, { id:"drop3", label:"Drop 3" },
              { id:"triad3", label:"Triads (three strings)" }, { id:"shell3", label:"7ths, no 5th (three strings)" },
              { id:"triadvl", label:"Voice-led triads (root-3rd-5th)" }, { id:"uppervl", label:"Voice-led upper triads (3rd-5th-7th)" },
              { id:"guide2", label:"Two-note chords (3rd & 7th)" } ]
  };

  // Which piano voicing a set of played notes is, for a chord that is already known.
  //   identify({ root, intervals }, midis) -> { style, styleLabel, index, label, name, tones:[names low..high], note }
  // `index` is the candidate's place in piano(chord, style) (the inversion / form). Octave does not
  // matter; spacing does. Notes that fit no style come back with style null and name "As played",
  // each note still named by its degree. A reading that uses every tone the chord has is preferred
  // (so a half-diminished 3-5-7-R is "1st inversion" before it is a rootless form).
  var IDENTIFY_ORDER = ["standard", "shell", "guide", "rootless", "drop2", "drop3"];
  var DEGREE_NAMES = ["R", "b9", "9", "#9", "3", "11", "#11", "5", "b13", "13", "b7", "7"];
  function identify(chord, midis){
    var seen = {}, ms = (midis || []).filter(function (m){ if (!isFinite(m) || seen[m]) return false; seen[m] = 1; return true; }).sort(function (x, y){ return x - y; });
    if (!ms.length || !chord) return null;
    var root = mod12(chord.root || 0), low = ms[0], key = ms.map(function (m){ return m - low; }).join(","), hit = null;
    IDENTIFY_ORDER.forEach(function (style){
      if (hit) return;
      pianoShapes(chord, style).forEach(function (sh, i){
        if (hit || mod12(root + sh.bassOff) !== mod12(low) || sh.rels.join(",") !== key) return;
        var def = STYLES.piano.filter(function (x){ return x.id === style; })[0], sl = def ? def.label : style;
        hit = { style: style, styleLabel: sl, index: i, label: sh.label, name: sl + ": " + sh.label, tones: sh.names.slice(), note: sh.note || "" };
      });
    });
    if (hit) return hit;
    var own = {}; analyze(chord).tones.forEach(function (t){ own[mod12(t.off)] = t.name; });
    return { style: null, styleLabel: "As played", index: -1, label: "As played", name: "As played", note: "",
             tones: ms.map(function (m){ var iv = mod12(m - root); return own[iv] || DEGREE_NAMES[iv]; }) };
  }

  global.ChordVoicings = {
    identify: identify,
    styles: function (instrument){
      return (STYLES[instrument] || []).map(function (s){ var o = { id:s.id, label:s.label }; if (s.sheetOnly) o.sheetOnly = true; return o; });
    },
    piano: piano, guitar: guitar, nearest: nearest, motion: motion, lead: lead, handMotion: handMotion, easiest: easiest,
    analyze: analyze, reduce: reduce, intervalsFromFormula: intervalsFromFormula,
    DEFAULT_TUNING: DEFAULT_TUNING.slice()
  };
})(typeof window !== "undefined" ? window : globalThis);
