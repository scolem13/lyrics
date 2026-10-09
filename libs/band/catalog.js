// catalog.js — names and plain-language descriptions of what the backing band can play
// (BandCatalog). ONE list, read by the Backing Track page (its menus) and the
// Accompaniment Styles page (its catalog cards), so the two never drift apart.
// Load after comp.js: comping entries pick up their rhythm from BandComp.FIGURES.
//
//   BandCatalog.bass   -> [{ id, label, feel, desc, tags }]      id = ctx.opts.bassFeel
//   BandCatalog.comp   -> [{ id, label, feel, desc, tags, hits }] id = ctx.opts.compRhythm
//       hits = [[beat, "L" | "S"], ...] for a fixed one-bar figure (x.5 = the off-beat eighth,
//       L = held, S = short stab), or null when the rhythm is not one fixed bar.
//   BandCatalog.drums  -> [{ id, label, feel, desc, tags }]       id = ctx.opts.groove
//   BandCatalog.voicings -> { piano: { <style id>: { fits, tags } }, guitar: { ... } }  (names live in BandHarmony.styleList)
//   Every entry carries group (the menu heading: "Jazz" | "Latin" | "Caribbean" | "Folk, rock and pop")
//   and fits = the ids of the styles it belongs in. The Backing Track page offers only what fits the
//   chosen style unless its Unlock box is ticked.
//   BandCatalog.styles -> [{ id, label, group, genres, desc, feel, bass, rhythm, drums, voicing:{ piano, guitar } }]
//       (ext:true = a style where players add unmarked 9ths, 13ths and 6ths)
//       a genre and its defaults: the feel, bass line, comping rhythm, drum groove and voicings that belong together.
//   BandCatalog.fits(entry, styleId) -> does that entry belong in that style
//   BandCatalog.feels / .cymbals -> [{ id, label, desc }]         ids = opts.feel / opts.ride
//   BandCatalog.url({ bass, rhythm, feel, comp }) -> link that opens the Backing Track
//       page with those choices preselected (it reads the same query names).
// tune on a bass / comp entry = the tune the figure comes from (group "From tunes"); after = what the
// band plays instead once the head is over, when the page's "Figure from the tune" says first chorus only.
// feel on an entry = the feel it is written for ("swing" | "straight" | "any").

