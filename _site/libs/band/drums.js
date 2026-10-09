// drums.js — jazz drum-set part for the backing band (BandDrums).
// Simple swing time with a few fills: ride pattern, hi-hat foot on 2 and 4, a feathered
// kick, sparse snare comping, a setup at the end of some 4-bar phrases and a fill into
// every new chorus. Pure logic: it returns abstract events and never touches audio.
//
//   var drums = BandDrums.create({ rng });      // rng: () => [0,1), seeded by the player
//   drums.bar(ctx)    -> [{ pos, piece, vel, straight? }]   one bar of events
//   drums.ending(ctx) -> the final hit
//   drums.reset()
//
// pos is in beats from the bar start. An off-beat eighth is written x.5 and the PLAYER
// swings it; triplet positions carry straight:true so they are left alone.
// piece is a kit-piece NAME (kick snare rim hatClosed hatFoot hatOpen ride rideBell crash
// tomHi tomMid tomLo sticks) — which sample that is lives in sounds.js, not here.
// ctx is the shared bar context (see player.js); this part reads index, length, beats,
// tempo, last and opts: bassFeel ("walk" | "two"), feel ("swing" | "straight": a straight-
// eighths groove with cross-stick on 2 and 4) and ride ("ride" | "hat" | "bell": which
// cymbal keeps the time).
// Stop time (ctx.stop): one hit on beat 1 — kick, snare and a closed hat — then nothing; a
// { pos, choke:"cymbals" } event asks the player to damp whatever cymbal is still ringing. The
// bar after it comes back in with a crash.
// Fills. opts.fills says how often: "auto" (unset; into every chorus and section, and at some phrase ends), "busy" (more of
// them), "sections" (only into a chorus, a new section and the top of the form) or "none" (only the ones asked for). A fill
// is asked for on one bar by opts.fillBars = { formIndex: "small" | "medium" | "large" }, by a "^fill" in the chart
// (ctx.form[i].fill) or by the player (ctx.fill, its Fill now). A section starts where ctx.form[i].section is set (P: in the
// chart); ctx.sectionEnd = true / false is the player saying so itself (it holds a section until told to move on).
// drums.fillNow(ctx, size, room) -> { from, hits } | null: a fill for the last beats of a bar already given out.
// Grooves (ctx.opts.groove = a GROOVES id; unset or "auto" = the time described above): fixed one- or
// two-bar patterns for the Latin, Caribbean, folk and rock styles. They are written for 4/4 (a 2/4 bar
// takes the first half; 3/4 only where the groove has its own three-beat bar) and fall back to the
// time above in any other meter. The Latin and Caribbean ones play no fills: a tom fill is a rock habit.
// Meters: 3/4 is a jazz waltz (ride "ding, ding-a, ding", hat foot on 2 and 3, kick on 1). The
// compound meters (ctx.compound: 6/8, 9/8, 12/8, where a beat is a dotted quarter) get their own
// groove whatever opts.feel says: all three eighths on the cymbal, kick on 1 (and 3), backbeat on
// 2 (and 4).

