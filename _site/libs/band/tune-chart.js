// tune-chart.js — shared iRealPro-style chord-chart renderer for ABC tunes.
// Used by BOTH the Chord Sheet (Stage Edition) tool and the Tune Assessment page, so
// chart features (sub-bar beat lines, beat-accurate chord placement, transposition…)
// live in one place. The host supplies a container + an ABC string; we parse the music
// (tracking note durations so each chord sits at its real beat) and build the grid.
//
//   var chart = TuneChart.render(containerEl, abcString, {
//     subBarBeats: 0,        // 0 = off, or draw a faint line every N beats (1, 2, …)
//     transpose: 0,          // semitones to transpose the chord symbols
//     preferFlats: true,     // spell transposed roots with flats (else sharps)
//     header: true,          // render a title + key/meter line inside the chart
//     barsPerRow: 4,
//     roman: false,          // false/"off" letters | true/"only" Roman numerals | "both" letters with the numeral beneath
//     keyNote: ""            // short text after the key in the header, e.g. "E♭ instruments · concert B♭"
//   });
//   chart.parsed                 // {title, composer, keyPc, keyName, meterN, meterD, …}
//   chart.barEls                 // the bar <div>s, in order (for highlighting)
//   chart.setSubBars(n)          // toggle/redraw beat lines
//   chart.setTranspose(semis)    // re-render in a new key
//   chart.setRoman(mode)         // false/"off" | true/"only" | "both" (needs TuneLibrary for the numerals)
//   chart.setKeyNote(text)       // the header note after the key ("" = the default "(from X)" when transposed)
//   chart.setLive(i)             // mark bar i as the sounding bar (-1 = none)
//   chart.redraw()

