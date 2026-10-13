/* ============================================================
   番茄钟 · 专注计时器 —— 逻辑脚本
   纯原生 JS，零依赖。使用 IIFE 包裹，避免污染全局作用域。
   计时基于 Date.now() 时间戳差值，切到后台也不会走不准。
   ============================================================ */
(function () {
  'use strict';

  /* ====================== 常量 ====================== */
  var SETTINGS_KEY = 'focusTimer.settings.v1';   // 设置持久化键
  var STATS_KEY = 'focusTimer.stats.v1';         // 统计持久化键
  var CYCLE_LENGTH = 4;                          // 每完成 4 个专注进入长休息
  var TICK_MS = 200;                             // 界面刷新间隔（毫秒）
  var RING_RADIUS = 120;                         // 与 SVG 中 circle 的 r 保持一致
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  var MIN_MINUTES = 1;
  var MAX_MINUTES = 180;
  var BASE_TITLE = '番茄钟 · 专注计时器';
  var TOMATO_DISPLAY_MAX = 20;                   // 番茄小方块最多渲染多少个

  var MODE_LABEL = { focus: '专注', short: '短休息', long: '长休息' };
  var MODE_ORDER = ['focus', 'short', 'long'];

  /* ====================== DOM 引用 ====================== */
  var el = {
    timeDisplay: document.getElementById('timeDisplay'),
    phaseLabel: document.getElementById('phaseLabel'),
    phaseHint: document.getElementById('phaseHint'),
    ringProgress: document.getElementById('ringProgress'),
    ringTrack: document.getElementById('ringTrack'),
    startPauseBtn: document.getElementById('startPauseBtn'),
    resetBtn: document.getElementById('resetBtn'),
    skipBtn: document.getElementById('skipBtn'),
    durationFocus: document.getElementById('durationFocus'),
    durationShort: document.getElementById('durationShort'),
    durationLong: document.getElementById('durationLong'),
    soundToggle: document.getElementById('soundToggle'),
    autoToggle: document.getElementById('autoToggle'),
    todayCount: document.getElementById('todayCount'),
    todayMinutes: document.getElementById('todayMinutes'),
    tomatoBar: document.getElementById('tomatoBar')
  };

  /* ====================== 运行时状态 ====================== */
  var state = {
    mode: 'focus',                                 // 当前模式
    running: false,                                // 是否正在倒计时
    endTime: 0,                                    // 运行时：本轮结束的时间戳
    remainingMs: 0,                                // 暂停时：本阶段剩余毫秒
    phaseTotalMs: 0,                               // 本阶段总毫秒，用于环形进度
    cycleFocusCount: 0,                            // 已完成的专注数（用于 4 个一轮）
    durations: { focus: 25, short: 5, long: 15 },  // 各模式时长（分钟）
    soundOn: true,
    autoStart: false,
    stats: { date: '', count: 0, seconds: 0 }      // 今日统计
  };

  var tickId = null;       // setInterval 句柄
  var audioCtx = null;     // 懒创建的 AudioContext

  /* ====================== 小工具函数 ====================== */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function clamp(value, min, max) {
    if (isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  /** 本地日期键，形如 2026-10-13，用来判断统计是否跨天 */
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 毫秒 -> MM:SS */
  function formatTime(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return pad2(minutes) + ':' + pad2(seconds);
  }

  function modeDurationMs(mode) {
    return state.durations[mode] * 60 * 1000;
  }

  /* ====================== 持久化：设置 ====================== */
  function loadSettings() {
    var raw;
    try {
      raw = localStorage.getItem(SETTINGS_KEY);
    } catch (e) {
      return; // 隐私模式等场景下 localStorage 可能不可用
    }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (!data) return;
      if (data.durations) {
        MODE_ORDER.forEach(function (mode) {
          var v = parseInt(data.durations[mode], 10);
          if (!isNaN(v)) state.durations[mode] = clamp(v, MIN_MINUTES, MAX_MINUTES);
        });
      }
      if (typeof data.soundOn === 'boolean') state.soundOn = data.soundOn;
      if (typeof data.autoStart === 'boolean') state.autoStart = data.autoStart;
    } catch (e) {
      /* 数据损坏则忽略，使用默认值 */
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        durations: state.durations,
        soundOn: state.soundOn,
        autoStart: state.autoStart
      }));
    } catch (e) {
      /* 写入失败静默忽略 */
    }
  }

  /* ====================== 持久化：今日统计 ====================== */
  function loadStats() {
    state.stats = { date: todayKey(), count: 0, seconds: 0 };
    var raw;
    try {
      raw = localStorage.getItem(STATS_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (data && data.date === state.stats.date) {
        state.stats.count = parseInt(data.count, 10) || 0;
        state.stats.seconds = parseInt(data.seconds, 10) || 0;
      }
    } catch (e) {
      /* 忽略损坏数据 */
    }
  }

  function saveStats() {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(state.stats));
    } catch (e) {
      /* 忽略 */
    }
  }

  /** 若已跨天，则把统计清零 */
  function ensureToday() {
    var key = todayKey();
    if (state.stats.date !== key) {
      state.stats = { date: key, count: 0, seconds: 0 };
      saveStats();
    }
  }

  /* ====================== 提示音（Web Audio 合成） ====================== */
  /**
   * 懒创建 AudioContext；首次必须由用户手势触发，
   * 否则浏览器会把它置为 suspended 并拒绝播放。
   */
  function ensureAudio() {
    if (!state.soundOn) return null;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) {
      try {
        audioCtx = new Ctor();
      } catch (e) {
        return null;
      }
    }
    if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /** 用振荡器 + 增益包络合成一段三音提示音，不依赖任何音频文件 */
  function playChime() {
    if (!state.soundOn) return;
    var ctx = ensureAudio();
    if (!ctx) return;

    var start = ctx.currentTime;
    var notes = [880, 1174.66, 1567.98]; // A5 / D6 / G6

    for (var i = 0; i < notes.length; i++) {
      var t = start + i * 0.16;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(notes[i], t);

      // 指数型淡入淡出，避免爆音
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.46);
    }
  }

  /* ====================== 计时核心（基于时间戳） ====================== */
  /** 当前阶段剩余毫秒：运行时用结束时间戳相减，暂停时读缓存值 */
  function getRemainingMs() {
    if (state.running) {
      return Math.max(0, state.endTime - Date.now());
    }
    return Math.max(0, state.remainingMs);
  }

  function startTickLoop() {
    stopTickLoop();
    tickId = window.setInterval(onTick, TICK_MS);
  }

  function stopTickLoop() {
    if (tickId !== null) {
      window.clearInterval(tickId);
      tickId = null;
    }
  }

  function onTick() {
    if (getRemainingMs() <= 0) {
      finishPhase();
      return;
    }
    render();
  }

  /* ====================== 阶段流转 ====================== */
  /** 切换模式并重置该阶段的倒计时 */
  function setMode(mode, keepRunning) {
    stopTickLoop();
    state.mode = mode;
    state.phaseTotalMs = modeDurationMs(mode);
    state.remainingMs = state.phaseTotalMs;
    state.endTime = 0;
    if (!keepRunning) state.running = false;
    document.body.setAttribute('data-mode', mode);
    render();
  }

  /** 下一个该进入的模式：专注后按 4 个一轮决定长/短休息，休息后回到专注 */
  function nextMode(current) {
    if (current !== 'focus') return 'focus';
    return (state.cycleFocusCount % CYCLE_LENGTH === 0) ? 'long' : 'short';
  }

  function startTimer() {
    if (state.running) return;
    ensureAudio();                 // 借用户手势解锁音频
    ensureToday();

    if (state.remainingMs <= 0) {
      state.phaseTotalMs = modeDurationMs(state.mode);
      state.remainingMs = state.phaseTotalMs;
    }
    state.endTime = Date.now() + state.remainingMs;
    state.running = true;
    startTickLoop();
    render();
  }

  function pauseTimer() {
    if (!state.running) return;
    state.remainingMs = getRemainingMs();   // 把剩余时间固化下来
    state.running = false;
    state.endTime = 0;
    stopTickLoop();
    render();
  }

  function toggleTimer() {
    if (state.running) {
      pauseTimer();
    } else {
      startTimer();
    }
  }

  function resetTimer() {
    stopTickLoop();
    state.running = false;
    state.endTime = 0;
    state.phaseTotalMs = modeDurationMs(state.mode);
    state.remainingMs = state.phaseTotalMs;
    render();
  }

  /** 自然结束当前阶段：记录专注统计并进入下一阶段 */
  function finishPhase() {
    stopTickLoop();
    state.running = false;
    state.endTime = 0;

    if (state.mode === 'focus') {
      ensureToday();
      state.stats.count += 1;
      state.stats.seconds += state.durations.focus * 60;
      state.cycleFocusCount += 1;
      saveStats();
      renderStats();
    }

    playChime();
    setMode(nextMode(state.mode));

    if (state.autoStart) startTimer();
  }

  /** 手动跳过：不计入统计，直接进入下一阶段 */
  function skipPhase() {
    stopTickLoop();
    state.running = false;
    state.endTime = 0;
    setMode(nextMode(state.mode));
    if (state.autoStart) startTimer();
  }

  /* ====================== 渲染 ====================== */
  function render() {
    var remaining = getRemainingMs();
    var total = state.phaseTotalMs > 0 ? state.phaseTotalMs : 1;
    var fraction = clamp(remaining / total, 0, 1); // 剩余比例

    el.timeDisplay.textContent = formatTime(remaining);
    el.phaseLabel.textContent = MODE_LABEL[state.mode];

    // 环形进度：offset 越大，可见圆环越短 —— 随剩余时间流逝而收缩
    el.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    el.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));

    el.startPauseBtn.textContent = state.running ? '⏸ 暂停' : '▶ 开始';
    el.phaseHint.textContent = state.running
      ? '正在' + MODE_LABEL[state.mode]
      : (remaining < total ? '已暂停' : '准备开始');

    // 模式按钮高亮
    var buttons = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.getAttribute('data-mode') === state.mode) {
        btn.classList.add('is-active');
      } else {
        btn.classList.remove('is-active');
      }
    }

    updateTitle();
  }

  /** 运行时把剩余时间同步到标签页标题 */
  function updateTitle() {
    if (state.running) {
      var suffix = state.mode === 'focus' ? '专注中' : MODE_LABEL[state.mode] + '中';
      document.title = formatTime(getRemainingMs()) + ' · ' + suffix;
    } else {
      document.title = BASE_TITLE;
    }
  }

  /** 渲染今日统计数据与番茄小方块 */
  function renderStats() {
    ensureToday();
    el.todayCount.textContent = String(state.stats.count);
    el.todayMinutes.textContent = String(Math.round(state.stats.seconds / 60));
    renderTomatoes(state.stats.count);
  }

  function renderTomatoes(count) {
    el.tomatoBar.innerHTML = '';

    if (count <= 0) {
      var empty = document.createElement('span');
      empty.className = 'tomato-empty';
      empty.textContent = '今天还没有完成的番茄，开始专注吧～';
      el.tomatoBar.appendChild(empty);
      return;
    }

    var shown = Math.min(count, TOMATO_DISPLAY_MAX);
    for (var i = 0; i < shown; i++) {
      var dot = document.createElement('span');
      dot.className = 'tomato';
      dot.textContent = '🍅';
      dot.title = '第 ' + (i + 1) + ' 个番茄';
      el.tomatoBar.appendChild(dot);
    }

    if (count > TOMATO_DISPLAY_MAX) {
      var more = document.createElement('span');
      more.className = 'tomato-more';
      more.textContent = '+' + (count - TOMATO_DISPLAY_MAX);
      el.tomatoBar.appendChild(more);
    }
  }

  /* ====================== 设置项同步 ====================== */
  function inputForMode(mode) {
    if (mode === 'focus') return el.durationFocus;
    if (mode === 'short') return el.durationShort;
    return el.durationLong;
  }

  function applySettingsToInputs() {
    el.durationFocus.value = String(state.durations.focus);
    el.durationShort.value = String(state.durations.short);
    el.durationLong.value = String(state.durations.long);
    el.soundToggle.checked = state.soundOn;
    el.autoToggle.checked = state.autoStart;
  }

  /** 修改某模式的分钟数并持久化 */
  function applyDuration(mode, minutes) {
    var next = clamp(parseInt(minutes, 10), MIN_MINUTES, MAX_MINUTES);
    state.durations[mode] = next;
    inputForMode(mode).value = String(next);
    saveSettings();

    // 若改的正是当前模式且没在倒计时，立即按新时长重置
    if (mode === state.mode && !state.running) {
      state.phaseTotalMs = modeDurationMs(mode);
      state.remainingMs = state.phaseTotalMs;
    }
    render();
  }

  /* ====================== 事件绑定 ====================== */
  function bindModeButtons() {
    var buttons = document.querySelectorAll('.mode-btn');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var mode = btn.getAttribute('data-mode');
          if (!mode || !MODE_LABEL[mode]) return;
          if (mode === state.mode && !state.running) return; // 已是当前模式就不打断
          setMode(mode);
        });
      })(buttons[i]);
    }
  }

  function bindDurationControls() {
    MODE_ORDER.forEach(function (mode) {
      var input = inputForMode(mode);
      input.addEventListener('change', function () {
        applyDuration(mode, input.value);
      });
      input.addEventListener('blur', function () {
        input.value = String(state.durations[mode]);
      });
    });

    var steppers = document.querySelectorAll('[data-stepper]');
    for (var i = 0; i < steppers.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var mode = btn.getAttribute('data-mode');
          var delta = parseInt(btn.getAttribute('data-delta'), 10) || 0;
          if (!MODE_LABEL[mode]) return;
          applyDuration(mode, state.durations[mode] + delta);
        });
      })(steppers[i]);
    }
  }

  function bindSwitches() {
    el.soundToggle.addEventListener('change', function () {
      state.soundOn = el.soundToggle.checked;
      saveSettings();
      if (state.soundOn) {
        ensureAudio();
        playChime();   // 打开音效时立即试听一下
      }
    });

    el.autoToggle.addEventListener('change', function () {
      state.autoStart = el.autoToggle.checked;
      saveSettings();
    });
  }

  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      var target = e.target;
      if (target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      )) {
        return; // 输入框聚焦时不触发快捷键
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        toggleTimer();
      } else {
        var key = (e.key || '').toLowerCase();
        if (key === 'r') {
          e.preventDefault();
          resetTimer();
        } else if (key === 's') {
          e.preventDefault();
          skipPhase();
        }
      }
    });
  }

  function bindEvents() {
    el.startPauseBtn.addEventListener('click', toggleTimer);
    el.resetBtn.addEventListener('click', resetTimer);
    el.skipBtn.addEventListener('click', skipPhase);

    bindModeButtons();
    bindDurationControls();
    bindSwitches();
    bindKeyboard();

    // 回到前台时立即校准一次界面（时间戳计时天然不怕后台）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.running) {
        if (getRemainingMs() <= 0) {
          finishPhase();
        } else {
          render();
        }
      }
    });
  }

  /* ====================== 启动 ====================== */
  function init() {
    loadSettings();
    loadStats();
    applySettingsToInputs();

    state.phaseTotalMs = modeDurationMs('focus');
    state.remainingMs = state.phaseTotalMs;

    setMode('focus');
    renderStats();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
