/* ==========================================================================
   NEON PULSE - Phase 1 rhythm engine
   Vanilla JS + Canvas + Web Audio. No libraries, no external assets.
   ========================================================================== */

(function () {
  'use strict';

  /* ======================================================================
     1. CONFIG & KEY BINDINGS
     ====================================================================== */

  const CONFIG = {
    approachTimeMs: 1300,
    leadInMs: 1000,
    bpm: 120,
    scheduleAheadMs: 400,
    missLingerMs: 300,
    resultsDelayMs: 700,
    inputOffsetMs: 0,
    maxInputAgeMs: 100,
    maxLatencyMs: 200,
    masterVolume: 0.6
  };

  const JUDGMENTS = [
    { name: 'SICK', windowMs: 45,  points: 350, weight: 1.0,  color: '#7df9ff' },
    { name: 'GOOD', windowMs: 90,  points: 200, weight: 0.75, color: '#7dff9a' },
    { name: 'BAD',  windowMs: 135, points: 50,  weight: 0.5,  color: '#ffd166' }
  ];
  const MISS_JUDGMENT = { name: 'MISS', points: 0, weight: 0.0, color: '#ff5470' };
  const HIT_WINDOW_MS = JUDGMENTS[JUDGMENTS.length - 1].windowMs;

  const BEAT_MS = 60000 / CONFIG.bpm;
  const STEP_MS = BEAT_MS / 2;
  const TOTAL_BEATS = 64;
  const TOTAL_STEPS = TOTAL_BEATS * 2;

  const DEFAULT_LANES = [
    { key: 'ArrowLeft',  label: 'Left',  color: '#b45cff', rotation: -Math.PI / 2 },
    { key: 'ArrowDown',  label: 'Down',  color: '#22d8ff', rotation: Math.PI },
    { key: 'ArrowUp',    label: 'Up',    color: '#4dff88', rotation: 0 },
    { key: 'ArrowRight', label: 'Right', color: '#ff4d8d', rotation: Math.PI / 2 }
  ];

  let customBindings = null;
  try {
    const saved = localStorage.getItem('neon_pulse_bindings');
    if (saved) customBindings = JSON.parse(saved);
  } catch (e) {}

  const LANES = DEFAULT_LANES.map(function (lane, i) {
    return {
      ...lane,
      key: customBindings && customBindings[i] !== undefined ? customBindings[i] : lane.key,
      tint: lane.color + '14'
    };
  });

  const LANE_COUNT = LANES.length;
  const KEY_TO_LANE = new Map();
  function rebuildKeyMap() {
    KEY_TO_LANE.clear();
    LANES.forEach(function (lane, index) {
      KEY_TO_LANE.set(lane.key, index);
    });
  }
  rebuildKeyMap();

  const NOTE_STATE = { PENDING: 'pending', HIT: 'hit', MISSED: 'missed' };
  const GAME_STATE = { READY: 'READY', SETTINGS: 'SETTINGS', PLAYING: 'PLAYING', PAUSED: 'PAUSED', RESULTS: 'RESULTS' };

  /* ======================================================================
     2. CHART DATA
     ====================================================================== */

  const L = 0, D = 1, U = 2, R = 3;
  function n(beat, lane) { return { time: beat * BEAT_MS, lane: lane }; }

  const CHART_DATA = [
    n(4, L), n(5, D), n(6, U), n(7, R),
    n(8, L), n(8.5, D), n(9, U), n(9.5, R), n(10, R), n(10.5, U), n(11, D), n(11.5, L),
    n(12, L), n(12, R), n(13, D), n(13, U), n(14, L), n(14.5, D), n(15, U), n(15.5, R),
    n(16, D), n(16.5, D), n(17, U), n(17.5, U), n(18, L), n(18, R), n(19, D), n(19.5, U),
    n(20, L), n(20.5, D), n(21, U), n(21.5, R), n(22, L), n(22.5, D), n(23, U), n(23.5, R),
    n(24, L), n(24.5, L), n(25, L), n(25.5, R), n(26, R), n(26.5, R), n(27, D), n(27, U),
    n(28, L), n(28, U), n(29, D), n(29, R), n(30, L), n(30, U), n(31, D), n(31, R),
    n(32, L), n(32.5, D), n(33, L), n(33.5, D), n(34, U), n(34.5, R), n(35, U), n(35.5, R),
    n(36, L), n(36, R), n(37, D), n(37.5, U), n(38, L), n(38, R), n(39, D), n(39.5, U),
    n(40, R), n(40.5, U), n(41, D), n(41.5, L), n(42, R), n(42.5, U), n(43, D), n(43.5, L),
    n(44, L), n(44, D), n(45, U), n(45, R), n(46, L), n(46, D), n(47, U), n(47, R),
    n(48, D), n(48.5, U), n(49, D), n(49.5, U), n(50, L), n(50.5, R), n(51, L), n(51.5, R),
    n(52, L), n(52, U), n(52.5, D), n(53, R), n(53.5, D), n(54, L), n(54, R), n(55, D), n(55, U),
    n(56, L), n(56.5, D), n(57, U), n(57.5, R), n(58, R), n(58.5, U), n(59, D), n(59.5, L),
    n(60, L), n(60, R), n(61, D), n(61, U), n(62, L), n(62, R)
  ];

  /* ======================================================================
     3. AudioEngine
     ====================================================================== */

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.noiseBuffer = null;
      this.active = new Set();
      this.generation = 0;
      this.transition = Promise.resolve();
    }

    isSupported() {
      return !!(window.AudioContext || window.webkitAudioContext);
    }

    ensureContext() {
      if (this.ctx) return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass();
      this.master = this.ctx.createGain();
      this.master.gain.value = CONFIG.masterVolume;
      this.master.connect(this.ctx.destination);

      const length = this.ctx.sampleRate;
      this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const samples = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
    }

    setRunning(shouldRun) {
      this.transition = this.transition
        .then(() => (shouldRun ? this.ctx.resume() : this.ctx.suspend()))
        .catch(function () {});
      return this.transition;
    }

    stopAll(fadeSeconds) {
      if (!this.ctx) return;
      this.generation++;
      const myGeneration = this.generation;
      const hardStop = () => {
        for (const entry of this.active) {
          try { entry.source.stop(); } catch (error) {}
        }
        this.active.clear();
      };
      if (fadeSeconds > 0) {
        this.master.gain.setTargetAtTime(0, this.ctx.currentTime, fadeSeconds / 4);
        setTimeout(() => {
          if (this.generation === myGeneration) hardStop();
        }, fadeSeconds * 1000 + 30);
      } else {
        hardStop();
      }
    }

    resetVolume() {
      this.master.gain.cancelScheduledValues(0);
      this.master.gain.setValueAtTime(CONFIG.masterVolume, this.ctx.currentTime);
    }

    kick(time) {
      this._tone(time, { type: 'sine', freq: 150, freqEnd: 45, gain: 0.9, decay: 0.25 });
    }

    snare(time) {
      this._noise(time, 'bandpass', 1800, 0.35, 0.16);
    }

    hat(time, accent) {
      this._noise(time, 'highpass', 7000, accent ? 0.13 : 0.07, 0.05);
    }

    bass(time, freq) {
      this._tone(time, { type: 'sawtooth', freq: freq, gain: 0.28, decay: 0.42, lowpass: 420 });
    }

    pluck(time, freq) {
      this._tone(time, { type: 'triangle', freq: freq, gain: 0.07, decay: 0.22 });
    }

    _tone(time, opts) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const nodes = [gain];
      osc.type = opts.type;
      osc.frequency.setValueAtTime(opts.freq, time);
      if (opts.freqEnd) osc.frequency.exponentialRampToValueAtTime(opts.freqEnd, time + opts.decay * 0.5);
      gain.gain.setValueAtTime(opts.gain, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + opts.decay);

      if (opts.lowpass) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = opts.lowpass;
        osc.connect(filter);
        filter.connect(gain);
        nodes.push(filter);
      } else {
        osc.connect(gain);
      }
      gain.connect(this.master);
      osc.start(time);
      osc.stop(time + opts.decay + 0.05);
      this._track(osc, nodes);
    }

    _noise(time, filterType, filterHz, peakGain, decay) {
      const ctx = this.ctx;
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = filterHz;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(peakGain, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start(time);
      source.stop(time + decay + 0.02);
      this._track(source, [filter, gain]);
    }

    _track(source, extraNodes) {
      const entry = { source: source };
      this.active.add(entry);
      source.onended = () => {
        source.disconnect();
        for (const node of extraNodes) node.disconnect();
        this.active.delete(entry);
      };
    }
  }

  /* ======================================================================
     4. SongClock (Strictly Synchronized Clock)
     ====================================================================== */

  class SongClock {
    constructor(audio) {
      this.audio = audio;
      this.startAudioTime = 0;
    }

    start() {
      this.startAudioTime = this.audio.ctx.currentTime + CONFIG.leadInMs / 1000;
    }

    // Unifying visual clock and audio clock directly to prevent any desync drift
    getTimeMs() {
      const audio = this.audio;
      return (audio.ctx.currentTime - this.startAudioTime) * 1000;
    }

    songMsToAudioTime(songMs) {
      return this.startAudioTime + songMs / 1000;
    }

    perfTimeToSongMs(eventTimeStamp) {
      const ageMs = clamp(performance.now() - eventTimeStamp, 0, CONFIG.maxInputAgeMs);
      return this.getTimeMs() - ageMs + CONFIG.inputOffsetMs;
    }
  }

  /* ======================================================================
     5. MusicScheduler
     ====================================================================== */

  const CHORDS = [
    { bass: 55.00, arp: [220.00, 261.63, 329.63] },
    { bass: 43.65, arp: [174.61, 220.00, 261.63] },
    { bass: 65.41, arp: [261.63, 329.63, 392.00] },
    { bass: 49.00, arp: [196.00, 246.94, 293.66] }
  ];
  const ARP_PATTERN = [0, 1, 2, 1];

  class MusicScheduler {
    constructor(audio, clock) {
      this.audio = audio;
      this.clock = clock;
      this.nextStep = 0;
    }

    reset() {
      this.nextStep = 0;
    }

    update() {
      const songTimeMs = this.clock.getTimeMs();
      const horizon = songTimeMs + CONFIG.scheduleAheadMs;
      while (this.nextStep < TOTAL_STEPS && this.nextStep * STEP_MS <= horizon) {
        const when = this.clock.songMsToAudioTime(this.nextStep * STEP_MS);
        this._playStep(this.nextStep, when);
        this.nextStep++;
      }
    }

    _playStep(step, when) {
      const audio = this.audio;
      const beat = step >> 1;
      const onBeat = (step % 2) === 0;
      const beatInBar = beat % 4;
      const chord = CHORDS[Math.floor(beat / 4) % CHORDS.length];

      if (onBeat) {
        audio.kick(when);
        audio.bass(when, chord.bass);
        if (beatInBar === 1 || beatInBar === 3) audio.snare(when);
      }
      audio.hat(when, !onBeat);
      if (beat >= 4) {
        audio.pluck(when, chord.arp[ARP_PATTERN[step % ARP_PATTERN.length]] * 2);
      }
    }
  }

  /* ======================================================================
     6. Game state
     ====================================================================== */

  const ui = {};
  const audio = new AudioEngine();
  const clock = new SongClock(audio);
  const music = new MusicScheduler(audio, clock);

  let canvas = null;
  let gfx = null;
  let gameState = GAME_STATE.READY;
  let listenersRegistered = false;

  let notes = [];
  let laneNotes = [[], [], [], []];
  const judgeCursor = [0, 0, 0, 0];
  const drawCursor = [0, 0, 0, 0];
  let globalCursor = 0;
  let unresolvedCount = 0;
  let chartResolvedAtMs = null;

  const stats = {
    score: 0, combo: 0, maxCombo: 0,
    hits: 0, misses: 0,
    resolved: 0,
    weightSum: 0,
    counts: { SICK: 0, GOOD: 0, BAD: 0 }
  };

  const laneHeld = [false, false, false, false];
  const pressAmount = [0, 0, 0, 0];
  const missFlash = [0, 0, 0, 0];
  const MAX_BURSTS = 12;
  const bursts = [];
  for (let i = 0; i < MAX_BURSTS; i++) bursts.push({ active: false, lane: 0, age: 0 });
  let burstCursor = 0;
  const BURST_SECONDS = 0.4;
  const popup = { text: '', sub: '', color: '#fff', age: 999 };
  const POPUP_SECONDS = 0.7;

  const layout = {
    width: 1, height: 1,
    highwayWidth: 0, laneWidth: 0, left: 0,
    hitY: 0, noteSize: 0, travel: 1
  };

  let rafId = null;
  let lastFrameTs = null;
  let devMode = false;
  let lastDevUpdate = 0;
  let lastProgressPercent = -1;
  let rebindLaneIndex = null;

  /* ======================================================================
     7. Notes, hit detection, scoring
     ====================================================================== */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function buildNotesFromChart() {
    const sorted = CHART_DATA
      .filter(function (c) { return c.lane >= 0 && c.lane < LANE_COUNT; })
      .sort(function (a, b) { return a.time - b.time; });
    notes = sorted.map(function (c) {
      return { time: c.time, lane: c.lane, state: NOTE_STATE.PENDING, judgment: null };
    });
    laneNotes = [[], [], [], []];
    for (const note of notes) laneNotes[note.lane].push(note);
  }

  function resetStats() {
    stats.score = 0; stats.combo = 0; stats.maxCombo = 0;
    stats.hits = 0; stats.misses = 0;
    stats.resolved = 0; stats.weightSum = 0;
    stats.counts.SICK = 0; stats.counts.GOOD = 0; stats.counts.BAD = 0;
  }

  function getAccuracyPercent() {
    if (stats.resolved === 0) return 100;
    return clamp((stats.weightSum / stats.resolved) * 100, 0, 100);
  }

  function judgeTiming(absoluteErrorMs) {
    for (let i = 0; i < JUDGMENTS.length; i++) {
      if (absoluteErrorMs <= JUDGMENTS[i].windowMs) return JUDGMENTS[i];
    }
    return null;
  }

  function handleLanePress(lane, inputTimeMs) {
    pressAmount[lane] = 1;
    const list = laneNotes[lane];
    let bestNote = null;
    let bestAbsError = Infinity;
    for (let i = judgeCursor[lane]; i < list.length; i++) {
      const note = list[i];
      if (note.state !== NOTE_STATE.PENDING) continue;
      const timingError = inputTimeMs - note.time;
      if (timingError < -HIT_WINDOW_MS) break;
      const absError = Math.abs(timingError);
      if (absError <= HIT_WINDOW_MS && absError < bestAbsError) {
        bestNote = note;
        bestAbsError = absError;
      }
    }
    if (bestNote === null) return;
    resolveHit(bestNote, judgeTiming(bestAbsError));
  }

  function resolveHit(note, judgment) {
    if (note.state !== NOTE_STATE.PENDING) return;
    note.state = NOTE_STATE.HIT;
    note.judgment = judgment;
    unresolvedCount--;

    stats.hits++;
    stats.resolved++;
    stats.weightSum += judgment.weight;
    stats.score += judgment.points;
    stats.counts[judgment.name]++;
    stats.combo++;
    if (stats.combo > stats.maxCombo) stats.maxCombo = stats.combo;

    spawnBurst(note.lane);
    showPopup(judgment.name, judgment.color);
    updateHud();
  }

  function resolveMiss(note) {
    if (note.state !== NOTE_STATE.PENDING) return;
    note.state = NOTE_STATE.MISSED;
    note.judgment = MISS_JUDGMENT;
    unresolvedCount--;

    stats.misses++;
    stats.resolved++;
    stats.weightSum += MISS_JUDGMENT.weight;
    stats.combo = 0;

    missFlash[note.lane] = 1;
    showPopup(MISS_JUDGMENT.name, MISS_JUDGMENT.color);
    updateHud();
  }

  function expireMissedNotes(songTimeMs) {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const list = laneNotes[lane];
      let cursor = judgeCursor[lane];
      while (cursor < list.length) {
        const note = list[cursor];
        if (note.state !== NOTE_STATE.PENDING) { cursor++; continue; }
        if (songTimeMs - note.time > HIT_WINDOW_MS) {
          resolveMiss(note);
          cursor++;
        } else {
          break;
        }
      }
      judgeCursor[lane] = cursor;

      const drawLimit = HIT_WINDOW_MS + CONFIG.missLingerMs;
      let drawIndex = drawCursor[lane];
      while (drawIndex < list.length && songTimeMs - list[drawIndex].time > drawLimit) drawIndex++;
      drawCursor[lane] = drawIndex;
    }
  }

  function checkChartFinished(songTimeMs) {
    if (unresolvedCount > 0) return;
    if (chartResolvedAtMs === null) chartResolvedAtMs = songTimeMs;
    if (songTimeMs - chartResolvedAtMs >= CONFIG.resultsDelayMs) finishSong();
  }

  /* ======================================================================
     8. Game loop
     ====================================================================== */

  function startLoop() {
    if (rafId !== null) return;
    lastFrameTs = null;
    rafId = requestAnimationFrame(gameLoop);
  }

  function stopLoop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function gameLoop(frameTimestamp) {
    rafId = null;
    if (gameState !== GAME_STATE.PLAYING) return;

    const frameSeconds = lastFrameTs === null ? 0 : clamp((frameTimestamp - lastFrameTs) / 1000, 0, 0.1);
    lastFrameTs = frameTimestamp;

    const songTimeMs = clock.getTimeMs();

    music.update();
    expireMissedNotes(songTimeMs);
    updateEffects(frameSeconds);
    updateProgress(songTimeMs);

    render(songTimeMs);
    if (devMode) updateDevPanel(songTimeMs, false);

    checkChartFinished(songTimeMs);

    if (gameState === GAME_STATE.PLAYING) rafId = requestAnimationFrame(gameLoop);
  }

  function updateEffects(dt) {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      pressAmount[lane] = laneHeld[lane] ? 1 : Math.max(0, pressAmount[lane] - dt * 8);
      missFlash[lane] = Math.max(0, missFlash[lane] - dt * 4);
    }
    for (let i = 0; i < MAX_BURSTS; i++) {
      const burst = bursts[i];
      if (!burst.active) continue;
      burst.age += dt;
      if (burst.age >= BURST_SECONDS) burst.active = false;
    }
    popup.age += dt;
  }

  function spawnBurst(lane) {
    const burst = bursts[burstCursor];
    burstCursor = (burstCursor + 1) % MAX_BURSTS;
    burst.active = true;
    burst.lane = lane;
    burst.age = 0;
  }

  function showPopup(name, color) {
    popup.text = name;
    popup.sub = stats.combo > 1 ? stats.combo + ' combo' : '';
    popup.color = color;
    popup.age = 0;
  }

  /* ======================================================================
     9. Rendering
     ====================================================================== */

  const ARROW_PATH = new Path2D();
  ARROW_PATH.moveTo(0, -0.5);
  ARROW_PATH.lineTo(0.5, 0.02);
  ARROW_PATH.lineTo(0.22, 0.02);
  ARROW_PATH.lineTo(0.22, 0.5);
  ARROW_PATH.lineTo(-0.22, 0.5);
  ARROW_PATH.lineTo(-0.22, 0.02);
  ARROW_PATH.lineTo(-0.5, 0.02);
  ARROW_PATH.closePath();

  function resizeCanvas() {
    const cssWidth = Math.max(1, ui.stage.clientWidth);
    const cssHeight = Math.max(1, ui.stage.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    gfx.setTransform(dpr, 0, 0, dpr, 0, 0);

    layout.width = cssWidth;
    layout.height = cssHeight;
    layout.highwayWidth = Math.max(120, Math.min(cssWidth * 0.96, 520, cssHeight * 0.75));
    layout.laneWidth = layout.highwayWidth / LANE_COUNT;
    layout.left = (cssWidth - layout.highwayWidth) / 2;
    layout.noteSize = layout.laneWidth * 0.72;
    layout.hitY = Math.min(cssHeight * 0.82, cssHeight - layout.laneWidth * 0.7);
    layout.travel = layout.hitY + layout.noteSize;

    if (gameState !== GAME_STATE.PLAYING) renderCurrentFrame();
  }

  function renderCurrentFrame() {
    const songTimeMs = (audio.ctx && gameState !== GAME_STATE.READY && gameState !== GAME_STATE.SETTINGS)
      ? clock.getTimeMs()
      : -CONFIG.leadInMs;
    render(songTimeMs);
    if (devMode) updateDevPanel(songTimeMs, true);
  }

  function laneCenterX(lane) {
    return layout.left + layout.laneWidth * (lane + 0.5);
  }

  function drawArrow(cx, cy, size, rotation, fillStyle, strokeStyle, lineWidthPx) {
    gfx.save();
    gfx.translate(cx, cy);
    gfx.rotate(rotation);
    gfx.scale(size, size);
    if (fillStyle) {
      gfx.fillStyle = fillStyle;
      gfx.fill(ARROW_PATH);
    }
    if (strokeStyle) {
      gfx.lineWidth = lineWidthPx / size;
      gfx.lineJoin = 'round';
      gfx.strokeStyle = strokeStyle;
      gfx.stroke(ARROW_PATH);
    }
    gfx.restore();
  }

  function render(songTimeMs) {
    const w = layout.width;
    const h = layout.height;
    gfx.clearRect(0, 0, w, h);

    const beatPosition = songTimeMs / BEAT_MS;
    const beatPhase = beatPosition - Math.floor(beatPosition);
    const pulse = Math.pow(1 - beatPhase, 3);

    drawHighway(pulse);
    drawLaneLights();
    drawReceptors();
    drawNotes(songTimeMs);
    drawBursts();
    drawPopup();
  }

  function drawHighway(pulse) {
    const x0 = layout.left;
    const hw = layout.highwayWidth;
    const lw = layout.laneWidth;
    const h = layout.height;

    gfx.fillStyle = 'rgba(8, 7, 24, 0.88)';
    gfx.fillRect(x0, 0, hw, h);

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      gfx.fillStyle = LANES[lane].tint;
      gfx.fillRect(x0 + lane * lw, 0, lw, h);
    }

    gfx.strokeStyle = '#ffffff';
    gfx.globalAlpha = 0.07;
    gfx.lineWidth = 1;
    gfx.beginPath();
    for (let i = 1; i < LANE_COUNT; i++) {
      gfx.moveTo(x0 + i * lw, 0);
      gfx.lineTo(x0 + i * lw, h);
    }
    gfx.stroke();

    gfx.globalAlpha = 0.5 + 0.5 * pulse;
    gfx.strokeStyle = '#9a7bff';
    gfx.shadowColor = '#9a7bff';
    gfx.shadowBlur = 8 + 14 * pulse;
    gfx.lineWidth = 2;
    gfx.beginPath();
    gfx.moveTo(x0, 0); gfx.lineTo(x0, h);
    gfx.moveTo(x0 + hw, 0); gfx.lineTo(x0 + hw, h);
    gfx.stroke();
    gfx.shadowBlur = 0;

    gfx.globalAlpha = 0.35;
    gfx.strokeStyle = '#ffffff';
    gfx.lineWidth = 2;
    gfx.beginPath();
    gfx.moveTo(x0, layout.hitY);
    gfx.lineTo(x0 + hw, layout.hitY);
    gfx.stroke();
    gfx.globalAlpha = 1;
  }

  function drawLaneLights() {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = layout.left + lane * layout.laneWidth;
      if (pressAmount[lane] > 0) {
        gfx.fillStyle = LANES[lane].color;
        gfx.globalAlpha = 0.12 * pressAmount[lane];
        gfx.fillRect(x, 0, layout.laneWidth, layout.hitY + layout.noteSize * 0.5);
      }
      if (missFlash[lane] > 0) {
        gfx.fillStyle = MISS_JUDGMENT.color;
        gfx.globalAlpha = 0.25 * missFlash[lane];
        gfx.fillRect(x, layout.hitY - layout.noteSize * 1.5, layout.laneWidth, layout.noteSize * 2.5);
      }
    }
    gfx.globalAlpha = 1;
  }

  function drawReceptors() {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const press = pressAmount[lane];
      const size = layout.noteSize * (1 + 0.12 * press);
      const cx = laneCenterX(lane);
      const color = LANES[lane].color;

      gfx.shadowColor = color;
      gfx.shadowBlur = 6 + 22 * press;
      if (press > 0) {
        gfx.globalAlpha = press * 0.85;
        drawArrow(cx, layout.hitY, size, LANES[lane].rotation, color, null, 0);
      }
      gfx.globalAlpha = 0.55 + 0.45 * press;
      drawArrow(cx, layout.hitY, size, LANES[lane].rotation, null, color, 3);
    }
    gfx.shadowBlur = 0;
    gfx.globalAlpha = 1;
  }

  function drawNotes(songTimeMs) {
    const pixelsPerMs = layout.travel / CONFIG.approachTimeMs;
    const size = layout.noteSize;

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const list = laneNotes[lane];
      const cx = laneCenterX(lane);
      const color = LANES[lane].color;
      const rotation = LANES[lane].rotation;

      for (let i = drawCursor[lane]; i < list.length; i++) {
        const note = list[i];
        const msUntilDue = note.time - songTimeMs;
        if (msUntilDue > CONFIG.approachTimeMs) break;
        if (note.state === NOTE_STATE.HIT) continue;
        const y = layout.hitY - msUntilDue * pixelsPerMs;

        if (note.state === NOTE_STATE.MISSED) {
          gfx.shadowBlur = 0;
          gfx.globalAlpha = 0.28;
          drawArrow(cx, y, size, rotation, '#6b6890', '#9a97b8', 2);
          gfx.globalAlpha = 1;
        } else {
          gfx.shadowColor = color;
          gfx.shadowBlur = 14;
          drawArrow(cx, y, size, rotation, color, 'rgba(255,255,255,0.85)', 2);
        }
      }
    }
    gfx.shadowBlur = 0;
    gfx.globalAlpha = 1;
  }

  function drawBursts() {
    for (let i = 0; i < MAX_BURSTS; i++) {
      const burst = bursts[i];
      if (!burst.active) continue;
      const t = burst.age / BURST_SECONDS;
      gfx.globalAlpha = 1 - t;
      gfx.strokeStyle = LANES[burst.lane].color;
      gfx.lineWidth = 4 * (1 - t) + 1;
      gfx.beginPath();
      gfx.arc(laneCenterX(burst.lane), layout.hitY, layout.laneWidth * (0.35 + 0.9 * t), 0, Math.PI * 2);
      gfx.stroke();
    }
    gfx.globalAlpha = 1;
  }

  function drawPopup() {
    if (popup.age >= POPUP_SECONDS) return;
    const t = popup.age / POPUP_SECONDS;
    const pop = 1 + Math.max(0, 0.25 - popup.age) * 1.6;
    const scale = (layout.laneWidth / 70) * pop;
    const cx = layout.left + layout.highwayWidth / 2;
    const cy = layout.hitY - layout.laneWidth * 1.9 - t * layout.laneWidth * 0.25;

    gfx.save();
    gfx.translate(cx, cy);
    gfx.scale(scale, scale);
    gfx.globalAlpha = 1 - t * t;
    gfx.textAlign = 'center';
    gfx.textBaseline = 'middle';
    gfx.font = '800 34px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    gfx.shadowColor = popup.color;
    gfx.shadowBlur = 16;
    gfx.fillStyle = popup.color;
    gfx.fillText(popup.text, 0, 0);
    if (popup.sub) {
      gfx.shadowBlur = 0;
      gfx.font = '700 18px "Avenir Next", "Segoe UI", system-ui, sans-serif';
      gfx.fillStyle = '#ece9ff';
      gfx.fillText(popup.sub, 0, 30);
    }
    gfx.restore();
  }

  /* ======================================================================
     10. HUD and Dev Panel
     ====================================================================== */

  function updateHud() {
    ui.score.textContent = String(stats.score);
    ui.accuracy.textContent = getAccuracyPercent().toFixed(2) + '%';
    ui.combo.textContent = String(stats.combo);
    ui.misses.textContent = String(stats.misses);
  }

  function updateProgress(songTimeMs) {
    const lastNoteTime = notes.length ? notes[notes.length - 1].time : 1;
    const percent = Math.round(clamp(songTimeMs / lastNoteTime, 0, 1) * 1000) / 10;
    if (percent === lastProgressPercent) return;
    lastProgressPercent = percent;
    ui.progressFill.style.width = percent + '%';
  }

  function updateDevPanel(songTimeMs, force) {
    const now = performance.now();
    if (!force && now - lastDevUpdate < 100) return;
    lastDevUpdate = now;

    while (globalCursor < notes.length && notes[globalCursor].state !== NOTE_STATE.PENDING) globalCursor++;
    let upcoming = '';
    let shown = 0;
    for (let i = globalCursor; i < notes.length && shown < 8; i++) {
      if (notes[i].state !== NOTE_STATE.PENDING) continue;
      upcoming += '  ' + Math.round(notes[i].time) + 'ms ' + LANES[notes[i].lane].label + '\n';
      shown++;
    }
    const audioState = audio.ctx ? audio.ctx.state : 'not started';
    ui.devPanel.textContent =
      'state: ' + gameState + '   audio: ' + audioState + '\n' +
      'song time: ' + songTimeMs.toFixed(0) + ' ms  (beat ' + (songTimeMs / BEAT_MS).toFixed(2) + ')\n' +
      'notes resolved: ' + stats.resolved + '/' + notes.length + '\n' +
      'next notes:\n' + (upcoming || '  none\n');
  }

  function toggleDevMode() {
    devMode = !devMode;
    ui.devPanel.hidden = !devMode;
    if (devMode) {
      const t = (audio.ctx && gameState !== GAME_STATE.READY) ? clock.getTimeMs() : -CONFIG.leadInMs;
      updateDevPanel(t, true);
    }
  }

  /* ======================================================================
     11. State changes, settings UI, pause, restart, results
     ====================================================================== */

  function setState(next) {
    gameState = next;
    document.body.dataset.state = next;
    const canControl = next === GAME_STATE.PLAYING || next === GAME_STATE.PAUSED;
    ui.pauseBtn.disabled = !canControl;
    ui.restartBtn.disabled = !canControl;
    ui.pauseBtn.textContent = next === GAME_STATE.PAUSED ? 'Resume' : 'Pause';
  }

  function releaseAllLanes() {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      laneHeld[lane] = false;
      pressAmount[lane] = 0;
    }
  }

  function resetSession() {
    resetStats();
    for (const note of notes) {
      note.state = NOTE_STATE.PENDING;
      note.judgment = null;
    }
    unresolvedCount = notes.length;
    chartResolvedAtMs = null;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      judgeCursor[lane] = 0;
      drawCursor[lane] = 0;
      pressAmount[lane] = 0;
      missFlash[lane] = 0;
      laneHeld[lane] = false;
    }
    globalCursor = 0;
    for (let i = 0; i < MAX_BURSTS; i++) bursts[i].active = false;
    popup.age = 999;
    lastProgressPercent = -1;
    ui.progressFill.style.width = '0%';
    updateHud();
  }

  function startSong() {
    if (!audio.isSupported()) return;
    stopLoop();
    audio.ensureContext();
    audio.stopAll(0);
    audio.resetVolume();
    audio.setRunning(true);
    resetSession();
    clock.start();
    music.reset();
    setState(GAME_STATE.PLAYING);
    startLoop();
  }

  function pauseGame() {
    if (gameState !== GAME_STATE.PLAYING) return;
    setState(GAME_STATE.PAUSED);
    stopLoop();
    releaseAllLanes();
    audio.setRunning(false);
    renderCurrentFrame();
  }

  function resumeGame() {
    if (gameState !== GAME_STATE.PAUSED) return;
    audio.setRunning(true);
    setState(GAME_STATE.PLAYING);
    startLoop();
  }

  function togglePause() {
    if (gameState === GAME_STATE.PLAYING) pauseGame();
    else if (gameState === GAME_STATE.PAUSED) resumeGame();
  }

  function restartGame() {
    if (gameState === GAME_STATE.READY || gameState === GAME_STATE.SETTINGS) return;
    startSong();
  }

  function finishSong() {
    stopLoop();
    releaseAllLanes();
    audio.stopAll(0.25);
    setState(GAME_STATE.RESULTS);
    ui.resScore.textContent = String(stats.score);
    ui.resAccuracy.textContent = getAccuracyPercent().toFixed(2) + '%';
    ui.resCombo.textContent = String(stats.maxCombo);
    ui.resMisses.textContent = String(stats.misses);
    ui.resBreakdown.textContent =
      'Sick ' + stats.counts.SICK + '  |  Good ' + stats.counts.GOOD + '  |  Bad ' + stats.counts.BAD;
    renderCurrentFrame();
  }

  function openSettings() {
    renderSettingsBindingsList();
    setState(GAME_STATE.SETTINGS);
  }

  function closeSettings() {
    setState(GAME_STATE.READY);
    rebindLaneIndex = null;
  }

  function renderSettingsBindingsList() {
    ui.settingsBindings.innerHTML = '';
    LANES.forEach(function (lane, index) {
      const row = document.createElement('div');
      row.className = 'binding-row';

      const label = document.createElement('span');
      label.className = 'binding-label';
      label.textContent = lane.label + ' Arrow';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'binding-key-btn';
      btn.textContent = lane.key;
      if (rebindLaneIndex === index) {
        btn.classList.add('listening');
        btn.textContent = 'Press a key...';
      }

      btn.addEventListener('click', function () {
        rebindLaneIndex = index;
        renderSettingsBindingsList();
      });

      row.appendChild(label);
      row.appendChild(btn);
      ui.settingsBindings.appendChild(row);
    });
  }

  function resetBindingsToDefault() {
    DEFAULT_LANES.forEach(function (lane, i) {
      LANES[i].key = lane.key;
    });
    localStorage.removeItem('neon_pulse_bindings');
    rebuildKeyMap();
    rebindLaneIndex = null;
    renderSettingsBindingsList();
  }

  /* ======================================================================
     12. Input and startup
     ====================================================================== */

  function onKeyDown(event) {
    if (gameState === GAME_STATE.SETTINGS && rebindLaneIndex !== null) {
      event.preventDefault();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
      
      LANES[rebindLaneIndex].key = event.key;
      rebuildKeyMap();
      
      const serialized = LANES.map(l => l.key);
      localStorage.setItem('neon_pulse_bindings', JSON.stringify(serialized));
      
      rebindLaneIndex = null;
      renderSettingsBindingsList();
      return;
    }

    const lane = KEY_TO_LANE.get(event.key);
    if (lane !== undefined) {
      event.preventDefault();
      if (event.repeat || laneHeld[lane]) return;
      laneHeld[lane] = true;
      if (gameState === GAME_STATE.PLAYING) {
        handleLanePress(lane, clock.perfTimeToSongMs(event.timeStamp));
      }
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

    switch (event.key) {
      case 'Escape':
      case 'p':
      case 'P':
        if (gameState === GAME_STATE.PLAYING || gameState === GAME_STATE.PAUSED) {
          togglePause();
        } else if (gameState === GAME_STATE.SETTINGS) {
          closeSettings();
        }
        break;
      case 'r':
      case 'R':
        if (gameState === GAME_STATE.PAUSED || gameState === GAME_STATE.RESULTS) startSong();
        break;
      case 'Enter':
        if (event.target.tagName === 'BUTTON') break;
        if (gameState === GAME_STATE.READY || gameState === GAME_STATE.RESULTS) startSong();
        break;
      case 'd':
      case 'D':
        if (gameState !== GAME_STATE.SETTINGS) toggleDevMode();
        break;
    }
  }

  function onKeyUp(event) {
    const lane = KEY_TO_LANE.get(event.key);
    if (lane !== undefined) {
      event.preventDefault();
      laneHeld[lane] = false;
    }
  }

  function onFocusLost() {
    if (gameState === GAME_STATE.PLAYING) pauseGame();
  }

  function onVisibilityChange() {
    if (document.hidden && gameState === GAME_STATE.PLAYING) pauseGame();
  }

  function bindButton(element, handler) {
    element.addEventListener('click', function () {
      handler();
      element.blur();
    });
  }

  function registerListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onFocusLost);
    document.addEventListener('visibilitychange', onVisibilityChange);

    bindButton(ui.startBtn, startSong);
    bindButton(ui.openSettingsBtn, openSettings);
    bindButton(ui.settingsBtn, openSettings);
    bindButton(ui.settingsBackBtn, closeSettings);
    bindButton(ui.settingsResetBtn, resetBindingsToDefault);
    bindButton(ui.pauseBtn, togglePause);
    bindButton(ui.restartBtn, restartGame);
    bindButton(ui.resumeBtn, resumeGame);
    bindButton(ui.pauseRestartBtn, restartGame);
    bindButton(ui.playAgainBtn, startSong);

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(resizeCanvas).observe(ui.stage);
    } else {
      window.addEventListener('resize', resizeCanvas);
    }
  }

  function cacheDom() {
    const byId = function (id) { return document.getElementById(id); };
    ui.stage = byId('stage');
    ui.devPanel = byId('dev-panel');
    ui.score = byId('hud-score');
    ui.accuracy = byId('hud-accuracy');
    ui.combo = byId('hud-combo');
    ui.misses = byId('hud-misses');
    ui.progressFill = byId('progress-fill');
    ui.pauseBtn = byId('btn-pause');
    ui.restartBtn = byId('btn-restart');
    ui.startBtn = byId('btn-start');
    ui.settingsBtn = byId('btn-settings');
    ui.openSettingsBtn = byId('btn-open-settings');
    ui.settingsBackBtn = byId('btn-settings-back');
    ui.settingsResetBtn = byId('btn-settings-reset');
    ui.settingsBindings = byId('settings-bindings');
    ui.resumeBtn = byId('btn-resume');
    ui.pauseRestartBtn = byId('btn-pause-restart');
    ui.playAgainBtn = byId('btn-play-again');
    ui.audioWarning = byId('audio-warning');
    ui.resScore = byId('res-score');
    ui.resAccuracy = byId('res-accuracy');
    ui.resCombo = byId('res-combo');
    ui.resMisses = byId('res-misses');
    ui.resBreakdown = byId('res-breakdown');
    canvas = byId('game-canvas');
    gfx = canvas.getContext('2d');
  }

  function init() {
    cacheDom();
    if (!audio.isSupported()) {
      ui.startBtn.disabled = true;
      ui.audioWarning.hidden = false;
    }
    buildNotesFromChart();
    unresolvedCount = notes.length;
    registerListeners();
    setState(GAME_STATE.READY);
    resizeCanvas();
    updateHud();

    if (new URLSearchParams(window.location.search).get('dev') === '1') toggleDevMode();
  }

  window.__neonPulseDebug = {
    getState: function () { return gameState; },
    getStats: function () { return stats; },
    getNotes: function () { return notes; },
    getSongTimeMs: function () { return audio.ctx ? clock.getTimeMs() : -CONFIG.leadInMs; },
    getListenerCount: function () { return listenersRegistered ? 1 : 0; },
    isLoopQueued: function () { return rafId !== null; }
  };

  init();
})();