(function (global) {
  var FLAT  = ["C","D♭","D","E♭","E","F","G♭","G","A♭","A","B♭","B"];
  var SHARP = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
  var ASCII_FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
  var PC = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  var TUPLET_TIME = { 2:3, 3:2, 4:3, 5:2, 6:2, 7:2, 8:3, 9:2 };   // default "in time of"

  function mod12(n){ return ((n % 12) + 12) % 12; }
  // roman display mode: "off" | "only" (numerals replace the letters; the old `true`) | "both"
  function romanMode(v){ return (!v || v === "off") ? "off" : v === "both" ? "both" : "only"; }
  function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }

  // ---- header fields ----
  function field(abc, tag){ var m = new RegExp("^"+tag+":\\s*(.+)$","m").exec(abc); return m ? m[1].trim() : ""; }
  function keyPcOf(k){ var m = /^([A-Ga-g])([#b]?)/.exec(k || ""); if (!m) return 0;
    return mod12(PC[m[1].toUpperCase()] + (m[2]==="#"?1:m[2]==="b"?-1:0)); }

  // meter "C" / "C|" / "n/d" / "none" -> {n, d}.  beat unit = 1/d note.
  function parseMeter(s){
    s = (s || "").trim();
    if (s === "C") return { n:4, d:4 };
    if (s === "C|") return { n:2, d:2 };
    var m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
    if (m) return { n:parseInt(m[1],10), d:parseInt(m[2],10) };
    return { n:4, d:4 };                                    // "none" / unknown → assume 4/4
  }
  // L: "1/8" -> whole-note fraction. If absent, ABC default depends on the meter.
  function parseUnit(abc, meter){
    var m = /^L:\s*(\d+)\s*\/\s*(\d+)/m.exec(abc);
    if (m) return parseInt(m[1],10) / parseInt(m[2],10);
    return (meter.n / meter.d) < 0.75 ? 1/16 : 1/8;         // standard ABC fallback
  }

  // ---- duration of one note token starting at text[i] (the letter is at `li`) ----
  // returns the duration in L-units for `num[/den]` style suffixes.
  function readDuration(text, i){
    var num = "", j = i;
    while (j < text.length && /\d/.test(text[j])) { num += text[j]; j++; }
    var den = 1, slashes = 0;
    while (j < text.length && text[j] === "/") { slashes++; j++; var d = ""; while (j < text.length && /\d/.test(text[j])) { d += text[j]; j++; }
      if (d) { den = parseInt(d, 10); break; } }
    if (slashes && den === 1) den = Math.pow(2, slashes);    // "/" = /2, "//" = /4
    var dur = (num ? parseInt(num, 10) : 1) / den;
    return { dur: dur, next: j };
  }

  // ---- parse the whole tune into bars with beat-positioned chords ----
  function parse(abc){
    var meter = parseMeter(field(abc, "M"));
    var unit  = parseUnit(abc, meter);                       // L-unit in whole notes
    var unitsPerBar  = (meter.n / meter.d) / unit;           // L-units in a full bar
    var unitsPerBeat = (1 / meter.d) / unit;                 // L-units per beat (1/d note)
    var meter0 = { n: meter.n, d: meter.d }, unitsPerBar0 = unitsPerBar, unitsPerBeat0 = unitsPerBeat;   // the tune's own meter (inline [M:] changes move the three above)
    var keyField = field(abc, "K"), keyPc = keyPcOf(keyField);

    // music = every non-header, non-directive line, joined by newlines so that each bar knows which line of the ABC it was
    // written on (srcLine: the chart keeps the ABC's lines). A backslash at the end of a line continues it.
    // A P: line in the body names the section that starts at the next bar (P:Verse, P:Chorus); it is kept as an inline [P:...]
    // field. (A P: line in the header, above K:, is the old "order of parts" field and is left alone.)
    // Every kept line remembers where it starts in the ABC, so a bar can say where it was written (bar.at; setMarks edits there).
    // A %%style line under a P: line is that section's own style (%%style bossa nova); it is kept as the annotation "^style ...",
    // which can also be written in a bar by hand. (A %%style line above the first P: is the whole tune's, and is the page's to read.)
    var inBody = false, mLines = [], lineOff = 0, sawPart = false;
    abc.split("\n").forEach(function(l){ var t = l.trim(), at = lineOff; lineOff += l.length + 1;
      if (/^K:/.test(t)){ inBody = true; return; }
      if (inBody && /^P:\s*\S/.test(t)){ sawPart = true; mLines.push({ text: "[P:" + t.slice(2).trim().replace(/\]/g, "") + "]", at: -1 }); return; }
      if (inBody && sawPart && /^%%\s*style\s+\S/i.test(t)){ mLines.push({ text: '"^style ' + t.replace(/^%%\s*style\s+/i, "").replace(/"/g, "") + '"', at: -1 }); return; }
      if (t && !/^[A-Za-z]:/.test(t) && !/^%/.test(t)) mLines.push({ text: l, at: at }); });
    var music = mLines.map(function(x){ return x.text; }).join("\n").replace(/\\[ \t]*\n/g, function(m){ return new Array(m.length + 1).join(" "); });
    var mStart = [], mo = 0; mLines.forEach(function(x){ mStart.push(mo); mo += x.text.length + 1; });
    function srcOff(i){ for (var k = mStart.length - 1; k >= 0; k--) if (mStart[k] <= i) return mLines[k].at < 0 ? -1 : mLines[k].at + (i - mStart[k]); return -1; }
    var lineNo = 0;

    var bars = [], pendingLeft = "plain", pendingEnding = null;
    var pendingSection = null;
    function newBar(){ var b = { chords:[], left:pendingLeft, right:"plain", ending:pendingEnding, lengthUnits:0, meter:{ n:meter.n, d:meter.d }, groupOnsets:[], srcLine:lineNo };
      if (pendingSection != null){ b.section = pendingSection; pendingSection = null; } return b; }
    var cur = newBar(), content = false, pos = 0;
    var lastDur = 0, brokenMul = 1, tupletLeft = 0, tupletMul = 1;
    // groupBoundary: a space after a note means the next note starts a new beaming group.
    // Used to detect asymmetric meter sub-groupings (e.g. 3+2+2 in 7/8).
    var lastWasNote = false, groupBoundary = true;

    function flush(right){
      if (!content && !cur.chords.length){ if (right === "repeat-open") pendingLeft = "repeat-open"; return; }
      cur.right = right; cur.lengthUnits = pos; cur.fullUnits = unitsPerBar; bars.push(cur);
      pendingLeft = (right === "repeat-close-open") ? "repeat-open" : "plain";
      pendingEnding = null; cur = newBar(); content = false; pos = 0; lastDur = 0; brokenMul = 1; tupletLeft = 0; tupletMul = 1;
      groupBoundary = true; lastWasNote = false;
    }
    function applyMods(dur){
      if (tupletLeft > 0){ dur *= tupletMul; tupletLeft--; if (tupletLeft === 0) tupletMul = 1; }
      if (brokenMul !== 1){ dur *= brokenMul; brokenMul = 1; }
      return dur;
    }

    var i = 0;
    while (i < music.length){
      var c = music[i];
      if (c === '\n'){ lineNo++; if (!content && !cur.chords.length) cur.srcLine = lineNo; c = ' '; }     // (a bar belongs to the line it starts on)
      if (c === ' '){ if (lastWasNote) groupBoundary = true; lastWasNote = false; i++; continue; }
      if (c === '"'){ var e = music.indexOf('"', i+1); if (e < 0) break;
        var s = music.slice(i+1, e).trim(); if (cur.at == null) cur.at = srcOff(i);
        var fm = /^[\^_<>@]\s*(small|short|big|long)?\s*fill$/i.exec(s);                    // an annotation: "^fill", "^small fill", "^big fill"
        if (fm || /^[\^_<>@]\s*stop$/i.test(s)) (cur.marks = cur.marks || []).push({ kind: fm ? "fill" : "stop", from: srcOff(i), to: srcOff(e) + 1 });
        if (fm) cur.fill = !fm[1] ? "medium" : /^(small|short)$/i.test(fm[1]) ? "small" : "large";   // the drummer fills at the end of this bar
        else if (/^[\^_<>@]\s*half(\s*time)?$/i.test(s)) cur.feel = "half";   // "^half time": this bar is felt in half time (in pairs: bars 1+2, 3+4, ...)
        else if (/^[\^_<>@]\s*style\b/i.test(s)) cur.style = s.replace(/^[\^_<>@]\s*style\s*:?\s*/i, "").trim() || "none";   // "^style bossa": this bar and the rest of its section in that style
        else if (/^[\^_<>@]\s*stop$/i.test(s)) cur.stop = true;                               // "^stop": stop time on this bar
        else if (/^[A-G]/.test(s)) { cur.chords.push({ sym:s, onset:pos }); content = true; }
        else if (/^n\.?c\.?$/i.test(s)) { cur.chords.push({ sym:"N.C.", onset:pos, nc:true }); content = true; }
        i = e+1; continue; }
      if (c === '!'){ var e2 = music.indexOf('!', i+1); if (e2 >= 0){
        var dec = music.slice(i+1, e2);
        if (dec === 'fine' || dec === 'segno' || dec === 'coda' ||
            dec === 'D.C.' || dec === 'D.S.' ||
            dec === 'D.C.alfine' || dec === 'D.S.alfine' ||
            dec === 'D.C.alcoda' || dec === 'D.S.alcoda'){
          cur.decors = cur.decors || []; cur.decors.push(dec);
        }
        i = e2+1; continue; } }
      if (c === '{'){ var e3 = music.indexOf('}', i+1); if (e3 >= 0){ i = e3+1; continue; } } // grace notes: 0 dur
      if (c === '>'){ pos += 0.5 * lastDur; brokenMul = 0.5; i++; continue; }                 // broken rhythm A>B
      if (c === '<'){ pos -= 0.5 * lastDur; brokenMul = 1.5; i++; continue; }                 // broken rhythm A<B
      // tuplet "(p" (vs slur "(")
      if (c === '(' && /\d/.test(music[i+1] || "")){ var p = parseInt(music[i+1], 10);
        tupletLeft = p; tupletMul = (TUPLET_TIME[p] || 2) / p; i += 2;
        if (music[i] === ':'){ while (i < music.length && /[:\d]/.test(music[i])) i++; }       // (p:q:r — ignore q/r
        continue; }
      if (c === '(' || c === ')' || c === '-'){ i++; continue; }                              // slurs / ties
      // inline field or note-chord group in brackets
      if (c === '['){
        if (/^[A-Z]:/.test(music.slice(i+1))){ var ef = music.indexOf(']', i+1); if (ef >= 0){
          var fld = music.slice(i+1, ef);
          if (/^M:/.test(fld)){                                 // inline meter change e.g. [M:3/4]
            var inM = parseMeter(fld.slice(2).trim());
            meter = inM; unitsPerBar = (inM.n / inM.d) / unit; unitsPerBeat = (1 / inM.d) / unit;
            cur.meter = { n:inM.n, d:inM.d };
          }
          else if (/^P:/.test(fld)){                            // a section label: on this bar if nothing is in it yet, else on the next
            if (!content && !cur.chords.length) cur.section = fld.slice(2).trim(); else pendingSection = fld.slice(2).trim();
          }
          i = ef+1; continue; } }
        // volta bracket [1 or [2 — mark the current bar as that ending
        if (/^[12]/.test(music[i+1])){ flush("plain"); cur.ending = parseInt(music[i+1], 10); i += 2; continue; }
        var eg = music.indexOf(']', i+1);
        if (eg >= 0){ if (cur.at == null) cur.at = srcOff(i); if (groupBoundary){ cur.groupOnsets.push(pos); groupBoundary = false; }
          var d = readDuration(music, eg+1); var dur;
          if (d.next === eg+1){
            // No explicit duration after ] — derive from the first note's duration inside the bracket.
            // [c2e2] → the '2' belongs to each inner note (duration 2), not after ].
            var inner = music.slice(i+1, eg);
            var nm2 = /(?:\^\^|\^|__|_|=)?[A-Ga-gxzZ][,']*/.exec(inner);
            if (nm2){ var di = readDuration(inner, nm2.index + nm2[0].length); dur = applyMods(di.dur); }
            else { dur = applyMods(1); }
          } else { dur = applyMods(d.dur); }
          pos += dur; lastDur = dur; content = true; lastWasNote = true; i = d.next; continue; }
      }
      // barlines (longest match first)
      if (music.substr(i,2) === "|]"){ flush("final"); i += 2; continue; }
      if (music.substr(i,2) === ":|" && music[i+2] === ":"){ flush("repeat-close-open"); i += 3; continue; }
      if (music.substr(i,2) === ":|" && /[12]/.test(music[i+2])){ flush("repeat-close"); cur.ending = parseInt(music[i+2], 10); i += 3; continue; }
      if (music.substr(i,2) === "::"){ flush("repeat-close-open"); i += 2; continue; }
      if (music.substr(i,2) === ":|"){ flush("repeat-close"); i += 2; continue; }
      if (music.substr(i,2) === "|:"){ flush("plain"); cur.left = pendingLeft = "repeat-open"; i += 2; continue; } // also tag the already-created next bar
      if (music.substr(i,2) === "||"){ flush("double"); i += 2; continue; }
      if (music.substr(i,2) === "[|"){ flush("double"); i += 2; continue; }
      // volta pipe |1 or |2 — flush current bar and mark the new bar as that ending
      if (c === '|' && /[12]/.test(music[i+1])){ flush("plain"); cur.ending = parseInt(music[i+1], 10); i += 2; continue; }
      if (c === '|'){ flush("plain"); i += 1; continue; }
      // note: [accidental][letter][octave marks][duration]
      var nm = /^(\^\^|\^|__|_|=)?([A-Ga-gxzZ])([,']*)/.exec(music.slice(i));
      if (nm){
        if (cur.at == null) cur.at = srcOff(i);
        if (groupBoundary && nm[2] !== 'z' && nm[2] !== 'Z'){ cur.groupOnsets.push(pos); groupBoundary = false; }
        var dd = readDuration(music, i + nm[0].length);
        // Z = multi-bar rest: Z1 = 1 bar, Z2 = 2 bars, Z alone = 1 bar
        var dur2 = applyMods(nm[2] === 'Z' ? unitsPerBar * dd.dur : dd.dur);
        pos += dur2; lastDur = dur2;                          // octave marks (nm[2]) don't affect duration
        content = true; lastWasNote = (nm[2] !== 'z' && nm[2] !== 'Z'); i = dd.next; continue;
      }
      i++;                                                    // decorations / stray chars
    }
    if (content || cur.chords.length){ cur.right = (cur.right === "plain") ? "final" : cur.right; cur.lengthUnits = pos; cur.fullUnits = unitsPerBar; bars.push(cur); }

    // Anacrusis (pickup): a partial leading bar. The first FULL bar is measure 1; the
    // pickup is measure 0. Numbering ripples from there (used by the chart + the
    // recording count-off so every tool agrees on "measure 1").
    var anacrusis = bars.length > 1 && (bars[0].lengthUnits + 1e-6) < bars[0].fullUnits;      // (against its own meter: a later change of meter does not make bar 1 a pickup)
    var anacrusisUnits = anacrusis ? bars[0].lengthUnits : 0;
    if (anacrusis) bars[0].anacrusis = true;
    for (var bi = 0, mno = anacrusis ? 0 : 1; bi < bars.length; bi++) bars[bi].measureNo = mno++;
    // Bars that do not hold what their meter says (bar.misfit; listed by check()). Not the pickup, not the last bar that
    // completes it, and not the two halves of a bar split by a repeat or double barline.
    bars.forEach(function(b, k){
      if (b.anacrusis || Math.abs(b.lengthUnits - b.fullUnits) < 1e-6) return;
      if (anacrusis && k === bars.length - 1 && Math.abs(b.lengthUnits + anacrusisUnits - b.fullUnits) < 1e-6) return;
      var nb = bars[k + 1], pb = bars[k - 1];
      if (nb && b.right !== "plain" && Math.abs(b.lengthUnits + nb.lengthUnits - b.fullUnits) < 1e-6) return;
      if (pb && pb.right !== "plain" && !pb.misfit && Math.abs(b.lengthUnits + pb.lengthUnits - pb.fullUnits) < 1e-6 && Math.abs(pb.lengthUnits - pb.fullUnits) > 1e-6) return;
      b.misfit = true; });

    // Per-tune layout, hard-codable in the ABC (opts can still override at render):
    //   %%score-bars N         → N measures per line (instead of the default 4)
    //   %%score-breaks a,b,c   → explicit measures-per-line for successive lines
    var bprM = /^%%\s*score-bars\s+(\d+)/m.exec(abc);
    var brkM = /^%%\s*score-breaks\s+([\d,\s]+)/m.exec(abc);
    var lineBreaks = brkM ? brkM[1].split(",").map(function(x){ return parseInt(x,10); }).filter(function(x){ return x > 0; }) : null;
    // Otherwise the chart follows the lines of the ABC: the bars written on one line make one row. (A whole tune written on a
    // single line of more than eight bars is taken as unformatted and gets the default four to a row.)
    var srcBreaks = null;
    if (!lineBreaks && !bprM){ var counts = [], lastLine = null;
      bars.forEach(function(b){ if (b.anacrusis) return; if (b.srcLine !== lastLine){ counts.push(0); lastLine = b.srcLine; } counts[counts.length - 1]++; });
      if (counts.length > 1 || (counts.length === 1 && counts[0] <= 8)) srcBreaks = counts; }

    // Detect beat grouping for asymmetric meters (5/8, 7/8, etc.) by reading the
    // beam-group boundaries that were recorded during note parsing above.
    // For symmetric meters (≤4 beats, compound) we leave this null.
    var isCompM = meter0.d >= 8 && meter0.n % 3 === 0 && meter0.n >= 6;
    var beatGrouping = (meter0.n > 4 && !isCompM) ? detectGroupingFromBars(bars, unitsPerBar0) : null;

    return {
      title: field(abc, "T") || "Untitled", composer: field(abc, "C"),
      meterStr: field(abc, "M") || "", meterN: meter0.n, meterD: meter0.d, unitL: unit,
      keyField: keyField, keyPc: keyPc,
      unitsPerBar: unitsPerBar0, unitsPerBeat: unitsPerBeat0, beatsPerBar: meter0.n,
      anacrusis: anacrusis, anacrusisUnits: anacrusisUnits,
      barsPerRow: bprM ? parseInt(bprM[1], 10) : 0, lineBreaks: lineBreaks, srcBreaks: srcBreaks,
      bars: bars, abc: abc, playOrder: computePlayOrder(bars), beatGrouping: beatGrouping
    };
  }

  // Rewrite the marks the band reads from the chart. m.stops = [bar index, ...] and / or m.fills = { bar index: "small" | "medium" | "large" }
  // (indexes into parse(abc).bars); a kind that is given replaces every mark of that kind, a kind left out is not touched.
  // Returns the new ABC: "^stop" / "^fill" / "^small fill" / "^big fill" written at the start of each bar.
  function setMarks(abc, m){
    m = m || {};
    var cuts = [], ins = [];
    parse(abc).bars.forEach(function(b){ (b.marks || []).forEach(function(k){ if (k.from >= 0 && ((k.kind === "stop" && m.stops) || (k.kind === "fill" && m.fills))) cuts.push(k); }); });
    cuts.sort(function(a, b){ return b.from - a.from; }).forEach(function(k){ abc = abc.slice(0, k.from) + abc.slice(k.to); });
    parse(abc).bars.forEach(function(b, i){ var t = "";
      if (m.stops && m.stops.indexOf(i) >= 0) t += '"^stop"';
      if (m.fills && m.fills[i]) t += m.fills[i] === "small" ? '"^small fill"' : m.fills[i] === "large" ? '"^big fill"' : '"^fill"';
      if (t && b.at >= 0) ins.push({ at: b.at, t: t }); });
    ins.sort(function(a, b){ return b.at - a.at; }).forEach(function(x){ abc = abc.slice(0, x.at) + x.t + abc.slice(x.at); });
    return abc;
  }

  // The bars whose contents do not add up to their meter: [{ bar (index), measureNo, meter:"4/4", have, want }] (have / want in
  // beats of that meter's lower number). Empty when the ABC is sound.
  function check(p){
    var out = []; if (!p || !p.bars) return out;
    p.bars.forEach(function(b, k){ if (!b.misfit) return; var m = b.meter || { n: p.meterN, d: p.meterD }, per = b.fullUnits / m.n;
      out.push({ bar: k, measureNo: b.measureNo, meter: m.n + "/" + m.d, want: m.n, have: Math.round(b.lengthUnits / per * 100) / 100 }); });
    return out;
  }

  // Analyse beam-group boundaries recorded in bar.groupOnsets to determine the sub-beat
  // grouping of an asymmetric meter (e.g. [3,2,2] for 7/8 beamed as GGG d2 dd).
  // Returns an array of L-unit group sizes, or null if no consistent pattern is found.
  function detectGroupingFromBars(bars, unitsPerBar){
    var countMap = {};
    bars.forEach(function(b){
      if (!b.groupOnsets || !b.groupOnsets.length) return;
      if (Math.abs(b.lengthUnits - unitsPerBar) > 0.5) return; // skip anacrusis / final partial bar
      var onsets = b.groupOnsets, groups = [];
      for (var k = 0; k < onsets.length; k++){
        var end = k + 1 < onsets.length ? onsets[k+1] : b.lengthUnits;
        groups.push(Math.round((end - onsets[k]) * 100) / 100); // round to avoid float noise
      }
      var key = groups.join(',');
      countMap[key] = (countMap[key] || 0) + 1;
    });
    var keys = Object.keys(countMap);
    if (!keys.length) return null;
    var best = keys.sort(function(a, b){ return countMap[b] - countMap[a]; })[0];
    return best.split(',').map(Number);
  }

  // Expand repeats + D.C./D.S./Fine into the sequence of written-bar indices that playback visits.
  // Handles |: … :| (incl. implicit start-of-tune open), ::, 1st/2nd volta, and jump directives:
  //   !fine!         — marks the stopping point for D.C./D.S. al Fine jumps
  //   !segno!        — marks the jump-back target for D.S. variants
  //   !D.C.alfine!   — jump back to bar 0, stop at Fine
  //   !D.S.alfine!   — jump back to !segno!, stop at Fine
  //   !D.C.!  !D.S.! — full repeat without a Fine stop (play through to end)
  function computePlayOrder(bars){
    var n = bars.length;
    // Locate landmark bars for jump directives.
    var fineIdx = -1, segnoIdx = -1, jumpIdx = -1, jumpType = null;
    for (var k = 0; k < n; k++){
      var dd = bars[k].decors;
      if (!dd) continue;
      for (var m2 = 0; m2 < dd.length; m2++){
        if (dd[m2] === 'fine' && fineIdx < 0)  fineIdx  = k;
        if (dd[m2] === 'segno')                 segnoIdx = k;
        if (!jumpType && (dd[m2] === 'D.C.alfine' || dd[m2] === 'D.S.alfine' ||
                          dd[m2] === 'D.C.'       || dd[m2] === 'D.S.')){
          jumpIdx  = k;
          jumpType = dd[m2];
        }
      }
    }
    // First pass: expand barline repeats through to the jump bar (or the end).
    var passEnd = (jumpIdx >= 0) ? jumpIdx : n - 1;
    var order = [], startStack = [0];
    for (var i = 0; i <= passEnd; i++){
      var b = bars[i];
      if (b.left === "repeat-open") startStack.push(i);
      order.push(i);
      if ((b.right === "repeat-close" || b.right === "repeat-close-open") && b.ending !== 2){
        var start = startStack[startStack.length - 1];
        for (var j = start; j <= i; j++){ if (bars[j].ending === 1) continue; order.push(j); }
        if (startStack.length > 1) startStack.pop();
      }
    }
    // Any written bars after the jump bar (but before the true end) play once before the jump.
    for (var i2 = passEnd + 1; i2 < n && jumpIdx >= 0; i2++) order.push(i2);

    // Second pass: D.C./D.S. jump — repeat from target to Fine (or end).
    if (jumpIdx >= 0){
      var jumpStart = (jumpType === 'D.S.alfine' || jumpType === 'D.S.') ? Math.max(0, segnoIdx) : 0;
      var jumpStop  = (jumpType === 'D.C.alfine' || jumpType === 'D.S.alfine')
                        ? (fineIdx >= 0 ? fineIdx : n - 1) : n - 1;
      var startStack2 = [jumpStart];
      for (var i3 = jumpStart; i3 <= jumpStop; i3++){
        var b3 = bars[i3];
        if (b3.left === "repeat-open") startStack2.push(i3);
        order.push(i3);
        if ((b3.right === "repeat-close" || b3.right === "repeat-close-open") && b3.ending !== 2){
          var start3 = startStack2[startStack2.length - 1];
          for (var j3 = start3; j3 <= i3; j3++){ if (bars[j3].ending === 1) continue; order.push(j3); }
          if (startStack2.length > 1) startStack2.pop();
        }
      }
    }
    return order;
  }

  // ---- chord symbol formatting + transpose ----
  function transposeSym(sym, semis, preferFlats){
    if (!semis) return sym;
    var names = preferFlats ? ASCII_FLAT : ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    return sym.replace(/([A-G])([#b]*)/g, function(m, L, acc){
      var pc = PC[L]; for (var k=0;k<acc.length;k++) pc += (acc[k]==="#"?1:-1);
      return names[mod12(pc + semis)];
    });
  }
  function fmtChord(sym, semis, preferFlats){
    sym = transposeSym(sym, semis, preferFlats);
    var bass = "", slash = sym.indexOf("/");
    if (slash >= 0){ bass = sym.slice(slash+1); sym = sym.slice(0, slash); }
    var m = /^([A-G][#b]*)(.*)$/.exec(sym); if (!m) return esc(sym);
    var pretty = function(s){ return esc(s).replace(/#/g,"♯").replace(/b/g,"♭"); };
    var html = '<span class="tc-rt">'+pretty(m[1])+'</span>';
    if (m[2]) html += '<span class="tc-q">'+pretty(m[2])+'</span>';
    if (bass) html += '<span class="tc-bass">/'+pretty(bass)+'</span>';
    return html;
  }
  // current key name for the header, given transpose
  function keyName(keyPc, semis, preferFlats){ return (preferFlats ? FLAT : SHARP)[mod12(keyPc + semis)]; }

  // ---- one-time scoped CSS ----
  function injectCss(){
    if (document.getElementById("tune-chart-css")) return;
    if (!document.getElementById("tune-chart-fonts")){
      var lk = document.createElement("link"); lk.id = "tune-chart-fonts"; lk.rel = "stylesheet";
      lk.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=JetBrains+Mono:wght@500;600&display=swap";
      document.head.appendChild(lk);
    }
    // Bravura: SMuFL font for U+E504 (repeatBarSlash) and other music glyphs
    if (!document.getElementById("tune-chart-bravura")){
      var bst = document.createElement("style"); bst.id = "tune-chart-bravura";
      bst.textContent = "@font-face{font-family:'Bravura';src:url('https://raw.githubusercontent.com/steinbergmedia/bravura/master/redist/woff/Bravura.woff2')format('woff2');font-display:swap}";
      document.head.appendChild(bst);
    }
    var css = ''
    + '.tune-chart{--tc-paper:#f4efe2;--tc-paper-2:#f7f2e6;--tc-edge:#e6dcc4;--tc-line:#cdbf9f;'
    +   '--tc-ink:#22201b;--tc-faint:#b7a987;--tc-sub:#d9ccae;--tc-live:#3fc2b4;--tc-live-soft:rgba(63,194,180,.16);'
    +   'background:linear-gradient(180deg,var(--tc-paper-2),var(--tc-paper));color:var(--tc-ink);'
    +   'border:1px solid var(--tc-edge);border-radius:6px;padding:clamp(1rem,2.4vw,1.8rem);font-family:"Oswald",sans-serif}'
    + '.tune-chart .tc-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap;'
    +   'border-bottom:2px solid var(--tc-ink);padding-bottom:.6rem;margin-bottom:1rem}'
    + '.tune-chart .tc-title{font-weight:700;text-transform:uppercase;letter-spacing:.02em;font-size:clamp(1.1rem,2.6vw,1.7rem);line-height:1}'
    + '.tune-chart .tc-by{font-family:Inter,system-ui,sans-serif;font-size:.78rem;color:#6f6450;font-style:italic;margin-top:.25rem}'
    + '.tune-chart .tc-meta{font-family:"JetBrains Mono",monospace;font-size:.8rem;color:#6f6450;text-align:right;white-space:nowrap}'
    + '.tune-chart .tc-meta b{color:var(--tc-ink);font-weight:600}'
    + '.tune-chart.tc-has-pickup{padding-top:calc(clamp(1rem,2.4vw,1.8rem) + .6rem)}'
    + '.tune-chart .tc-pickup{display:inline-flex;align-items:center;gap:.45rem;margin:0 0 .55rem;padding:.18rem .55rem;'
    +   'border:1.5px solid var(--tc-ink);border-radius:4px;background:rgba(0,0,0,.03);'
    +   'font-family:"JetBrains Mono",monospace;font-size:.62rem;text-transform:uppercase;letter-spacing:.12em;color:var(--tc-ink);transition:background .14s}'
    + '.tune-chart .tc-pickup .tc-pk-arrow{font-size:.9rem;line-height:1}'
    + '.tune-chart .tc-pickup .tc-pk-chord{font-family:"Oswald",sans-serif;font-size:1.05rem;letter-spacing:0;font-weight:600}'
    + '.tune-chart .tc-pickup.tc-live{background:var(--tc-live-soft);border-color:var(--tc-live)}'
    + '.tune-chart .tc-systems{display:flex;flex-direction:column;gap:.5rem}'
    + '.tune-chart .tc-system{display:grid;border-left:2px solid var(--tc-ink)}'
    + '.tune-chart .tc-bar{position:relative;min-height:60px;border-right:2px solid var(--tc-ink);'
    +   'border-top:1px solid var(--tc-line);border-bottom:1px solid var(--tc-line);overflow:hidden;transition:background .14s;cursor:pointer}'
    + '.tune-chart .tc-subline{position:absolute;top:0;bottom:0;width:1px;background:var(--tc-sub);pointer-events:none}'
    + '.tune-chart .tc-chord{position:absolute;top:50%;transform:translateY(-50%);white-space:nowrap;font-weight:600;line-height:.9;letter-spacing:.01em}'
    + '.tune-chart .tc-rt{font-size:1.6rem}'
    + '.tune-chart.tc-roman-mode .tc-rt{font-size:1.3rem;font-family:"JetBrains Mono",monospace;letter-spacing:.01em}'
    + '.tune-chart.tc-roman-both .tc-chord{display:flex;flex-direction:column;align-items:flex-start;gap:.3rem}'
    + '.tune-chart .tc-lt{display:block;white-space:nowrap}'
    + '.tune-chart .tc-rn{display:block;font-family:"JetBrains Mono",monospace;font-size:.72rem;font-weight:600;line-height:1;color:#6f6450;letter-spacing:.02em}'
    + '.tune-chart .tc-q{font-size:.95rem;font-weight:600;position:relative;top:-.55em;margin-left:.02em;color:#3a352b}'
    + '.tune-chart .tc-bass{font-size:1rem;color:#6f6450}'
    + '.tune-chart .tc-nc-chord{font-size:.9rem;font-style:italic;color:var(--tc-faint)}'
    + '.tune-chart .tc-beat-slash{position:absolute;top:50%;transform:translateY(-50%);font-family:"Bravura",serif;font-size:1.5rem;color:var(--tc-sub);line-height:1;pointer-events:none}'
    + '.tune-chart .tc-bar.tc-empty::after{content:"";font-family:"Bravura",serif;position:absolute;left:.2rem;top:50%;transform:translateY(-50%);color:var(--tc-sub);font-size:1.5rem;line-height:1}'
    + '.tune-chart .tc-bar.tc-nc-bar::after,.tune-chart.tc-with-beats .tc-bar.tc-empty::after{content:none}'
    + '.tune-chart .tc-bar[data-right="double"]{box-shadow:3px 0 0 -1px var(--tc-ink)}'
    + '.tune-chart .tc-bar[data-right="final"]{box-shadow:5px 0 0 -1px var(--tc-ink)}'
    + '.tune-chart .tc-bar[data-right="repeat-close"]{box-shadow:4px 0 0 -1px var(--tc-ink)}'
    + '.tune-chart .tc-bar[data-right="repeat-close"]::before{content:"";position:absolute;right:5px;top:50%;transform:translateY(-50%);width:4px;height:4px;border-radius:50%;background:var(--tc-ink);box-shadow:0 -8px 0 var(--tc-ink)}'
    + '.tune-chart .tc-bar[data-left="repeat-open"]{box-shadow:inset 3px 0 0 -1px var(--tc-ink)}'
    + '.tune-chart .tc-bar[data-left="repeat-open"] .tc-open{position:absolute;left:4px;top:50%;transform:translateY(-50%);width:4px;height:4px;border-radius:50%;background:var(--tc-ink);box-shadow:0 -8px 0 var(--tc-ink)}'
    + '.tune-chart .tc-ending{position:absolute;top:2px;left:5px;font-family:"JetBrains Mono",monospace;font-size:.62rem;color:var(--tc-ink);border-top:1.5px solid var(--tc-ink);border-left:1.5px solid var(--tc-ink);padding:1px 0 0 3px;min-width:1.3em}'
    // a section label (P:Verse in the ABC) at the top left of the bar it starts on, set in far enough to clear a time signature there, and a fill mark ("^fill") in the bottom right
    + '.tune-chart .tc-section{position:absolute;top:2px;left:2.4rem;max-width:calc(100% - 2.8rem);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"JetBrains Mono",monospace;font-size:.62rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--tc-ink)}'
    + '.tune-chart .tc-fillmark{position:absolute;bottom:2px;right:6px;font-family:"JetBrains Mono",monospace;font-size:.58rem;font-style:italic;color:var(--tc-faint);pointer-events:none}'
    + '.tune-chart .tc-meter{position:absolute;top:3px;left:4px;display:flex;flex-direction:column;align-items:center;font-family:"JetBrains Mono",monospace;font-weight:700;line-height:1;color:var(--tc-ink)}'
    // a change of meter: one line (6/8) in the top left corner of its own bar, above the chords; when the bar starts a row, also a grey
    // stacked courtesy signature at the far right of the bar before it
    + '.tune-chart .tc-systems .tc-bar.tc-misfit{border-bottom:3px solid #d9822b}'
    + '.tune-chart .tc-meter.tc-own{top:1px;flex-direction:row;align-items:baseline}'
    + '.tune-chart .tc-own .tc-mn{border-bottom:0;padding-bottom:0}'
    + '.tune-chart .tc-own .tc-mn::after{content:"/"}'
    + '.tune-chart .tc-meter.tc-courtesy{left:auto;right:2px;top:2px;color:var(--tc-faint)}'
    + '.tune-chart .tc-mn,.tune-chart .tc-md{display:block;font-size:.6rem;line-height:1.15}'
    + '.tune-chart .tc-mn{border-bottom:1px solid currentColor;padding-bottom:1px}'
    + '.tune-chart .tc-bar.tc-live{background:var(--tc-live-soft)}'
    + '.tune-chart .tc-bar.tc-live::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--tc-live)}'
    + '.tune-chart .tc-bar.tc-live .tc-chord{color:#0c5a52}'
    + '@media (max-width:560px){.tune-chart .tc-rt{font-size:1.3rem}.tune-chart.tc-roman-both .tc-rt{font-size:1.1rem}.tune-chart.tc-roman-both .tc-rn{font-size:.66rem}}';
    var st = document.createElement("style"); st.id = "tune-chart-css"; st.textContent = css; document.head.appendChild(st);
  }

  // ---- render ----
  function render(container, abc, opts){
    injectCss();
    opts = opts || {};
    var state = {
      parsed: (typeof abc === "string") ? parse(abc) : abc,
      subBarBeats: opts.subBarBeats || 0,
      transpose: opts.transpose || 0,
      preferFlats: opts.preferFlats !== false,
      roman: romanMode(opts.roman),
      keyNote: opts.keyNote || "",
      header: opts.header !== false,
      opts: opts,           // keep the explicit overrides; per-tune layout is read in draw()
      barEls: [], liveBar: -2,
      introLen: 0, introBars: []  // set by setIntro() when an arranger intro is active
    };
    container.classList.add("tune-chart");

    // group the measure-bar indices into rows: explicit lineBreaks win, else barsPerRow
    function buildRows(indices, perRow, lineBreaks){
      var rows = [], i = 0;
      if (lineBreaks && lineBreaks.length){
        for (var L = 0; i < indices.length; L++){
          var n = (L < lineBreaks.length) ? lineBreaks[L] : perRow;
          rows.push(indices.slice(i, i + n)); i += n;
        }
      } else { for (; i < indices.length; i += perRow) rows.push(indices.slice(i, i + perRow)); }
      return rows;
    }
    function fillChord(cell, bar, upb){
      bar.chords.forEach(function(ch){
        var el = document.createElement("span");
        var leftCss = "calc(" + (100 * ch.onset / upb) + "% + .2rem)";
        if (ch.nc){
          el.className = "tc-chord tc-nc-chord"; el.textContent = "N.C."; el.style.left = leftCss;
          cell.appendChild(el); return;
        }
        el.className = "tc-chord"; el.style.left = leftCss;
        // opts.romanFn(sym, keyPc) lets a host supply its own numerals (default: TuneLibrary's applied-chord analysis)
        var rnFn = state.opts.romanFn || (global.TuneLibrary && TuneLibrary.roman), haveRn = !!rnFn;
        if (state.roman === "only" && haveRn){
          var rn = rnFn(ch.sym, state.parsed.keyPc);
          el.innerHTML = '<span class="tc-rt">' + esc(rn || ch.sym) + '</span>';
        } else {
          var letters = fmtChord(ch.sym, state.transpose, state.preferFlats), rn2 = (state.roman === "both" && haveRn) ? rnFn(ch.sym, state.parsed.keyPc) : null;
          el.innerHTML = rn2 ? '<span class="tc-lt">' + letters + '</span><span class="tc-rn">' + esc(rn2) + '</span>' : letters;
        }
        cell.appendChild(el);
      });
    }

    function draw(){
      var p = state.parsed;
      var perRow = state.opts.barsPerRow || p.barsPerRow || 4;
      var lineBreaks = state.opts.lineBreaks || p.lineBreaks || null;
      // the ABC's own lines (unless the caller or the ABC set a layout): rows as written, every row as wide as the longest (four at least for a one-line tune)
      var srcCols = 0;
      if (!lineBreaks && !state.opts.barsPerRow && !p.barsPerRow && p.srcBreaks){ lineBreaks = p.srcBreaks; srcCols = Math.max.apply(null, lineBreaks.concat(lineBreaks.length === 1 ? [4] : [])); }
      var upb = p.unitsPerBar || 1, beats = p.beatsPerBar || 4;
      container.innerHTML = "";
      container.classList.toggle("tc-has-pickup", !!p.anacrusis);
      container.classList.toggle("tc-roman-mode", state.roman === "only");
      container.classList.toggle("tc-roman-both", state.roman === "both");
      state.barEls = new Array(p.bars.length); state.liveBar = -2;   // fresh DOM ⇒ re-apply highlight

      if (state.header){
        var h = document.createElement("div"); h.className = "tc-head";
        var left = document.createElement("div");
        var t = document.createElement("div"); t.className = "tc-title"; t.textContent = p.title; left.appendChild(t);
        if (p.composer){ var by = document.createElement("div"); by.className = "tc-by"; by.textContent = "by " + p.composer; left.appendChild(by); }
        var meta = document.createElement("div"); meta.className = "tc-meta";
        meta.innerHTML = "<b>" + keyName(p.keyPc, state.transpose, state.preferFlats) + "</b>"
          + (state.keyNote ? " <span class='tc-keynote' style='color:#9c7a3d'>(" + esc(state.keyNote) + ")</span>"
            : state.transpose ? " <span style='color:#9c7a3d'>(from " + FLAT[p.keyPc] + ")</span>" : "")
          + (p.meterStr ? "  ·  " + esc(p.meterStr) : "");
        h.appendChild(left); h.appendChild(meta); container.appendChild(h);
      }

      // pickup flag (top-left). It IS bar 0 for highlighting, so the live bar can sit on
      // it while the anacrusis plays. May carry the pickup's chord.
      if (p.anacrusis){
        var pk = document.createElement("div"); pk.className = "tc-pickup";
        var arrow = document.createElement("span"); arrow.className = "tc-pk-arrow"; arrow.textContent = "⤴"; pk.appendChild(arrow);
        var lab = document.createElement("span"); lab.textContent = "Pickup"; pk.appendChild(lab);
        var pkc = p.bars[0].chords;
        if (pkc && pkc.length){ var cc = document.createElement("span"); cc.className = "tc-pk-chord";
          cc.innerHTML = fmtChord(pkc[0].sym, state.transpose, state.preferFlats); pk.appendChild(cc); }
        container.appendChild(pk); state.barEls[0] = pk;
      }

      container.classList.toggle("tc-with-beats", state.subBarBeats > 0);
      var sys = document.createElement("div"); sys.className = "tc-systems"; container.appendChild(sys);
      var startBar = p.anacrusis ? 1 : 0, idxs = [];
      for (var bb = startBar; bb < p.bars.length; bb++) idxs.push(bb);
      var rows = buildRows(idxs, perRow, lineBreaks);

      // Show a stacked time-signature indicator whenever the meter changes bar-to-bar.
      // Seed lastMeter with the tune's initial meter so the first bar doesn't duplicate
      // what the header already shows; use a sentinel when the header is hidden so the
      // very first bar shows the initial meter.
      var lastMeter = state.header ? { n:p.meterN, d:p.meterD } : { n:-1, d:-1 };

      var prevCell = null;                                    // the bar before, for a courtesy time signature
      rows.forEach(function(rowIdxs){
        var cols = srcCols || (lineBreaks ? rowIdxs.length : perRow);     // uniform mode pads to perRow
        var row = document.createElement("div"); row.className = "tc-system";
        row.style.gridTemplateColumns = "repeat(" + cols + ",1fr)";
        for (var c = 0; c < cols; c++){
          var cell = document.createElement("div"); cell.className = "tc-bar";
          if (c < rowIdxs.length){
            var b = rowIdxs[c], bar = p.bars[b];
            cell.setAttribute("data-bar", b);
            cell.setAttribute("data-left", bar.left); cell.setAttribute("data-right", bar.right);
            if (bar.misfit){ cell.classList.add("tc-misfit"); cell.setAttribute("title", "This bar does not add up to its meter"); }
            if (bar.left === "repeat-open"){ var od = document.createElement("span"); od.className = "tc-open"; cell.appendChild(od); }
            if (bar.ending){ var en = document.createElement("span"); en.className = "tc-ending"; en.textContent = bar.ending + "."; cell.appendChild(en); }
            if (bar.section){ var sc = document.createElement("span"); sc.className = "tc-section"; sc.textContent = bar.section; if (bar.ending) sc.style.left = "4.2rem"; cell.appendChild(sc); }                // (an ending bracket pushes the time signature along too)
            if (bar.fill){ var fl = document.createElement("span"); fl.className = "tc-fillmark"; fl.textContent = bar.fill === "small" ? "small fill" : bar.fill === "large" ? "big fill" : "fill";
              fl.setAttribute("title", "The drummer fills at the end of this bar"); cell.appendChild(fl); }
            var bm = bar.meter || { n:p.meterN, d:p.meterD };
            if (bm.n !== lastMeter.n || bm.d !== lastMeter.d){
              var sigHtml = '<span class="tc-mn">'+bm.n+'</span><span class="tc-md">'+bm.d+'</span>';
              var mt = document.createElement("div"); mt.className = "tc-meter tc-own"; mt.innerHTML = sigHtml;
              if (bar.ending) mt.style.left = "1.7rem";              // (clear of the ending bracket)
              cell.appendChild(mt); lastMeter = { n:bm.n, d:bm.d };
              if (c === 0 && prevCell){                               // over a line break: warn at the end of the row above
                var ct = document.createElement("div"); ct.className = "tc-meter tc-courtesy"; ct.innerHTML = sigHtml;
                ct.setAttribute("title", "Next bar: " + bm.n + "/" + bm.d); prevCell.appendChild(ct); }
            }
            prevCell = cell;
            if (state.subBarBeats > 0){
              for (var bt = state.subBarBeats; bt < beats; bt += state.subBarBeats){
                var beatUnits = bt * (p.unitsPerBeat || 1);
                if (beatUnits >= (bar.lengthUnits || upb) - 1e-6) continue;
                var ln = document.createElement("div"); ln.className = "tc-subline";
                ln.style.left = (100 * beatUnits / upb) + "%"; cell.appendChild(ln);
              }
              // Repeat-bar slashes on every beat that has no new chord starting
              var isNcOnly = bar.chords.length && bar.chords.every(function(cc){ return cc.nc; });
              if (!isNcOnly){
                for (var sb = 0; sb < beats; sb += state.subBarBeats){
                  var sbUnits = sb * (p.unitsPerBeat || 1);
                  if (sbUnits >= (bar.lengthUnits || upb) - 1e-6) continue;
                  var hasChordHere = bar.chords.some(function(cc){ return !cc.nc && Math.abs(cc.onset - sbUnits) < 1e-6; });
                  if (!hasChordHere){
                    var slEl = document.createElement("span"); slEl.className = "tc-beat-slash";
                    slEl.textContent = ""; slEl.style.left = "calc(" + (100 * sbUnits / upb) + "% + .2rem)";
                    cell.appendChild(slEl);
                  }
                }
              }
            }
            var realChords = bar.chords.filter(function(cc){ return !cc.nc; });
            var ncChords   = bar.chords.filter(function(cc){ return  cc.nc; });
            if (realChords.length || ncChords.length){ fillChord(cell, bar, Math.max(bar.fullUnits || upb, bar.lengthUnits || 0)); if (ncChords.length && !realChords.length) cell.classList.add("tc-nc-bar"); }
            else cell.classList.add("tc-empty");
            state.barEls[b] = cell;
          } else { cell.style.visibility = "hidden"; }
          row.appendChild(cell);
        }
        sys.appendChild(row);
      });
    }
    draw();

    // Playback sync is POSITIONAL: abcjs tags each note element with an absolute measure
    // class `abcjs-mmN` (N == our bar index, pickup = 0). Reading it from the current
    // event is robust to cycles/loops/seeks/repeats/mid-tune starts — no counting.
    function measureOf(ev){
      var els = ev && ev.elements; if (!els || !els.length) return null;
      for (var i = 0; i < els.length; i++){ var grp = els[i]; if (!grp) continue;
        for (var j = 0; j < grp.length; j++){
          var cls = grp[j] && grp[j].getAttribute && grp[j].getAttribute("class");
          var m = cls && /\babcjs-mm(\d+)\b/.exec(cls); if (m) return parseInt(m[1], 10);
        } }
      return null;
    }

    return {
      get parsed(){ return state.parsed; },
      get barEls(){ return state.barEls; },
      redraw: draw,
      setSubBars: function(n){ state.subBarBeats = n || 0; draw(); },
      setRoman: function(mode){ state.roman = romanMode(mode); draw(); },
      setKeyNote: function(text){ state.keyNote = text || ""; draw(); },
      setTranspose: function(semis, preferFlats){ state.transpose = semis || 0; if (preferFlats != null) state.preferFlats = preferFlats; draw(); },
      setTune: function(newAbc){ state.parsed = (typeof newAbc === "string") ? parse(newAbc) : newAbc; draw(); },
      setLive: function(i){ var wasOff = state.liveBar < 0; if (state.liveBar === i) return; state.liveBar = i;
        state.barEls.forEach(function(el, k){ el.classList.toggle("tc-live", k === i); });
        },
      // Tell the chart how many intro bars precede the main play sequence, and which
      // written-bar indices they map to (for "last-N" intros; empty for count-ins).
      setIntro: function(len, bars){ state.introLen = len || 0; state.introBars = bars || []; },
      // map the m-th played measure (in the expanded/repeated timeline) back to its
      // written bar and highlight that. Cycles via % so repeats > 1 wrap correctly.
      setPlayMeasure: function(m){
        var po = state.parsed.playOrder || [];
        var il = state.introLen || 0;
        var mm = m - il;
        if (m < 0){ this.setLive(-1); return; }
        if (mm < 0){
          // Still in the intro: highlight the corresponding intro bar (if it's a tune bar).
          var ib = state.introBars || [];
          this.setLive(m < ib.length ? ib[m] : -1); return;
        }
        if (!po.length){ this.setLive(mm); return; }
        this.setLive(po[mm % po.length]);
      },
      // feed every abcjs cursor event here; highlights the written bar of the sounding
      // note (loop/seek/repeat-safe). Call resetPlayback() on start/finish.
      resetPlayback: function(){ this.setLive(-1); },
      onPlaybackEvent: function(ev){
        var mm = measureOf(ev); if (mm == null) return;
        this.setPlayMeasure(mm);
      },
      get playOrder(){ return state.parsed.playOrder || []; }
    };
  }

  global.TuneChart = { parse: parse, check: check, setMarks: setMarks, render: render, transposeSym: transposeSym, fmtChord: fmtChord };
})(typeof window !== "undefined" ? window : globalThis);
