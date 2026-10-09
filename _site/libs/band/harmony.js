// harmony.js — chord symbols, chord scales and comping voicings for the jazz band engine.
// Pure data + functions (no audio, no DOM): the bass and comping parts are built on it,
// and it loads in plain Node for testing.
//
//   BandHarmony.parseChord(sym, transpose)  -> Chord (never throws)
//       { sym, label, nc, unknown, root, bass, slash, quality, third, fifth, seventh, sixth,
//         sus, ext, add9, six9, b9, s9, s11, b5, s5, b13, alt, tones[], scale[], key }
//       root/bass are pitch classes AFTER transposition; intervals are semitones above the
//       root (null = absent). quality: maj | min | dom | hdim | dim | aug | sus | power.
//       `unknown` = the suffix had text we could not read (a word, not a chord).
//   BandHarmony.chordScale(chord)           -> [semitones above the root] for passing tones
//   BandHarmony.voicing(chord, style, prev, inst) -> ascending MIDI notes, voice-led from `prev`
//       piano styles: "rootless" (four-note A/B left-hand shapes) | "guide" (3rd + 7th) | "shell" (root, 3rd, 7th)
//         | "standard" (close position) | "drop2" | "drop3"   (shell, standard, drop2, drop3 from voicings.js
//         when it has them; shell and standard fall back to the tables below)
//       guitar styles (inst "guitar"): "shell3" | "drop2" | "drop3" | "triad3" (from voicings.js),
//       "triadvl" | "uppervl" (triads on strings 4-3-2) and "guide2" (two-note chords on strings 4-5,
//       3-4, 2-3). Guitar shapes follow each other by the smallest move of the fretting hand.
//   BandHarmony.candidates(chord, style, inst, kind) -> [{ midis, strings? }] every shape the style offers
//       (kind "passing": the passing diminished chord of a "bh" voicing)
//   BandHarmony.toward(chord, style, prev, inst, { top, differ, passing }) -> the shape whose top note is
//       nearest `top` (how comping moves through inversions); .sixthOf(chord), .asSixth(chord): see below
//       Several styles can be combined as "a+b" (e.g. "guide2+top3"): the band draws on the shapes of all.
//       Guitar also has "top3" / "mid3": the three-string shapes on strings 3-2-1 / 4-3-2 only.
//       Band-level styles for both instruments: "bh" (drop 2 on the chord read as a sixth chord, Barry
//       Harris) and "auto" (the comping part chooses a style for the moment).
//   BandHarmony.styleList(inst)            -> [{ id, label }] the voicing styles to offer for "piano" | "guitar"
//       (ChordVoicings.styles minus the sheet-only ones, plus whichever band styles it lacks)
//   BandHarmony.defaultStyle(inst)         -> "rootless" | "shell3"
//   BandHarmony.hasStyle(inst, id)         -> true when `id` is one of styleList(inst)
//   BandHarmony.meterInfo(n, d)            -> { n, d, compound, beats, per }: 6/8, 9/8 and 12/8 are
//       compound (beats = dotted quarters, per = 3 eighths each); other meters count their lower note
//   BandHarmony.buildForm(parsed, transpose)-> [{ src, beats, chords:[{pos, chord}], meter:{n, d}, compound }]
//       TuneChart.parse output -> the bars the band plays, in play order (repeats expanded).
//   BandHarmony.pinMap(form, pins)         -> { "<form bar index>:<beat>": midis } for comp.js's opts.pins, from
//       [{ bar: written bar index, pos, midis }] (a written bar that plays twice is pinned both times)
//   BandHarmony.asPlayed(bars, o)          -> [{ sym, midis, played, strings? }] (guitar: strings = [{ string, fret, midi }], the grip)
//       one entry per chord of the form, in order,
//       from bar records (the player's onBarEvents): the notes of the first comp event that sounded the chord
//       (played: true), else a fresh voicing in style o.style / o.inst (played: false)
//   BandHarmony.chordAt(chords, pos)        -> the chord sounding at beat `pos` (or null)
//   BandHarmony.sameChord(a, b), .noteName(midi), .pcName(pc), .STYLES (voicing tables)
//
// Transposition is applied to pitch classes BEFORE voicing, so every key is voiced in the
// same register instead of sliding already-voiced notes up and down.