(function (global) {
  var FIG = (global.BandComp && global.BandComp.FIGURES) || {};
  function hits(id){ return FIG[id] ? FIG[id].map(function (h){ return [h[0], h[1]]; }) : null; }

  var bass = [
    { id:"walk", label:"Walking", feel:"swing", tags:["Jazz","Swing","Blues"],
      desc:"One note on every beat (four quarter notes in 4/4, three in 3/4, dotted quarters in 12/8): the root on beat 1 when the chord changes, chord tones and scale steps in between, and an approach note on beat 4 that leads into the next bar." },
    { id:"two", label:"Two-feel", feel:"swing", tags:["Jazz","Swing"],
      desc:"Half notes on beats 1 and 3, root then fifth, with an occasional pickup into the next bar. The lighter feel a band often plays on the head before the bass starts to walk." },
    { id:"riff", label:"Boogaloo riff", feel:"straight", tags:["Boogaloo","Soul jazz","Rock"],
      desc:"A repeated straight-eighths figure: root on 1, root pushed on the and of 2, then a fifth and flat seventh on beat 4 leading back to the root. The kind of line under Watermelon Man. In 6/8 and 12/8 it becomes a shuffle: each beat played long-short, climbing root, 3rd, 5th, 6th." },
    { id:"riffwalk", label:"Boogaloo riff, walking at times", feel:"straight", tags:["Boogaloo","Soul jazz"],
      desc:"The boogaloo riff, but about half the four-bar phrases end with a bar of walking quarter notes that leads into the next phrase, and now and then two bars." },
    { id:"sowhat", label:"So What: the bass call", feel:"swing", group:"From tunes", tune:"So What", after:"Walking", tags:["Modal jazz"],
      desc:"The bass has the melody. A two-bar figure: the root, then eighth notes up the scale from the fifth (5, 6, 7, root, 9) and back through the seventh to the root on the next downbeat. Then it waits for the chords to answer. Pair it with the So What comping rhythm." },
    { id:"killerjoe", label:"Killer Joe: two-bar vamp", feel:"swing", group:"From tunes", tune:"Killer Joe", after:"Walking", tags:["Hard bop"],
      desc:"A two-bar figure for two chords a whole step apart: the root held for two beats, then two quarter notes that climb into the next root from below (C, G, A into B flat; B flat, G, B into C)." },
    { id:"songfather", label:"Song for My Father: root, fifth, octave", feel:"straight", group:"From tunes", tune:"Song for My Father", after:"Bossa nova", tags:["Bossa nova","Hard bop"],
      desc:"The figure the tune opens with: the root for a beat and a half, the fifth on the and of 2, the octave on beat 3 held to the end of the bar. Steely Dan borrowed it for Rikki Don't Lose That Number." },
    { id:"footprints", label:"Footprints: waltz ostinato", feel:"swing", group:"From tunes", tune:"Footprints", after:"Walking", tags:["Modal jazz"],
      desc:"A two-bar figure in 3/4 (one bar of 6/4): root, fifth, octave in quarter notes, then the third above that octave held for two beats and the fifth to lead back." },
    { id:"allblues", label:"All Blues: 6/8 vamp", feel:"any", group:"From tunes", tune:"All Blues", after:"Walking", tags:["Modal jazz","Blues"],
      desc:"A two-bar figure in 6/8. Each bar is a long note and two short ones: root, fifth, sixth, then seventh, sixth, fifth." },
    { id:"chameleon", label:"Chameleon: chromatic pickup", feel:"straight", group:"From tunes", tune:"Chameleon", after:"Boogaloo riff", tags:["Funk"],
      desc:"The root on beat 1, then two eighth notes on beat 4 that climb by semitones into the next bar's root. Only the skeleton of the record's line." },
    { id:"maiden", label:"Maiden Voyage: roots on the rhythm", feel:"straight", group:"From tunes", tune:"Maiden Voyage", after:"Bossa nova", tags:["Modal jazz"],
      desc:"The bass plays the comping rhythm: 1, the and of 2 and 4 in the first bar, the and of 2 and 4 in the second." },
    { id:"takefive", label:"Take Five: 3 + 2", feel:"swing", group:"From tunes", tune:"Take Five", after:"Walking", tags:["Cool jazz"],
      desc:"For 5/4: root on 1, fifth on the and of 2, then the root on 4 and 5." },
    { id:"roots", label:"Roots on every beat", feel:"any", group:"Folk, rock and pop", tags:["Rock","Pop","Folk"],
      desc:"The root of the chord on every beat and nothing else. The plainest line there is, under driving eighths or a strummed song." },
    { id:"alt", label:"Root and fifth", feel:"any", group:"Folk, rock and pop", tags:["Folk","Country","Polka","Waltz","Calypso"],
      desc:"The boom of boom-chick: the root on beat 1 and the fifth on beat 3, short, the same every bar. In 3/4 it is one note a bar, root one bar and fifth the next." },
    { id:"tresillo", label:"3+3+2 (tresillo)", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Reggaeton"],
      desc:"The root on beat 1 and on the and of 2, the fifth on beat 4: eight eighth notes grouped 3+3+2." },
    { id:"eighths", label:"Root eighths", feel:"straight", group:"Folk, rock and pop", tags:["Rock","Pop","Punk"],
      desc:"The root on every eighth note, the beats a little louder: the rock bass line under With or Without You and a thousand others." },
    { id:"dotted", label:"Dotted (1, and of 2, 3)", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Folk","Ballad"],
      desc:"The root on beat 1, again on the and of 2 and on beat 3, the same rhythm as the kick drum. Every second bar ends with an eighth note that leads into the next chord." },
    { id:"octaves", label:"Octaves (disco)", feel:"straight", group:"Folk, rock and pop", tags:["Disco","Dance","Pop"],
      desc:"The root on every beat and the root an octave up on every off-beat." },
    { id:"motown", label:"Motown: root, fifth, octave", feel:"straight", group:"Folk, rock and pop", tags:["Motown","Soul","Pop"],
      desc:"A two-bar line: the root on 1 and the and of 2, the fifth on 3, then the octave and fifth in eighths; the second bar ends by leading into the next chord. A plain stand-in for a Motown bass part, which would move far more." },
    { id:"held", label:"Held roots (the bass voice)", feel:"any", group:"Hymns and carols", tags:["Hymn","Carol","Chorale"],
      desc:"The root of every chord, held until the next chord: the bass part of a four-part hymn." },
    { id:"halves", label:"Roots on 1 and 3", feel:"any", group:"Hymns and carols", tags:["Carol","Folk","Hymn"],
      desc:"The root on beats 1 and 3, held; one note a bar in 3/4. A chord that changes in between gets its root when it arrives." },
    { id:"twelve8", label:"12/8 ballad", feel:"any", group:"Folk, rock and pop", tags:["Doo-wop","Blues","Ballad"],
      desc:"Long notes on beats 1 and 3, root then fifth, each set up by a short note on the last eighth of the beat before." },
    { id:"bossa", label:"Bossa nova", feel:"straight", group:"Latin", tags:["Bossa nova","Latin"],
      desc:"Root on 1 and fifth on 3, each one set up by an eighth note just before it: the fifth on the and of 2, the next chord's root on the and of 4." },
    { id:"tango", label:"Tango (habanera)", feel:"straight", group:"Latin", tags:["Tango","Latin"],
      desc:"The habanera rhythm: root held for a beat and a half, the fifth on the and of 2, then the root an octave up on 3 and the fifth on 4." },
    { id:"tumbao", label:"Tumbao", feel:"straight", group:"Latin", tags:["Son montuno","Salsa","Latin"],
      desc:"The Cuban bass line that never plays beat 1: the fifth on the and of 2, then on beat 4 the root of the NEXT bar's chord, held over the barline." },
    { id:"chacha", label:"Cha-cha", feel:"straight", group:"Latin", tags:["Cha-cha","Latin"],
      desc:"Root held through beats 1 and 2, the fifth on 3 and the root again on 4." }
  ];
  bass.forEach(function (b){ if (!b.group) b.group = "Jazz"; });

  var comp = [
    { id:"auto", label:"Varied", feel:"any", tags:["Jazz"],
      desc:"The band chooses: two-bar phrases built from the swing figures, with some bars left empty. In straight eighths it plays the boogaloo stabs. Tick rhythms under it and it varies between just those.", hits:null },
    { id:"charleston", label:"Charleston", feel:"swing", tags:["Jazz","Swing"],
      desc:"A held chord on beat 1 and a short one on the and of 2. The first comping rhythm most players learn.", hits:hits("charleston") },
    { id:"reverse", label:"Reverse Charleston", feel:"swing", tags:["Jazz","Swing"],
      desc:"The Charleston displaced: a short chord on the and of 1 and a held one on beat 3.", hits:hits("reverse") },
    { id:"garland", label:"Red Garland", feel:"swing", tags:["Jazz","Hard bop"],
      desc:"Chords on the and of 2 and the and of 4. The second one anticipates the next bar's chord and is held across the barline.", hits:hits("garland") },
    { id:"offbeats", label:"Off-beats", feel:"swing", tags:["Jazz"],
      desc:"Chords on the and of 1 and the and of 3, never on a downbeat.", hits:hits("offbeats") },
    { id:"pad", label:"Long notes", feel:"any", tags:["Ballad","Jazz"],
      desc:"One held chord per bar (or per chord). Leaves the most room for a soloist.", hits:hits("pad") },
    { id:"four", label:"Four to the bar", feel:"swing", tags:["Swing","Big band"],
      desc:"A short chord on every beat with 2 and 4 a little louder, the way Freddie Green played rhythm guitar.", hits:[[0,"S"],[1,"S"],[2,"S"],[3,"S"]] },
    { id:"stabs", label:"Boogaloo stabs", feel:"straight", tags:["Boogaloo","Soul jazz","Rock"],
      desc:"A stab on beat 1, the chord pushed and held on the and of 2, and sometimes an answering stab late in the bar. Locks with the boogaloo bass riff.", hits:[[0,"S"],[1.5,"L"]] },
    { id:"sowhat", label:"So What: the answer", feel:"swing", group:"From tunes", tune:"So What", after:"Varied", tags:["Modal jazz"],
      desc:"A two-bar pattern. Nothing in the first bar, under the bass call. In the second, two chords: the voicing a whole step above the chord, held from beat 3, then the chord itself, short, on the and of 4. Use the Fourths voicing for the sound of the record.", hits:[[2,"L"],[3.5,"S"]] },
    { id:"maiden", label:"Maiden Voyage", feel:"straight", group:"From tunes", tune:"Maiden Voyage", after:"Varied", tags:["Modal jazz"],
      desc:"A two-bar pattern of held chords: 1, the and of 2 and 4 (held over the barline), then the and of 2 and 4.", hits:[[0,"L"],[1.5,"L"],[3,"L"]] },
    { id:"takefive", label:"Take Five vamp", feel:"swing", group:"From tunes", tune:"Take Five", after:"Varied", tags:["Cool jazz"],
      desc:"For 5/4, grouped 3 + 2: a held chord on 1, a short one on the and of 2, then short chords on 4 and 5.", hits:[[0,"L"],[1.5,"S"],[3,"S"],[4,"S"]] },
    { id:"oompah", label:"Boom-chick / oom-pah-pah", feel:"any", group:"Folk, rock and pop", tags:["Folk","Country","Polka","Waltz"],
      desc:"Short chords on the beats the bass leaves free: 2 and 4 in 4/4, 2 and 3 in a waltz. Goes with the Root and fifth bass line.", hits:[[1,"S"],[3,"S"]] },
    { id:"hymn", label:"Hymn: four parts", feel:"any", group:"Hymns and carols", tags:["Hymn","Carol","Chorale"],
      desc:"Every chord played once and held until the next one. On the piano or organ it is four parts: the root in the left hand and three voices above it that move as little as possible from chord to chord. It follows the chart's chords, so a carol written with a chord on every beat sounds like the hymnal.", hits:[[0,"L"]] },
    { id:"ballRock", label:"Ballad: rocking", feel:"any", group:"Folk, rock and pop", tags:["Ballad","Pop"],
      desc:"Quarter notes: the chord on 1, the thumb on 2, the top two notes on 3, the thumb on 4, over held left-hand octaves on the root. On the piano with the Standard voicing the chord is a triad in first inversion.", hits:[[0,"L"],[1,"S"],[2,"L"],[3,"S"]] },
    { id:"ballBroken", label:"Ballad: half-broken", feel:"any", group:"Folk, rock and pop", tags:["Ballad","Pop"],
      desc:"A two-bar pattern. Three notes up the chord (thumb, middle, top) and the whole chord held from beat 3; then the chord held from beat 1 and the three notes on beats 3 and 4.", hits:[[0,"S"],[0.5,"S"],[1,"S"],[2,"L"]] },
    { id:"ballSync", label:"Ballad: syncopated", feel:"any", group:"Folk, rock and pop", tags:["Ballad","Pop"],
      desc:"Three held sounds a bar: the chord on beat 1, its top two notes on the and of 2 and on beat 4 (3+3+2).", hits:[[0,"L"],[1.5,"L"],[3,"L"]] },
    { id:"quarters", label:"Quarter-note chords", feel:"any", group:"Folk, rock and pop", tags:["Pop","Ballad","Rock"],
      desc:"The chord on every beat, held. On the piano the left hand adds the root underneath as each chord arrives: Let It Be, Imagine, Someone Like You.", hits:[[0,"L"],[1,"L"],[2,"L"],[3,"L"]] },
    { id:"triplets", label:"Triplet chords (12/8)", feel:"any", group:"Folk, rock and pop", tags:["Doo-wop","Blues","Ballad"],
      desc:"The chord on all three eighth notes of every beat, the doo-wop piano part. In 4/4 they are played as triplets.", hits:null },
    { id:"eighths", label:"Driving eighths", feel:"straight", group:"Folk, rock and pop", tags:["Rock","Pop"],
      desc:"The chord on every eighth note, the beats a little louder than the off-beats.", hits:[[0,"S"],[0.5,"S"],[1,"S"],[1.5,"S"],[2,"S"],[2.5,"S"],[3,"S"],[3.5,"S"]] },
    { id:"upbeats", label:"Every off-beat", feel:"straight", group:"Caribbean", tags:["Ska","Reggae","Calypso"],
      desc:"A short chord on the and of every beat and never on the beat: the ska and calypso afterbeat.", hits:[[0.5,"S"],[1.5,"S"],[2.5,"S"],[3.5,"S"]] },
    { id:"bossa", label:"Bossa nova", feel:"straight", group:"Latin", tags:["Bossa nova","Latin"],
      desc:"A two-bar pattern. First bar (shown): beat 1, the and of 2 held, beat 3. Second bar: beat 2 and the and of 3.", hits:[[0,"S"],[1.5,"L"],[3,"S"]] },
    { id:"tango", label:"Tango (habanera)", feel:"straight", group:"Latin", tags:["Tango","Latin"],
      desc:"A held chord on 1, then short ones on the and of 2, on 3 and on 4.", hits:[[0,"L"],[1.5,"S"],[2,"S"],[3,"S"]] },
    { id:"montuno", label:"Son montuno", feel:"straight", group:"Latin", tags:["Son montuno","Salsa","Latin"],
      desc:"A two-bar pattern of short chords. First bar (shown): 1, 2, the and of 2, the and of 3, the and of 4. Second bar: every off-beat. Here it is played as block chords, not the pianist's broken octaves.", hits:[[0,"S"],[1,"S"],[1.5,"S"],[2.5,"S"],[3.5,"S"]] },
    { id:"chacha", label:"Cha-cha", feel:"straight", group:"Latin", tags:["Cha-cha","Latin"],
      desc:"A chord on 2, then the cha-cha-cha: 3, the and of 3, and 4.", hits:[[1,"S"],[2,"S"],[2.5,"S"],[3,"L"]] },
    { id:"tresillo", label:"3+3+2 (tresillo)", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Latin"],
      desc:"Three held chords in a bar of eight eighth notes, grouped 3+3+2: beat 1, the and of 2, beat 4. Clocks, Shape of You, Eye of the Tiger.", hits:[[0,"L"],[1.5,"L"],[3,"L"]] },
    { id:"clave32", label:"3-2 clave / Bo Diddley beat", feel:"straight", group:"Folk, rock and pop", tags:["Rock","Pop","Latin"],
      desc:"The chords play the 3-2 son clave over two bars. First bar (shown): 1, the and of 2, 4. Second bar: 2 and 3. Faith, Desire, I Want Candy.", hits:[[0,"S"],[1.5,"S"],[3,"S"]] },
    { id:"barbara", label:"The Barbara Ann rhythm", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Motown"],
      desc:"A two-bar pattern: 1, 2, 3 and the and of 4 (shown), then the and of 1, the and of 2, and 3. Barbara Ann, You Can't Hurry Love, Walking on Sunshine.", hits:[[0,"S"],[1,"S"],[2,"S"],[3.5,"S"]] },
    { id:"alberti", label:"Alberti bass", feel:"straight", group:"Folk, rock and pop", tags:["Classical","Pop"],
      desc:"The notes of the chord one at a time in eighth notes: lowest, highest, middle, highest. Mozart's Sonata K. 545.", hits:[[0,"S"],[0.5,"S"],[1,"S"],[1.5,"S"],[2,"S"],[2.5,"S"],[3,"S"],[3.5,"S"]] },
    { id:"g333322", label:"Groups: 3+3+3+3+2+2", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock"],
      desc:"Sixteen eighth notes over two bars grouped 3+3+3+3+2+2. First bar (shown): 1, the and of 2, 4. Second bar: the and of 1, 3, 4. Beautiful Day.", hits:[[0,"L"],[1.5,"L"],[3,"L"]] },
    { id:"g33433", label:"Groups: 3+3+4+3+3", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Dance"],
      desc:"Sixteen eighth notes over two bars grouped 3+3+4+3+3. First bar (shown): 1, the and of 2, 4. Second bar: 2 and the and of 3. Party Rock Anthem, Starships.", hits:[[0,"L"],[1.5,"L"],[3,"L"]] },
    { id:"g3x8", label:"Groups: eight 3s then four 2s (sixteenths)", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Dance"],
      desc:"Two bars of sixteenth notes: eight groups of three, then four groups of two to square it up. Ghostbusters, Raise Your Glass. For slow and medium tempos.", hits:null },
    { id:"strumCamp", label:"Strum: D, D-U, U-D-U", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Folk"],
      desc:"The strum most songbooks start with: down on 1, down-up on 2, then up, down-up through 3 and 4 (the hand misses the strings on beat 3).", hits:[[0,"L"],[1,"L"],[1.5,"L"],[2.5,"L"],[3,"L"],[3.5,"L"]] },
    { id:"strumFolk", label:"Strum: D, D-U, D, D-U", feel:"straight", group:"Folk, rock and pop", tags:["Folk","Country","Pop"],
      desc:"Down on 1 and 3, down-up on 2 and 4.", hits:[[0,"L"],[1,"L"],[1.5,"L"],[2,"L"],[3,"L"],[3.5,"L"]] },
    { id:"strumEights", label:"Strum: down-up eighths", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock"],
      desc:"Every eighth note, down on the beat and up off it, leaning on 2 and 4.", hits:[[0,"L"],[0.5,"L"],[1,"L"],[1.5,"L"],[2,"L"],[2.5,"L"],[3,"L"],[3.5,"L"]] },
    { id:"strumPunk", label:"Strum: muted eighths, open in the chorus", feel:"straight", group:"Folk, rock and pop", tags:["Emo","Pop-punk","Rock"],
      desc:"Palm-muted eighth-note downstrokes in the verse, then open down-up eighths in the Chorus bars. On guitar the chords become power chords on the low strings. With no Chorus bars set, the second half of the form is the open part.", hits:[[0,"L"],[0.5,"S"],[1,"S"],[1.5,"S"],[2,"S"],[2.5,"S"],[3,"S"],[3.5,"S"]] },
    { id:"strumQuarters", label:"Strum: downstrokes on the beat", feel:"any", group:"Folk, rock and pop", tags:["Pop","Rock","Folk"],
      desc:"One ringing downstroke on every beat. The first strum to learn, and the usual one for a slow song.", hits:[[0,"L"],[1,"L"],[2,"L"],[3,"L"]] },
    { id:"strum332", label:"Strum: 3-3-2 accents", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock"],
      desc:"The D, D-U, U-D-U strum with the weight moved to beat 1, the and of 2 and beat 4, the 3+3+2 grouping under a great many pop songs.", hits:[[0,"L"],[1,"L"],[1.5,"L"],[2.5,"L"],[3,"L"],[3.5,"L"]] },
    { id:"strum16", label:"Strum: sixteenths", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Rock","Funk"],
      desc:"The D, D-U, U-D-U strum at double speed, twice in the bar. For slow and medium tempos.", hits:null },
    { id:"arp", label:"Arpeggio, up and down", feel:"any", group:"Folk, rock and pop", tags:["Ballad","Pop"],
      desc:"The notes of the voicing one at a time in eighth notes, up to the top and back down, each left to ring.", hits:[[0,"S"],[0.5,"S"],[1,"S"],[1.5,"S"],[2,"S"],[2.5,"S"],[3,"S"],[3.5,"S"]] },
    { id:"arp2", label:"Arpeggio, low and high", feel:"any", group:"Folk, rock and pop", tags:["Ballad","Pop","Folk"],
      desc:"Eighth notes rocking between the lowest and the highest note of the voicing.", hits:[[0,"S"],[0.5,"S"],[1,"S"],[1.5,"S"],[2,"S"],[2.5,"S"],[3,"S"],[3.5,"S"]] }
  ];
  comp.forEach(function (c){ if (!c.group) c.group = "Jazz"; });

  var drums = [
    { id:"auto", label:"Jazz time", feel:"any", group:"Jazz", tags:["Jazz","Swing","Boogaloo"],
      desc:"Follows the Feel menu. Swing: the ride pattern, hi-hat foot on 2 and 4, a feathered kick and a little snare. Straight eighths: eighths on the cymbal, kick on 1 and 3, cross-stick on 2 and 4." },
    { id:"funk", label:"Funk", feel:"straight", group:"Jazz", tags:["Funk","Boogaloo","Soul jazz"],
      desc:"Snare on 2 and 4 with a syncopated kick: beat 1, the and of 2 and the and of 3. Eighths on the cymbal." },
    { id:"bossa", label:"Bossa nova", feel:"straight", group:"Latin", tags:["Bossa nova"],
      desc:"Eighths on the cymbal, the kick on 1 and 3 with an eighth-note pickup before each, and the two-bar bossa clave on the cross-stick." },
    { id:"clave", label:"Son clave (2-3)", feel:"straight", group:"Latin", tags:["Son montuno","Salsa","Mambo"],
      desc:"The 2-3 son clave on the cross-stick over two bars, a bell pattern on the cymbal and a light kick with the tumbao bass. A drum-kit stand-in for the congas, timbales and clave of a real section." },
    { id:"clave32", label:"Son clave (3-2)", feel:"straight", group:"Latin", tags:["Son montuno","Salsa","Mambo"],
      desc:"The same groove as the 2-3 clave with its bars the other way round: three cross-stick notes in the first bar, two in the second." },
    { id:"bodiddley", label:"Bo Diddley beat", feel:"straight", group:"Folk, rock and pop", tags:["Rock","Pop"],
      desc:"The 3-2 clave played on the toms over a steady kick: 1, the and of 2, 4, then 2 and 3. Faith, Desire, I Want Candy." },
    { id:"dembow", label:"Reggaeton (dembow)", feel:"straight", group:"Caribbean", tags:["Reggaeton","Dancehall","Pop"],
      desc:"Kick on every beat, with the snare on the sixteenth before beats 2 and 4 and on the and of 2 and 4: a 3+3+2 in sixteenths, twice a bar. Despacito, One Dance." },
    { id:"chacha", label:"Cha-cha", feel:"straight", group:"Latin", tags:["Cha-cha"],
      desc:"The cymbal on every beat like the cha-cha bell, cross-stick on 2, and two tom notes on 4 and the and of 4." },
    { id:"tango", label:"Tango", feel:"straight", group:"Latin", tags:["Tango"],
      desc:"A light habanera on the kick under quarter notes on the cymbal. Tango bands rarely carry a drum kit, so this stays out of the way." },
    { id:"calypso", label:"Calypso", feel:"straight", group:"Caribbean", tags:["Calypso"],
      desc:"Kick on 1 and 3, cross-stick on the and of 2 and on 4, and cymbal eighths that lean on the off-beats." },
    { id:"onedrop", label:"Reggae one-drop", feel:"straight", group:"Caribbean", tags:["Reggae","Ska"],
      desc:"Nothing on beat 1. Kick and cross-stick together on beat 3, with cymbal eighths that lean on the off-beats." },
    { id:"boomchick", label:"Two-beat", feel:"any", group:"Folk, rock and pop", tags:["Folk","Country","Polka","Waltz"],
      desc:"Kick with the bass on 1 and 3, a soft snare with the chords on 2 and 4. In 3/4: kick on 1, snare on 2 and 3." },
    { id:"rock", label:"Rock backbeat", feel:"straight", group:"Folk, rock and pop", tags:["Rock","Pop"],
      desc:"Eighths on the cymbal and a full snare on 2 and 4. The kick changes over four bars: 1, 3 and the and of 3; then 1, the and of 2 and 3; the last bar adds a pickup on the and of 4. Sixteenth-note fills." },
    { id:"strum", label:"Pop backbeat", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Folk","Rock"],
      desc:"A lighter backbeat for a strummed song: kick on 1, the and of 2 and 3, with the Dotted bass line. Fills are a snare note or two." },
    { id:"ballad", label:"Ballad", feel:"straight", group:"Folk, rock and pop", tags:["Ballad","Pop"],
      desc:"Quiet eighths on the cymbal, a cross-stick on 2 and 4 and a soft kick on 1, the and of 2 and 3. In a chorus bar the cross-stick becomes the snare." },
    { id:"dance", label:"Four on the floor", feel:"straight", group:"Folk, rock and pop", tags:["Disco","Dance","Pop"],
      desc:"Kick on every beat, snare and clap on 2 and 4, and the open hi-hat on every off-beat." },
    { id:"motown", label:"Motown", feel:"straight", group:"Folk, rock and pop", tags:["Motown","Soul","Pop"],
      desc:"The snare on all four beats, louder on 2 and 4 with a tambourine, over eighths on the cymbal. You Can't Hurry Love, Reach Out I'll Be There." },
    { id:"train", label:"Train beat", feel:"straight", group:"Folk, rock and pop", tags:["Country","Rockabilly","Folk"],
      desc:"The snare on every eighth note, leaning on 2 and 4, over a kick on 1 and 3. Folsom Prison Blues." },
    { id:"none", label:"No drums", feel:"any", group:"Hymns and carols", tags:["Hymn","Carol","Ballad"],
      desc:"The drummer sits out." },
    { id:"brushes", label:"Light time", feel:"straight", group:"Hymns and carols", tags:["Carol","Folk"],
      desc:"Very quiet eighths on the hi-hat, a soft kick on 1 and 3 and a light cross-stick on 2 and 4. No fills. A stand-in for brushes." },
    { id:"twelve8", label:"12/8", feel:"any", group:"Folk, rock and pop", tags:["Doo-wop","Blues","Ballad"],
      desc:"Three eighths to every beat on the cymbal, kick on 1 and 3, backbeat on 2 and 4. In 4/4 the eighths are triplets." },
    { id:"halftime", label:"Half-time", feel:"straight", group:"Folk, rock and pop", tags:["Pop","Ballad","Rock"],
      desc:"The backbeat at half speed: kick on 1 and the and of 2, one snare on beat 3." }
  ];

  // which styles each entry belongs in
  var FITS = {
    bass: { walk:"swing ballad", two:"swing ballad", riff:"boogaloo", riffwalk:"boogaloo", roots:"rock pop folk reggae strum hymn carol emo", alt:"folk calypso reggae train strum carol", held:"hymn carol pop", halves:"carol hymn pop strum", eighths:"rock emo", dotted:"strum pop rock emo", octaves:"dance", motown:"motown", twelve8:"doowop",
            bossa:"bossa", tango:"tango", tumbao:"montuno chacha", chacha:"chacha", tresillo:"dance rock reggaeton",
            sowhat:"swing", killerjoe:"swing boogaloo", songfather:"bossa", footprints:"swing", allblues:"swing", chameleon:"boogaloo rock", maiden:"boogaloo bossa", takefive:"swing" },
    comp: { auto:"swing ballad boogaloo", charleston:"swing ballad", reverse:"swing", garland:"swing", offbeats:"swing", four:"swing", stabs:"boogaloo",
            pad:"swing ballad boogaloo bossa tango pop folk rock reggaeton strum dance doowop hymn carol emo", oompah:"folk train motown carol", eighths:"rock", hymn:"hymn carol pop", ballRock:"pop strum carol hymn doowop", ballBroken:"pop strum carol hymn", ballSync:"pop strum carol",  quarters:"pop rock strum motown hymn carol emo", triplets:"doowop",
            strumCamp:"strum rock folk carol", strumFolk:"carol folk strum train", strumEights:"rock strum emo", strumPunk:"emo rock", strumQuarters:"strum rock folk pop carol emo", strum332:"strum rock dance", strum16:"strum rock dance", upbeats:"calypso reggae", bossa:"bossa", tango:"tango",
            montuno:"montuno", chacha:"chacha", arp:"pop ballad folk strum doowop hymn carol", arp2:"pop folk strum carol emo", alberti:"pop folk", tresillo:"dance rock reggaeton", clave32:"rock", barbara:"motown rock", g333322:"rock dance", g33433:"dance reggaeton", g3x8:"dance rock", sowhat:"swing", maiden:"boogaloo bossa", takefive:"swing" },
    drums: { auto:"swing ballad boogaloo", funk:"boogaloo rock", bossa:"bossa", clave:"montuno", clave32:"montuno", bodiddley:"rock", dembow:"reggaeton dance", chacha:"chacha", tango:"tango", calypso:"calypso",
             onedrop:"reggae", none:"hymn carol pop folk strum", brushes:"carol strum folk pop", boomchick:"folk train carol", rock:"rock emo", strum:"strum rock pop", ballad:"pop strum", dance:"dance", motown:"motown", train:"train", twelve8:"doowop", halftime:"pop rock emo" }
  };
  var JAZZ = "swing ballad boogaloo", POP = "folk rock emo pop strum dance motown doowop train hymn carol", PLAIN = POP + " calypso reggae reggaeton tango montuno chacha";
  var VOICE = {
    piano: { standard:[PLAIN, "Folk, rock, pop, Latin"], shell:[JAZZ + " bossa", "Jazz, bossa nova"], guide:[JAZZ, "Jazz"], rootless:[JAZZ + " bossa", "Jazz, bossa nova"], sowhat:[JAZZ + " bossa", "Modal jazz"],
             drop2:["swing ballad bossa tango montuno chacha", "Jazz, Latin"], drop3:["swing ballad bossa", "Jazz, bossa nova"], bh:["swing ballad", "Bebop"], auto:[JAZZ, "Jazz"] },
    guitar: { drop2:["swing ballad bossa tango montuno chacha", "Jazz, Latin"], drop3:["swing ballad bossa", "Jazz, bossa nova"], triad3:[PLAIN, "Folk, rock, pop, Latin"],
              shell3:[JAZZ + " bossa", "Jazz, bossa nova"], triadvl:[PLAIN, "Folk, rock, pop, Latin"], uppervl:[JAZZ + " bossa", "Jazz, bossa nova"], guide2:[JAZZ, "Jazz"],
              top3:[JAZZ + " bossa calypso reggae", "Jazz, funk, reggae"], mid3:[JAZZ + " bossa rock motown dance", "Jazz, funk, rock"], open:[POP + " calypso reggae", "Folk, rock, pop"], bh:["swing ballad", "Bebop"], auto:[JAZZ, "Jazz"] }
  };
  [["bass", bass], ["comp", comp], ["drums", drums]].forEach(function (p){ p[1].forEach(function (e){ e.fits = (FITS[p[0]][e.id] || "").split(" ").filter(Boolean); }); });
  var voicings = {};
  Object.keys(VOICE).forEach(function (inst){ voicings[inst] = {}; Object.keys(VOICE[inst]).forEach(function (id){
    voicings[inst][id] = { fits: VOICE[inst][id][0].split(" "), tags: VOICE[inst][id][1].split(", ") }; }); });

  var PLAINV = { piano:"standard", guitar:"triad3" }, STRUMV = { piano:"standard", guitar:"open" }, JAZZV = { piano:"rootless", guitar:"shell3" };
  var styles = [
    { id:"swing", label:"Swing", ext:true, group:"Jazz", genres:"Swing, bebop, hard bop, jazz blues", feel:"swing", bass:"walk", rhythm:"auto", drums:"auto", voicing:JAZZV,
      desc:"Walking bass, the ride cymbal and syncopated comping." },
    { id:"ballad", label:"Jazz ballad", ext:true, group:"Jazz", genres:"Ballads, slow standards", feel:"swing", bass:"two", rhythm:"pad", drums:"auto", voicing:JAZZV,
      desc:"Bass in two, long chords, quiet time." },
    { id:"boogaloo", label:"Boogaloo", ext:true, group:"Jazz", genres:"Boogaloo, soul jazz, funky blues", feel:"straight", bass:"riff", rhythm:"stabs", drums:"auto", voicing:JAZZV,
      desc:"A straight-eighths bass riff with chord stabs locked to it, as in Watermelon Man." },
    { id:"bossa", label:"Bossa nova", ext:true, group:"Latin", genres:"Bossa nova, slow samba", feel:"straight", bass:"bossa", rhythm:"bossa", drums:"bossa", voicing:JAZZV,
      desc:"Root-and-fifth bass with pickups, a two-bar comping pattern and the bossa clave on the cross-stick." },
    { id:"montuno", label:"Son montuno", group:"Latin", genres:"Son, salsa, mambo", feel:"straight", bass:"tumbao", rhythm:"montuno", drums:"clave", voicing:PLAINV,
      desc:"Tumbao bass that anticipates each bar, the two-bar montuno rhythm and 2-3 son clave." },
    { id:"chacha", label:"Cha-cha", group:"Latin", genres:"Cha-cha-ch\u00e1", feel:"straight", bass:"chacha", rhythm:"chacha", drums:"chacha", voicing:PLAINV,
      desc:"A steady bell on the beats with the cha-cha-cha on 3, the and of 3, and 4." },
    { id:"tango", label:"Tango", group:"Latin", genres:"Tango, habanera", feel:"straight", bass:"tango", rhythm:"tango", drums:"tango", voicing:PLAINV,
      desc:"The habanera rhythm in the bass and chords." },
    { id:"calypso", label:"Calypso", group:"Caribbean", genres:"Calypso, mento, soca", feel:"straight", bass:"alt", rhythm:"upbeats", drums:"calypso", voicing:PLAINV,
      desc:"Root-and-fifth bass with chords on every off-beat." },
    { id:"reggae", label:"Ska / reggae", group:"Caribbean", genres:"Reggae, ska, rocksteady", feel:"straight", bass:"roots", rhythm:"upbeats", drums:"onedrop", voicing:PLAINV,
      desc:"Off-beat chords over a one-drop: the drums leave beat 1 empty." },
    { id:"reggaeton", label:"Reggaeton", group:"Caribbean", genres:"Reggaeton, dancehall, Latin pop", feel:"straight", bass:"tresillo", rhythm:"pad", drums:"dembow", voicing:PLAINV,
      desc:"The dembow drum pattern under long chords, with the bass on a 3+3+2." },
    // The rock and pop styles are each one band: a bass line written on its drum groove's kick, a comping
    // part, the sounds that go with them and whether chords are pushed. (Ids "rock", "pop" and "folk" are kept
    // from the three generic styles they replace: saved setups and links name them.)
    { id:"rock", label:"Straight-eighth rock", group:"Folk, rock and pop", genres:"Rock, pop-rock, new wave", feel:"straight", bass:"eighths", rhythm:"strumEights", drums:"rock", voicing:STRUMV, push:true,
      sound:{ bass:"electric", cymbal:"hat", piano:"piano", guitar:"cguitar" },
      desc:"Root eighths on the bass, down-up eighths on the chords and a backbeat whose kick changes from bar to bar." },
    { id:"emo", label:"Emo / pop-punk", group:"Folk, rock and pop", genres:"Emo, pop-punk, alternative rock", feel:"straight", bass:"eighths", rhythm:"strumPunk", drums:"rock", voicing:STRUMV, push:true,
      sound:{ bass:"electric", cymbal:"hat", piano:"piano", guitar:"dguitar", lead:"guitar" },
      desc:"A distorted guitar chugging muted power chords in the verse and opening up in the Chorus bars, over root eighths and a rock backbeat. Set Half-time bars for a half-time chorus or breakdown." },
    { id:"strum", label:"Acoustic strum", group:"Folk, rock and pop", genres:"Folk-pop, singer-songwriter, campfire songs", feel:"straight", bass:"dotted", rhythm:"strumCamp", drums:"strum", voicing:STRUMV, push:true,
      sound:{ bass:"electric", cymbal:"hat", piano:"piano", guitar:"aguitar", lead:"guitar" },
      desc:"A strummed steel-string guitar over a light backbeat, with the bass and kick together on 1, the and of 2 and 3." },
    { id:"pop", label:"Piano ballad", group:"Folk, rock and pop", genres:"Pop and rock ballads", feel:"straight", bass:"dotted", rhythm:"ballRock+ballBroken+ballSync", drums:"ballad", voicing:STRUMV, time:{ feel:"half", parts:"bass drums plain" },      // half time: the backbeat on 3, the bass at half speed, the piano as written
      sound:{ bass:"electric", cymbal:"hat", piano:"piano", guitar:"aguitar", lead:"piano", kit:{ hat:53 } },       // kit = Backing Track kit faders (0-150; 53 = 35% of the travel): the hi-hat well down
      desc:"Left-hand octaves and a first-inversion right hand broken three ways (rocking, half-broken, syncopated), in four-bar spans, over a half-time bass and drums: a quiet kick and a cross-stick on 3." },
    { id:"dance", label:"Dance pop", group:"Folk, rock and pop", genres:"Disco, dance pop, four on the floor", feel:"straight", bass:"octaves", rhythm:"tresillo", drums:"dance", voicing:PLAINV,
      sound:{ bass:"electric", cymbal:"hat", piano:"epiano", guitar:"cguitar" },
      desc:"Kick on every beat, the open hi-hat and the bass octave on every off-beat, chords on a 3+3+2." },
    { id:"motown", label:"Motown / soul", group:"Folk, rock and pop", genres:"Motown, 60s soul, Northern soul", feel:"straight", bass:"motown", rhythm:"barbara", drums:"motown", voicing:PLAINV,
      sound:{ bass:"electric", cymbal:"hat", piano:"piano", guitar:"cguitar" },
      desc:"The snare on all four beats with a tambourine on 2 and 4, a bass line through root, fifth and octave, and the two-bar chord rhythm of You Can't Hurry Love." },
    { id:"doowop", label:"12/8 doo-wop", group:"Folk, rock and pop", genres:"Doo-wop, 50s ballads, slow blues ballads", feel:"swing", bass:"twelve8", rhythm:"triplets", drums:"twelve8", voicing:PLAINV,
      sound:{ bass:"upright", cymbal:"ride", piano:"piano", guitar:"cguitar", lead:"piano" },
      desc:"Triplet piano chords over a slow backbeat. Works on a chart in 12/8 and, as triplets, on one in 4/4." },
    { id:"train", label:"Country train beat", group:"Folk, rock and pop", genres:"Country, rockabilly, bluegrass-style songs", feel:"straight", bass:"alt", rhythm:"strumFolk", drums:"train", voicing:STRUMV,
      sound:{ bass:"upright", cymbal:"hat", piano:"piano", guitar:"aguitar", lead:"guitar" },
      desc:"Root-and-fifth bass, a boom-chicka strum and the snare on every eighth note." },
    { id:"folk", label:"Boom-chick", group:"Folk, rock and pop", genres:"Folk, polka, old-time; waltzes in 3/4", feel:"straight", bass:"alt", rhythm:"oompah", drums:"boomchick", voicing:STRUMV,
      sound:{ bass:"upright", cymbal:"hat", piano:"piano", guitar:"aguitar" },
      desc:"Bass on 1 and 3, chords on 2 and 4. In 3/4 it is oom-pah-pah." }
  ];
  styles.push(
    { id:"hymn", label:"Hymn (four parts)", group:"Hymns and carols", genres:"Hymns, chorales, traditional carols", feel:"straight", bass:"held", rhythm:"hymn", drums:"none", voicing:PLAINV,
      sound:{ bass:"upright", cymbal:"ride", piano:"piano", guitar:"aguitar", lead:"piano" },
      desc:"No drums. Every chord is held until the next: three voices over the root on the piano, with the bass doubling the root. Choose Church organ as the instrument for the other obvious sound." },
    { id:"carol", label:"Folk carol", group:"Hymns and carols", genres:"Carols and folk hymns with a band: between a hymn and acoustic rock", feel:"straight", bass:"halves", rhythm:"strumFolk", drums:"brushes", voicing:STRUMV,
      sound:{ bass:"upright", cymbal:"hat", piano:"piano", guitar:"aguitar", lead:"guitar" },
      desc:"A strummed steel-string guitar, upright bass on 1 and 3 and very light time, for Deck the Halls or God Rest Ye Merry, Gentlemen played by a folk-rock band." });
  // The sounds a style is played on. Jazz and Latin styles: upright bass, ride cymbal, the plain piano or
  // jazz guitar. lead = the instrument the style is built around, which the pages switch to when it is chosen.
  var ELECTRIC = { reggae: 1, reggaeton: 1 }, HAT = { reggae: 1, reggaeton: 1, calypso: 1 };
  styles.forEach(function (s){ if (!s.sound) s.sound = { bass: ELECTRIC[s.id] ? "electric" : "upright", cymbal: HAT[s.id] ? "hat" : "ride", piano: "piano", guitar: "guitar" }; });
  // Everything a page needs to play a style: band options for BandPlayer plus the sample sets to load.
  // family = "piano" | "guitar" (the comping instrument to use; default the style's lead, else piano).
  function styleOpts(id, family){
    var s = byId(styles, id) || styles[0], fam = family || s.sound.lead || "piano", snd = s.sound[fam] || fam;
    return { opts: { comp: fam, compSound: snd, bassSound: s.sound.bass, ride: s.sound.cymbal, push: !!s.push, feel: s.feel, bassFeel: s.bass, compRhythm: s.rhythm, groove: s.drums,
                     voicing: (s.voicing && s.voicing[fam]) || undefined, timeFeel: s.time ? s.time.feel : "normal", timeFeelParts: s.time ? s.time.parts : undefined },
             instruments: [s.sound.bass === "electric" ? "ebass" : "bass", snd, "kit"] };
  }
  function fits(entry, styleId){ return !!(entry && entry.fits && entry.fits.indexOf(styleId) >= 0); }

  var feels = [
    { id:"swing", label:"Swing", desc:"Off-beat eighths are played late: close to a triplet at medium tempos, evening out as the tempo rises." },
    { id:"straight", label:"Straight eighths", desc:"Even eighths, with kick on 1 and 3 and cross-stick on 2 and 4." }
  ];
  var cymbals = [
    { id:"ride", label:"Ride", desc:"The ride cymbal keeps time, with the hi-hat foot on 2 and 4." },
    { id:"hat", label:"Closed hi-hat", desc:"Time on the closed hi-hat instead of the ride." },
    { id:"bell", label:"Ride bell", desc:"The bell of the ride on the beats, the bow of the cymbal in between." }
  ];

  function url(o){
    o = o || {}; var q = [];
    ["style", "bass", "rhythm", "drums", "feel", "comp"].forEach(function (k){ if (o[k]) q.push(k + "=" + encodeURIComponent(o[k])); });
    return "/tools/backing-track.html" + (q.length ? "?" + q.join("&") : "");
  }
  function byId(list, id){ for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

  global.BandCatalog = { bass: bass, comp: comp, drums: drums, voicings: voicings, styles: styles, styleOpts: styleOpts, fits: fits, feels: feels, cymbals: cymbals, url: url, byId: byId };
})(typeof window !== "undefined" ? window : globalThis);
