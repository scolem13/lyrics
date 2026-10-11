// player.js — transport, scheduler and mixer for the backing band (BandPlayer).
// Asks the parts (BandBass / BandComp / BandDrums) for one bar at a time, just before
// it is needed, swings + humanises their events and plays them through BandSounds on a
// small mix bus (part faders → room reverb → compressor → soft clip). It knows nothing about
// harmony or samples: chords are opaque objects from BandHarmony.buildForm and sounds
// are instrument/piece names.
//
//   var player = BandPlayer.create({
//     parsed,                      // TuneChart.parse output (or setChart later)
//     tempo: 120, transpose: 0,
//     countIn: 1,                  // bars of stick clicks: 0, 1 or 2 (2 = "1 . 2 . | 1 2 3 4")
//     choruses: 0,                 // 0 = loop until stopped; N = N choruses, the ending hit, then onEnd
//     intro: null,                 // { bars: 4, kind: "vamp" (the first chord) | "last" (the last bars of the form), tacet: "drums" }
//                                  // played once after the count-in when starting from the top; onBar gets intro:true,
//                                  // introBar / introBars, index -1. Stops and pins do not apply to it. player.setIntro(o)
//     opts: {},                    // handed to the parts untouched, as ctx.opts
//     volumes: { bass:1, comp:1, drums:1 },   // faders, 0..1.5 (1 = the default balance)
//     seed,                        // optional int → the same performance every time
//     onState(s),                  // "idle" | "loading" | "playing"
//     onLoadProgress(done, total),
//     onBar(info),                 // as the bar starts SOUNDING: { bar, index, chorus, src, beats, countIn }
//                                  //   (count-in bars: countIn true, index/src -1; the final hit adds ending:true)
//     onBeat(info),                // { beat, bar, countIn }
//     onEnd(),
//     humanize: 1,                 // 0 = dead on the grid (tests); onEvent(e) taps every scheduled note
//   });
//   player.load() / play() -> Promise     player.stop()     player.isPlaying() state() context()
//   player.setTempo(bpm) setTranspose(semis) setChart(parsed) setVolume(part, v)
//   player.setOpts(obj) setCountIn(n) setChoruses(n)
//   player.setInstruments([names]) // the sample sets to have loaded (the page asks for the ones its menus need)
//   player.setKitVolume(piece, v)  // fader for one kit piece, 0..1.5 (1 = as mixed); cfg.kit = { piece: v } to start with
// Sounds: opts.bassSound "electric" plays the bass part on "ebass"; opts.compSound (any sound of the comping instrument's family, BandSounds.family) e.g. "epiano" plays
// piano comping on "epiano"; opts.rideSound "ride2" swaps the ride cymbal. The parts never know.
// Stop time: opts.stops = [form bar index, ...]. On those bars ctx.stop is true (the band hits beat 1
// and only the bass leads back in) and the bar before gets ctx.nextStop, so nothing rings across.
//   player.setStartBar(i)          // form bar the next play() starts on (after the count-in)
//   player.setCycle(from, to)      // loop just those form bars (inclusive); setCycle(null) = whole form. Live.
//                                  // from > to loops OVER THE END of the form: setCycle(9, 1) plays bars 10..last, 1, 2.
//   player.setTempoSteps([8, -3])  // bpm added at each repeat, taken in turn; null = off. cfg.onTempo(bpm) reports
//                                  // each step; stopping returns to the tempo that was set.
// Sections: the chart's own (a P: line in the ABC puts `section` on a form bar). cfg.onSection({ index, name, bar, early })
// is called as each one starts to sound, or cfg.sectionLead beats before it does (early:true) so a page can turn first.
//   player.sections()              // [{ name, from, to }] in form bar indexes ([] when the chart names none)
//   player.setHold(on)             // hold: every section repeats until next() is called; then the drummer fills and the band moves on
//   player.next()                  // (the fill is the cue). Pressed during the section's last bar it still takes effect at the barline.
//   player.goSection(i)            // go to section i: at the end of this pass in hold mode, at the next barline otherwise
//   player.fill(size)              // Fill now: "small" | "medium" | "large" at the end of the bar now sounding, or of the next one
//                                  // when there is no room left in this one. Returns "now" | "next" | null (not playing).
// A melody: a page may put bar.melody = [{ pos, dur, midi }] (beats) on the bars of the parsed chart; it is played on the comping
// instrument unless opts.melody === false (opts.melodyLevel 0..1).
// A section's own style: a form bar may carry `style` (a BandCatalog style id or name; "^style bossa" or a %%style line under a
// P: line in the ABC). Those bars are played with that style's line, rhythm, groove, feel, voicings and sounds in place of the
// page's (styleOptsFor); everything else in opts still applies. opts.sectionOverrides ({ section index: options })
// comes before that: a section listed there is played with those options and its style from the chart is not consulted. Its sample sets are loaded with the rest.
// Fills and stops written in the chart ("^fill", "^stop") arrive on the form bars; see drums.js for opts.fills / opts.fillBars.
//   BandPlayer.renderOffline({ parsed, tempo, transpose, choruses, countIn, opts, volumes,
//                              seed, sampleRate, stems }) -> Promise<{ mix, stems? }>
//
// Bar context given to every part (once per bar, in order):
//   { bar, index, length, chorus, beats, chords, nextChords, tempo, last, opts, meter:{n, d}, compound }
// A beat is the meter's lower note (a quarter in 3/4 and 4/4) — except in compound meters
// (6/8, 9/8, 12/8: ctx.compound), where it is the dotted quarter, so 6/8 has 2 beats and 12/8
// has 4, and the tempo counts dotted quarters.
// Part events (pos/dur in beats, vel 0..1; an off-beat eighth is written x.5 and swung
// HERE — in a compound meter x.5 is the beat's THIRD eighth; straight:true events — triplets,
// a compound beat's second eighth at x.333 — are left where they are):
//   bass { pos, dur, midi, vel }   comp { pos, dur, midis, vel, inst? }   drums { pos, piece, vel, straight? }