(function (global) {
  var NAT = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  var FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];

  function mod12(n){ return ((n % 12) + 12) % 12; }
  function pcName(pc){ return FLAT[mod12(pc)]; }
  function noteName(midi){ return FLAT[mod12(midi)] + (Math.floor(midi / 12) - 1); }
  function accOf(s){ var a = 0; for (var i = 0; i < s.length; i++) a += (s[i] === "#" || s[i] === "♯") ? 1 : -1; return a; }

  // ---- chord symbol parser ----
  function ncChord(sym, unknown){
    return { sym: sym, label: "N.C.", nc: true, unknown: !!unknown, root: 0, bass: 0, slash: false,
      quality: "nc", third: null, fifth: null, seventh: null, sixth: null, sus: 0, ext: 0,
      add9: false, six9: false, b9: false, s9: false, s11: false, b5: false, s5: false, b13: false,
      alt: false, tones: [], scale: [], key: "nc" };
  }

  // Read the suffix as a run of tokens in any order (quality words, stacked extension
  // numbers like "91113", alterations like "b9#5"). Anything left over means it was a
  // word ("Fine", "Fast") rather than a chord.
  function scanSuffix(s){
    var f = { maj:false, maj7:false, min:false, dim:false, hdim:false, aug:false, sus:0, alt:false,
              power:false, other:false, nums:{}, alts:{}, adds:{}, left:"" };
    var i = 0, m;
    while (i < s.length){
      var r = s.slice(i);
      if ((m = /^[\s(),]+/.exec(r))){ i += m[0].length; continue; }
      if ((m = /^other/.exec(r))){ f.other = true; i += m[0].length; continue; }
      if ((m = /^power/.exec(r))){ f.power = true; i += m[0].length; continue; }
      if ((m = /^(maj|Maj|MAJ|ma(?=\d)|M(?![a-z]))/.exec(r))){ f.maj = true; i += m[0].length; continue; }
      if ((m = /^[Δ∆^]/.exec(r))){ f.maj = true; f.maj7 = true; i += 1; continue; }   // triangle = maj7
      if ((m = /^(min|Min|MIN|mi(?=\d|$)|m)/.exec(r))){ f.min = true; i += m[0].length; continue; }
      if ((m = /^(dim|°|o(?![a-z]))/.exec(r))){ f.dim = true; i += m[0].length; continue; }
      if ((m = /^(ø|Ø|h(?=7|$))/.exec(r))){ f.hdim = true; i += m[0].length; continue; }
      if ((m = /^sus\s*([24])?/.exec(r))){ f.sus = m[1] ? parseInt(m[1], 10) : 4; i += m[0].length; continue; }
      if ((m = /^add\s*(13|11|9|6|4|2)/.exec(r))){ f.adds[m[1]] = true; i += m[0].length; continue; }
      if ((m = /^alt/.exec(r))){ f.alt = true; i += m[0].length; continue; }
      if ((m = /^aug/.exec(r))){ f.aug = true; i += m[0].length; continue; }
      if ((m = /^([b#♭♯])(13|11|10|9|7|6|5|4|3|2|1)/.exec(r))){
        f.alts[((m[1] === "#" || m[1] === "♯") ? "#" : "b") + m[2]] = true; i += m[0].length; continue; }
      if ((m = /^\+(?=5|9|11)/.exec(r))){ s = s.slice(0, i) + "#" + s.slice(i + 1); continue; }     // "7+9" = #9
      if (r[0] === "+"){ f.aug = true; i += 1; continue; }
      if ((m = /^-(?=5|9|13)/.exec(r)) && i > 0){ s = s.slice(0, i) + "b" + s.slice(i + 1); continue; } // "7-5" = b5
      if (r[0] === "-"){ f.min = true; i += 1; continue; }
      if ((m = /^(13|11|9|7|6|5|4|3|2|1)/.exec(r))){ f.nums[m[1]] = true; i += m[0].length; continue; }
      f.left += r[0]; i += 1;
    }
    return f;
  }

  function parseChord(sym, transpose){
    var raw = String(sym == null ? "" : sym).trim();
    var t = mod12(Math.round(transpose || 0));
    if (raw === "" || /^n\.?\s*c\.?$/i.test(raw)) return ncChord(raw, false);
    var m = /^([A-G])([#b♯♭]*)([\s\S]*)$/.exec(raw);
    if (!m) return ncChord(raw, true);
    var root = mod12(NAT[m[1]] + accOf(m[2]) + t), rest = m[3], bass = root, slash = false;
    if (/^\s*n\.?\s*c\.?\s*$/i.test(rest)) return ncChord(raw, false);  // "GN.C." (MusicXML import) = no chord
    rest = rest.replace(/6\s*\/\s*9/g, "69");                       // "6/9" is a chord, not a slash bass
    var sm = /\/\s*([A-G])([#b♯♭]*)\s*$/.exec(rest);
    if (sm){ bass = mod12(NAT[sm[1]] + accOf(sm[2]) + t); slash = bass !== root; rest = rest.slice(0, sm.index); }
    rest = rest.replace(/\/\s*$/, "");
    var f = scanSuffix(rest), N = f.nums, A = f.alts;

    var ext = N[13] ? 13 : N[11] ? 11 : N[9] ? 9 : N[7] ? 7 : 0;
    var six9 = !!(N[6] && N[9] && !N[7] && !N[11] && !N[13]);
    var has7 = (ext >= 7 && !six9) || f.maj7;
    var hdim = f.hdim || (f.min && has7 && A.b5 && !f.maj) || (f.dim && f.min && !!N[7]);
    var dim = (f.dim || f.other) && !hdim;             // MusicXML kind "other" is a passing dim7 in this library
    var min = f.min && !hdim && !dim;
    var b9 = !!(A.b9 || A.b2 || f.alt), s9 = !!(A["#9"] || A["#2"] || f.alt);
    var s11 = !!(A["#11"] || A["#4"] || A["#1"]);
    var power = f.power || (!!N[5] && !ext && !N[6] && !f.maj && !f.min && !f.dim && !f.hdim && !f.aug
                            && !f.sus && !f.alt && !Object.keys(A).length);
    var sus = f.sus || (N[4] ? 4 : 0);
    if (!sus && N[11] && !min && !hdim && !dim && !f.maj && !s11) sus = 4;   // C11 is played as C9sus4

    var third = (min || dim || hdim || A.b3) ? 3 : 4;
    if (sus || power) third = null;
    var fifth = (dim || hdim || A.b5 || f.alt) ? 6 : (f.aug || A["#5"]) ? 8 : 7;
    var seventh = null;
    if (dim) seventh = (has7 || f.other) ? 9 : null;
    else if (hdim) seventh = 10;
    else if (f.maj && has7) seventh = 11;
    else if (has7 || A.b7) seventh = 10;
    else if ((b9 || s9) && !min && !power) seventh = 10;             // an altered 9th implies a dominant
    var sixth = N[6] ? 9 : null;

    var quality = power ? "power" : sus ? "sus" : dim ? "dim" : hdim ? "hdim" : min ? "min"
      : seventh === 10 ? "dom" : (fifth === 8 && seventh == null && !f.maj) ? "aug" : "maj";
    var isDom = quality === "dom" || (quality === "sus" && seventh === 10);
    var c = {
      sym: raw, label: "", nc: false, unknown: /[^b#\s]/.test(f.left),
      root: root, bass: bass, slash: slash, quality: quality,
      third: third, fifth: fifth, seventh: seventh, sixth: sixth, sus: sus, ext: ext,
      add9: !!(f.adds[9] || f.adds[2] || N[2]), six9: six9,
      b9: b9 && (isDom || min), s9: s9 && isDom, s11: s11,
      b5: !!A.b5 && !dim && !hdim, s5: !!(f.aug || A["#5"]),
      b13: !!(A.b13 || f.alt || (A.b6 && isDom)), alt: f.alt
    };
    // bass-line chord tones: root, 3rd (or the sus note), 5th, 7th (or 6th)
    var tones = [0];
    if (third != null) tones.push(third); else if (sus) tones.push(sus === 2 ? 2 : 5);
    tones.push(fifth);
    if (seventh != null) tones.push(seventh); else if (sixth != null) tones.push(sixth);
    c.tones = tones;
    c.scale = chordScale(c);
    c.key = [root, bass, quality, third, fifth, seventh, sixth, sus, +c.b9, +c.s9, +c.s11, +c.b5, +c.s5, +c.b13, +c.six9].join(":");
    c.label = pcName(root) + rest.trim() + (sm ? "/" + pcName(bass) : "");
    return c;
  }

  function sameChord(a, b){ return !!a && !!b && a.key === b.key; }

  // ---- chord scales (for bass passing tones) ----
  function chordScale(c){
    var s;
    switch (c.quality){
      case "dom":
        if (c.alt || (c.s9 && (c.s5 || c.b13)) || (c.b5 && c.s5)) s = [0,1,3,4,6,8,10];       // altered
        else if (c.b9 && (c.s9 || (c.ext === 13 && !c.b13))) s = [0,1,3,4,6,7,9,10];            // half-whole
        else if (c.b9) s = [0,1,4,5,7,8,10];                                                    // mixolydian b9 b13
        else if (c.s9) s = [0,3,4,5,7,9,10];                                                    // mixolydian with #9
        else if (c.s5 && !c.b5) s = [0,2,4,6,8,10];                                             // whole tone
        else if (c.b13) s = [0,2,4,5,7,8,10];
        else if (c.s11 || c.b5) s = [0,2,4,6,7,9,10];                                           // lydian dominant
        else s = [0,2,4,5,7,9,10];                                                              // mixolydian
        break;
      case "sus": s = c.seventh != null ? (c.b9 ? [0,1,5,7,8,10] : [0,2,5,7,9,10]) : [0,2,5,7,9]; break;
      case "maj": s = c.s11 ? [0,2,4,6,7,9,11] : c.fifth === 8 ? [0,2,4,6,8,9,11] : [0,2,4,5,7,9,11]; break;
      case "min":
        if (c.seventh === 11) s = [0,2,3,5,7,9,11];                                             // melodic minor
        else if (c.b9) s = [0,1,3,5,7,8,10];                                                    // phrygian
        else if (c.seventh === 10 || c.sixth != null) s = [0,2,3,5,7,9,10];                     // dorian
        else s = [0,2,3,5,7,8,10];                                                              // bare triad: aeolian
        if (c.fifth === 8) s = [0,2,3,5,8,10];
        break;
      case "hdim": s = [0,1,3,5,6,8,10]; break;                                                 // locrian
      case "dim":  s = [0,2,3,5,6,8,9,11]; break;                                               // whole-half
      case "aug":  s = [0,2,4,6,8,10]; break;
      default:     s = [0,2,5,7,9];                                                             // power: no 3rd, no 7th
    }
    var seen = {}, out = [];
    s.concat(c.tones || []).forEach(function (iv){ iv = mod12(iv); if (!seen[iv]){ seen[iv] = 1; out.push(iv); } });
    return out.sort(function (a, b){ return a - b; });
  }

  // ---- voicings ----
  // A form is the list of chord degrees from the bottom note up. Degrees are resolved
  // against the chord, so one "dom" row covers 7, 9, 13, 7b9, 7#9, 7#5, 7#11 and alt.
  // To add an instrument, add a style: its own forms, register and (optionally) an
  // accept(notes) test for playability (e.g. guitar strings/frets).
  var STYLES = {
    rootless: { lo: 48, hi: 74, centre: 60, forms: {
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
    } },
    // guide tones: the 3rd and 7th only
    guide: { lo: 48, hi: 72, centre: 58, forms: {
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
    } },
    // shell: root, 3rd, 7th (the 6th for a 6 chord); fallback for the library's "shell"
    shell: { lo: 43, hi: 67, centre: 55, forms: {
      dom:   [["R","7","3"], ["R","3","7"]],
      sus7:  [["R","7","4"], ["R","4","7"]],
      maj7:  [["R","7","3"], ["R","3","7"]],
      maj6:  [["R","6","3"], ["R","3","6"]],
      min7:  [["R","7","3"], ["R","3","7"]],
      min6:  [["R","6","3"], ["R","3","6"]],
      hdim:  [["R","7","3"], ["R","3","7"]],
      dim:   [["R","bb7","3"], ["R","3","bb7"]],
      aug:   [["R","3","5"], ["R","5","3"]],
      sus:   [["R","4","5"], ["R","5","4"]],
      sus2:  [["R","2","5"], ["R","5","2"]],
      power: [["R","5"], ["R","5","R"]]
    } },
    // standard: the chord in close position (root position and its inversions); fallback for the library's "standard"
    standard: { lo: 48, hi: 74, centre: 61, forms: {
      dom:   [["R","3","5","7"], ["3","5","7","R"], ["5","7","R","3"], ["7","R","3","5"]],
      sus7:  [["R","4","5","7"], ["4","5","7","R"], ["5","7","R","4"], ["7","R","4","5"]],
      maj7:  [["R","3","5","7"], ["3","5","7","R"], ["5","7","R","3"], ["7","R","3","5"]],
      maj6:  [["R","3","5"], ["3","5","R"], ["5","R","3"]],
      min7:  [["R","3","5","7"], ["3","5","7","R"], ["5","7","R","3"], ["7","R","3","5"]],
      min6:  [["R","3","5","6"], ["3","5","6","R"], ["5","6","R","3"], ["6","R","3","5"]],
      hdim:  [["R","3","5","7"], ["3","5","7","R"], ["5","7","R","3"], ["7","R","3","5"]],
      dim:   [["R","3","5","bb7"], ["3","5","bb7","R"], ["5","bb7","R","3"], ["bb7","R","3","5"]],
      aug:   [["R","3","5"], ["3","5","R"], ["5","R","3"]],
      sus:   [["R","4","5"], ["4","5","R"], ["5","R","4"]],
      sus2:  [["R","2","5"], ["2","5","R"], ["5","R","2"]],
      power: [["R","5"], ["5","R"]]
    } },
    // fourths: the "So What" voicing (Bill Evans on So What): three perfect 4ths with a major 3rd on top,
    // from the root of a minor chord (Dm11 = D G C F A); the nearest stack of 4ths for the other kinds.
    sowhat: { lo: 45, hi: 76, centre: 59, forms: {
      dom:   [["7","3","13","9","5"]],
      sus7:  [["R","4","7","9","5"]],
      maj7:  [["3","6","9","5","7"]],
      maj6:  [["3","6","9","5","R"]],
      min7:  [["R","4","7","3","5"]],
      min6:  [["R","4","7","3","5"]],
      hdim:  [["3","5","7","R"],  ["7","R","3","5"]],
      dim:   [["R","3","5","bb7"], ["3","5","bb7","R"], ["5","bb7","R","3"], ["bb7","R","3","5"]],
      aug:   [["3","5","R"], ["5","R","3"], ["R","3","5"]],
      sus:   [["5","R","4"], ["R","4","5"]],
      sus2:  [["2","5","R"], ["5","R","2"]],
      power: [["R","5"], ["5","R"]]
    } }
  };
  // own-table styles by instrument: rootless and guide are always the band's own shapes; shell
  // and standard come from the library when it has them. Guitar is the library's alone.
  var OWN = { piano: ["rootless", "guide", "shell", "standard", "sowhat"], guitar: [] };
  var OWN_LABEL = { rootless: "Rootless (A/B forms)", guide: "Guide tones (3rd & 7th)", shell: "Shells (root, 3rd, 7th)", standard: "Standard (close position)", sowhat: "Fourths (So What voicing)" };
  var GUITAR_FALLBACK = [{ id:"shell3", label:"Shells, no 5th (three strings)" }, { id:"drop2", label:"Drop 2" },
                         { id:"drop3", label:"Drop 3" }, { id:"triad3", label:"Triads (three strings)" }];
  var DEFAULT_STYLE = { piano: "rootless", guitar: "shell3" };
  function libStyles(inst){
    var V = global.ChordVoicings, l = [];
    try { l = (V && V.styles) ? V.styles(inst) : []; } catch (e){ l = []; }
    return (l || []).filter(function (s){ return s && s.id && !s.sheetOnly; });
  }
  function libHas(inst, style){ return libStyles(inst).some(function (s){ return s.id === style; }); }
  function styleList(inst){
    inst = inst === "guitar" ? "guitar" : "piano";
    var lib = libStyles(inst).map(function (s){ return { id: s.id, label: s.label || OWN_LABEL[s.id] || s.id }; });
    var band = (global.ChordVoicings ? BAND_STYLES : BAND_STYLES.slice(1)).map(function (s){ return { id: s.id, label: s.label }; });   // "bh" needs the library's drop 2
    if (inst === "guitar") return (lib.length ? lib.concat(GUITAR_BAND.map(function (s){ return { id: s.id, label: s.label }; })) : GUITAR_FALLBACK.slice()).concat(band);
    var have = {}; lib.forEach(function (s){ have[s.id] = 1; });
    var missing = OWN.piano.filter(function (id){ return !have[id]; }).map(function (id){ return { id: id, label: OWN_LABEL[id] }; });
    var tail = missing.filter(function (x){ return x.id === "sowhat"; });                 // the specialised one goes after the everyday styles
    return missing.filter(function (x){ return x.id !== "sowhat"; }).concat(lib, tail, band);
  }
  function hasStyle(inst, id){
    var list = styleList(inst), parts = String(id || "").split("+");
    return parts.length > 0 && parts.every(function (p){ return p && (parts.length === 1 || p !== "auto") && list.some(function (s){ return s.id === p; }); });
  }
  function defaultStyle(inst){ return DEFAULT_STYLE[inst === "guitar" ? "guitar" : "piano"]; }

  function voicingClass(c){
    switch (c.quality){
      case "dom":   return "dom";
      case "sus":   return c.seventh != null ? "sus7" : c.sus === 2 ? "sus2" : "sus";
      case "maj":   return c.seventh === 11 ? "maj7" : "maj6";
      case "min":   return (c.sixth != null && c.seventh == null) ? "min6" : "min7";
      case "hdim":  return "hdim";
      case "dim":   return "dim";
      case "aug":   return "aug";
      default:      return "power";
    }
  }
  // degree token -> semitones above the root, for this chord. `fi` = form index: when a
  // dominant carries both b9 and #9 (alt), form A takes the #9 and form B the b9.
  function degree(c, tok, fi){
    switch (tok){
      case "R":   return 0;
      case "2":   return 2;
      case "4":   return 5;
      case "3":   return c.third != null ? c.third : (c.sus === 2 ? 2 : 5);
      case "5":   if (c.quality === "maj" && c.s11) return 6;                 // maj7#11: #11 replaces the 5th
                  if (c.quality === "maj" && c.ext === 13 && c.fifth === 7) return 9;
                  return c.fifth != null ? c.fifth : 7;
      case "6":   return 9;
      case "bb7": return 9;
      case "7":   return c.seventh != null ? c.seventh : (c.quality === "maj" ? 11 : 10);
      case "9":   if (c.b9 && c.s9) return fi === 0 ? 3 : 1;
                  return c.b9 ? 1 : c.s9 ? 3 : 2;
      case "13":  return (c.b13 || c.s5) ? 8 : (c.s11 || c.b5) ? 6 : 9;
    }
    return 0;
  }
  // stack the form's pitch classes upward from the lowest allowed bottom note
  function stack(c, ivs, lo){
    var out = [], prev = null;
    ivs.forEach(function (iv){
      var pc = mod12(c.root + iv), n;
      if (prev == null){ n = lo; while (mod12(n) !== pc) n++; }
      else { n = prev + 1; while (mod12(n) !== pc) n++; }
      out.push(n); prev = n;
    });
    // a #9 sits above the major 3rd, never a semitone under it
    if (c.s9 && c.third === 4){
      var i9 = -1, i3 = -1;
      out.forEach(function (n, k){ var iv = mod12(n - c.root); if (iv === 3) i9 = k; if (iv === 4) i3 = k; });
      if (i9 >= 0 && i3 >= 0 && out[i9] < out[i3]){
        var top = Math.max.apply(null, out), n9 = out[i9]; while (n9 < top) n9 += 12;
        out[i9] = n9; out.sort(function (a, b){ return a - b; });
      }
    }
    return out;
  }
  function centreOf(v){ var s = 0; for (var i = 0; i < v.length; i++) s += v[i]; return s / v.length; }
  // total voice movement between two voicings (voice-by-voice when the sizes match)
  function motion(a, b){
    var s = 0, i;
    if (a.length === b.length){ for (i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; }
    function near(x, arr){ var d = 99; for (var k = 0; k < arr.length; k++) d = Math.min(d, Math.abs(x - arr[k])); return d; }
    for (i = 0; i < b.length; i++) s += near(b[i], a);
    for (i = 0; i < a.length; i++) s += near(a[i], b);
    return s * 0.5 * (4 / Math.max(a.length, b.length));
  }

  // Drop-2 / drop-3 and the guitar three-string shapes come from the shared ChordVoicings
  // library (voicings.js), so the band plays the same shapes the Chord Sheet tool draws.
  // Guitar string sets are limited to comping registers (string index 0 = lowest).
  var GUITAR_SETS = { drop2: [[1,2,3,4],[2,3,4,5]], drop3: [[0,2,3,4],[1,3,4,5]],
                      shell3: [[0,2,3],[1,2,3],[2,3,4]], triad3: [[1,2,3],[2,3,4],[3,4,5]],
                      triadvl: [[2,3,4]], uppervl: [[2,3,4]], guide2: [[1,2],[2,3],[3,4]], top3: [[3,4,5]], mid3: [[2,3,4]] };
  // The guitar is led by the HAND, not the ear: the next shape is the smallest move for the fretting
  // hand from the last one (ChordVoicings.easiest). lastGrip remembers where the fingers were.
  // Where a comping guitarist lives: low on the neck, the chord centred around C below middle C..E above.
  // Without this pull the hand drifted up to frets 9-12 and stayed, a fifth to an octave above the idiom.
  var GTR = { fret: 4, pull: 0.45, centre: 52, pitch: 0.3 };
  var lastGrip = null, grips = {};                             // grips: notes -> the strings and frets they were last played on
  function isLed(style){ return style === "triadvl" || style === "uppervl"; }
  // Every shape the shared library offers for a chord spec in a style, kept to the comping register.
  function libCands(spec, style, inst){
    var V = global.ChordVoicings, cands; if (!V || !spec.intervals || !spec.intervals.length) return [];
    if (inst === "guitar"){
      var lib = LIB_ALIAS[style] || style, one = !!LIB_ALIAS[style];                       // one string set: every position on it
      cands = V.guitar(spec, lib, { maxSpan: 4, stringSets: GUITAR_SETS[style], allPositions: isLed(style) || one, maxFret: (isLed(style) || one) ? 12 : 15 });
      if (!cands.length) cands = V.guitar(spec, lib, { maxSpan: 4 });
      var ok = cands.filter(function (c){ return c.midis[0] >= 40 && c.midis[c.midis.length - 1] <= 76 && (c.span == null || c.span <= 4); });
      if (ok.length) cands = ok;
    } else {
      cands = V.piano(spec, style, { lo: 48, hi: 77, allOctaves: true });
      var fit = cands.filter(function (c){ return c.midis[0] >= 48 && c.midis[c.midis.length - 1] <= 77; });
      if (fit.length) cands = fit;
    }
    return cands || [];
  }
  // The band's own tables (rootless, guide, ...): [{ midis, fi }] with fi = which form.
  function ownCands(chord, style){
    var st = STYLES[style] || STYLES.rootless;
    var forms = st.forms[voicingClass(chord)] || st.forms.power;
    var cands = [], loose = [];
    forms.forEach(function (form, fi){
      var seen = {}, ivs = [];
      form.forEach(function (tok){ var iv = mod12(degree(chord, tok, fi)); if (!seen[iv]){ seen[iv] = 1; ivs.push(iv); } });
      var base = stack(chord, ivs, st.lo);
      for (var oct = 0; oct <= 24; oct += 12){
        var v = base.map(function (n){ return n + oct; });
        if (v[v.length - 1] > st.hi + 5) break;
        if (st.accept && !st.accept(v, chord)) continue;
        var muddy = v.length > 1 && v[1] - v[0] === 1 && v[0] < 52;           // no semitone cluster at the bottom
        var item = { midis: v, fi: fi, drift: Math.abs(centreOf(v) - st.centre) };
        if (v[v.length - 1] <= st.hi && !muddy) cands.push(item); else loose.push(item);
      }
    });
    return cands.length ? cands : loose;
  }

  // ---- Barry Harris: a chord as a SIXTH chord, and the diminished chord that passes between its inversions ----
  // The sixth-diminished scale is a 6th chord interleaved with a diminished 7th a tone above its root:
  //   major 7 / 6 / triad -> the major 6 on the root          minor 7 -> the major 6 a minor 3rd up (Dm7 = F6)
  //   minor 6 / triad     -> the minor 6 on the root          half-diminished -> the minor 6 a minor 3rd up
  //   dominant 7          -> the minor 6 on its 5th (G7 = Dm6), or a semitone up when altered (G7alt = Abm6)
  // Diminished, augmented, sus and power chords have no such reading (null).
  function sixthOf(chord){
    if (!chord || chord.nc) return null;
    var r = chord.root, q = chord.quality, alt = chord.alt || chord.b9 || chord.s9 || chord.b13 || chord.s5, root, minor;
    if (q === "maj"){ root = r; minor = false; }
    else if (q === "min"){ if (chord.seventh === 10){ root = r + 3; minor = false; } else { root = r; minor = true; } }
    else if (q === "dom"){ root = alt ? r + 1 : r + 7; minor = true; }
    else if (q === "hdim"){ root = r + 3; minor = true; }
    else return null;
    root = mod12(root);
    return { six: { root: root, intervals: minor ? [0, 3, 7, 9] : [0, 4, 7, 9] }, dim: { root: mod12(root + 2), intervals: [0, 3, 6, 9] } };
  }
  // A major 7th chord read as a 6th (Cmaj7 -> C6, Cmaj9 -> C6/9); any other chord comes back as it is.
  var sixCache = {};
  function asSixth(chord){
    if (!chord || chord.nc || chord.quality !== "maj" || chord.seventh !== 11 || chord.s11 || chord.s5 || chord.b5) return chord;
    var k = chord.key; if (sixCache[k]) return sixCache[k];
    var c = {}; for (var f in chord) c[f] = chord[f];
    c.seventh = null; c.sixth = 9; c.key = chord.key + "~6";
    c.tones = chord.tones.filter(function (t){ return t !== 11; }); if (c.tones.indexOf(9) < 0) c.tones.push(9);
    c.tones.sort(function (a, b){ return a - b; });
    return (sixCache[k] = c);
  }

  // ---- colour: the chord as the comping voices it ----
  // chord.tones is the basic chord (triad or 7th). colour() returns a copy whose tones also hold
  //   - the natural 9th / 13th the symbol WRITES (C9, C13, Cmaj9, Cm9, C6/9, Cadd9), and
  //   - the unmarked ones asked for in `add`: { six: a major 7th played as a 6th, nine: a 9th on a plain
  //     7th chord, thirteen: a 9th and 13th on a plain dominant 7th }.
  // Unmarked colour only goes on a chord with nothing written beyond its 7th: no extension, alteration or sus.
  // Altered chords (b9, #9, #11, b13, alt...) come back unchanged for now: alterations are the next step.
  // Styles that are defined by their notes (shells, guide tones, three-string shapes, open chords) ignore
  // the extra tones; standard, drop 2 and drop 3 use them; rootless adds its own 9th and 13th regardless.
  var colourCache = {};
  function colour(chord, add){
    if (!chord || chord.nc) return chord;
    add = add || {};
    var q = chord.quality, altered = chord.alt || chord.b9 || chord.s9 || chord.s11 || chord.b5 || chord.s5 || chord.b13;
    if (altered) return chord;
    var plain = chord.sus === 0 && chord.ext <= 7 && !chord.add9 && !chord.six9 && chord.sixth == null && chord.seventh != null;
    var six = plain && add.six && q === "maj" && chord.seventh === 11;
    var thirteen = (chord.ext === 13 && (q === "dom" || q === "maj")) || (plain && add.thirteen && q === "dom");
    var nine = thirteen || chord.ext >= 9 || chord.add9 || chord.six9 || (plain && add.nine && (q === "maj" || q === "min" || q === "dom"));
    if (q === "hdim" || q === "dim" || q === "aug" || q === "power") nine = thirteen = false;
    if (!six && !nine && !thirteen) return chord;
    var tag = (six ? "6" : "") + (nine ? "9" : "") + (thirteen ? "13" : ""), k = chord.key + "~c" + tag;
    if (colourCache[k]) return colourCache[k];
    var base = six ? asSixth(chord) : chord, c = {}; for (var f in base) c[f] = base[f];
    c.tones = base.tones.slice();
    if (nine && c.tones.indexOf(2) < 0) c.tones.push(2);
    if (thirteen && c.tones.indexOf(9) < 0) c.tones.push(9);
    c.tones.sort(function (a, b){ return a - b; });
    c.key = k; c.colour = { six: !!six, nine: !!nine, thirteen: !!thirteen };
    return (colourCache[k] = c);
  }

  // Band-level styles on top of the library's: "auto" (the comping part picks; here it means the
  // instrument's default) and "bh" (drop 2 on the chord's sixth-chord reading).
  var BAND_STYLES = [{ id: "bh", label: "Drop 2, sixth-diminished (Barry Harris)" }, { id: "auto", label: "Auto (the band chooses)" }];
  // Guitar only: the three-string shapes (triads, and R-3-7 for 7th chords) kept to ONE string set.
  var GUITAR_BAND = [{ id: "top3", label: "Three strings: 3-2-1 (top)", lib: "shell3" }, { id: "mid3", label: "Three strings: 4-3-2", lib: "shell3" },
                     { id: "open", label: "Open and barre chords" }];

  // ---- "open": the strummer's chords. An open-position shape where the chord has one, otherwise the
  // E-shape or A-shape barre chord, whichever sits nearer the nut. One shape per chord, so nothing to lead.
  // Frets are low E to high E; x = string not played. Movable shapes are written at the nut.
  // Extensions are dropped (C9 and C13 are played C7, C6 and Cadd9 as C, Cm6 as Cm) and a slash bass is left to the bassist.
  var OPEN_TUNING = [40, 45, 50, 55, 59, 64];
  var OPEN_SHAPES = {                                   // "<root pitch class>:<type>"
    "0:maj": "x32010", "0:7": "x32310", "0:maj7": "x32000",
    "2:maj": "xx0232", "2:min": "xx0231", "2:7": "xx0212", "2:maj7": "xx0222", "2:m7": "xx0211", "2:sus4": "xx0233", "2:sus2": "xx0230",
    "4:maj7": "021100", "5:maj7": "xx3210",
    "7:maj": "320003", "7:7": "320001", "7:maj7": "320002", "11:7": "x21202"
  };
  var E_SHAPE = { maj: "022100", min: "022000", "7": "020100", m7: "020000", maj7: "0x110x", sus4: "022200", "7sus4": "020200", power: "022xxx", aug: "032110" };
  var A_SHAPE = { maj: "x02220", min: "x02210", "7": "x02020", m7: "x02010", maj7: "x02120", sus4: "x02230", sus2: "x02200", "7sus4": "x02030", power: "x022xx",
                  aug: "x03221", dim7: "x01212", m7b5: "x0101x" };
  function openType(c){
    switch (c.quality){
      case "power": return "power";
      case "sus":   return c.sus === 2 ? "sus2" : c.seventh === 10 ? "7sus4" : "sus4";
      case "dom":   return "7";
      case "min":   return c.seventh === 10 ? "m7" : "min";
      case "hdim":  return "m7b5";
      case "dim":   return "dim7";
      case "aug":   return "aug";
      default:      return c.seventh === 11 ? "maj7" : "maj";
    }
  }
  function openShape(chord){
    var type = openType(chord), pc = mod12(chord.root), pick = null;
    function shape(str, fret, name){
      var strings = [];
      for (var i = 0; i < 6; i++){ var ch = str.charAt(i); if (ch === "x") continue; var f = parseInt(ch, 10) + fret; strings.push({ string: i, fret: f, midi: OPEN_TUNING[i] + f }); }
      var fretted = strings.filter(function (s){ return s.fret > 0; }).map(function (s){ return s.fret; });
      return { midis: strings.map(function (s){ return s.midi; }), strings: strings, style: "open", fretPos: fret, label: name,
               span: fretted.length ? Math.max.apply(null, fretted) - Math.min.apply(null, fretted) + 1 : 0 };
    }
    if (OPEN_SHAPES[pc + ":" + type]) return shape(OPEN_SHAPES[pc + ":" + type], 0, "Open chord");
    [[E_SHAPE, 4, "E shape"], [A_SHAPE, 9, "A shape"]].forEach(function (m){
      if (!m[0][type]) return; var fret = mod12(pc - m[1]);
      if (!pick || fret < pick.fret) pick = { str: m[0][type], fret: fret, name: m[2] };
    });
    if (!pick) return null;
    if (type === "m7b5" && pick.fret === 0) pick.fret = 12;                    // (that shape has no open form)
    return shape(pick.str, pick.fret, pick.fret ? pick.name + " barre, fret " + pick.fret : "Open chord");
  }
  var LIB_ALIAS = { top3: "shell3", mid3: "shell3" };
  // Several styles at once are written "a+b" (opts.voicing "guide2+top3"): the band draws on all of them.
  function splitStyle(style){ return String(style || "").split("+").filter(function (x){ return x && x !== "auto"; }); }
  // kind "passing" asks for the passing diminished chord of a "bh" voicing instead of the chord itself.
  function candidates(chord, style, inst, kind){
    if (!chord || chord.nc) return [];
    inst = inst === "guitar" ? "guitar" : "piano";
    if (String(style).indexOf("+") >= 0){                              // several styles: every shape of each, once
      var pool = [], seen = {};
      splitStyle(style).forEach(function (one){ candidates(chord, one, inst, kind).forEach(function (c){
        var k = c.midis.join(","); if (!seen[k]){ seen[k] = 1; pool.push(c); } }); });
      if (pool.length || kind === "passing") return pool;
      style = defaultStyle(inst);
    }
    if (style === "auto" || !style) style = defaultStyle(inst);
    if (style === "open"){
      if (kind === "passing") return [];
      var os = inst === "guitar" ? openShape(chord) : null; if (os) return [os];
      style = defaultStyle(inst);
    }
    if (LIB_ALIAS[style] && inst === "guitar"){ var ac = libCands({ root: chord.root, intervals: chord.tones }, style, inst); if (ac.length || kind === "passing") return kind === "passing" ? [] : ac; style = "shell3"; }
    if (style === "bh"){
      var sx = sixthOf(chord);
      if (sx){ var bc = libCands(kind === "passing" ? sx.dim : sx.six, "drop2", inst); if (bc.length) return bc; }
      if (kind === "passing") return [];
      style = "drop2";
    } else if (kind === "passing") return [];
    var own = OWN[inst];
    if ((own.indexOf(style) < 0 || style === "shell" || style === "standard") && libHas(inst, style)){
      var lc = libCands({ root: chord.root, intervals: chord.tones }, style, inst); if (lc.length) return lc; }
    return ownCands(chord, style);                     // (also the guitar's fallback when the library did not load)
  }
  function gripFor(prev){ return (prev && prev.length && lastGrip && lastGrip.key === prev.join(",")) ? lastGrip.strings : null; }
  function remember(best){ if (best && best.strings){ lastGrip = { key: best.midis.join(","), strings: best.strings }; grips[lastGrip.key] = best.strings; } }

  function voicing(chord, style, prev, inst){
    if (!chord || chord.nc) return [];
    inst = inst === "guitar" ? "guitar" : "piano";
    var cands = candidates(chord, style, inst), V = global.ChordVoicings, p = (prev && prev.length) ? prev : null, best = null;
    if (!cands.length) return [];
    if (cands.every(function (c){ return c.fi != null; })){                    // the band's own tables: least motion, near the style's centre
      var bestCost = Infinity;
      cands.forEach(function (it){
        var cost = (p ? motion(p, it.midis) + 0.3 * it.drift : it.drift) + it.fi * 0.01;    // stable tie-break
        if (cost < bestCost){ bestCost = cost; best = it; }
      });
    } else if (inst === "guitar" && V.easiest){
      var grip = gripFor(p);
      best = (grip || !p) ? V.easiest(cands, grip, p, GTR.fret, GTR) : V.nearest(cands, p, GTR.centre);          // a pinned chord has no known grip: go by ear
      remember(best);
    } else best = V.nearest(cands, p, 62);
    return best ? best.midis.slice() : [];
  }

  // voicing() for a display that looks ahead: the same choice, without moving the band's hand
  // (the guitar's remembered grip). -> { midis, strings | null }
  function peek(chord, style, prev, inst){
    var lg = lastGrip, m = voicing(chord, style, prev, inst), st = (lastGrip && lastGrip !== lg) ? lastGrip.strings : null;
    lastGrip = lg;
    return { midis: m, strings: st || (m.length && grips[m.join(",")]) || null };
  }

  // A voicing chosen for its TOP NOTE: the shape whose highest note is nearest o.top, moving the other
  // voices (and on guitar the hand) as little as that allows. o.differ skips the shape already sounding;
  // o.passing asks for the passing diminished chord ("bh" only; [] when the style has none).
  function toward(chord, style, prev, inst, o){
    o = o || {}; inst = inst === "guitar" ? "guitar" : "piano";
    var cands = candidates(chord, style, inst, o.passing ? "passing" : null), V = global.ChordVoicings;
    if (!cands.length) return o.passing ? [] : voicing(chord, style, prev, inst);
    var p = (prev && prev.length) ? prev : null, key = p ? p.join(",") : "", grip = inst === "guitar" ? gripFor(p) : null;
    var best = null, bestCost = Infinity;
    cands.forEach(function (c){
      if (o.differ && cands.length > 1 && c.midis.join(",") === key) return;
      var top = c.midis[c.midis.length - 1];
      var cost = 2 * Math.abs(top - (o.top == null ? top : o.top)) + (p ? 0.25 * motion(p, c.midis) : 0) + (c.fi || 0) * 0.01;
      if (grip && V && V.handMotion) cost += 0.6 * V.handMotion(grip, c.strings);
      if (inst === "guitar") cost += GTR.pitch * Math.abs((c.midis[0] + top) / 2 - GTR.centre);
      if (cost < bestCost){ bestCost = cost; best = c; }
    });
    if (inst === "guitar") remember(best);
    return best ? best.midis.slice() : [];
  }

  // ---- chart -> form ----
  function chordAt(chords, pos){
    var c = null;
    for (var i = 0; i < (chords || []).length; i++){ if (chords[i].pos <= pos + 1e-6) c = chords[i].chord; else break; }
    return (c && !c.nc) ? c : null;
  }

  // What a beat is in a meter. 6/8, 9/8 and 12/8 are COMPOUND: the band counts dotted quarters
  // (2, 3 or 4 beats to the bar) and each beat divides in three. Everything else counts the
  // meter's own lower note.
  // ---- half time / double time ----
  // feelPart(part) wraps a part (bass, comp or drums) so that ctx.opts.timeFeel can change the size of
  // its beat without the chart, the tempo or the bar count changing:
  //   "double": the part plays TWO of its bars inside each bar of the chart, at twice the tempo;
  //   "half":   the part plays ONE of its bars across two bars of the chart, at half the tempo
  //             (bars pair up by form index: 1+2, 3+4, ...; two bars of 5/8 make one bar of five).
  // The wrapper builds the bar the part sees (chords re-placed on the new beats, tempo scaled) and maps
  // the events back, already swung (straight:true), so the player and the MIDI export need no changes.
  // Not in compound meters and not on stop bars. ctx.form / ctx.nextIndex (the form and the bar played
  // next) are used when given. Pinned voicings follow their chords onto the new bar numbers.
  // Which parts change: ctx.opts.timeFeelParts, the names joined by spaces. Unset = "bass drums": the
  // comping keeps its own rhythm, as a pianist or guitarist usually does when the rhythm section shifts,
  // but thins out / fills in and leans on the new backbeat (respond(), below). Add the word "plain"
  // ("bass drums plain") to leave the comping exactly as it is in normal time.
  function feelPart(part, name){
    var carry = null;
    function swingOf(ctx, tempo){
      if (ctx.opts && ctx.opts.feel === "straight") return 0.5;
      var P = global.BandPlayer; return (P && P.swingFor) ? P.swingFor(tempo) : 2 / 3;
    }
    function warp(pos, s){ var b = Math.floor(pos), f = pos - b; return b + (f <= 0.5 ? f * (s / 0.5) : s + (f - 0.5) * ((1 - s) / 0.5)); }
    function back(ev, s, k, off){
      var e = Object.assign({}, ev);
      e.pos = Math.round(((ev.straight ? ev.pos : warp(ev.pos, s)) * k + off) * 10000) / 10000;
      if (e.dur != null) e.dur = Math.round(e.dur * k * 1000) / 1000;
      e.straight = true; delete e.of;
      return e;
    }
    // the pins of the chart's chords, re-keyed for the bar the part is shown (`src` = "chart bar:beat")
    function pinsFor(ctx, c2, nextLen){
      var pins = ctx.opts && ctx.opts.pins; if (!pins) return Object.assign({}, ctx.opts);
      var map = {};
      (c2.chords || []).forEach(function (c){ if (c.src && pins[c.src]) map[c2.index + ":" + c.pos] = pins[c.src]; });
      (c2.nextChords || []).forEach(function (c){ if (c.src && pins[c.src]) map[(nextLen > 0 ? (c2.index + 1) % nextLen : c2.index + 1) + ":" + c.pos] = pins[c.src]; });
      return Object.assign({}, ctx.opts, { pins: map });
    }
    // the chorus bars (opts.lift, chart bar indexes) in the part's own bar numbers: k = 2 doubled, 0.5 halved
    function liftFor(opts, k){ var l = opts && opts.lift; if (!l || !l.forEach) return opts; var out = [];
      l.forEach(function (i){ (k === 2 ? [i * 2, i * 2 + 1] : [Math.floor(i / 2)]).forEach(function (j){ if (out.indexOf(j) < 0) out.push(j); }); });
      opts.lift = out; return opts; }
    // chords of chart beats [lo, hi) of chart bar `src` on a beat `k` times as long, starting at band beat `at`
    function place(chords, lo, hi, k, at, out, src){
      (chords || []).forEach(function (c){
        if (c.pos < lo - 1e-6 || c.pos >= hi - 1e-6) return;
        var p = at + Math.floor((c.pos - lo) / k + 1e-6), prev = out[out.length - 1], it = { pos: p, chord: c.chord, src: src == null ? null : src + ":" + c.pos };
        if (prev && prev.pos === p){ if (c.pos === lo) out[out.length - 1] = it; return; }   // a bar's first chord wins a shared beat
        if (prev && sameChord(prev.chord, c.chord)) return;
        out.push(it);
      });
      return out;
    }
    // where the chord sounding at `pos` of a bar started ("bar:beat"), for its pin
    function srcAt(chords, pos, index){ var s = null; (chords || []).forEach(function (c){ if (c.pos <= pos + 1e-6) s = c.pos; }); return s == null ? null : index + ":" + s; }
    // the drummer's fill for a chart bar, worked out here because the part is about to see other bar numbers
    function planOf(ctx, index, nextIndex){ var D = global.BandDrums; return name === "drums" && D && D.fillPlan ? D.fillPlan(ctx, index, nextIndex) : null; }
    function doubled(ctx){
      var B = ctx.beats, h = B / 2, ph = ctx.phrase || { bar: ctx.index % 4 }, s = swingOf(ctx, ctx.tempo * 2), out = [];
      var nxi = ctx.nextIndex != null ? ctx.nextIndex : (ctx.length > 0 ? (ctx.index + 1) % ctx.length : ctx.index + 1);
      function sub(chords, k, idx){
        var list = place(chords, k * h, (k + 1) * h, 0.5, 0, [], idx), c0 = chordAt(chords, k * h);
        if (c0 && (!list.length || list[0].pos > 0)) list.unshift({ pos: 0, chord: c0, src: srcAt(chords, k * h, idx) });
        return list.filter(function (c){ return c.pos < B; });
      }
      var subs = [sub(ctx.chords, 0, ctx.index), sub(ctx.chords, 1, ctx.index)], after = sub(ctx.nextChords, 0, nxi);
      for (var k = 0; k < 2; k++){
        var c2 = Object.assign({}, ctx, { bar: ctx.bar * 2 + k, index: ctx.index * 2 + k, length: (ctx.length || 0) * 2, chords: subs[k], nextChords: k ? after : subs[1],
          tempo: ctx.tempo * 2, last: !!ctx.last && k === 1, loopEnd: !!ctx.loopEnd && k === 1, nextStop: !!ctx.nextStop && k === 1,
          phrase: { bar: (ph.bar * 2 + k) % 4, turnaround: !!ph.turnaround, top: !!ph.top && k === 0 } });
        c2.opts = liftFor(pinsFor(ctx, c2, 0), 2);                       // (the bar after is found by its own number, never by wrapping)
        var pl = planOf(ctx); if (pl) c2.fillPlan = k ? pl : { fill: null, sectionEnd: false };   // a fill asked of the chart's bar is the second half's
        (part.bar(c2) || []).forEach(function (ev){ if (ev && ev.pos >= 0 && ev.pos < B + 1e-6) out.push(back(ev, s, 0.5, k * h)); });
      }
      return out.filter(function (e){ return e.pos < B - 1e-6; });
    }
    function halved(ctx){
      var B = ctx.beats, i = ctx.index, form = ctx.form, ph = ctx.phrase || { bar: i % 4 }, s = swingOf(ctx, ctx.tempo / 2);
      if (carry && carry.bar === ctx.bar && carry.index === i){ var kept = carry.evs; carry = null; return kept; }
      carry = null;
      var first = i % 2 === 0, len = ctx.length || (form ? form.length : 0);
      var paired = first && form && ctx.nextIndex === i + 1 && form[i + 1] && form[i + 1].beats === B && !ctx.last && !ctx.nextStop;
      var a = first ? ctx.chords : (form && form[i - 1] && form[i - 1].beats === B ? form[i - 1].chords : ctx.chords);
      var b = first ? (paired ? form[i + 1].chords : ctx.nextChords) : ctx.chords;
      var nxi = ctx.nextIndex != null ? ctx.nextIndex : (len > 0 ? (i + 1) % len : i + 1);
      var chords = place(b, 0, B, 2, Math.floor(B / 2 + 1e-6), place(a, 0, B, 2, 0, [], first ? i : i - 1), first ? (paired ? i + 1 : nxi) : i);
      var nx = paired && len ? form[(i + 2) % len].chords : ctx.nextChords, nxSrc = paired && len ? (i + 2) % len : first ? null : nxi;
      var c2 = Object.assign({}, ctx, { bar: Math.floor(ctx.bar / 2), index: Math.floor(i / 2), length: Math.ceil(len / 2), chords: chords, nextChords: place(nx, 0, B, 2, 0, [], nxSrc),
        tempo: ctx.tempo / 2, last: !!ctx.last, phrase: { bar: Math.floor(i / 2) % 4, turnaround: !!ph.turnaround, top: !!ph.top } });
      c2.opts = liftFor(pinsFor(ctx, c2, c2.length), 0.5);
      var p1 = planOf(ctx), p2 = paired ? planOf(ctx, i + 1, len ? (i + 2) % len : i + 2) : null;       // the pair's fill is asked of either bar, its section ends with the second
      if (p1) c2.fillPlan = p2 ? { fill: p2.fill || p1.fill, sectionEnd: p2.sectionEnd } : p1;
      var now = [], later = [];
      (part.bar(c2) || []).forEach(function (ev){
        if (!ev || !(ev.pos >= 0)) return;
        var e = back(ev, s, 2, 0);
        if (e.pos < B - 1e-6) now.push(e); else if (e.pos < 2 * B - 1e-6){ e.pos = Math.round((e.pos - B) * 10000) / 10000; later.push(e); }
      });
      if (!first) return later;                              // came in on the second bar of a pair
      if (paired) carry = { bar: ctx.bar + 1, index: i + 1, evs: later };
      return now;
    }
    // The comping when only the rhythm section changes time: same rhythm, different weight.
    //   double: thinner and shorter. Each chord's first hit and the hits between the beats stay (those
    //     are where the doubled backbeat falls, so they are played straight and a little louder); the
    //     other hits on the beat go. A bar with nothing between the beats gets one stab on the "and" of 2.
    //   half: fuller and longer. Every chord rings until the next hit, and beat 3 (where the half-time
    //     backbeat falls) is accented, re-striking the chord there when the rhythm had nothing on it.
    // Bars of broken chords (arp) and passing chords are left as they are.
    function respond(evs, f, ctx){
      var B = ctx.beats || 4, list = evs.filter(function (e){ return e && e.pos >= 0; }).sort(function (a, b){ return a.pos - b.pos; });
      if (!list.length || list.some(function (e){ return e.arp || e.passing || !e.midis; })) return evs;
      function near(x, y){ return Math.abs(x - y) < 0.02; }
      function louder(e, k){ var c = Object.assign({}, e); c.vel = Math.round(Math.min(0.8, (e.vel == null ? 0.6 : e.vel) * k) * 1000) / 1000; return c; }
      var out = [], seen = {}, i, e;
      if (f === "double"){
        for (i = 0; i < list.length; i++){
          e = list[i]; var fr = e.pos - Math.floor(e.pos + 1e-6), firstOf = !seen[e.of]; seen[e.of] = 1;
          if (near(fr, 0.5)){ var c = louder(e, 1.14); c.straight = true; c.dur = Math.min(c.dur == null ? 0.4 : c.dur, 0.45); out.push(c); }
          else if (firstOf || near(e.pos, 0)){ var k0 = Object.assign({}, e); if (k0.dur != null && list.length > 1) k0.dur = Math.min(k0.dur, 0.75); out.push(k0); }
        }
        if (B >= 2 && !out.some(function (x){ return near(x.pos - Math.floor(x.pos + 1e-6), 0.5); })){
          var src = null; list.forEach(function (x){ if (x.pos <= 1.5) src = x; });
          if (src && list.length > 1){ var st = louder(src, 1.1); st.pos = 1.5; st.dur = 0.4; st.straight = true; out.push(st); }
        }
      } else {
        var mid = B % 2 === 0 ? B / 2 : null, hit = false;
        for (i = 0; i < list.length; i++){
          e = list[i]; var until = (i + 1 < list.length ? list[i + 1].pos : B) - e.pos, c2 = Object.assign({}, e);
          if (mid != null && e.pos < mid - 0.02 && e.pos + until > mid) until = mid - e.pos;        // ... or until beat 3, which is struck again
          c2.dur = Math.round(Math.max(e.dur == null ? 0 : e.dur, Math.min(until, 2) * 0.96) * 1000) / 1000;
          if (mid != null && near(e.pos, mid)){ c2 = louder(c2, 1.14); hit = true; }
          out.push(c2);
        }
        if (mid != null && !hit){
          var from = null; list.forEach(function (x){ if (x.pos < mid) from = x; });
          var nxt = null; list.forEach(function (x){ if (nxt == null && x.pos > mid) nxt = x.pos; });
          if (from){ var r = louder(from, 1.12); r.pos = mid; r.dur = Math.round(Math.min((nxt == null ? B : nxt) - mid, 2) * 0.96 * 1000) / 1000; delete r.straight; out.push(r); }
        }
      }
      return out.sort(function (a, b){ return a.pos - b.pos; });
    }
    // the time feel this part plays the bar in ("double" | "half" | anything else = as written), and what the rhythm section is doing
    function feelOf(ctx){
      var f = ctx && ctx.opts && ctx.opts.timeFeel, who = ctx && ctx.opts && ctx.opts.timeFeelParts;
      // opts.halfBars (form bar indexes, in pairs 1+2, 3+4, ...): those bars are one step slower than the rest, the bass and drums changing and the chords answering
      var hb = ctx && ctx.opts && ctx.opts.halfBars;
      if (hb && hb.indexOf && !ctx.intro && hb.indexOf(ctx.index) >= 0 && hb.indexOf(ctx.index % 2 ? ctx.index - 1 : ctx.index + 1) >= 0){ if (f === "double") f = "normal"; else if (f !== "half"){ f = "half"; who = "bass drums"; } }
      var whoL = String(who == null ? "bass drums" : who).split(" "), f0 = f;
      if (name && whoL.indexOf(name) < 0) f = null;
      return { f: f, f0: f0, whoL: whoL, plain: (f !== "double" && f !== "half") || ctx.compound || ctx.stop || !ctx.chords || !ctx.chords.length };
    }
    return {
      bar: function (ctx){
        var fo = feelOf(ctx), f = fo.f, f0 = fo.f0, whoL = fo.whoL;
        if (fo.plain){
          carry = null;
          // the comping keeps its own rhythm but answers the rhythm section (unless told "plain")
          if (name === "comp" && f == null && (f0 === "double" || f0 === "half") && whoL.indexOf("plain") < 0 && !ctx.compound && !ctx.stop) return respond(part.bar(ctx) || [], f0, ctx);
          return part.bar(ctx);
        }
        return f === "double" ? doubled(ctx) : halved(ctx);
      },
      // a fill for a bar already given out (the drums; see drums.js): only where the part plays the chart's own bars
      fillNow: function (ctx, size, room){ return part.fillNow && feelOf(ctx).plain ? part.fillNow(ctx, size, room) : null; },
      ending: function (ctx){ carry = null; return part.ending ? part.ending(ctx) : []; },
      reset: function (){ carry = null; if (part.reset) part.reset(); }
    };
  }

  function meterInfo(n, d){
    n = n || 4; d = d || 4;
    var compound = d === 8 && n >= 6 && n % 3 === 0;
    return { n: n, d: d, compound: compound, beats: compound ? n / 3 : n, per: compound ? 3 : 1 };
  }

  function buildForm(parsed, transpose){
    var out = [];
    if (!parsed || !parsed.bars || !parsed.bars.length) return out;
    var order = (parsed.playOrder && parsed.playOrder.length) ? parsed.playOrder
      : parsed.bars.map(function (_, i){ return i; });
    var mN = parsed.meterN || parsed.beatsPerBar || 4, mD = parsed.meterD || 4;
    var unitL = (mN / mD) / (parsed.unitsPerBar || 1);              // the L: unit, in whole notes
    var cache = {}, carry = null;
    function chordOf(sym){ return cache[sym] || (cache[sym] = parseChord(sym, transpose)); }
    // the notes of the key (K: field; a minor key = its natural minor), for parts that add neighbour notes
    var kf = String(parsed.keyField || "").replace(/^[A-Ga-g][#b]?\s*/, ""), minorKey = /^(m(?!aj)|min|aeo)/i.test(kf);
    var keyPcs = parsed.keyPc == null ? null : [0, 2, 4, 5, 7, 9, 11].map(function (iv){ return mod12(parsed.keyPc + (minorKey ? 3 : 0) + (transpose || 0) + iv); });

    order.forEach(function (bi){
      var bar = parsed.bars[bi];
      if (!bar || bar.anacrusis) return;                            // the band comes in on bar 1
      var mt = bar.meter || { n: mN, d: mD }, mi = meterInfo(mt.n, mt.d);
      var upBeat = mi.per * (1 / mt.d) / unitL;                     // L-units per beat in this bar
      var len = bar.lengthUnits > 0 ? bar.lengthUnits / upBeat : mi.beats;
      var beats = Math.max(1, Math.round(Math.min(mi.beats, len)));
      // a bar that does not add up to its meter (TuneChart marks it misfit): a full bar of the meter, unless the chart says to
      // play such bars as written (parsed.asWritten), short or long
      if (bar.misfit) beats = parsed.asWritten ? Math.max(1, Math.round(len)) : mi.beats;
      var barUnits = beats * upBeat;

      var raw = [];
      (bar.chords || []).forEach(function (c){
        if (c.nc){ raw.push({ onset: c.onset, nc: true }); return; }
        var ch = chordOf(c.sym);
        if (ch.nc){ if (!ch.unknown) raw.push({ onset: c.onset, nc: true }); return; }
        if (ch.unknown) return;                                     // a word in quotes, not a chord
        raw.push({ onset: c.onset, chord: ch });
      });
      // several symbols stacked on one onset (MusicXML imports): share the time up to the next one
      var spread = [];
      for (var i = 0; i < raw.length; ){
        var j = i; while (j < raw.length && Math.abs(raw[j].onset - raw[i].onset) < 1e-6) j++;
        var end = j < raw.length ? raw[j].onset : Math.max(barUnits, raw[i].onset);
        for (var k = i; k < j; k++){ var e = raw[k]; spread.push({ onset: raw[i].onset + (k - i) * (end - raw[i].onset) / (j - i), nc: e.nc, chord: e.chord }); }
        i = j;
      }
      // snap to the beat; a later chord on the same beat wins
      var byBeat = {};
      spread.forEach(function (e){ var p = Math.round(e.onset / upBeat); if (p >= beats) p = beats - 1; if (p < 0) p = 0; byBeat[p] = e; });
      var chords = [];
      if (!byBeat[0] && carry) chords.push({ pos: 0, chord: carry });
      Object.keys(byBeat).map(Number).sort(function (a, b){ return a - b; }).forEach(function (p){
        var e = byBeat[p], last = chords.length ? chords[chords.length - 1].chord : null;
        if (e.nc){ carry = null; if (last && !last.nc) chords.push({ pos: p, chord: ncChord("N.C.", false) }); return; }
        carry = e.chord;
        if (last && sameChord(last, e.chord)) return;
        chords.push({ pos: p, chord: e.chord });
      });
      if (!chords.some(function (x){ return !x.chord.nc; })) chords = [];
      // unit: this bar's beat against the beat of the tune's own meter (the tempo's beat), so that the written note values keep their length
      // through a change of meter: 4/4 to 7/8 = 0.5 (eighths), 4/4 to 6/8 = 1.5 (dotted quarters), 6/8 to 2/4 = 2/3
      var mi0 = meterInfo(mN, mD), unit = Math.round((mi.per / mt.d) / (mi0.per / mD) * 10000) / 10000;
      var fbar = { src: bi, beats: beats, chords: chords, meter: { n: mt.n, d: mt.d }, compound: mi.compound, keyPcs: keyPcs, unit: unit };
      if (bar.section != null && bar.section !== "") fbar.section = String(bar.section);      // P:Verse in the ABC: a section starts on this bar
      // a written melody for this bar (a page puts it on the parsed bar): [{ pos (beats), dur (beats), midi }]; the player plays it on the comping instrument
      if (bar.melody && bar.melody.length) fbar.melody = bar.melody.map(function (n){ return { pos: n.pos, dur: n.dur, midi: n.midi + (transpose || 0) }; });
      if (bar.stop) fbar.stop = true;                                                         // "^stop": stop time on this bar
      if (bar.fill) fbar.fill = bar.fill;                                                     // "^fill": the drummer fills at the end of it
      out.push(fbar);
    });
    return out;
  }

  // ---- pinned voicings + the as-played view ----
  // A parsed chord as the shared voicing library describes one: { root, intervals }, the written
  // extensions and alterations above the octave (for ChordVoicings.identify / .piano).
  function libChord(c){
    if (!c || c.nc) return null;
    var iv = (c.tones || []).slice();
    if (c.b9) iv.push(13); if (c.s9) iv.push(15);
    if (!c.b9 && !c.s9 && (c.ext >= 9 || c.add9 || c.six9)) iv.push(14);
    if (c.s11) iv.push(18); if (c.b13) iv.push(20); else if (c.ext >= 13) iv.push(21);
    return { root: c.root, intervals: iv };
  }
  function pinMap(form, pins){
    var map = {};
    (pins || []).forEach(function (p){
      if (!p || !p.midis || !p.midis.length) return;
      (form || []).forEach(function (fb, i){
        if (fb.src === p.bar && fb.chords.some(function (c){ return Math.abs(c.pos - p.pos) < 1e-6; })) map[i + ":" + p.pos] = p.midis.slice();
      });
    });
    return map;
  }
  function asPlayed(bars, o){
    o = o || {}; var first = {}, firstGrip = {}, out = [], prev = null;
    (bars || []).forEach(function (r){ ((r.parts && r.parts.comp) || []).forEach(function (e){
      if (e && e.of != null && !e.passing && !e.arp && e.midis && e.midis.length && !first[e.of]){ first[e.of] = e.midis.slice(); if (e.strings) firstGrip[e.of] = e.strings; } }); });
    (bars || []).forEach(function (r){ (r.chords || []).forEach(function (c){
      if (!c.chord || c.chord.nc) return;
      var m = first[r.index + ":" + c.pos], played = !!m;
      if (!m) m = voicing(c.chord, o.style || "rootless", prev, o.inst || "piano");
      if (m.length) prev = m;
      // the fingering: the one that event was played with, else the last one used for these notes
      var entry = { sym: c.chord.sym, midis: m.slice(), played: played }, g = o.inst === "guitar" && (firstGrip[r.index + ":" + c.pos] || grips[m.join(",")]);
      if (g) entry.strings = g.map(function (s){ return { string: s.string, fret: s.fret, midi: s.midi }; });   // the fingering the band had in mind
      out.push(entry);
    }); });
    return out;
  }

  // Plain chart numerals: the degree of the chord's root in the key, lower-case for minor and
  // diminished chords, keeping the chord's own figures (I7, IV7, ii7, #iv dim7, VI7b9). No
  // applied-chord analysis: a blues reads I7 IV7 V7.
  var DEGREE = ["I","\u266dII","II","\u266dIII","III","IV","\u266fIV","V","\u266dVI","VI","\u266dVII","VII"];
  function roman(sym, keyPc){
    var c = parseChord(sym, 0); if (!c || c.nc || c.unknown) return null;
    var m = /^[A-G][#b\u266f\u266d]*(.*)$/.exec(sym || ""), suf = (m ? m[1] : "").replace(/\/[A-G][#b]*$/, "");
    var small = c.quality === "min" || c.quality === "hdim" || c.quality === "dim";
    var num = DEGREE[mod12(c.root - (keyPc || 0))]; if (small) num = num.toLowerCase();
    if (c.quality === "hdim") suf = "\u00f87";
    else if (c.quality === "dim") suf = suf.replace(/^(dim|\u00b0|o)/, "\u00b0");
    else if (c.quality === "min") suf = suf.replace(/^(min|mi|m(?!aj)|-)/, "");
    return num + suf.replace(/b/g, "\u266d").replace(/#/g, "\u266f");
  }

  // Pushed chords (opts.push): is the NEXT bar's chord played early, on the last eighth of this bar? The
  // bass, the comping and the drums all ask this, so they push together: into the third bar of each
  // four-bar phrase, when the chord changes there. Never into or out of a stop, in the last bar, in a
  // compound or odd-length bar, or while the band is in half or double time.
  function pushes(ctx){
    var o = ctx && ctx.opts; if (!o || !o.push || ctx.compound || ctx.beats !== 4 || ctx.stop || ctx.nextStop || ctx.last || ctx.intro || ctx.ending) return false;
    if (o.timeFeel && o.timeFeel !== "normal") return false;
    if ((ctx.phrase ? ctx.phrase.bar : ctx.index % 4) !== 1) return false;
    var n = ctx.nextChords && ctx.nextChords[0]; if (!n || n.pos !== 0 || !n.chord || n.chord.nc) return false;
    var cur = chordAt(ctx.chords, 3.5); return !!cur && cur.key !== n.chord.key;
  }
  // Is this bar one of the chorus bars (opts.lift = form bar indexes), where the band plays up?
  function lifted(ctx, index){ var l = ctx && ctx.opts && ctx.opts.lift; return !!(l && l.indexOf && !ctx.intro && l.indexOf(index == null ? ctx.index : index) >= 0); }

  global.BandHarmony = { pushes: pushes, lifted: lifted,
    parseChord: parseChord, chordScale: chordScale, voicing: voicing, buildForm: buildForm,
    chordAt: chordAt, sameChord: sameChord, noteName: noteName, pcName: pcName, libChord: libChord,
    voicingClass: voicingClass, motion: motion, STYLES: STYLES,
    styleList: styleList, defaultStyle: defaultStyle, openShape: openShape, hasStyle: hasStyle, pinMap: pinMap, asPlayed: asPlayed, roman: roman, meterInfo: meterInfo,
    candidates: candidates, toward: toward, peek: peek, gripOf: function (midis){ return gripFor(midis); }, sixthOf: sixthOf, asSixth: asSixth, colour: colour, feelPart: feelPart
  };
})(typeof window !== "undefined" ? window : globalThis);