(function (global) {
  var T = 1 / 3;   // one triplet step

  // Ride-pattern variants: which of the bar's "2 and 4" beats get the skip note after them.
  var RIDE = [ { w:70, skip:"all" }, { w:12, skip:"last" }, { w:8, skip:"first" }, { w:10, skip:"none" } ];
  var RIDE_FAST = [ { w:45, skip:"all" }, { w:20, skip:"last" }, { w:5, skip:"first" }, { w:30, skip:"none" } ];

  // Snare/kick comping for a bar of plain time: [weight, [[pos, piece, vel], ...]].
  // Mostly space; everything is quiet so it colours the time rather than leading it.
  var COMPS = [
    [38, []],
    [14, [[3.5, "snare", 0.38]]],
    [12, [[1.5, "snare", 0.36]]],
    [ 8, [[3,   "snare", 0.33]]],
    [ 8, [[1.5, "snare", 0.34], [3.5, "snare", 0.40]]],
    [ 6, [[0.5, "snare", 0.32]]],
    [ 8, [[2.5, "snare", 0.36]]],
    [ 6, [[3.5, "kick",  0.50]]]
  ];

  // Fills, written against the LAST n beats of the bar: [offset from the fill's first
  // beat, piece, vel]. Offsets on the triplet grid are emitted straight; x.5 offsets
  // are swung eighths. trip:true fills are skipped at fast tempos.
  var FILLS = {
    small: [
      { n:1, hits:[[0, "snare", 0.46], [0.5, "snare", 0.62]] },
      { n:1, trip:true, hits:[[0, "snare", 0.42], [T, "snare", 0.50], [2*T, "snare", 0.64]] },
      { n:1, hits:[[0.5, "snare", 0.62], [0.5, "kick", 0.50]] },
      { n:1, hits:[[0, "tomHi", 0.52], [0.5, "tomLo", 0.60]] },
      { n:1, hits:[[0.5, "snare", 0.56]] },
      { n:1, hits:[[0, "kick", 0.50], [0.5, "snare", 0.60]] },
      { n:1, trip:true, hits:[[T, "snare", 0.46], [2*T, "tomHi", 0.58]] }
    ],
    medium: [
      { n:2, trip:true, hits:[[0, "snare", 0.46], [T, "snare", 0.50], [2*T, "snare", 0.55],
                              [1, "tomHi", 0.60], [1+T, "tomMid", 0.64], [1+2*T, "tomLo", 0.70]] },
      { n:2, hits:[[0, "snare", 0.50], [0.5, "snare", 0.55], [1, "tomHi", 0.60], [1.5, "tomLo", 0.68]] },
      { n:2, hits:[[0.5, "snare", 0.50], [1, "snare", 0.56], [1.5, "snare", 0.68]] },
      { n:2, trip:true, hits:[[0, "snare", 0.48], [2*T, "snare", 0.54], [1, "snare", 0.60], [1+2*T, "tomLo", 0.68]] },
      { n:2, hits:[[0, "tomHi", 0.52], [0.5, "snare", 0.50], [1, "tomMid", 0.58], [1.5, "kick", 0.56]] },
      { n:2, hits:[[0, "snare", 0.54], [1, "kick", 0.50], [1.5, "snare", 0.64]] },
      { n:2, trip:true, hits:[[0, "kick", 0.50], [T, "snare", 0.48], [2*T, "snare", 0.52], [1, "kick", 0.52], [1+T, "tomMid", 0.58], [1+2*T, "tomLo", 0.64]] },
      { n:2, hits:[[1, "snare", 0.54], [1.5, "snare", 0.66]] }
    ],
    large: [
      { n:3, trip:true, hits:[[0.5, "snare", 0.48], [1, "snare", 0.50], [1+T, "snare", 0.54], [1+2*T, "snare", 0.58],
                              [2, "tomHi", 0.62], [2+T, "tomMid", 0.66], [2+2*T, "tomLo", 0.72]] },
      { n:3, hits:[[0, "snare", 0.48], [0.5, "snare", 0.52], [1, "tomHi", 0.56], [1.5, "tomHi", 0.60],
                   [2, "tomMid", 0.64], [2.5, "tomLo", 0.72]] },
      { n:3, trip:true, hits:[[0, "snare", 0.50], [1, "snare", 0.52], [1.5, "snare", 0.56], [2, "snare", 0.60],
                              [2+T, "tomHi", 0.64], [2+2*T, "tomLo", 0.72]] }
    ]
  };

  // Fills for the rock and pop grooves (GROOVES[..].fills). "rock": sixteenths on the snare and down the
  // toms, never longer than two beats. "light": a couple of snare notes at most, for ballads, strummed
  // songs and dance grooves, where a tom roll would be out of character.
  var FILLS_ROCK = {
    small: [
      { n:1, hits:[[0, "snare", 0.48], [0.25, "snare", 0.50], [0.5, "snare", 0.58], [0.75, "snare", 0.66]] },
      { n:1, hits:[[0, "tomHi", 0.54], [0.5, "tomLo", 0.62]] },
      { n:1, hits:[[0.5, "snare", 0.62], [0.5, "kick", 0.50]] },
      { n:1, hits:[[0, "snare", 0.52], [0.5, "tomMid", 0.58], [0.75, "tomLo", 0.62]] },
      { n:1, hits:[[0.5, "tomHi", 0.56], [0.75, "tomHi", 0.60]] },
      { n:1, hits:[[0, "kick", 0.52], [0.25, "snare", 0.50], [0.5, "kick", 0.52], [0.75, "snare", 0.64]] }
    ],
    medium: [
      { n:2, hits:[[0, "tomHi", 0.56], [0.5, "tomHi", 0.58], [1, "tomMid", 0.60], [1.25, "tomMid", 0.60], [1.5, "tomLo", 0.66], [1.75, "tomLo", 0.70]] },
      { n:2, hits:[[0, "snare", 0.54], [0.75, "snare", 0.56], [1.5, "snare", 0.66], [1.5, "kick", 0.52]] },
      { n:2, hits:[[0, "kick", 0.54], [0.5, "snare", 0.54], [0.75, "snare", 0.56], [1, "kick", 0.54], [1.5, "tomMid", 0.62], [1.75, "tomLo", 0.66]] },
      { n:2, hits:[[1, "snare", 0.52], [1.25, "snare", 0.54], [1.5, "snare", 0.60], [1.75, "snare", 0.68]] },
      { n:2, hits:[[0, "snare", 0.50], [0.25, "snare", 0.50], [0.5, "snare", 0.56], [0.75, "snare", 0.58], [1, "tomHi", 0.60], [1.25, "tomHi", 0.60], [1.5, "tomLo", 0.66], [1.75, "tomLo", 0.70]] },
      { n:2, hits:[[0, "snare", 0.52], [0.5, "snare", 0.56], [1, "tomHi", 0.60], [1.5, "tomLo", 0.68]] },
      { n:2, hits:[[0.5, "snare", 0.52], [1, "snare", 0.58], [1.5, "snare", 0.68], [1.5, "kick", 0.52]] }
    ]
  };
  FILLS_ROCK.large = FILLS_ROCK.medium;
  var FILLS_LIGHT = {
    small: [ { n:1, hits:[[0.5, "snare", 0.50]] }, { n:1, hits:[[0.5, "kick", 0.48]] }, { n:1, hits:[[0.5, "rim", 0.50]] }, { n:1, hits:[[0.5, "hatOpen", 0.46]] }, { n:1, hits:[[0.5, "tomMid", 0.46]] } ],
    medium: [ { n:1, hits:[[0, "snare", 0.46], [0.5, "snare", 0.58]] }, { n:1, hits:[[0, "tomMid", 0.48], [0.5, "tomLo", 0.56]] }, { n:1, hits:[[0.5, "snare", 0.56]] },
              { n:1, hits:[[0, "kick", 0.48], [0.5, "snare", 0.56]] }, { n:1, hits:[[0, "tomHi", 0.46], [0.5, "snare", 0.56]] }, { n:1, hits:[[0, "snare", 0.48], [0.5, "kick", 0.50]] },
              { n:1, hits:[[0.5, "tomLo", 0.54]] } ]
  };
  FILLS_LIGHT.large = FILLS_LIGHT.medium;

  // Grooves: bars = [[pos, piece, vel], ...] for each bar of the pattern (two-bar patterns follow the
  // form bar's parity). "cym" / "cymOff" = the time-keeping cymbal chosen in opts.ride, on and off the beat.
  function cymEighths(on, off){ var h = []; for (var b = 0; b < 4; b++){ h.push([b, "cym", on]); h.push([b + 0.5, "cymOff", off]); } return h; }
  function cymBeats(v){ return [[0, "cym", v], [1, "cym", v], [2, "cym", v], [3, "cym", v]]; }
  var FOOT = [[1, "hatFoot", 0.36], [3, "hatFoot", 0.36]];
  function ROCK(kicks){ return cymEighths(0.58, 0.44).concat(kicks.map(function (p){ return [p, "kick", p === 0 ? 0.62 : p === Math.floor(p) ? 0.58 : 0.48]; }), [[1, "snare", 0.66], [3, "snare", 0.66]]); }
  function BACK(on, off, kicks, piece, v){ return cymEighths(on, off).concat(kicks.map(function (p){ return [p, "kick", p === 0 ? 0.58 : p === Math.floor(p) ? 0.52 : 0.42]; }), [[1, piece, v], [3, piece, v]]); }
  function lifted(ctx, i){ var l = ctx.opts && ctx.opts.lift; return !!(l && l.indexOf && !ctx.intro && l.indexOf(i == null ? ctx.index : i) >= 0); }
  // What is asked of bar `index` (this bar when left out): { fill: a size or null, sectionEnd: the next bar starts a section }.
  // A wrapper that renumbers the bars (half time, double time) hands the answer over as ctx.fillPlan.
  function fillPlan(ctx, index, nextIndex){
    if (ctx.fillPlan && index == null) return ctx.fillPlan;
    var o = ctx.opts || {}, own = index == null || index === ctx.index, i = index == null ? ctx.index : index;
    var nx = nextIndex != null ? nextIndex : own && ctx.nextIndex != null ? ctx.nextIndex : i + 1;
    var form = ctx.intro ? null : ctx.form, fb = form && form[i], nb = form && form[nx];
    var fill = (own && ctx.fill) || (ctx.intro ? null : (o.fillBars && o.fillBars[i]) || (fb && fb.fill)) || null;
    var se = own && ctx.sectionEnd != null ? !!ctx.sectionEnd : !!(nb && nb.section != null && nx !== i);
    return { fill: fill, sectionEnd: se };
  }
  // where this bar sits in its four-bar phrase: counted from the start of its section when the chart has sections
  function phraseBar(ctx){
    var form = ctx.form;
    if (form && !ctx.fillPlan && !ctx.intro) for (var i = ctx.index; i >= 0; i--) if (form[i] && form[i].section != null) return (ctx.index - i) % 4;
    return ctx.index % 4;
  }
  function tripletGroove(ctx){ var g = ctx.opts && GROOVES.hasOwnProperty(ctx.opts.groove) ? GROOVES[ctx.opts.groove] : null; return !!(g && g.triplet); }
  var BOSSA_K = [[0, "kick", 0.46], [1.5, "kick", 0.38], [2, "kick", 0.46], [3.5, "kick", 0.38]];
  var GROOVES = {
    bossa:   { bars: [ cymEighths(0.48, 0.38).concat(BOSSA_K, FOOT, [[0, "rim", 0.50], [1.5, "rim", 0.50], [3, "rim", 0.50]]),
                       cymEighths(0.48, 0.38).concat(BOSSA_K, FOOT, [[1, "rim", 0.50], [2.5, "rim", 0.50]]) ] },
    clave:   { bars: [ cymBeats(0.52).concat([[1.5, "cymOff", 0.42], [3.5, "cymOff", 0.42], [1, "rim", 0.56], [2, "rim", 0.56], [1.5, "kick", 0.36], [3, "kick", 0.44]], FOOT),
                       cymBeats(0.52).concat([[1.5, "cymOff", 0.42], [3.5, "cymOff", 0.42], [0, "rim", 0.56], [1.5, "rim", 0.56], [3, "rim", 0.56], [1.5, "kick", 0.36], [3, "kick", 0.44]], FOOT) ] },
    clave32: { bars: [ cymBeats(0.52).concat([[1.5, "cymOff", 0.42], [3.5, "cymOff", 0.42], [0, "rim", 0.56], [1.5, "rim", 0.56], [3, "rim", 0.56], [1.5, "kick", 0.36], [3, "kick", 0.44]], FOOT),
                       cymBeats(0.52).concat([[1.5, "cymOff", 0.42], [3.5, "cymOff", 0.42], [1, "rim", 0.56], [2, "rim", 0.56], [1.5, "kick", 0.36], [3, "kick", 0.44]], FOOT) ] },
    // the Bo Diddley beat: the 3-2 clave on the toms over a steady kick
    bodiddley: { bars: [ [[0, "kick", 0.56], [2, "kick", 0.52], [0, "tomLo", 0.60], [1.5, "tomLo", 0.58], [3, "tomMid", 0.58], [1, "hatFoot", 0.36], [3, "hatFoot", 0.36]],
                         [[0, "kick", 0.56], [2, "kick", 0.52], [1, "tomMid", 0.58], [2, "tomLo", 0.60], [1, "hatFoot", 0.36], [3, "hatFoot", 0.36]] ] },
    // dembow (reggaeton): kick on every beat, the snare on the sixteenth before beats 2 and 4 and on the and of 2 and 4
    dembow:  { bars: [ [[0, "kick", 0.62], [1, "kick", 0.58], [2, "kick", 0.62], [3, "kick", 0.58], [0.75, "snare", 0.56], [1.5, "snare", 0.60], [2.75, "snare", 0.56], [3.5, "snare", 0.60],
                        [0, "hatClosed", 0.36], [0.5, "hatClosed", 0.30], [1, "hatClosed", 0.36], [2, "hatClosed", 0.36], [2.5, "hatClosed", 0.30], [3, "hatClosed", 0.36]] ] },
    chacha:  { bars: [ cymBeats(0.56).concat([[0, "kick", 0.44], [1, "rim", 0.52], [3, "tomHi", 0.50], [3.5, "tomMid", 0.46]]) ] },
    tango:   { bars: [ cymBeats(0.36).concat([[0, "kick", 0.50], [1.5, "kick", 0.38], [2, "kick", 0.46], [3, "kick", 0.42]]) ] },
    calypso: { bars: [ cymEighths(0.40, 0.52).concat([[0, "kick", 0.52], [2, "kick", 0.50], [1.5, "rim", 0.54], [3, "rim", 0.54]]) ] },
    onedrop: { bars: [ cymEighths(0.36, 0.52).concat([[2, "kick", 0.60], [2, "rim", 0.58]]) ] },
    boomchick: { bars: [ [[0, "kick", 0.54], [2, "kick", 0.50], [1, "snare", 0.40], [3, "snare", 0.40], [1, "hatFoot", 0.40], [3, "hatFoot", 0.40]] ],
                 three: [[0, "kick", 0.54], [1, "snare", 0.36], [2, "snare", 0.38], [1, "hatFoot", 0.38], [2, "hatFoot", 0.38]], fills: "light" },
    // The rock and pop grooves are four bars long, so the kick changes from bar to bar, and each kick
    // pattern is the rhythm of the bass line that goes with it (bass.js LINES). "back" = the backbeat:
    // a cross-stick, or the snare in a chorus bar (opts.lift).
    rock:    { bars: [ ROCK([0, 2, 2.5]), ROCK([0, 1.5, 2]), ROCK([0, 2, 2.5]), ROCK([0, 2, 2.5, 3.5]) ], fills: "rock" },
    // the strummed song: kick on 1, the and of 2 and 3, with the "Dotted" bass line
    strum:   { bars: [ BACK(0.50, 0.36, [0, 1.5, 2], "snare", 0.56), BACK(0.50, 0.36, [0, 1.5, 2, 3.5], "snare", 0.56) ],
               three: cymEighths(0.46, 0.34).slice(0, 6).concat([[0, "kick", 0.56], [2, "snare", 0.50]]), fills: "light" },
    // the ballad: the same kick, quieter, under a cross-stick
    ballad:  { bars: [ BACK(0.44, 0.32, [0, 1.5, 2], "back", 0.52), BACK(0.44, 0.32, [0, 2, 3.5], "back", 0.52) ],
               three: cymEighths(0.42, 0.30).slice(0, 6).concat([[0, "kick", 0.52], [2, "back", 0.48]]), fills: "light" },
    // four on the floor: kick on every beat, snare and clap on 2 and 4, the open hi-hat on every off-beat
    dance:   { bars: [ [0, 1, 2, 3].reduce(function (h, b){ return h.concat([[b, "kick", 0.64], [b, "hatClosed", 0.34], [b + 0.5, "hatOpen", 0.46]]); }, [])
                         .concat([[1, "snare", 0.60], [3, "snare", 0.60], [1, "clap", 0.50], [3, "clap", 0.50]]) ], fills: "light" },
    // Motown: the snare on all four beats, a tambourine on 2 and 4
    motown:  { bars: [ cymEighths(0.50, 0.38).concat([[0, "kick", 0.60], [1.5, "kick", 0.46], [2, "kick", 0.56], [0, "snare", 0.44], [1, "snare", 0.62], [2, "snare", 0.44], [3, "snare", 0.62], [1, "tamb", 0.50], [3, "tamb", 0.50]]) ], fills: "light" },
    // the country train beat: the snare on every eighth, leaning on 2 and 4, over a two-beat kick
    train:   { bars: [ [0, 1, 2, 3].reduce(function (h, b){ return h.concat([[b, "snare", b % 2 ? 0.60 : 0.34], [b + 0.5, "snare", 0.40]]); }, [])
                         .concat([[0, "kick", 0.54], [2, "kick", 0.50], [1, "hatFoot", 0.40], [3, "hatFoot", 0.40]]) ], fills: "light" },
    // brushes (played on the hi-hat and cross-stick: the kit has no brush samples): very light time for a carol or a folk song
    brushes: { bars: [ cymEighths(0.36, 0.26).concat([[0, "kick", 0.46], [2, "kick", 0.40], [1, "rim", 0.38], [3, "rim", 0.40]]) ],
               three: cymEighths(0.34, 0.24).slice(0, 6).concat([[0, "kick", 0.46], [1, "rim", 0.32], [2, "rim", 0.36]]), fills: false },
    // 12/8 time (a slow doo-wop or blues ballad), also played as triplets over a bar of 4/4: see compoundBar
    twelve8: { triplet: true },
    halftime:{ bars: [ cymEighths(0.54, 0.40).concat([[0, "kick", 0.60], [1.5, "kick", 0.46], [2, "snare", 0.68]]) ], fills: "light" },
    funk:    { bars: [ cymEighths(0.54, 0.44).concat([[0, "kick", 0.62], [1.5, "kick", 0.50], [2.5, "kick", 0.52], [1, "snare", 0.66], [3, "snare", 0.66]]) ], fills: true }
  };

  // ctx.intensity (0..1, from the player's conductor; 0.5 = the plain pattern)
  function busy(ctx){ return ctx.intensity == null ? 0.5 : ctx.intensity; }
  function onEighthGrid(x){ return Math.abs(x * 2 - Math.round(x * 2)) < 1e-6; }

  function create(cfg){
    var rng = (cfg && cfg.rng) || Math.random;
    var afterFill = null;      // "crash" | "kick": how the bar after a fill lands on beat 1
    var lastComp = -1, lastFill = null, pushedIn = false, sinceCrash = 99;
    // How hard the band is playing just now: what the bass and chords did in this bar when the player says so
    // (ctx.energy), else the conductor's intensity.
    function energy(ctx){ return ctx.energy != null ? ctx.energy : busy(ctx); }
    // How the bar after a fill (or the first bar of a chorus) begins: a crash, an open hi-hat, or just the kick.
    // The crash is earned: likelier the harder the band is playing, seldom after a small fill, and seldom twice within four bars.
    function land(ctx, size, entering){
      var e = energy(ctx), p = entering ? 0.45 + 0.4 * e : size === "small" ? 0.04 + 0.2 * e : 0.12 + 0.6 * e;
      if (sinceCrash < 4) p *= 0.25;
      if (rng() < p) return "crash";
      return rng() < 0.3 ? "hat" : "kick";
    }
    function opening(ev, landing){ sinceCrash++;
      if (landing === "crash"){ ev.push({ pos:0, piece:"crash", vel:0.74 }); sinceCrash = 0; }
      else if (landing === "hat") ev.push({ pos:0, piece:"hatOpen", vel:0.56 }); }
    // the same fill never comes out quite the same: now and then one note is left out, and the weight shifts a little
    function vary(hits){
      var h = hits.map(function (x){ return [x[0], x[1], Math.max(0.3, Math.min(0.8, x[2] + (rng() - 0.5) * 0.08))]; });
      if (h.length > 2 && rng() < 0.35) h.splice(Math.floor(rng() * (h.length - 1)), 1);
      if (h.length > 1 && rng() < 0.2 && h[h.length - 1][1] === "snare") h[h.length - 1][1] = rng() < 0.5 ? "tomLo" : "tomMid";
      return h;
    }

    function weighted(list, weightOf){
      var total = 0, i;
      for (i = 0; i < list.length; i++) total += weightOf(list[i]);
      var r = rng() * total;
      for (i = 0; i < list.length; i++){ r -= weightOf(list[i]); if (r < 0) return i; }
      return list.length - 1;
    }

    // Which size of fill (if any) this bar gets. Every chorus turns around with one;
    // the other 4-bar phrase endings get a small setup less than half the time.
    function fillSize(ctx, beats, askedOnly){
      if (beats < 2) return null;
      var size = null, plan = fillPlan(ctx), mode = (ctx.opts && ctx.opts.fills) || "auto", asked = !!plan.fill;
      if (askedOnly && !asked) return null;
      var nx = ctx.nextIndex != null ? ctx.nextIndex : ctx.index + 1;
      if (asked) size = plan.fill;                                                                // marked in the chart, on the page, or Fill now
      else if (mode === "none") return null;
      else if (ctx.last) size = "large";
      else if (lifted(ctx, nx) && !lifted(ctx)) size = "medium";                                  // into the chorus
      else if (ctx.sectionEnd !== false && (ctx.loopEnd != null ? ctx.loopEnd : ctx.index === ctx.length - 1)) size = rng() < 0.6 ? "medium" : "large";
      else if (plan.sectionEnd) size = "medium";                                                  // into a new section
      else if (mode === "sections") return null;
      else if (phraseBar(ctx) === 3){ var r = rng(), k = mode === "busy" ? 2.2 : 2 * energy(ctx); size = r < 0.30 * k ? "small" : r < 0.42 * k ? "medium" : null; }   // more set-ups as the band builds
      else if (mode === "busy" && phraseBar(ctx) === 1 && rng() < 0.3) size = "small";
      // a fill never takes the whole bar: at most one beat of a two-beat bar, two of a three-beat bar
      if (size && beats === 2) size = "small";
      if (size === "large" && beats === 3) size = "medium";
      return size ? { size: size, asked: asked } : null;
    }
    // One fill of that size from the lists that suit the groove, no longer than maxN beats (a smaller one when none fits).
    function pickFill(ctx, size, maxN){
      var gr = grooveOf(ctx);
      var set = gr && gr.fills === "rock" ? FILLS_ROCK : gr && gr.fills !== true ? FILLS_LIGHT : FILLS;      // (a groove with no fills of its own plays a light one when asked)
      var sizes = size === "large" ? ["large", "medium", "small"] : size === "medium" ? ["medium", "small"] : ["small"], playable = [];
      for (var q = 0; q < sizes.length && !playable.length; q++){
        playable = set[sizes[q]].filter(function (f){ return !(f.trip && ctx.tempo > 220) && (maxN == null || f.n <= maxN); });
        if (ctx.compound || tripletGroove(ctx)){ var tr = playable.filter(function (f){ return f.trip; }); if (tr.length) playable = tr; }   // the beat is already in three
        else if ((ctx.opts && ctx.opts.feel === "straight") || grooveOf(ctx)) playable = playable.filter(function (f){ return !f.trip; });
      }
      if (!playable.length) return null;
      var pool = playable.filter(function (f){ return f !== lastFill; });   // don't play the same fill twice running
      if (!pool.length) pool = playable;
      var f = pool[Math.floor(rng() * pool.length)];
      lastFill = f;
      return f;
    }
    function chooseFill(ctx, beats, askedOnly){
      var want = fillSize(ctx, beats, askedOnly); if (!want) return null;
      var f = pickFill(ctx, want.size, null); if (!f) return null;
      var gr = grooveOf(ctx), small = !want.asked && gr && gr.fills === "light" && !(ctx.loopEnd != null ? ctx.loopEnd : ctx.index === ctx.length - 1);
      return { size: small ? "small" : want.size, n: f.n, hits: vary(f.hits), asked: want.asked };
    }
    // A fill for a bar that is already sounding: only its last `room` beats can still be changed. Returns the beat the
    // fill starts on and its events (the caller drops what the drums had from there on), or null when nothing fits.
    function fillNow(ctx, size, room){
      var beats = ctx.beats || 4, g = ctx.opts && ctx.opts.groove;
      if (ctx.stop || g === "click" || g === "none" || beats < 2) return null;
      var maxN = Math.min(Math.floor(room + 1e-6), beats === 2 ? 1 : beats === 3 ? 2 : beats - 1);
      if (maxN < 1) return null;
      var f = pickFill(ctx, size || "medium", maxN); if (!f) return null;
      var from = beats - f.n, hits = vary(f.hits).map(function (h){ var e = { pos: from + h[0], piece: h[1], vel: h[2] }; if (!onEighthGrid(h[0])) e.straight = true; return e; });
      afterFill = land(ctx, f.n > 1 ? size || "medium" : "small");
      return { from: from, hits: hits };
    }

    // Compound meters: every eighth on the cymbal, kick on beats 1 and 3, backbeat on 2 and 4
    // (a three-beat bar gets a cross-stick on 2 and 3). The slow-blues / ballad 12/8.
    function compoundBar(ctx){
      var ev = [], beats = ctx.beats || 4, i, b = busy(ctx);
      var fill = chooseFill(ctx, beats), timeEnds = fill ? beats - fill.n : beats;
      var landing = afterFill; afterFill = null;
      var cym = (ctx.opts && ctx.opts.ride) || "ride", lift = lifted(ctx);
      if (lift && !lifted(ctx, ctx.index - 1)) landing = land(ctx, "large", true);
      if (lift && cym === "hat") cym = "ride";
      var beatPiece = cym === "hat" ? "hatClosed" : cym === "bell" ? "rideBell" : "ride";
      var offPiece = cym === "hat" ? "hatClosed" : "ride";
      var back = lift ? "snare" : b < 0.4 ? "rim" : "snare";                              // cross-stick while the band plays down
      opening(ev, landing);
      for (i = 0; i < timeEnds; i++){
        if (!(i === 0 && landing === "crash")) ev.push({ pos:i, piece:beatPiece, vel:0.66 });
        ev.push({ pos:i + T, piece:offPiece, vel:0.34, straight:true });
        ev.push({ pos:i + 2 * T, piece:offPiece, vel:0.44, straight:true });
        var isBack = beats === 3 ? i > 0 : i % 2 === 1;
        if (isBack) ev.push({ pos:i, piece: beats === 3 ? "rim" : back, vel: back === "snare" && beats !== 3 ? 0.60 : 0.52 });
        else ev.push({ pos:i, piece:"kick", vel: i === 0 ? (landing ? 0.60 : 0.54) : 0.48 });
      }
      if (cym !== "hat") for (i = 1; i < beats; i += 2) ev.push({ pos:i, piece:"hatFoot", vel:0.42 });
      // a kick pickup on the last eighth before a strong beat, more often as the band builds
      for (i = 1; i < timeEnds; i += 2) if (rng() < 0.12 + 0.3 * b) ev.push({ pos:i + 2 * T, piece:"kick", vel:0.40, straight:true });
      if (fill){
        fill.hits.forEach(function (h){
          var e = { pos: timeEnds + h[0], piece: h[1], vel: h[2] };
          if (!onEighthGrid(h[0])) e.straight = true;
          ev.push(e);
        });
        afterFill = land(ctx, fill.size);
      }
      ev.sort(function (a, c){ return a.pos - c.pos; });
      return ev;
    }

    // the groove this bar is played in, or null for the jazz time
    function grooveOf(ctx){
      var g = ctx.opts && GROOVES.hasOwnProperty(ctx.opts.groove) ? GROOVES[ctx.opts.groove] : null, beats = ctx.beats || 4;
      if (!g || ctx.compound || g.triplet) return null;
      return (beats === 4 || beats === 2 || (beats === 3 && g.three)) ? g : null;
    }
    function grooveBar(ctx, g){
      var ev = [], beats = ctx.beats || 4, cym = (ctx.opts && ctx.opts.ride) || "ride", lift = lifted(ctx);
      if (lift && cym === "hat") cym = "ride";                          // the chorus moves from the hi-hat to the ride
      var beatPiece = cym === "hat" ? "hatClosed" : cym === "bell" ? "rideBell" : "ride", offPiece = cym === "hat" ? "hatClosed" : "ride";
      var fill = chooseFill(ctx, beats, !g.fills), timeEnds = fill ? beats - fill.n : beats;       // (a groove without fills still plays one that is asked for)
      var landing = afterFill; afterFill = null;
      if (lift && !lifted(ctx, ctx.index - 1)) landing = land(ctx, "large", true);
      // a pushed chord: the kick plays it with the band on the last eighth, and leaves the next downbeat alone
      var H = global.BandHarmony, tied = pushedIn, push = !fill && !!(H && H.pushes && H.pushes(ctx)); pushedIn = push;
      if (push) ev.push({ pos:3.5, piece:"kick", vel:0.62 });
      opening(ev, landing);
      var pat = beats === 3 ? g.three : g.bars[ctx.index % g.bars.length];
      // boom-chick strength (opts.boom, 0..1; 0.5 = as written). Subtle: the hi-hat foot and a soft kick on 1.
      // Polka power: everything harder, the cymbal on every beat and a kick into the next bar.
      var bm = g === GROOVES.boomchick && ctx.opts && ctx.opts.boom != null ? Math.max(0, Math.min(1, +ctx.opts.boom)) : null;
      if (bm != null){
        pat = pat.filter(function (h){ return bm >= 0.3 || h[1] === "hatFoot" || (h[1] === "kick" && h[0] === 0); }).map(function (h){ return [h[0], h[1], Math.min(0.85, h[2] * (0.62 + 0.76 * bm))]; });
        if (bm >= 0.75){ for (var q = 0; q < beats; q++) pat.push([q, "cym", 0.50]); if (beats >= 4) pat.push([beats - 0.5, "kick", 0.44]); }
        if (bm < 0.3 && !(fill && fill.asked)) fill = null, timeEnds = beats;
      }
      pat.forEach(function (h){
        if (h[0] >= timeEnds - 1e-6) return;
        var piece = h[1] === "cym" ? beatPiece : h[1] === "cymOff" ? offPiece : h[1];
        if (piece === "hatFoot" && cym === "hat") return;                // the hat is being played with the stick
        if (h[0] === 0 && landing === "crash" && (h[1] === "cym" || h[1] === "cymOff")) return;
        if (piece === "back") piece = lift ? "snare" : "rim";
        if (piece === "kick" && ((tied && h[0] === 0) || (push && h[0] >= 3.5))) return;
        ev.push({ pos:h[0], piece:piece, vel: lift && (piece === "snare" || piece === "kick") ? Math.min(0.8, Math.round(h[2] * 1060) / 1000) : h[2] });
      });
      if (fill){
        fill.hits.forEach(function (h){ var e = { pos: timeEnds + h[0], piece: h[1], vel: h[2] }; if (!onEighthGrid(h[0])) e.straight = true; ev.push(e); });
        afterFill = land(ctx, fill.size);
      }
      ev.sort(function (a, b){ return a.pos - b.pos; });
      return ev;
    }

    function stopBar(){
      afterFill = "crash";
      return [ { pos:0, piece:"kick", vel:0.70 }, { pos:0, piece:"snare", vel:0.62 }, { pos:0, piece:"hatClosed", vel:0.55 },
               { pos:0.3, choke:"cymbals", straight:true } ];
    }

    // groove "click": a metronome. Sticks on every beat, the first one louder; no fills, no stops.
    function clickBar(ctx){
      var ev = [], beats = ctx.beats || 4;
      for (var i = 0; i < beats; i++) ev.push({ pos:i, piece:"sticks", vel: i === 0 ? 0.8 : 0.6 });
      return ev;
    }

    function bar(ctx){
      if (ctx.opts && ctx.opts.groove === "click") return clickBar(ctx);
      if (ctx.opts && ctx.opts.groove === "none") return [];                // no drummer
      if (ctx.stop) return stopBar();
      if (ctx.compound || tripletGroove(ctx)) return compoundBar(ctx);
      var gr = grooveOf(ctx); if (gr) return grooveBar(ctx, gr);
      var ev = [], beats = ctx.beats || 4, i, waltz = beats === 3;
      var two = !!(ctx.opts && ctx.opts.bassFeel === "two");
      var fill = chooseFill(ctx, beats), timeEnds = fill ? beats - fill.n : beats;
      var landing = afterFill; afterFill = null;
      var straight = !!(ctx.opts && ctx.opts.feel === "straight");
      // which cymbal keeps time: the ride, a closed hi-hat (then no hat foot), or the ride's bell on the beats
      var cym = (ctx.opts && ctx.opts.ride) || "ride";
      var beatPiece = cym === "hat" ? "hatClosed" : cym === "bell" ? "rideBell" : "ride";
      var offPiece = cym === "hat" ? "hatClosed" : "ride";

      // beat 1 after a fill: crash (or just a kick accent) instead of the plain ride note
      opening(ev, landing);
      if (landing) ev.push({ pos:0, piece:"kick", vel:0.60 });

      // ride: every beat, accenting 2 and 4, with the skip note after them
      var variants = ctx.tempo > 220 ? RIDE_FAST : RIDE;
      var skip = straight ? "none" : variants[weighted(variants, function (v){ return v.w; })].skip;
      var skipBeats = [];
      for (i = 1; i < beats; i += 2) skipBeats.push(i);
      if (skip === "last") skipBeats = skipBeats.slice(-1);
      else if (skip === "first") skipBeats = skipBeats.slice(0, 1);
      else if (skip === "none") skipBeats = [];
      for (i = 0; i < timeEnds; i++){
        if (!(i === 0 && landing === "crash")) ev.push({ pos:i, piece:beatPiece, vel: straight ? 0.62 : (i % 2 ? 0.72 : 0.62) });
        if (straight || skipBeats.indexOf(i) >= 0) ev.push({ pos:i + 0.5, piece:offPiece, vel:0.45 });
      }

      // hi-hat foot on 2 and 4, straight through fills (it is the time-keeper) — unless the hat is being played
      if (cym !== "hat") for (i = 1; i < beats; i += 2) ev.push({ pos:i, piece:"hatFoot", vel:0.52 });
      if (cym !== "hat" && waltz) ev.push({ pos:2, piece:"hatFoot", vel:0.42 });       // waltz: the foot on 2 and 3

      if (straight){
        // straight eighths: kick on 1 and 3 (sometimes pushed onto the "and" of 2), cross-stick on 2 and 4
        var pushK = rng() < 0.3;
        for (i = 0; i < timeEnds; i++){
          if (waltz ? i === 0 : i % 2 === 0){ if (!(i === 0 && landing)) ev.push({ pos:(i === 2 && pushK) ? 1.5 : i, piece:"kick", vel:0.50 }); }
          else ev.push({ pos:i, piece:"rim", vel:0.55 });
        }
      } else {
        // feathered kick: felt more than heard. Follows the bass in a two-feel.
        for (i = landing ? 1 : 0; i < timeEnds; i++){
          if ((two && i % 2) || (waltz && i > 0)) continue;              // a waltz leans on beat 1 only
          ev.push({ pos:i, piece:"kick", vel: waltz ? 0.26 : 0.20 });
        }
      }

      if (fill){
        fill.hits.forEach(function (h){
          var e = { pos: timeEnds + h[0], piece: h[1], vel: h[2] };
          if (!onEighthGrid(h[0])) e.straight = true;
          ev.push(e);
        });
        afterFill = land(ctx, fill.size);
      } else if (straight){
        // the groove above is the whole part
      } else if (two){
        // two-feel: cross-stick on the last beat most bars, no snare chatter
        if (rng() < 0.75) ev.push({ pos:beats - 1, piece:"rim", vel:0.50 });
      } else {
        var quiet = 2 * (1 - busy(ctx));                               // the empty bar gets likelier when the band is playing down
        var ci = weighted(COMPS, function (c){ return c[1].length ? c[0] : c[0] * quiet; });
        if (ci === lastComp && COMPS[ci][1].length) ci = weighted(COMPS, function (c){ return c[0]; });   // one re-roll against repeats
        lastComp = ci;
        COMPS[ci][1].forEach(function (h){ if (h[0] < beats) ev.push({ pos:h[0], piece:h[1], vel:h[2] }); });
      }

      ev.sort(function (a, b){ return a.pos - b.pos; });
      return ev;
    }

    function ending(ctx){
      afterFill = null; if (ctx && ctx.opts && ctx.opts.groove === "none") return [];
      return [ { pos:0, piece:"crash", vel:0.80 }, { pos:0, piece:"kick", vel:0.70 } ];
    }

    function reset(){ afterFill = null; lastComp = -1; lastFill = null; pushedIn = false; sinceCrash = 99; }

    return { bar: bar, ending: ending, reset: reset, fillNow: fillNow };
  }

  global.BandDrums = { create: create, GROOVES: GROOVES, fillPlan: fillPlan };
})(typeof window !== "undefined" ? window : globalThis);