(function (global) {
  var PARTS = ["bass", "comp", "comp2", "drums"];        // comp2 = a second chord player (opts.second; silent without it)
  var LOOKAHEAD = 0.15, LOOKAHEAD_HIDDEN = 1.6;   // seconds scheduled ahead (more when the tab is hidden: timers get throttled)
  var TICK_MS = 25, START_DELAY = 0.12, RING = 3.0, GEN_MARGIN = 0.1;
  var TRIM   = { bass: 1.0, comp: 1.0, comp2: 1.0, drums: 1.0 };        // default balance at fader = 1 (tuned by measurement)
  var SEND   = { bass: 0.02, comp: 0.16, comp2: 0.16, drums: 0.11 };     // room-reverb send per part
  var JITTER = { bass: 0.003, comp: 0.004, comp2: 0.004, drums: 0.002 };  // random timing looseness, seconds
  var LAY    = { bass: -0.006, comp: 0.008, comp2: 0.010, drums: 0 };     // where each player sits: bass a touch ahead of the ride, comping behind it

  // The conductor: how hard the band is playing this bar (0..1, 0.5 = the plain pattern). It
  // builds over four choruses, lifts through the last four bars of each one, and peaks on a
  // final chorus. opts.variation (0..1) is how far it may move from 0.5: 0 = strict.
  var ARC = [0.30, 0.50, 0.65, 0.80];
  function intensityFor(index, length, chorus, choruses, variation){
    var v = clamp(variation == null ? 0.6 : +variation || 0, 0, 1);
    var arc = ARC[chorus % ARC.length];
    if (choruses > 1 && chorus >= choruses - 1) arc = 0.85;
    var tail = length - index;                                   // bars left in the form, 1 = the last
    if (length >= 8 && tail <= 4) arc += 0.10 * (5 - tail) / 4;
    return clamp(0.5 + v * (arc - 0.5), 0, 1);
  }
  var STRUM = 0.010, VEL_JITTER = 0.06, WET = 0.55, MASTER = 1.0;
  var SEED = { bass: 101, comp: 211, comp2: 257, drums: 307, human: 401 };

  // the options a bar of another style is played with (BandCatalog.sectionOpts): the page's, with that style's own on top
  function styleOptsFor(name, base){ var C = global.BandCatalog; return C && C.sectionOpts ? C.sectionOpts(name, base) : null; }
  function styleSounds(form, base){ var out = [], seen = {};
    (form || []).forEach(function (b){ if (!b.style || seen[b.style]) return; seen[b.style] = 1;
      var s = styleOptsFor(b.style, base); if (s) s.instruments.forEach(function (n){ if (out.indexOf(n) < 0) out.push(n); }); });
    return out; }
  // the sample set the second chord player needs, if there is one
  function secondSound(opts){ var s = opts && opts.second; return s && s.comp ? (s.compSound || s.comp) : null; }
  function isStop(opts, idx, form){ var s = opts && opts.stops; return !!((form && form[idx] && form[idx].stop) || (s && s.indexOf && s.indexOf(idx) >= 0)); }
  // the chart's sections: a new one starts on every form bar that carries a name; none named = no sections
  function sectionsOf(form){
    var out = [], any = false;
    (form || []).forEach(function (b, i){ if (b.section != null) any = true;
      if (b.section != null || !out.length) out.push({ name: b.section || "", from: i, to: i }); else out[out.length - 1].to = i; });
    return any ? out : [];
  }
  // How hard each section of a song is played (the conductor's arc, 0..1; see intensityFor). A song is one pass of a long form, so
  // the build comes from its sections instead of from the chorus count: every time a kind of section comes round again (Verse 1,
  // Verse 2; Chorus, Chorus) it is played a step harder, a chorus sits above a verse, an intro starts low and an outro stays up.
  var STEPS = [0.40, 0.55, 0.68, 0.80];
  function sectionArcs(secs){
    var seen = {}, top = 0;
    return secs.map(function (sc){
      var base = String(sc.name || "").replace(/\s+\d+$/, "").trim().toLowerCase();
      if (/^(intro|introduction)/.test(base)) return 0.32;
      if (/^(interlude|solo|instrumental|break)/.test(base)) return 0.50;
      if (/^(outro|coda|ending|tag)/.test(base)) return 0.76;
      seen[base] = (seen[base] || 0) + 1;
      var a = STEPS[Math.min(seen[base], STEPS.length) - 1];
      if (/^(chorus|refrain)/.test(base)) a = Math.max(a + 0.08, top + 0.07); else top = Math.max(top, a);      // a chorus tops the verses before it
      return Math.min(0.9, a);
    });
  }
  function sectionAt(secs, i){ for (var k = 0; k < secs.length; k++) if (i >= secs[k].from && i <= secs[k].to) return k; return -1; }
  var TEMPO_MIN = 40, TEMPO_MAX = 300;                      // limits for the tempo-step practice mode
  function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
  function mulberry32(a){ return function (){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // Swing: where in the beat the off-beat eighth lands. Triplet feel at medium tempos,
  // straightening as it gets fast (0.667 at 120, 0.61 at 200, 0.55 at 300).
  function swingFor(bpm){ return 0.68 - 0.08 * clamp((bpm - 100) / 120, 0, 1) - 0.05 * clamp((bpm - 220) / 80, 0, 1); }
  function warp(pos, s){ var b = Math.floor(pos), f = pos - b; return b + (f <= 0.5 ? f * (s / 0.5) : s + (f - 0.5) * ((1 - s) / 0.5)); }

  // ---- form: chart → bars the parts can read (BandHarmony's job; plain fallback keeps the drums alive) ----
  function plainForm(parsed){
    var order = parsed.playOrder && parsed.playOrder.length ? parsed.playOrder : parsed.bars.map(function (_, i){ return i; });
    var upb = parsed.unitsPerBeat || 1, out = [];
    order.forEach(function (i){ var b = parsed.bars[i]; if (!b || b.anacrusis) return;
      out.push({ src: i, beats: (b.meter && b.meter.n) || parsed.beatsPerBar || 4, meter: b.meter || { n: parsed.beatsPerBar || 4, d: 4 }, compound: false,
                 chords: b.chords.filter(function (c){ return !c.nc; }).map(function (c){ return { pos: c.onset / upb, chord: { sym: c.sym } }; }) }); });
    return out;
  }
  function buildForm(parsed, transpose){
    if (!parsed || !parsed.bars) return [];
    var H = global.BandHarmony, form = (H && H.buildForm) ? H.buildForm(parsed, transpose || 0) : plainForm(parsed);
    return (form || []).filter(function (b){ return b && b.beats > 0; });
  }

  // ---- mix bus: part faders → master → compressor → out, with a short room on a send ----
  function roomIR(ctx){
    var sr = ctx.sampleRate, len = Math.floor(0.9 * sr), buf = ctx.createBuffer(2, len, sr), rnd = mulberry32(90210);
    for (var ch = 0; ch < 2; ch++){ var d = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    return buf;
  }
  // safety net after the compressor: exactly linear below about -1.5 dBFS, rounds off
  // anything hotter (all faders pushed up) instead of letting the output clip hard
  function softClip(ctx){
    var n = 2049, curve = new Float32Array(n), k = 0.84, top = 0.985 - k;
    for (var i = 0; i < n; i++){ var x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      curve[i] = (a <= k ? a : k + top * Math.tanh((a - k) / top)) * (x < 0 ? -1 : 1); }
    var ws = ctx.createWaveShaper(); ws.curve = curve; return ws;
  }
  function faderGain(part, v){ v = clamp(v == null ? 1 : v, 0, 1.5); return TRIM[part] * v * v; }   // square taper
  function makeBus(ctx, volumes){
    var master = ctx.createGain(), comp = ctx.createDynamicsCompressor(), out = ctx.createGain();
    master.gain.value = 1; out.gain.value = MASTER;
    comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.16;
    var clip = softClip(ctx);
    master.connect(comp); comp.connect(out); out.connect(clip); clip.connect(ctx.destination);
    var verb = ctx.createConvolver(), hp = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter(), wet = ctx.createGain();
    verb.buffer = roomIR(ctx); hp.type = "highpass"; hp.frequency.value = 250; lp.type = "lowpass"; lp.frequency.value = 5500;
    wet.gain.value = WET; verb.connect(hp); hp.connect(lp); lp.connect(wet); wet.connect(master);
    var ins = {};
    PARTS.forEach(function (p){
      var g = ctx.createGain(), s = ctx.createGain();
      g.gain.value = faderGain(p, volumes[p]); s.gain.value = SEND[p];
      g.connect(master); g.connect(s); s.connect(verb); ins[p] = g;
    });
    return {
      ins: ins,
      setVolume: function (p, v){ if (ins[p]) ins[p].gain.setTargetAtTime(faderGain(p, v), ctx.currentTime, 0.02); },
      fadeOut: function (sec){ var t = ctx.currentTime; out.gain.cancelScheduledValues(t); out.gain.setValueAtTime(out.gain.value, t); out.gain.linearRampToValueAtTime(0, t + sec); },
      dispose: function (){ try { clip.disconnect(); } catch (e) {} }
    };
  }

  // ---- one performance: bar generation + event scheduling on a context clock ----
  // Position is tracked in LINEAR BEATS since the count-in started; an anchor (beat ↔
  // context time) turns beats into seconds, and moving the anchor is how tempo changes.
  function Session(ctx, bank, bus, c, seed, tap){
    this.ctx = ctx; this.bank = bank; this.bus = bus; this.c = c; this.tap = tap || null;
    this.tempo = c.tempo; this.spb = 60 / c.tempo; this.anchorL = 0; this.anchorT = 0;
    this.form = buildForm(c.parsed, c.transpose); this.sections = sectionsOf(this.form); this.arcs = sectionArcs(this.sections);
    this.advance = null; this.held = null; this.fillAsk = null; this.jump = null; this.lastInfo = null;   // hold mode and Fill now (see generate)
    this.organ = {};                                              // the organist's memory, for each chord part played on an organ
    this.human = mulberry32(seed + SEED.human);
    this.human2 = mulberry32(seed + SEED.human + 17);             // the second chord player's own, so the others are humanized the same with or without it
    this.parts = {};
    var self = this, G = { bass: global.BandBass, comp: global.BandComp, drums: global.BandDrums };
    if (global.BandComp && global.BandComp.createSecond) G.comp2 = { create: global.BandComp.createSecond };
    var H = global.BandHarmony, wrap = (H && H.feelPart) || function (x){ return x; };                 // half time / double time (opts.timeFeel)
    PARTS.forEach(function (p){ if (G[p] && G[p].create) self.parts[p] = wrap(G[p].create({ rng: mulberry32(seed + SEED[p]) }), p === "comp2" ? "comp" : p); });
    this.nextL = 0; this.barNo = 0; this.chorus = 0; this.pass = 0; this.prev = null;
    var r0 = this.range(), sb = c.startBar | 0;
    this.formIdx = (sb < this.form.length && r0.has(sb)) ? sb : r0.from;   // first pass may start part-way in
    this.countIn = this.countInLeft = clamp(c.countIn | 0, 0, 2);
    this.intro = this.formIdx === 0 ? introBars(this.form, c.intro) : []; this.introAt = 0;      // only from the top of the form
    this.pending = []; this.timeline = []; this.wantEnding = false; this.done = false; this.endL = null;
    this.gen = []; this.firedL = 0;                          // form bars generated so far (for rewind), and how far events have been handed to the bank
  }
  // Writing ahead (c.ahead): how many beats beyond the scheduling horizon are generated early, so the page can
  // show the music before it is played: one pass of the form (or loop) plus a bar. Not while the tempo steps at
  // each repeat (a second pending tempo change would have nowhere to live).
  // Following the player (c.follow = 0..1, how loud the page hears the user): mostly that, a little of the conductor's arc.
  Session.prototype.level = function (arc){ var f = this.c.follow; return f == null ? arc : clamp(0.3 * arc + 0.7 * f, 0, 1); };
  Session.prototype.aheadBeats = function (){
    var c = this.c; if (!c.ahead || c.follow != null || (c.tempoSteps && c.tempoSteps.length)) return 0;      // (music written ahead could not follow anyone)
    var r = this.range(), n = 0, form = this.form; for (var i = 0; i < form.length; i++) if (r.has(i)) n += form[i].beats;
    return n + (form[r.from] ? form[r.from].beats : 4);
  };
  // Something changed (options, choruses, loop, chart) while bars had been written ahead: throw away every bar
  // that has not started to be scheduled and go back to generate it again. Returns its bar number, or null.
  // The parts keep their state (they have "played" the discarded bars), which only costs a little continuity.
  Session.prototype.rewind = function (){
    var k = -1; for (var i = 0; i < this.gen.length; i++) if (this.gen[i].L0 > this.firedL + 1e-6){ k = i; break; }
    if (k < 0) return null;
    var g = this.gen[k], L0 = g.L0; this.gen.length = k;
    this.nextL = L0; this.formIdx = g.formIdx; this.barNo = g.barNo; this.chorus = g.chorus; this.wantEnding = false; this.done = false; this.endL = null;
    this.advance = g.adv; this.held = g.held; this.fillAsk = g.ask; this.jump = null;
    this.pending = this.pending.filter(function (p){ return p.L0 < L0 - 1e-6; });
    this.timeline = this.timeline.filter(function (e){ return e.L < L0 - 1e-6; });
    return g.barNo;
  };
  // The bars of an intro: a vamp on the form's first chord, or the last bars of the form.
  function introBars(form, o){
    var n = o ? clamp(o.bars | 0, 0, 16) : 0, out = [], k;
    if (!n || !form.length) return out;
    if (o.kind === "last"){ for (k = n; k >= 1; k--) out.push(form[((form.length - k) % form.length + form.length) % form.length]); return out; }
    var fb = form[0], first = null;
    for (k = 0; k < fb.chords.length && !first; k++) if (fb.chords[k].chord && !fb.chords[k].chord.nc) first = fb.chords[k].chord;
    for (k = 0; k < n; k++) out.push({ src: -1, beats: fb.beats, chords: first ? [{ pos: 0, chord: first }] : [], meter: fb.meter, compound: fb.compound });
    return out;
  }
  Session.prototype.start = function (t0){ this.anchorT = t0; this.anchorL = 0; };
  // `prev` is the anchor before a scheduled tempo step, so bars already generated at the
  // old tempo keep their times while the new tempo starts exactly on the barline.
  Session.prototype.timeOf = function (L){ var p = this.prev;
    return (p && L < this.anchorL) ? p.T + (L - p.L) * p.spb : this.anchorT + (L - this.anchorL) * this.spb; };
  Session.prototype.linAt = function (t){ var p = this.prev;
    return (p && t < this.anchorT) ? p.L + (t - p.T) / p.spb : this.anchorL + (t - this.anchorT) / this.spb; };
  Session.prototype.setTempo = function (bpm){
    var now = this.ctx.currentTime, L = this.linAt(now); this.prev = null;
    this.anchorL = L; this.anchorT = now; this.tempo = bpm; this.spb = 60 / bpm;
  };
  // The bars being looped: the whole form, or the cycle the page set (clamped to the form).
  Session.prototype.range = function (){
    var n = this.form.length, cy = this.c.cycle;
    if (!cy) return { from: 0, to: n - 1, len: n, has: function (){ return true; }, pos: function (i){ return i; } };
    var a = clamp(cy.from | 0, 0, n - 1), b = clamp(cy.to | 0, 0, n - 1), wrap = a > b;      // from after to: the loop runs over the end
    return { from: a, to: b, len: wrap ? n - a + b + 1 : b - a + 1,
             has: function (i){ return wrap ? (i >= a || i <= b) : (i >= a && i <= b); },
             pos: function (i){ return (i - a + n) % n; } };                               // how far into the loop bar i is
  };
  // Tempo-change practice: at each repeat add the next step (e.g. [8] or [8, -3] alternating),
  // taking effect on the barline at linear beat L.
  Session.prototype.stepTempo = function (L){
    var steps = this.c.tempoSteps; if (!steps || !steps.length) return;
    var bpm = clamp(Math.round(this.tempo + (+steps[this.pass % steps.length] || 0)), TEMPO_MIN, TEMPO_MAX); this.pass++;
    if (bpm === this.tempo) return;
    var T = this.timeOf(L);
    this.prev = { L: this.anchorL, T: this.anchorT, spb: this.spb };
    this.anchorL = L; this.anchorT = T; this.tempo = bpm; this.spb = 60 / bpm; this.c.tempo = bpm;
    var self = this, wait = Math.max(0, (T - this.ctx.currentTime) * 1000);        // report it when it is heard, not when it is planned
    if (this.onTempo) setTimeout(function (){ if (self.onTempo && self.tempo === bpm) self.onTempo(bpm); }, wait);
  };
  Session.prototype.refreshForm = function (){
    var f; try { f = buildForm(this.c.parsed, this.c.transpose); } catch (e){ if (global.console) console.error(e); return; }
    if (!f.length) return;
    this.form = f; this.formIdx = this.formIdx % f.length; this.sections = sectionsOf(f); this.arcs = sectionArcs(this.sections); this.held = null;
  };
  Session.prototype.collect = function (part, evs, L0, beats, compound, unit){
    if (!evs) return;
    for (var i = 0; i < evs.length; i++){ var ev = evs[i];
      if (!ev || !(ev.pos >= 0) || ev.pos >= beats + 1e-6) continue;       // also drops NaN
      this.pending.push({ part: part, ev: ev, L0: L0, compound: !!compound, unit: unit || 1, o: this.nowOpts || null }); }
  };
  // the options of this bar: the page's, or its section's own style on top of them
  // A page's own settings for a section come first (opts.sectionOverrides: { section index: options }, laid over the
  // page's): they replace the section's style from the chart.
  Session.prototype.barOpts = function (fb, idx){
    var c = this.c, k = c.optsRev | 0, ov = c.opts && c.opts.sectionOverrides, si = ov && idx != null ? sectionAt(this.sections, idx) : -1;
    if (!this.styleCache || this.styleCache.rev !== k) this.styleCache = { rev: k, map: {} };
    var m = this.styleCache.map;
    if (si >= 0 && ov[si]){ var key = "\u0000section " + si; if (!(key in m)) m[key] = Object.assign({}, c.opts, ov[si], { sectionOverrides: null, sectionStyle: "menus" }); return m[key]; }
    if (!fb || !fb.style) return c.opts; if (!(fb.style in m)){ var s = styleOptsFor(fb.style, c.opts); m[fb.style] = s ? s.opts : c.opts; }
    return m[fb.style];
  };
  Session.prototype.callParts = function (method, bctx, L0){
    var self = this; this.nowOpts = bctx.opts && bctx.opts !== this.c.opts ? bctx.opts : null;
    var rec = { bar: bctx.bar, index: bctx.index, chorus: bctx.chorus, length: bctx.length, beats: bctx.beats, tempo: bctx.tempo,
                meter: bctx.meter, compound: !!bctx.compound,
                ending: method === "ending", chords: bctx.chords, opts: Object.assign({}, bctx.opts), parts: {} };
    var tacet = bctx.tacet ? String(bctx.tacet).split(" ") : [];
    PARTS.forEach(function (p){ var part = self.parts[p]; if (!part || typeof part[method] !== "function" || tacet.indexOf(p) >= 0) return;
      // the drummer listens: how busy and how loud the bass and the chords are in this bar, half and half with the conductor's intensity
      if (p === "drums" && method === "bar"){ var n = 0, vs = 0; ["bass", "comp"].forEach(function (q){ (rec.parts[q] || []).forEach(function (e){ if (e.hand === "L") return; n++; vs += e.vel || 0.6; }); });
        if (n){ var dens = clamp(n / (2 * (bctx.beats || 4)) * 1.3, 0, 1), loud = clamp((vs / n - 0.5) / 0.3, 0, 1); bctx.energy = clamp(0.5 * (bctx.intensity == null ? 0.5 : bctx.intensity) + 0.25 * dens + 0.25 * loud, 0, 1); } }
      try { var evs = part[method](bctx) || [], dyn = 0.86 + 0.28 * (bctx.intensity == null ? 0.5 : bctx.intensity);
        evs.forEach(function (e){ if (e && e.vel != null) e.vel = Math.round(clamp(e.vel * dyn, 0.03, 1) * 1000) / 1000; });   // louder as the band builds
        rec.parts[p] = evs; self.collect(p, evs, L0, bctx.beats, bctx.compound, bctx.unit); }
      catch (e){ if (global.console) console.error("BandPlayer: " + p + "." + method + " failed", e); } });
    // An instrument with a pedal and a switch (the tonewheel organ): where the swell sits and when the rotary speaker changes
    // speed in this bar (BandComp.organist). Kept beside the notes as rec.parts.ctl and scheduled like them.
    var S = global.BandSounds, C = global.BandComp;
    if (S && S.getControl && C && C.organist) ["comp", "comp2"].forEach(function (p){
      var o = bctx.opts || {}, snd = p === "comp" ? (o.compSound || o.comp) : (o.second && (o.second.compSound || o.second.comp));
      if (!snd || !S.getTonebars(snd) || !rec.parts[p] || tacet.indexOf(p) >= 0) return;
      var mine = self.organ[p] || (self.organ[p] = {}), cx = p === "comp2" ? Object.assign({}, bctx, { opts: Object.assign({}, o, { organ: (o.second && o.second.organ) || o.organ }) }) : bctx;
      try { var cs = C.organist(cx, method, mine).map(function (e){ e.sound = snd; e.straight = true; return e; });
        rec.parts.ctl = (rec.parts.ctl || []).concat(cs); self.collect("ctl", cs, L0, bctx.beats, bctx.compound, bctx.unit); }
      catch (e){ if (global.console) console.error("BandPlayer: organist failed", e); } });
    if (this.barTap && !bctx.intro) this.barTap(rec);        // (the intro is not part of the log of choruses)                       // onBarEvents: the bar exactly as generated (notation / MIDI export)
    return rec;
  };
  // Generate the next bar (count-in, a bar of the form, or the ending) into `pending`.
  Session.prototype.generate = function (){
    var c = this.c, form = this.form, L0 = this.nextL, beats, b;
    if (this.countInLeft > 0){
      beats = form[0].beats;
      var sparse = this.countIn === 2 && this.countInLeft === 2, evs = [];        // "1 . 2 ." then "1 2 3 4"
      var cmp = !!form[0].compound, thin = sparse && beats >= 4;                  // short bars are counted in full both times
      for (b = 0; b < beats; b++) if (!thin || b % 2 === 0){
        evs.push({ pos: b, piece: "sticks", vel: b === 0 ? 0.8 : 0.66 });
        if (cmp && !sparse){ evs.push({ pos: b + 1 / 3, piece: "sticks", vel: 0.3, straight: true }); evs.push({ pos: b + 2 / 3, piece: "sticks", vel: 0.3, straight: true }); }   // the three eighths of each beat
      }
      this.collect("drums", evs, L0, beats, cmp);
      this.timeline.push({ L: L0, beats: beats, info: { bar: -this.countInLeft, index: -1, chorus: 0, src: -1, beats: beats, countIn: true } });
      this.countInLeft--; this.nextL += beats; return;
    }
    if (this.introAt < this.intro.length){                   // the intro: once, between the count-in and the top
      var ib = this.intro, ik = this.introAt, ibar = ib[ik], inext = ik + 1 < ib.length ? ib[ik + 1] : form[this.formIdx];
      beats = ibar.beats;
      this.callParts("bar", { bar: ik - ib.length, index: ik, length: ib.length, chorus: 0, beats: beats, chords: ibar.chords, nextChords: inext.chords,
        tempo: this.tempo, last: false, loopEnd: false, opts: Object.assign({}, c.opts, { pins: null, stops: null }), form: ib, nextIndex: ik + 1,
        fill: this.takeFill(), sectionEnd: ik + 1 === ib.length && form[this.formIdx].section != null ? true : undefined,      // a fill into a named first section
        meter: ibar.meter, compound: !!ibar.compound, stop: false, nextStop: ik + 1 === ib.length && isStop(c.opts, this.formIdx, form),
        intensity: intensityFor(0, form.length, 0, c.choruses, c.opts && c.opts.variation), intro: true, tacet: c.intro && c.intro.tacet,
        phrase: { bar: ik % 4, turnaround: ib.length - 1 - ik < 2, top: ik === 0 } }, L0);
      this.timeline.push({ L: L0, beats: beats, info: { bar: ik - ib.length, index: -1, chorus: 0, src: ibar.src, beats: beats, countIn: false, intro: true, introBar: ik, introBars: ib.length } });
      this.introAt++; this.nextL += beats; return;
    }
    if (this.wantEnding){                                    // the final hit: every part lands on the top chord
      var top = form[this.range().from], first = top.chords.length ? [{ pos: 0, chord: top.chords[0].chord }] : [];
      beats = top.beats;
      this.callParts("ending", { bar: this.barNo, index: 0, length: form.length, chorus: this.chorus, beats: beats, chords: first,
        nextChords: first, tempo: this.tempo, last: true, ending: true, opts: c.opts, meter: top.meter, compound: !!top.compound }, L0);
      this.timeline.push({ L: L0, beats: beats, ending: true,
        info: { bar: this.barNo, index: 0, chorus: this.chorus, src: top.src, beats: beats, countIn: false, ending: true } });
      this.endL = L0; this.nextL += beats; this.done = true; return;
    }
    var r = this.range(), secs = this.sections, pre = { formIdx: this.formIdx, chorus: this.chorus, adv: this.advance, held: this.held, ask: this.fillAsk };
    // Hold mode: the bar before this one ended a section that was going to repeat. If next() has been pressed since, move on after all.
    if (this.held){
      var hd = this.held; this.held = null;
      if (this.advance != null){
        var js = this.advance >= 0 ? secs[this.advance] : null; this.advance = null;
        this.formIdx = js ? js.from : hd.nextIdx;
        if (this.lastInfo) this.lastInfo.nextSection = sectionAt(secs, this.formIdx);
        if (!js && hd.atEnd){ this.chorus++; if (hd.last){ this.wantEnding = true; return this.generate(); } }
      }
    }
    if (this.jump != null){ if (this.jump < form.length) this.formIdx = this.jump; this.jump = null; }     // goSection outside hold mode
    if (this.formIdx >= form.length || !r.has(this.formIdx)) this.formIdx = r.from;   // the cycle moved under us
    var fb = form[this.formIdx], atEnd = this.formIdx === r.to, nextIdx = atEnd ? r.from : (this.formIdx + 1) % form.length;
    var cp = r.pos(this.formIdx);
    var gi = { L0: L0, formIdx: pre.formIdx, barNo: this.barNo, chorus: pre.chorus, adv: pre.adv, held: pre.held, ask: pre.ask };
    this.gen.push(gi); if (this.gen.length > 600) this.gen.splice(0, this.gen.length - 600);
    var last = c.choruses > 0 && this.chorus >= c.choruses - 1 && atEnd;
    // Hold mode: at the end of a section go round again unless told to move on. sectionEnd tells the drummer which (unset: the chart decides).
    var si = sectionAt(secs, this.formIdx), sec = si >= 0 ? secs[si] : null, sectionEnd;
    if (c.hold && sec && this.formIdx === sec.to){
      if (this.advance == null){ this.held = { nextIdx: nextIdx, atEnd: atEnd, last: last }; nextIdx = sec.from; atEnd = false; last = false; sectionEnd = false; }
      else { var to = this.advance >= 0 ? secs[this.advance] : null; this.advance = null; sectionEnd = true;
        if (to){ nextIdx = to.from; atEnd = false; last = false; } }
    }
    beats = fb.beats; var u = fb.unit || 1;                  // (u: this bar's beat against the tempo's beat, after a change of meter)
    var bctx = { bar: this.barNo, index: this.formIdx, length: form.length, chorus: this.chorus, beats: beats,
      chords: fb.chords, nextChords: form[nextIdx].chords, tempo: this.tempo / u, unit: u, last: last, loopEnd: atEnd, opts: this.barOpts(fb, this.formIdx), form: form, nextIndex: nextIdx,
      meter: fb.meter, compound: !!fb.compound, stop: isStop(c.opts, this.formIdx, form), nextStop: !last && isStop(c.opts, nextIdx, form),
      fill: this.takeFill(), sectionEnd: sectionEnd,
      intensity: this.level(sec && c.opts.build !== false ? this.sectionLevel(si, this.formIdx, nextIdx) : intensityFor(cp, r.len, this.chorus, c.choruses, c.opts && c.opts.variation)),
      phrase: { bar: cp % 4, turnaround: r.len - 1 - cp < 2, top: this.formIdx === r.from } };
    bctx.finalChorus = c.choruses > 0 && this.chorus >= c.choruses - 1;
    gi.ctx = bctx; gi.beats = beats; gi.unit = u; gi.compound = !!fb.compound;
    gi.rec = this.callParts("bar", bctx, L0);
    // The tune, where the chart's bar has one written out (fb.melody): on the comping instrument, through the comping fader.
    // opts.melody = false leaves it out; opts.melodyLevel (0..1, default 0.8) is how hard it is played.
    if (fb.melody && c.opts.melody !== false){
      var lead = c.opts.comp === "guitar" ? "guitar" : "piano", mv = c.opts.melodyLevel == null ? 0.8 : +c.opts.melodyLevel;
      var mel = fb.melody.map(function (n){ var e = { pos: n.pos, dur: Math.max(0.1, n.dur * 0.95), midis: [n.midi], vel: mv, inst: lead, melody: true };
        if (Math.abs(n.pos * 2 - Math.round(n.pos * 2)) > 1e-3) e.straight = true; return e; });
      this.collect("comp", mel, L0, beats, fb.compound, u);
      if (gi.rec && gi.rec.parts) gi.rec.parts.melody = mel;
    }
    var info = { bar: this.barNo, index: this.formIdx, chorus: this.chorus, src: fb.src, beats: beats, countIn: false, intensity: bctx.intensity };
    if (sec){ info.section = si; info.sectionName = sec.name; info.sectionBar = this.formIdx - sec.from; info.sectionLast = this.formIdx === sec.to; info.nextSection = last ? -1 : sectionAt(secs, nextIdx); }
    this.timeline.push({ L: L0, beats: beats, unit: u, info: info }); this.lastInfo = info;
    this.nextL += beats * u; this.barNo++; this.formIdx = nextIdx;
    if (atEnd){ this.chorus++; if (!last) this.stepTempo(this.nextL); }
    if (last) this.wantEnding = true;
    var keepT = this.c.ahead ? 600 : 8;                      // (bars written ahead are still to come: keep them findable)
    if (this.timeline.length > keepT) this.timeline.splice(0, this.timeline.length - keepT);
  };
  // The conductor's level for a bar of a song with sections: its section's arc, leaning into a bigger section over its last two bars,
  // and a step up for each later pass of the whole form. opts.variation scales it as it does the chorus arc; opts.build = false turns it off.
  Session.prototype.sectionLevel = function (si, idx, nextIdx){
    var secs = this.sections, arc = this.arcs[si], sc = secs[si], v = this.c.opts && this.c.opts.variation;
    var ni = sectionAt(secs, nextIdx), up = ni >= 0 && ni !== si ? this.arcs[ni] - arc : 0;
    if (up > 0 && sc.to - idx < 2) arc += up * (sc.to - idx === 0 ? 0.6 : 0.3);
    arc += 0.06 * Math.min(this.chorus, 3);
    v = clamp(v == null ? 0.6 : +v || 0, 0, 1);
    return clamp(0.5 + v * (arc - 0.5), 0, 1);
  };
  Session.prototype.takeFill = function (){ var f = this.fillAsk; this.fillAsk = null; return f || undefined; };
  // Fill now. If the bar that is sounding still has whole beats that have not gone to the sample bank, the drummer rewrites
  // them ("now"); otherwise the next bar to be written gets the fill ("next").
  // heldOnly: only if that bar is the end of a section that was going to repeat (next() pressed late: the fill is the cue), and never queued.
  Session.prototype.fillNow = function (size, heldOnly){
    var L = this.linAt(this.ctx.currentTime), g = null, d = this.parts.drums;
    for (var i = this.gen.length - 1; i >= 0; i--) if (this.gen[i].L0 <= L + 1e-6){ g = this.gen[i]; break; }
    if (heldOnly && !(g && g.ctx && g.ctx.sectionEnd === false && (this.c.opts || {}).fills !== "none")) return null;
    if (g && g.ctx && d && d.fillNow && L < g.L0 + g.beats * g.unit){
      var room = Math.floor((g.L0 + g.beats * g.unit - Math.max(this.firedL, L) - 0.02) / g.unit + 1e-6), f = null;
      try { f = room >= 1 ? d.fillNow(g.ctx, size, room) : null; } catch (e){ f = null; }
      if (f && f.hits && f.hits.length){
        var cut = f.from - 1e-6, L0 = g.L0, dyn = 0.86 + 0.28 * (g.ctx.intensity == null ? 0.5 : g.ctx.intensity);
        var gone = function (e){ return e.pos >= cut && e.piece !== "hatFoot"; };
        this.pending = this.pending.filter(function (p){ return !(p.part === "drums" && Math.abs(p.L0 - L0) < 1e-6 && gone(p.ev)); });
        f.hits.forEach(function (e){ e.vel = Math.round(clamp(e.vel * dyn, 0.03, 1) * 1000) / 1000; });
        this.collect("drums", f.hits, L0, g.beats, g.compound, g.unit);
        if (g.rec && g.rec.parts){ var kept = (g.rec.parts.drums || []).filter(function (e){ return !gone(e); });       // the bar as played, for the export
          g.rec.parts.drums = kept.concat(f.hits).sort(function (a, b){ return a.pos - b.pos; }); }
        return "now";
      }
    }
    if (heldOnly) return null;
    this.fillAsk = size; return "next";
  };
  // Hand one event to the sample bank: swing is already in L; add the human touches here.
  Session.prototype.fire = function (p, L){
    if (p.part === "ctl"){ if (this.bank.control) this.bank.control(p.ev.sound, p.ev.ctl, p.ev.value, this.timeOf(L), (p.ev.glide || 0) * this.spb * (p.unit || 1)); return; }
    var ev = p.ev, h = p.part === "comp2" ? this.human2 : this.human, hz = this.c.humanize == null ? 1 : this.c.humanize, dest = this.bus.ins[p.part];
    var t = this.timeOf(L) + (LAY[p.part] + (h() + h() - 1) * JITTER[p.part]) * hz;
    var vel = clamp((ev.vel == null ? 0.7 : ev.vel) * (1 + (h() * 2 - 1) * VEL_JITTER * hz), 0, 1);
    var o = p.o || this.c.opts || {};
    if (ev.choke){ if (this.bank.choke) this.bank.choke(ev.choke, this.timeOf(L)); return; }
    if (p.part === "drums"){
      var piece = (ev.piece === "ride" && o.rideSound === "ride2") ? "ride2" : ev.piece, kv = this.c.kit && this.c.kit[ev.piece];
      this.bank.play("kit", { piece: piece, vel: vel, gain: kv == null ? 1 : kv * kv }, t, dest);
    }
    else if (p.part === "bass") this.bank.play(o.bassSound === "electric" ? "ebass" : "bass", { midi: ev.midi, vel: vel, dur: (ev.dur || 0.9) * this.spb * (p.unit || 1) }, t, dest);
    else {
      var ms = (ev.midis || []).slice().sort(function (a, b){ return a - b; }), n = ms.length;
      var spread = h() * STRUM * hz, dur = (ev.dur || 0.4) * this.spb * (p.unit || 1);     // chords are rolled very slightly, low to high
      var sound = ev.inst || "piano", S = global.BandSounds;
      if (p.part === "comp2") o = Object.assign({}, o, { compSound: (o.second && o.second.compSound) || sound });        // the second player's own sound
      if (o.compSound && o.compSound !== sound && S && S.family && S.family(o.compSound) === sound) sound = o.compSound;      // the same voicings on another sound of that family
      // a strum is a slower roll: low string first on a downstroke, high string first on an upstroke
      if (ev.strum){ spread = Math.min(0.028, 0.12 * this.spb) * (ev.strum === "up" ? 0.6 : 1) * hz; if (ev.strum === "up") ms.reverse(); }
      for (var i = 0; i < n; i++) this.bank.play(sound, ev.mute ? { midi: ms[i], vel: vel, dur: dur, cutoff: 1100 } : { midi: ms[i], vel: vel, dur: dur }, t + (n > 1 ? spread * i / (n - 1) : 0), dest);
    }
    if (this.tap) this.tap({ part: p.part, time: t, L: L, pos: ev.pos, vel: vel, piece: ev.piece, midi: ev.midi, midis: ev.midis, dur: ev.dur });
  };
  // Generate and schedule everything that sounds before `horizonT` (Infinity = the whole performance).
  Session.prototype.pump = function (horizonT){
    var hL = this.linAt(horizonT);
    var far = hL + GEN_MARGIN + this.aheadBeats();
    while (!this.done && this.nextL <= far) this.generate();
    if (hL > this.firedL) this.firedL = hL;
    var straight = this.c.opts && this.c.opts.feel === "straight";                 // straight eighths: no warp
    var sw = swingFor(this.tempo), keep = [];
    for (var i = 0; i < this.pending.length; i++){
      var p = this.pending[i], s = (p.o ? p.o.feel === "straight" : straight) ? 0.5 : sw;      // (a bar in its section's own style has its own feel)
      var L = p.L0 + (p.ev.straight ? p.ev.pos : warp(p.ev.pos, p.compound ? 2 / 3 : s)) * (p.unit || 1);
      if (L <= hL) this.fire(p, L); else keep.push(p);
    }
    this.pending = keep;
  };
  // Which bar/beat is sounding at context time t (for the chart highlight).
  Session.prototype.positionAt = function (t){
    var L = this.linAt(t), tl = this.timeline, e = null;
    for (var i = 0; i < tl.length; i++){ if (tl[i].L <= L + 1e-6) e = tl[i]; else break; }
    if (!e) return null;
    var beat = Math.floor((L - e.L) / (e.unit || 1) + 1e-6);
    if (e.ending) beat = 0; else if (beat >= e.beats) return null;
    return { entry: e, beat: beat, left: (e.L + e.beats * (e.unit || 1) - L) / (e.unit || 1) };
  };

  // ---- shared live context + bank (one per page, created on first use) ----
  var shared = null;
  function audio(){
    if (!shared){
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC || !global.BandSounds) throw new Error("BandPlayer: Web Audio / BandSounds unavailable");
      var ctx = new AC({ latencyHint: "interactive" });
      shared = { ctx: ctx, bank: global.BandSounds.create(ctx) };
    }
    return shared;
  }
  function settings(cfg){
    var v = cfg.volumes || {};
    return { parsed: cfg.parsed || null, tempo: clamp(+cfg.tempo || 120, 30, 400), transpose: cfg.transpose | 0,
      countIn: cfg.countIn == null ? 1 : clamp(cfg.countIn | 0, 0, 2), choruses: Math.max(0, cfg.choruses | 0),
      opts: Object.assign({}, cfg.opts), humanize: cfg.humanize, kit: Object.assign({}, cfg.kit),
      volumes: { bass: v.bass == null ? 1 : v.bass, comp: v.comp == null ? 1 : v.comp, comp2: v.comp2 == null ? 1 : v.comp2, drums: v.drums == null ? 1 : v.drums },
      intro: cfg.intro || null, hold: !!cfg.hold, startBar: Math.max(0, cfg.startBar | 0), cycle: cfg.cycle || null, tempoSteps: cfg.tempoSteps || null,
      instruments: cfg.instruments || ["bass", "piano", "kit"], ahead: !!cfg.ahead };
  }
  function newSeed(seed){ return seed == null ? (Math.random() * 0x7fffffff) | 0 : seed | 0; }

  function create(cfg){
    cfg = cfg || {};
    var c = settings(cfg), state = "idle", session = null, bus = null, timer = null, raf = null, token = 0, loadP = null;
    var lastEntry = null, lastBeat = -1, baseTempo = c.tempo, annSec = null, annBar = null; var lastFrame = 0;
    // a section is announced once: when it starts to sound, or cfg.sectionLead beats before (early)
    function announce(i, startBar, early){
      if (annSec === i && annBar === startBar) return; annSec = i; annBar = startBar;
      var sc = session && session.sections[i]; if (sc && cfg.onSection) cfg.onSection({ index: i, name: sc.name, bar: startBar, early: !!early });
    }

    function setState(s){ if (s === state) return; state = s; if (cfg.onState) cfg.onState(s); }
    function hidden(){ return typeof document !== "undefined" && document.hidden; }

    // the sample sets to have: the page's, and those of any section played in a style of its own
    function needed(){ var out = c.instruments.slice(), f = [], s2 = secondSound(c.opts); if (s2 && out.indexOf(s2) < 0) out.push(s2);
      try { f = session ? session.form : global.BandHarmony.buildForm(c.parsed, c.transpose | 0); } catch (e){}
      styleSounds(f, c.opts).forEach(function (n){ if (out.indexOf(n) < 0) out.push(n); }); return out; }
    function load(){                                            // the bank skips what it already has
      var a = audio(), need = needed(), key = need.join(",");
      if (!loadP || loadP.key !== key){
        loadP = a.bank.load(need, cfg.onLoadProgress).catch(function (e){ loadP = null; throw e; });
        loadP.key = key;
      }
      return loadP;
    }
    function tick(){
      if (!session) return;
      var ctx = session.ctx;
      session.pump(ctx.currentTime + (hidden() ? LOOKAHEAD_HIDDEN : LOOKAHEAD));
      if ((cfg.onBar || cfg.onBeat || cfg.onSection) && Date.now() - lastFrame > 120) frame(true);
      if (session.done && ctx.currentTime >= session.timeOf(session.endL) + RING) teardown(true);
    }
    // (Also called from the timer: a window that is covered or in the background gets no animation frames, and a page
    // following this one -- the lyrics site -- still has to hear about bars, beats and sections.)
    function frame(fromTimer){
      if (fromTimer !== true) raf = global.requestAnimationFrame(frame);
      if (!session) return;
      lastFrame = Date.now();
      var ctx = session.ctx, pos = session.positionAt(ctx.currentTime - (ctx.outputLatency || 0));
      if (!pos) return;
      if (pos.entry !== lastEntry){ lastEntry = pos.entry; lastBeat = -1; if (cfg.onBar) cfg.onBar(pos.entry.info); }
      var inf = pos.entry.info;
      if (cfg.onSection && inf.section != null && inf.section >= 0){
        if (inf.sectionBar === 0 || annSec == null) announce(inf.section, inf.bar - inf.sectionBar, false);
        if (cfg.sectionLead > 0 && inf.sectionLast && inf.nextSection >= 0 && pos.left <= cfg.sectionLead) announce(inf.nextSection, inf.bar + 1, true);
      }
      if (pos.beat !== lastBeat){ lastBeat = pos.beat;
        if (cfg.onBeat) cfg.onBeat({ beat: pos.beat, bar: pos.entry.info.bar, countIn: pos.entry.info.countIn }); }
    }
    function begin(){
      var a = audio();
      if (!buildForm(c.parsed, c.transpose).length){ setState("idle"); throw new Error("BandPlayer: no bars to play"); }
      bus = makeBus(a.ctx, c.volumes);
      session = new Session(a.ctx, a.bank, bus, c, newSeed(cfg.seed), cfg.onEvent);
      session.barTap = cfg.onBarEvents || null;
      baseTempo = c.tempo;
      session.onTempo = function (bpm){ if (cfg.onTempo) cfg.onTempo(bpm); };
      session.start(a.ctx.currentTime + START_DELAY);
      lastEntry = null; lastBeat = -1; annSec = annBar = null;
      setState("playing");
      tick(); timer = setInterval(tick, TICK_MS);
      if (global.requestAnimationFrame && (cfg.onBar || cfg.onBeat || cfg.onSection)) raf = global.requestAnimationFrame(frame);
    }
    function teardown(natural){
      if (timer){ clearInterval(timer); timer = null; }
      if (raf != null && global.cancelAnimationFrame){ global.cancelAnimationFrame(raf); raf = null; }
      var b = bus, s = session; session = null; bus = null;
      if (b){ b.fadeOut(0.03); if (s) s.bank.stopAll(); setTimeout(b.dispose, 400); }
      if (c.tempo !== baseTempo){ c.tempo = baseTempo; if (cfg.onTempo) cfg.onTempo(baseTempo); }   // tempo steps start over next time
      setState("idle");
      if (natural && cfg.onEnd) cfg.onEnd();
    }
    function play(){
      if (state !== "idle") return Promise.resolve();
      var a, my = ++token;
      try { a = audio(); } catch (e){ return Promise.reject(e); }
      if (a.ctx.state === "suspended") a.ctx.resume();          // inside the user gesture
      if (!needed().every(function (n){ return a.bank.has(n); })) setState("loading");
      return load().then(function (){ if (my !== token) return; begin(); },
                         function (e){ if (my === token) setState("idle"); throw e; });
    }
    function stop(){ token++; teardown(false); }
    // bars written ahead are out of date: generate them again from the first one not yet scheduled
    function redo(){ if (!session || !session.gen.length) return; var b = session.rewind(); if (b != null && cfg.onRewind) cfg.onRewind(b); }

    if (typeof document !== "undefined") document.addEventListener("visibilitychange", function (){ if (session) tick(); });

    return {
      load: load, play: play, stop: stop,
      isPlaying: function (){ return state === "playing"; },
      state: function (){ return state; },
      context: function (){ return shared ? shared.ctx : null; },   // the AudioContext, once it exists
      // What the listener was hearing at context time t (now if omitted): the bar's info and how many
      // beats into it, unrounded. null when nothing is sounding. For timing something played along.
      where: function (t){
        if (!session) return null;
        var ctx = session.ctx, L = session.linAt((t == null ? ctx.currentTime : t) - (ctx.outputLatency || 0)), tl = session.timeline, e = null;
        for (var i = 0; i < tl.length; i++){ if (tl[i].L <= L + 1e-6) e = tl[i]; else break; }
        return e ? { info: e.info, pos: (L - e.L) / (e.unit || 1), beats: e.beats } : null;
      },
      setTempo: function (bpm){ c.tempo = baseTempo = clamp(+bpm || c.tempo, 30, 400); if (session) session.setTempo(c.tempo); },
      setTranspose: function (n){ c.transpose = n | 0; if (session) session.refreshForm(); redo(); },
      setChart: function (parsed){ c.parsed = parsed; if (session) session.refreshForm(); redo(); },
      setVolume: function (part, v){ if (!(part in c.volumes)) return; c.volumes[part] = v; if (bus) bus.setVolume(part, v); },
      setOpts: function (o){ Object.assign(c.opts, o); c.optsRev = (c.optsRev | 0) + 1; redo(); },
      // Write the music a pass of the form ahead of the playing (cfg.ahead), so it can be shown before it sounds.
      // cfg.onRewind(barNo) says that the bars from barNo on were discarded and will come again through onBarEvents.
      setAhead: function (on){ c.ahead = !!on; },
      // How hard the user is playing, 0..1 (the page measures it from the microphone); null = stop following.
      setFollow: function (x){ var was = c.follow; c.follow = x == null ? null : clamp(+x || 0, 0, 1); if (was == null && c.follow != null) redo(); },
      setInstruments: function (list){ c.instruments = list.slice(); if (shared) load().catch(function (){}); },   // before the first play this only records the list
      setKitVolume: function (piece, v){ c.kit[piece] = clamp(+v, 0, 1.5); },
      setCountIn: function (n){ c.countIn = clamp(n | 0, 0, 2); },
      sections: function (){ return session ? session.sections.slice() : sectionsOf(buildForm(c.parsed, c.transpose)); },
      setHold: function (on){ c.hold = !!on; redo(); if (session && !c.hold) session.advance = null; },
      // (bars written ahead are thrown back first: they were written without knowing this)
      next: function (){ if (!session) return false; redo(); session.advance = -1; if (session.held) session.fillNow("medium", true); return true; },
      goSection: function (i){ if (!session || !session.sections[i]) return false; redo();
        if (!c.hold) session.jump = session.sections[i].from; else { session.advance = i | 0; if (session.held) session.fillNow("medium", true); } return true; },
      fill: function (size){ if (!session) return null; redo(); return session.fillNow(size === "small" || size === "large" ? size : "medium"); },
      setIntro: function (o){ c.intro = o || null; },             // takes effect at the next play()
      setChoruses: function (n){ c.choruses = Math.max(0, n | 0); redo(); },
      setStartBar: function (i){ c.startBar = Math.max(0, i | 0); },                       // form bar index for the next play()
      setCycle: function (from, to){ c.cycle = from == null ? null : { from: from | 0, to: (to == null ? from : to) | 0 }; redo(); },   // live
      setTempoSteps: function (steps){ c.tempoSteps = (steps && steps.length) ? steps.slice() : null; }     // bpm added at each repeat, in turn
    };
  }

  // Render a finite performance to a buffer with the SAME session code as live playback.
  // stems:true also renders each part alone (same seed, so the same notes).
  function renderOffline(o){
    o = o || {};
    var c = settings(o), seed = newSeed(o.seed), rate = o.sampleRate || 44100;
    c.startBar = 0; c.cycle = null; c.tempoSteps = null;      // offline renders are whole choruses at one tempo
    if (!(c.choruses > 0)) c.choruses = 2;
    var OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext, form = buildForm(c.parsed, c.transpose);
    if (!OAC || !global.BandSounds) return Promise.reject(new Error("BandPlayer: offline audio unavailable"));
    if (!form.length) return Promise.reject(new Error("BandPlayer: no bars to play"));
    var beats = c.countIn * form[0].beats + form[0].beats;
    form.forEach(function (b){ beats += b.beats * c.choruses; });
    introBars(form, c.intro).forEach(function (b){ beats += b.beats; });
    var seconds = START_DELAY + beats * 60 / c.tempo + RING;

    function one(volumes, tap){
      var ctx = new OAC(2, Math.ceil(seconds * rate), rate), bank = global.BandSounds.create(ctx);
      var cc = Object.assign({}, c, { volumes: volumes });
      var need = c.instruments.slice(), s2 = secondSound(c.opts); if (s2 && need.indexOf(s2) < 0) need.push(s2);
      try { styleSounds(global.BandHarmony.buildForm(c.parsed, c.transpose | 0), c.opts).forEach(function (n){ if (need.indexOf(n) < 0) need.push(n); }); } catch (e){}
      return bank.load(need).then(function (){
        var s = new Session(ctx, bank, makeBus(ctx, volumes), cc, seed, tap);
        s.start(START_DELAY); s.pump(Infinity);
        return ctx.startRendering();
      });
    }
    var result = {};
    return one(c.volumes, o.onEvent).then(function (mix){
      result.mix = mix;
      if (!o.stems) return result;
      result.stems = {};
      return PARTS.filter(function (p){ return p !== "comp2" || secondSound(c.opts); }).reduce(function (chain, p){
        return chain.then(function (){ var solo = { bass: 0, comp: 0, comp2: 0, drums: 0 }; solo[p] = c.volumes[p];
          return one(solo).then(function (buf){ result.stems[p] = buf; }); });
      }, Promise.resolve()).then(function (){ return result; });
    });
  }

  // One chord on the band's sampled instruments, for pages that only want to hear a voicing:
  //   BandPlayer.chord(midis, { inst: "piano" | "epiano" | "guitar" | "bass" | "ebass", dur: seconds, vel, roll: seconds low to high })
  // Loads that instrument on first use (the returned promise settles when the notes are scheduled).
  var chordOut = null;
  function chord(midis, o){
    o = o || {};
    var a = audio(), inst = o.inst || "piano", ms = (midis || []).slice().sort(function (x, y){ return x - y; }), n = ms.length;
    if (!n) return Promise.resolve();
    if (a.ctx.state === "suspended" && a.ctx.resume) a.ctx.resume();
    if (!chordOut){ chordOut = a.ctx.createGain(); chordOut.gain.value = 0.8; chordOut.connect(a.ctx.destination); }
    return a.bank.load([inst]).then(function (){
      var t = a.ctx.currentTime + 0.03, roll = o.roll != null ? o.roll : (inst === "guitar" || (global.BandSounds.family && global.BandSounds.family(inst) === "guitar") ? 0.045 : 0.012);
      ms.forEach(function (m, i){ a.bank.play(inst, { midi: m, vel: o.vel == null ? 0.66 : o.vel, dur: o.dur || 1.6 }, t + (n > 1 ? roll * i / (n - 1) : 0), chordOut); });
    });
  }

  global.BandPlayer = { chord: chord, create: create, renderOffline: renderOffline, swingFor: swingFor, warp: warp, intensityFor: intensityFor };
})(typeof window !== "undefined" ? window : globalThis);
