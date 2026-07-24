/**
 * Chiptune audio: synthesized SFX and a looping BGM via the Web Audio API.
 * No asset files — everything is generated from oscillators/noise so it works
 * offline and inside a sandboxed page. Audio must be resumed from a user
 * gesture (the START button/tap), per browser autoplay policy.
 */
(function (global) {
  "use strict";

  var ctx = null;
  var master = null;      // global volume (muting sets this to 0)
  var musicBus = null;    // sub-mix for the BGM
  var muted = false;

  var TEMPO = 136;                    // BPM
  var musicTimer = null;
  var step = 0;
  var nextNoteTime = 0;

  // A-minor spy ostinato. null = rest. Lead is eighth-notes (16 steps = 2 bars).
  var LEAD = [
    440, 523, 659, 523, 440, 523, 659, 784,
    698, 659, 587, 523, 494, 587, 440, 330
  ];
  var BASS = [110, 110, 87.31, 87.31, 98, 98, 110, 110]; // quarter notes

  function ensure() {
    if (ctx) return;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.85;
    master.connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.30;
    musicBus.connect(master);
  }

  function resume() {
    ensure();
    if (ctx && ctx.state === "suspended") ctx.resume();
  }

  // ---- One-shot voices ----------------------------------------------------

  function blip(o) {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = o.type || "square";
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.25, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g); g.connect(master);
    osc.start(t); osc.stop(t + o.dur + 0.02);
  }

  function noiseBurst(dur, gain) {
    if (!ctx || muted) return;
    var t = ctx.currentTime;
    var n = Math.floor(ctx.sampleRate * dur);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = ctx.createBufferSource(); src.buffer = buf;
    var g = ctx.createGain(); g.gain.value = gain || 0.3;
    src.connect(g); g.connect(master);
    src.start(t);
  }

  function arpeggio(freqs, dur, type) {
    freqs.forEach(function (f, i) {
      setTimeout(function () {
        blip({ type: type || "square", f0: f, dur: dur, gain: 0.28 });
      }, i * dur * 900);
    });
  }

  var SFX = {
    shoot:   function () { blip({ type: "square", f0: 900, f1: 220, dur: 0.11, gain: 0.16 }); },
    jump:    function () { blip({ type: "square", f0: 300, f1: 660, dur: 0.14, gain: 0.16 }); },
    pickup:  function () { arpeggio([660, 990, 1320], 0.09, "triangle"); },
    explode: function () { noiseBurst(0.28, 0.32); blip({ type: "sawtooth", f0: 180, f1: 40, dur: 0.28, gain: 0.18 }); },
    caution: function () { blip({ type: "square", f0: 520, dur: 0.1, gain: 0.2 });
                           setTimeout(function () { blip({ type: "square", f0: 520, dur: 0.1, gain: 0.2 }); }, 150); },
    miss:    function () { blip({ type: "sawtooth", f0: 440, f1: 55, dur: 0.6, gain: 0.28 }); },
    win:     function () { arpeggio([523, 659, 784, 1047, 1319], 0.15, "square"); },
    over:    function () { arpeggio([392, 330, 262, 196], 0.24, "sawtooth"); },
    powerup: function () { arpeggio([784, 988, 1319, 1568], 0.08, "square"); },
    block:   function () { blip({ type: "square", f0: 220, f1: 140, dur: 0.12, gain: 0.24 });
                           noiseBurst(0.08, 0.18); }
  };

  function play(name) { if (SFX[name]) SFX[name](); }

  // ---- BGM scheduler (lookahead) -----------------------------------------

  function musicNote(freq, time, dur, type, gain) {
    if (!ctx) return;
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, time);
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(g); g.connect(musicBus);
    osc.start(time); osc.stop(time + dur + 0.02);
  }

  function scheduler() {
    if (!ctx) return;
    var eighth = (60 / TEMPO) / 2;
    while (nextNoteTime < ctx.currentTime + 0.12) {
      var lead = LEAD[step % LEAD.length];
      if (lead) musicNote(lead, nextNoteTime, eighth * 0.9, "square", 0.10);
      if (step % 2 === 0) {
        var bass = BASS[(step / 2) % BASS.length];
        musicNote(bass, nextNoteTime, eighth * 1.7, "triangle", 0.16);
      }
      nextNoteTime += eighth;
      step = (step + 1) % LEAD.length;
    }
  }

  function startMusic() {
    ensure();
    if (!ctx || musicTimer) return;
    step = 0;
    nextNoteTime = ctx.currentTime + 0.1;
    musicTimer = setInterval(scheduler, 25);
  }

  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.value = muted ? 0 : 0.85;
  }

  global.Sound = {
    resume: resume,
    play: play,
    startMusic: startMusic,
    stopMusic: stopMusic,
    setMuted: setMuted,
    isMuted: function () { return muted; }
  };
})(window);
