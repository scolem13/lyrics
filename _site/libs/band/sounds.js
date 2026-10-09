// sounds.js — the band's sample bank (BandSounds). THE ONLY FILE THAT KNOWS WHERE THE
// SOUNDS COME FROM. The parts (bass.js / comp.js / drums.js) and the player ask for
// "bass, midi 41" or "kit, ride" — never a GM number, a soundfont name or a file.
//
// An instrument is a declarative definition holding a list of ZONES (one sample each):
//   pitched zone: { url, midi (the sample's own pitch), lo?, hi? (key range), velLo?, velHi?, gain? }
//   kit zone:     { url, piece, velLo?, velHi?, gain? }
// Playback picks the nearest matching zone and repitches it, so a sparse set (say one
// sample every third note) works. Several zones on the same key/piece and velocity are
// played round-robin. There is ONE loader and ONE playback path for every zone, whatever
// its origin: the soundfont below is only a helper that GENERATES zone lists.
//
//   var bank = BandSounds.create(audioCtx);            // AudioContext or OfflineAudioContext
//   bank.load(["bass","piano","kit"], onProgress)      -> Promise (idempotent; onProgress(done,total))
//   bank.play("bass",  { midi:41, vel:0.8, dur:0.45 }, when, destNode)
//   bank.play("kit",   { piece:"ride", vel:0.6 },      when, destNode)
//   bank.choke("cymbals", when)                        // damp ringing cymbals (a stop-time hit)
//   bank.stopAll()                                     // fade + cut everything sounding or scheduled
//   bank.has(name)                                     // loaded and playable?
//   BandSounds.define(name, def | function (sf) -> def)  // override/add an instrument at runtime
//   BandSounds.pieces                                  // the kit-piece names the drum part may use
//
// vel is 0..1 (0.7 = normal mf); dur is in SECONDS here (the player converts from beats).
// spec.gain (default 1) is a plain level trim on top: the player's per-piece drum faders.
// Alternatives the player can swap in: "ebass" for "bass", "epiano" for "piano", and the kit
// piece "ride2" (a second ride cymbal) for "ride".

(function (global) {
  var SF_DEFAULT = "https://cdn.jsdelivr.net/gh/paulrosen/midi-js-soundfonts/MusyngKite/";
  var PIECES = ["kick","snare","rim","hatClosed","hatFoot","hatOpen","ride","ride2","rideBell","crash","tomHi","tomMid","tomLo","sticks"];

  // ======================================================================================
  // INSTRUMENT DEFINITIONS — edit this block (and nothing else) to change the sounds.
  //
  // `sf` is the soundfont base URL. gain = level trim for the whole instrument (the
  // soundfont's bass and piano are recorded far quieter than its drums); release = fade
  // after note-off, in seconds; tone = velocity-dependent low-pass (softer = darker).
  // The gains were set by measuring rendered stems: with the player's faders at 1 the
  // bass and drums are equally loud and the piano sits 3 LU under them (mix ≈ -16 LUFS).
  // A new sample set only needs its `gain` adjusted to land in the same place.
  //
  // To move an instrument to RECORDED SAMPLES, drop the files under
  // /apps/shared/band/samples/ and replace its zone list — nothing else changes:
  //
  //   bass: { gain: 1, release: 0.06, zones: [
  //     { url: "/apps/shared/band/samples/bass/E1_mf.wav", midi: 28, velHi: 0.6 },   // velocity layers
  //     { url: "/apps/shared/band/samples/bass/E1_f.wav",  midi: 28, velLo: 0.6 },
  //     { url: "/apps/shared/band/samples/bass/A1_mf.wav", midi: 33 },               // sparse is fine
  //     ... ] },
  //   kit: { zones: [
  //     { url: "/apps/shared/band/samples/kit/ride_1.wav", piece: "ride" },          // same piece twice
  //     { url: "/apps/shared/band/samples/kit/ride_2.wav", piece: "ride" },          //   = round-robin
  //     ... ], pieces: { hatOpen: { group: "hat" }, hatFoot: { chokes: "hat" } } }
  // ======================================================================================
  function instruments(sf){
    return {
      bass:   { gain: 2.2, release: 0.06,
                zones: soundfontZones(sf, "acoustic_bass", 28, 57, 3) },
      piano:  { gain: 4.05, release: 0.12, tone: { base: 1200, range: 11000 },
                zones: soundfontZones(sf, "acoustic_grand_piano", 43, 84, 3) },
      // electric alternatives; gains set from the level of the raw samples against the two above, not yet by ear
      ebass:  { gain: 1.1, release: 0.07,
                zones: soundfontZones(sf, "electric_bass_finger", 28, 57, 3) },
      epiano: { gain: 1.6, release: 0.14, tone: { base: 1500, range: 9000 },
                zones: soundfontZones(sf, "electric_piano_1", 43, 84, 3) },
      guitar: { gain: 2.9, release: 0.08,
                zones: soundfontZones(sf, "electric_guitar_jazz", 40, 78, 3) },
      // steel-string acoustic and clean electric, for the folk, rock and pop styles (gains are first guesses, not yet set by ear)
      aguitar:{ gain: 2.6, release: 0.10,
                zones: soundfontZones(sf, "acoustic_guitar_steel", 40, 84, 3) },
      cguitar:{ gain: 2.6, release: 0.08,
                zones: soundfontZones(sf, "electric_guitar_clean", 40, 84, 3) },
      // distorted electric, for the emo / pop-punk style (level a first guess: the samples are compressed and loud)
      dguitar:{ gain: 1.5, release: 0.06,
                zones: soundfontZones(sf, "distortion_guitar", 40, 84, 3) },
      // for hymns: the piano's voicings on a church organ (level a first guess; the samples are a few seconds long, so very long chords fade)
      organ:  { gain: 1.3, release: 0.18,
                zones: soundfontZones(sf, "church_organ", 36, 84, 3) },
      kit:    { gain: 1.25,
                zones: soundfontKit(sf, { kick:36, rim:37, snare:38, hatClosed:42, hatFoot:44, hatOpen:46,
                                          crash:49, ride:51, ride2:59, rideBell:53, tomLo:43, tomMid:45, tomHi:48, sticks:31, clap:39, tamb:54 }),
                // per-piece trim (the soundfont's kick is ~8x hotter than its ride); group/chokes =
                // the closed hat and the foot cut a ringing open hat; the cymbals can be damped by choke("cymbals")
                pieces: { kick:{ gain:0.56 }, snare:{ gain:0.80 }, clap:{ gain:0.70 }, tamb:{ gain:0.90 }, rim:{ gain:1.15 }, sticks:{ gain:0.50 },
                          ride:{ gain:1.95, group:"cymbals" }, ride2:{ gain:2.4, group:"cymbals" }, rideBell:{ gain:1.5, group:"cymbals" }, crash:{ gain:1.9, group:"cymbals" },
                          hatClosed:{ gain:1.6, chokes:"hat" }, hatFoot:{ gain:1.6, chokes:"hat" }, hatOpen:{ gain:1.4, group:"hat" },
                          tomHi:{ gain:0.95 }, tomMid:{ gain:0.95 }, tomLo:{ gain:0.95 } } }
    };
  }

  // ---- soundfont helpers: turn a MIDI.js-style soundfont into zone lists ----
  // Files are <base><instrument>-mp3/<Note>.mp3, flats only, MIDI 60 = C4.
  var NOTE = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
  function noteName(midi){ return NOTE[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
  // one zone every `step` semitones covering lo..hi (so each note is repitched by at most step/2)
  function soundfontZones(sf, name, lo, hi, step){
    step = step || 1; var half = Math.floor(step / 2), zones = [];
    for (var m = lo + half; m - half <= hi; m += step)
      zones.push({ url: sf + name + "-mp3/" + noteName(m) + ".mp3", midi: m, lo: m - half, hi: m - half + step - 1 });
    return zones;
  }
  // kit: piece name -> the soundfont's percussion note
  function soundfontKit(sf, map){
    return Object.keys(map).map(function (piece){ return { url: sf + "percussion-mp3/" + noteName(map[piece]) + ".mp3", piece: piece }; });
  }
  function resolveBase(){
    try { if (typeof global.getSoundfontUrl === "function")
      return Promise.resolve(global.getSoundfontUrl()).then(function (u){ return u || SF_DEFAULT; }, function (){ return SF_DEFAULT; });
    } catch (e) {}
    return Promise.resolve(SF_DEFAULT);
  }

  var overrides = {};
  function define(name, def){ overrides[name] = def; }
  function buildDefs(sf){
    var defs = instruments(sf);
    Object.keys(overrides).forEach(function (k){ defs[k] = typeof overrides[k] === "function" ? overrides[k](sf) : overrides[k]; });
    return defs;
  }

  // ---- zone choice (pure). Returns every zone tied for best; the caller round-robins. ----
  function velOk(z, vel){ return (z.velLo == null || vel >= z.velLo) && (z.velHi == null || vel < z.velHi || z.velHi >= 1); }
  function pickZones(zones, spec){
    var vel = spec.vel == null ? 0.7 : spec.vel, kit = spec.piece != null;
    var pool = zones.filter(function (z){ return kit ? z.piece === spec.piece : z.midi != null; });
    var byVel = pool.filter(function (z){ return velOk(z, vel); });
    if (byVel.length) pool = byVel;                       // no layer for this velocity → any layer
    if (kit || !pool.length) return pool;
    var inRange = pool.filter(function (z){ return (z.lo == null || spec.midi >= z.lo) && (z.hi == null || spec.midi <= z.hi)
                                                && (z.lo != null || z.hi != null); });
    if (inRange.length) pool = inRange;
    var best = Infinity;
    pool.forEach(function (z){ var d = Math.abs(z.midi - spec.midi); if (d < best) best = d; });
    var near = pool.filter(function (z){ return Math.abs(z.midi - spec.midi) === best; });
    return near.filter(function (z){ return z.midi === near[0].midi; });   // one root only (a tie above/below)
  }

  // ---- loading: fetch + decode once per URL (shared by every bank / context) ----
  var CACHE = {};
  function decode(ctx, ab){
    return new Promise(function (res, rej){ var p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
  }
  // Find where the sound really starts (so every hit lands on its beat whatever padding
  // the file has) and where it ends: the first 150 ms of silence after the peak. Cutting
  // there drops dead air (soundfont drum files are 6 s for a 1 s hit) and the stray
  // click some of them carry at the very end of the file.
  function prepare(ctx, buf){
    var n = buf.length, nch = buf.numberOfChannels, sr = buf.sampleRate, blk = Math.max(1, Math.round(sr / 100));
    var nb = Math.ceil(n / blk), pk = new Float32Array(nb), peak = 0, peakBlk = 0, c, i, d, a, k;
    for (c = 0; c < nch; c++){ d = buf.getChannelData(c);
      for (i = 0; i < n; i++){ a = d[i] < 0 ? -d[i] : d[i]; k = (i / blk) | 0; if (a > pk[k]) pk[k] = a; } }
    for (k = 0; k < nb; k++) if (pk[k] > peak){ peak = pk[k]; peakBlk = k; }
    if (!(peak > 0)) return { buffer: buf, offset: 0 };
    var onTh = peak * 0.02, first = n;
    for (c = 0; c < nch; c++){ d = buf.getChannelData(c);
      for (i = 0; i < first; i++){ a = d[i] < 0 ? -d[i] : d[i]; if (a > onTh){ first = i; break; } } }
    var offset = Math.min(0.08, Math.max(0, first / sr - 0.002));
    var offTh = peak * 0.001, quiet = 0, endBlk = nb;
    for (k = peakBlk; k < nb; k++){ quiet = pk[k] < offTh ? quiet + 1 : 0; if (quiet >= 15){ endBlk = k - 14; break; } }
    var keep = Math.min(n, (endBlk + 2) * blk);
    if (keep < n){
      var out = ctx.createBuffer(nch, keep, sr), fade = Math.min(keep, Math.round(0.01 * sr));
      for (c = 0; c < nch; c++){ var o = out.getChannelData(c); o.set(buf.getChannelData(c).subarray(0, keep));
        for (i = 0; i < fade; i++) o[keep - 1 - i] *= i / fade; }
      buf = out;
    }
    return { buffer: buf, offset: offset };
  }
  function fetchBuffer(ctx, url){
    if (!CACHE[url]) CACHE[url] = fetch(url)
      .then(function (r){ if (!r.ok) throw new Error(r.status + " " + url); return r.arrayBuffer(); })
      .then(function (ab){ return decode(ctx, ab); })
      .then(function (buf){ return prepare(ctx, buf); })
      .catch(function (e){ delete CACHE[url]; throw e; });        // allow a retry
    return CACHE[url];
  }

  function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

  function create(ctx){
    var defsP = null, defs = null, ready = {}, loading = {}, rr = {}, live = new Set(), ringing = {};

    function getDefs(){ return defsP || (defsP = resolveBase().then(function (sf){ defs = buildDefs(sf); return defs; })); }

    function loadOne(name, tick){
      if (loading[name]) return loading[name];
      var def = defs[name]; if (!def) return Promise.reject(new Error("BandSounds: unknown instrument " + name));
      var p = Promise.all(def.zones.map(function (z){
        if (z.buffer){ tick(); return null; }
        return fetchBuffer(ctx, z.url).then(function (r){ z.buffer = r.buffer; z.offset = r.offset; },
                                            function (e){ if (global.console) console.warn("BandSounds: sample failed —", e && e.message); })
          .then(tick);
      })).then(function (){
        if (!def.zones.some(function (z){ return z.buffer; })) throw new Error("BandSounds: no samples loaded for " + name);
        ready[name] = true;
      });
      loading[name] = p.catch(function (e){ delete loading[name]; throw e; });
      return loading[name];
    }
    function load(names, onProgress){
      return getDefs().then(function (){
        var total = 0, done = 0;
        names.forEach(function (n){ if (defs[n] && !loading[n]) total += defs[n].zones.length; });
        function tick(){ done++; if (onProgress) onProgress(Math.min(done, total), total); }
        if (onProgress) onProgress(0, total);
        return Promise.all(names.map(function (n){ return loadOne(n, tick); }));
      }).then(function (){});
    }

    function choke(group, t){
      var list = ringing[group]; if (!list) return;
      ringing[group] = list.filter(function (v){
        if (v.t >= t) return true;
        try { v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.012); v.src.stop(t + 0.12); } catch (e) {}
        return false;
      });
    }

    // spec = { midi | piece, vel?, dur? (seconds; omit = let the sample ring), release? }
    function play(inst, spec, when, dest){
      var def = defs && defs[inst];
      if (!def || !ready[inst]){ if (defs && def) load([inst]).catch(function (){}); return null; }   // lazy-load, skip this hit
      var vel = clamp(spec.vel == null ? 0.7 : spec.vel, 0, 1); if (!(vel > 0)) return null;
      var group = pickZones(def.zones.filter(function (z){ return z.buffer; }), spec); if (!group.length) return null;
      var key = inst + ":" + (spec.piece != null ? spec.piece : group[0].midi), z = group[(rr[key] = (rr[key] || 0) + 1) % group.length];
      var pc = (spec.piece != null && def.pieces && def.pieces[spec.piece]) || {};
      var level = Math.pow(vel, def.curve || 1.6) * (def.gain || 1) * (z.gain || 1) * (pc.gain || 1) * (spec.gain == null ? 1 : Math.max(0, spec.gain));
      if (!(level > 0)) return null;
      var t = Math.max(when || 0, ctx.currentTime);

      var src = ctx.createBufferSource(); src.buffer = z.buffer;
      if (spec.midi != null && z.midi != null) src.playbackRate.value = Math.pow(2, (spec.midi - z.midi) / 12);
      var g = ctx.createGain(), tail = src; g.gain.value = 0;
      if (def.tone || spec.cutoff){                         // softer notes are darker (one sample layer, many dynamics); spec.cutoff = a fixed low-pass in Hz (a palm mute)
        var f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 0.5;
        f.frequency.value = spec.cutoff ? spec.cutoff : Math.min(18000, (def.tone.base + def.tone.range * Math.pow(vel, 1.3)) * Math.pow(2, ((spec.midi || 60) - 60) / 24));
        src.connect(f); tail = f;
      }
      tail.connect(g); g.connect(dest || ctx.destination);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.002);

      var v = { src: src, g: g, t: t };
      if (pc.chokes) choke(pc.chokes, t);
      if (pc.group) (ringing[pc.group] = ringing[pc.group] || []).push(v);
      src.start(t, z.offset || 0);
      if (spec.dur != null){                                // note-off: short release so nothing clicks
        var rel = spec.release != null ? spec.release : (def.release || 0.08), end = t + Math.max(0.03, spec.dur);
        g.gain.setTargetAtTime(0, end, rel / 3); src.stop(end + rel * 2 + 0.02);
      }
      live.add(v);
      src.onended = function (){ live.delete(v); try { g.disconnect(); } catch (e) {}
        if (pc.group && ringing[pc.group]){ var k = ringing[pc.group].indexOf(v); if (k >= 0) ringing[pc.group].splice(k, 1); } };
      return v;
    }

    function stopAll(){
      var now = ctx.currentTime;
      live.forEach(function (v){
        try { v.g.gain.cancelScheduledValues(now); v.g.gain.setTargetAtTime(0, now, 0.01); v.src.stop(now + 0.08); } catch (e) {}
      });
      ringing = {};
    }

    return { load: load, play: play, stopAll: stopAll, choke: function (group, when){ choke(group, Math.max(when || 0, ctx.currentTime)); }, has: function (n){ return !!ready[n]; }, context: ctx };
  }

  global.BandSounds = {
    create: create, define: define, resolveBase: resolveBase, pieces: PIECES.slice(),
    soundfontZones: soundfontZones, soundfontKit: soundfontKit, pickZones: pickZones, noteName: noteName
  };
})(typeof window !== "undefined" ? window : globalThis);
