/* 应用主逻辑 */
(function () {
  'use strict';

  // 软件版本号（单一来源）：更新时只需改这里 + sw.js 的 CACHE_NAME，同步脚本会校验两者一致
  var APP_VERSION = 'v24';

  var $ = function (id) { return document.getElementById(id); };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  var CN_MONTHS = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];

  function lunarMonthsOf(year) {
    return LunarYear.fromYear(year).getMonths().filter(function (m) { return m.getYear() === year; })
      .map(function (m) {
        var v = m.getMonth();
        return { value: v, label: (v < 0 ? '闰' : '') + CN_MONTHS[Math.abs(v) - 1], days: m.getDayCount() };
      });
  }

  function monthDays(cal, year, month) {
    if (cal === 'solar') return new Date(year, month, 0).getDate();
    var months = lunarMonthsOf(year);
    for (var i = 0; i < months.length; i++) {
      if (months[i].value === month) return months[i].days;
    }
    return 30;
  }

  function formatDisplayDate(cal, d) {
    if (cal === 'lunar') {
      var months = lunarMonthsOf(d.year);
      var found = null;
      for (var i = 0; i < months.length; i++) if (months[i].value === d.month) found = months[i];
      return '农历：' + d.year + '年' + (found ? found.label : d.month + '月') + d.day + '日 ' + pad(d.hour) + ':' + pad(d.minute);
    }
    return '公历：' + d.year + '年' + d.month + '月' + d.day + '日 ' + pad(d.hour) + ':' + pad(d.minute);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function timeStr() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function nowParts() {
    var d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  }

  // 默认显示日期：农历模式下把今天的公历换算成农历
  function defaultDisplayDate(cal) {
    var n = nowParts();
    if (cal === 'lunar') {
      var lunar = Solar.fromYmd(n.year, n.month, n.day).getLunar();
      return {
        year: lunar.getYear(), month: lunar.getMonth(), day: lunar.getDay(),
        hour: n.hour, minute: n.minute
      };
    }
    return n;
  }

  var DISPLAY_KEY = 'bazi_pwa_display_v1';
  var DISPLAY_DEFAULT = { hide: true, hideShen: true, ganShen: true, dishi: true, nayin: true, liunian: true };
  function loadDisplay() {
    var out = {};
    for (var k in DISPLAY_DEFAULT) out[k] = DISPLAY_DEFAULT[k];
    try {
      var raw = JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}');
      for (var k2 in DISPLAY_DEFAULT) if (typeof raw[k2] === 'boolean') out[k2] = raw[k2];
    } catch (e) {}
    return out;
  }
  function saveDisplay(o) {
    try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // 滚轮声音/震动开关（持久保存，避免每次进入都要重新设置）
  var FEEDBACK_KEY = 'bazi_pwa_feedback_v1';
  var FEEDBACK_DEFAULT = { sound: true, vibrate: true };
  function loadFeedback() {
    var out = {};
    for (var k in FEEDBACK_DEFAULT) out[k] = FEEDBACK_DEFAULT[k];
    try {
      var raw = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || '{}');
      for (var k2 in FEEDBACK_DEFAULT) if (typeof raw[k2] === 'boolean') out[k2] = raw[k2];
    } catch (e) {}
    return out;
  }
  function saveFeedback() {
    try {
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify({ sound: picker.sound, vibrate: picker.vibrate }));
    } catch (e) {}
  }
  function syncFeedbackUI() {
    var s = $('dt-sound-toggle');
    var v = $('dt-vibrate-toggle');
    if (s) {
      s.textContent = '声音：' + (picker.sound ? '开' : '关');
      s.classList.toggle('off', !picker.sound);
    }
    if (v) {
      v.textContent = '震动：' + (picker.vibrate ? '开' : '关');
      v.classList.toggle('off', !picker.vibrate);
    }
  }

  var state = {
    display: loadDisplay(),
    name: '',
    gender: 1,
    remark: '',
    date: todayStr(),
    time: timeStr(),
    calendar: 'lunar',
    displayDate: defaultDisplayDate('lunar'),
    region: { name: '未知地-即北京时间', longitude: null },
    save: true,
    currentResult: null,
    currentCaseId: null,
    resultOrigin: 'input',
    manageMode: false,
    selected: {},
    exportSelected: {},
    searchQuery: '',
    searchOpen: false,
    confirmAction: null,
    pendingRegionIndex: 0
  };

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ---------- 滚轮日期选择器 ---------- */
  var feedbackPrefs = loadFeedback();
  var picker = {
    cal: 'solar', year: 2026, month: 1, day: 1, hour: 0, minute: 0,
    sound: feedbackPrefs.sound, vibrate: feedbackPrefs.vibrate,
    timers: {}, verifyTimers: {}, touching: {}, pendingRefresh: {}
  };
  var audioCtx = null;
  var lastTickAt = 0;

  function tickSound() {
    if (!picker.sound) return;
    // 快速连续滑动时只节流声音，震动仍逐格触发
    var now = Date.now();
    if (now - lastTickAt < 45) return;
    lastTickAt = now;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1050, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.14, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.055);
    } catch (e) {}
  }

  function tickVibration() {
    if (!picker.vibrate) return;
    // 12ms 太轻，改为 30ms 单脉冲，手感明显但仍是一格一下
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
  }

  function pickerToSolar(p) {
    if (p.cal === 'solar') {
      return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute };
    }
    var solar = Lunar.fromYmd(p.year, p.month, p.day).getSolar();
    return { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay(), hour: p.hour, minute: p.minute };
  }

  function solarToPicker(s, cal) {
    if (cal === 'solar') {
      return { year: s.year, month: s.month, day: s.day, hour: s.hour, minute: s.minute };
    }
    var lunar = Solar.fromYmd(s.year, s.month, s.day).getLunar();
    return { year: lunar.getYear(), month: lunar.getMonth(), day: lunar.getDay(), hour: s.hour, minute: s.minute };
  }

  function clampPicker() {
    if (picker.cal === 'lunar') {
      var months = lunarMonthsOf(picker.year);
      var found = false;
      for (var i = 0; i < months.length; i++) if (months[i].value === picker.month) found = true;
      if (!found && months.length) picker.month = months[0].value;
    }
    var max = monthDays(picker.cal, picker.year, picker.month);
    if (picker.day > max) picker.day = max;
    if (picker.day < 1) picker.day = 1;
  }

  function wheelItems(key) {
    var items = [];
    var i;
    if (key === 'year') {
      for (i = 1900; i <= 2100; i++) items.push({ value: i, label: String(i) });
    } else if (key === 'month') {
      if (picker.cal === 'solar') {
        for (i = 1; i <= 12; i++) items.push({ value: i, label: i + '月' });
      } else {
        items = lunarMonthsOf(picker.year).map(function (m) { return { value: m.value, label: m.label }; });
      }
    } else if (key === 'day') {
      var max = monthDays(picker.cal, picker.year, picker.month);
      for (i = 1; i <= max; i++) items.push({ value: i, label: i + '日' });
    } else if (key === 'hour') {
      for (i = 0; i < 24; i++) items.push({ value: i, label: i + '时' });
    } else if (key === 'minute') {
      for (i = 0; i < 60; i++) items.push({ value: i, label: i + '分' });
    }
    return items;
  }

  function renderWheelCol(key) {
    var col = document.querySelector('.wheel-col[data-key="' + key + '"]');
    if (!col) return;
    var items = wheelItems(key);
    col._items = items;
    var selected = 0;
    for (var i = 0; i < items.length; i++) if (items[i].value === picker[key]) selected = i;
    col.innerHTML = '<div class="wheel-list">' + items.map(function (it) {
      return '<div class="wheel-item">' + esc(it.label) + '</div>';
    }).join('') + '</div>';
    col.scrollTop = selected * 40;
  }

  function renderAllWheels() {
    ['year', 'month', 'day', 'hour', 'minute'].forEach(renderWheelCol);
  }

  function updatePickerPreview() {
    var el = $('dt-solar-preview');
    var s = pickerToSolar(picker);
    if (picker.cal === 'solar') {
      // 选公历时显示对应的农历
      var lunar = Solar.fromYmd(s.year, s.month, s.day).getLunar();
      el.textContent = '对应农历：' + lunar.getYear() + '年' + lunar.getMonthInChinese() + '月' + lunar.getDayInChinese() + '日';
    } else {
      // 选农历时显示对应的公历
      el.textContent = '对应公历：' + s.year + '-' + pad(s.month) + '-' + pad(s.day) + ' ' + pad(s.hour) + ':' + pad(s.minute);
    }
  }

  var ITEM_H = 40;

  function wheelIndex(col) {
    var items = col._items || [];
    if (!items.length) return 0;
    return Math.max(0, Math.min(items.length - 1, Math.round(col.scrollTop / ITEM_H)));
  }

  // 平滑吸附后强制校正一次，防止快速滑动/动画被打断时停在半格，露出空行
  function snapWheel(col, key) {
    var items = col._items || [];
    if (!items.length) return;
    var idx = wheelIndex(col);
    var target = idx * ITEM_H;
    // 以最终对齐的格子为准同步值，避免显示与选中值不一致
    if (items[idx] && picker[key] !== items[idx].value) picker[key] = items[idx].value;
    if (Math.abs(col.scrollTop - target) < 1) return;
    clearTimeout(picker.verifyTimers[key]);
    if (col.scrollTo) {
      try {
        col.scrollTo({ top: target, behavior: 'smooth' });
        picker.verifyTimers[key] = setTimeout(function () {
          if (Math.abs(col.scrollTop - target) >= 1) col.scrollTop = target;
        }, 360);
        return;
      } catch (e) {}
    }
    col.scrollTop = target;
  }

  // 依赖列正在被手指滑动时先不重绘，避免重置它的滚动位置
  function refreshColumn(key) {
    if (picker.touching[key]) { picker.pendingRefresh[key] = true; return; }
    renderWheelCol(key);
  }

  function finishWheel(col, key) {
    if (!col.isConnected) return;
    clampPicker();
    if (key === 'year') {
      refreshColumn('month');
      refreshColumn('day');
    } else if (key === 'month') {
      refreshColumn('day');
    }
    updatePickerPreview();
    snapWheel(col, key);
  }

  function scheduleSnap(col, key, delay) {
    clearTimeout(picker.timers[key]);
    picker.timers[key] = setTimeout(function () {
      if (picker.touching[key]) return;   // 手指还没离开，交给 touchend 再排
      finishWheel(col, key);
    }, delay == null ? 140 : delay);
  }

  function resetWheelTimers() {
    for (var k in picker.timers) clearTimeout(picker.timers[k]);
    for (var k2 in picker.verifyTimers) clearTimeout(picker.verifyTimers[k2]);
    picker.timers = {};
    picker.verifyTimers = {};
    picker.touching = {};
    picker.pendingRefresh = {};
  }

  function onWheelScroll(e) {
    var col = e.currentTarget;
    var key = col.dataset.key;
    var items = col._items;
    if (!items || !items.length) return;
    // 浏览器回弹时 idx 可能越界，夹到首/末项，避免漏掉最后一格
    var idx = Math.max(0, Math.min(items.length - 1, Math.round(col.scrollTop / ITEM_H)));
    var value = items[idx].value;
    if (picker[key] !== value) {
      picker[key] = value;
      tickSound();
      tickVibration();
    }
    scheduleSnap(col, key);
  }

  function openPicker() {
    resetWheelTimers();
    var d = state.date.split('-');
    var t = state.time.split(':');
    var solar = {
      year: parseInt(d[0], 10), month: parseInt(d[1], 10), day: parseInt(d[2], 10),
      hour: parseInt(t[0], 10), minute: parseInt(t[1], 10)
    };
    picker.cal = state.calendar;
    var parts = solarToPicker(solar, picker.cal);
    picker.year = parts.year;
    picker.month = parts.month;
    picker.day = parts.day;
    picker.hour = parts.hour;
    picker.minute = parts.minute;
    clampPicker();
    document.querySelectorAll('.cal-tab').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.cal === picker.cal);
    });
    $('datetime-modal').classList.remove('hidden');
    renderAllWheels();
    updatePickerPreview();
  }

  function switchCalendar(cal) {
    if (cal === picker.cal) return;
    var solar = pickerToSolar(picker);
    picker.cal = cal;
    var parts = solarToPicker(solar, cal);
    picker.year = parts.year;
    picker.month = parts.month;
    picker.day = parts.day;
    clampPicker();
    document.querySelectorAll('.cal-tab').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.cal === cal);
    });
    renderAllWheels();
    updatePickerPreview();
  }

  function showView(name) {
    ['input', 'result', 'cases'].forEach(function (v) {
      $('view-' + v).classList.toggle('active', v === name);
    });
    if (name === 'cases') renderCases();
    var pages = document.querySelectorAll('.view.active .page');
    if (pages.length) pages[0].scrollTop = 0;
  }

  // 返回上一页：按当前视图决定去向，供返回按钮与边缘右滑手势共用
  function goBack() {
    var active = document.querySelector('.view.active');
    if (!active) return false;
    if (active.id === 'view-input') {
      showView('cases');
    } else if (active.id === 'view-result') {
      showView(state.resultOrigin === 'cases' ? 'cases' : 'input');
    } else if (active.id === 'view-cases') {
      resetForNewCase();
      showView('input');
    } else {
      return false;
    }
    return true;
  }

  /* ---------- 输入页 ---------- */
  function syncInputUI() {
    $('input-name').value = state.name;
    $('input-remark').value = state.remark;
    $('datetime-text').textContent = formatDisplayDate(state.calendar, state.displayDate);
    $('region-text').textContent = '地区：' + state.region.name;
    document.querySelectorAll('.gender-option').forEach(function (b) {
      b.classList.toggle('selected', Number(b.dataset.gender) === state.gender);
    });
    $('switch-save').classList.toggle('on', state.save);
    $('switch-save').setAttribute('aria-checked', state.save ? 'true' : 'false');
  }

  function currentInput() {
    return {
      name: state.name,
      gender: state.gender,
      remark: state.remark,
      date: state.date,
      time: state.time,
      calendar: state.calendar,
      displayDate: state.displayDate,
      region: state.region
    };
  }

  // 回到主界面准备新建命例：清空上一次的姓名与备注，时间恢复默认农历
  function resetForNewCase() {
    state.name = '';
    state.remark = '';
    state.date = todayStr();
    state.time = timeStr();
    state.calendar = 'lunar';
    state.displayDate = defaultDisplayDate('lunar');
    state.currentCaseId = null;
    state.currentResult = null;
    syncInputUI();
  }

  function calculate(saveOverride) {
    var input = currentInput();
    if (!input.date || !input.time) { toast('请先选择公历时间'); return; }
    try {
      var result = Bazi.compute(input);
      state.currentResult = result;
      renderResult(result);
      showView('result');

      var shouldSave = typeof saveOverride === 'boolean' ? saveOverride : state.save;
      if (shouldSave && !state.currentCaseId) {
        var id = CaseStore.add(input);
        if (id) {
          state.currentCaseId = id;
          toast('命例已保存');
        } else {
          toast('保存失败，本地存储空间可能已满');
        }
      } else if (shouldSave && state.currentCaseId) {
        CaseStore.update(state.currentCaseId, input);
        toast('命例已更新');
      }
    } catch (e) {
      toast('排盘失败：' + e.message);
    }
  }

  /* ---------- 结果页 ---------- */
  function renderResult(r) {
    var info = ''
      + '<p>' + (r.input.name || '某人') + '：' + (r.input.gender === 0 ? '女士' : '男士') + '</p>'
      + '<p>出生地区：' + esc(r.input.region.name || '未知') + '</p>'
      + '<p>北京时间：' + esc(r.beijingText) + '</p>';
    if (r.correctionText) info += '<p>' + esc(r.correctionText) + '</p>';
    info += '<p>虚岁：' + esc(r.xuAge) + '岁 · 年龄：' + esc(r.ageText) + '</p>'
      + '<p>农历：' + esc(r.lunarText) + '</p>';

    var d = state.display;
    var pillars = r.pillars.map(function (p) {
      return '<div class="pillar">'
        + (d.ganShen ? '<div class="p-gan-shen">' + esc(p.ganShen) + '</div>' : '')
        + '<div class="p-gan">' + esc(p.gan) + '</div>'
        + '<div class="p-zhi">' + esc(p.zhi) + '</div>'
        + (d.hide ? '<div class="p-hide">' + esc(p.hide) + '</div>' : '')
        + (d.hideShen ? '<div class="p-hide-shen">' + esc(p.hideShen) + '</div>' : '')
        + (d.dishi ? '<div class="p-dishi">' + esc(p.dishi) + '</div>' : '')
        + (d.nayin ? '<div class="p-nayin">' + esc(p.nayin) + '</div>' : '')
        + '</div>';
    }).join('');

    var yunList = (r.yun && r.yun.list) || [];
    var firstYun = yunList[0];
    var yunIntroHtml = '<div class="yun-intro"><p>' + esc(r.yun.startText) + '</p><p>' + esc(r.yun.jiaoText) + '</p></div>';
    var yunHtml = '';

    if (d.liunian) {
      var yunCaption = firstYun
        ? '<div class="yun-caption">大运 ' + esc(firstYun.gan + firstYun.zhi) + '起 · 虚岁 ' + esc(firstYun.age) + '</div>'
        : '';

      var flowRows = [];
      function addFlowRow(label, values, cls) {
        var cells = values.map(function (v) {
          return '<td class="' + cls + '">' + esc(v == null ? '' : v) + '</td>';
        }).join('');
        flowRows.push('<tr><td class="flow-label">' + esc(label) + '</td>' + cells + '</tr>');
      }

      if (d.ganShen) addFlowRow('十神', yunList.map(function (x) { return x.shen; }), 'flow-shen');
      addFlowRow('大运', yunList.map(function (x) { return x.gan + x.zhi; }), 'flow-gan');
      if (d.dishi) addFlowRow('地势', yunList.map(function (x) { return x.dishiFull || x.dishi; }), 'flow-dishi');
      addFlowRow('虚岁', yunList.map(function (x) { return String(x.age); }), 'flow-num');
      addFlowRow('始于', yunList.map(function (x) { return String(x.year); }), 'flow-year');

      var maxLiunian = 0;
      yunList.forEach(function (x) {
        maxLiunian = Math.max(maxLiunian, (x.liunian || []).length);
      });
      for (var li = 0; li < maxLiunian; li++) {
        (function (idx) {
          addFlowRow('流年' + (idx + 1), yunList.map(function (x) {
            var ln = (x.liunian || [])[idx];
            return ln ? ln.ganzhi : '';
          }), 'flow-liunian');
        })(li);
      }

      addFlowRow('止于', yunList.map(function (x) {
        return String(x.endYear != null ? x.endYear : x.year + 9);
      }), 'flow-year');

      yunHtml = yunCaption + yunIntroHtml
        + (yunList.length
          ? '<div class="yun-scroll"><table class="yun-table yun-table-flow"><tbody>' + flowRows.join('') + '</tbody></table></div>'
          : '');
    } else {
      function classicRows(cls, key) {
        return '<tr>' + yunList.map(function (x) {
          return '<td class="' + cls + '">' + esc(x[key] == null ? '' : x[key]) + '</td>';
        }).join('') + '</tr>';
      }
      yunHtml = yunIntroHtml
        + (yunList.length
          ? '<div class="yun-scroll"><table class="yun-table"><tbody>'
            + (d.ganShen ? classicRows('yun-shen', 'shen') : '')
            + classicRows('yun-gan', 'gan')
            + classicRows('yun-zhi', 'zhi')
            + '<tr>' + yunList.map(function (x) { return '<td class="yun-num">' + pad(x.age) + '</td>'; }).join('') + '</tr>'
            + '<tr>' + yunList.map(function (x) { return '<td class="yun-num">' + String(x.year).slice(-2) + '</td>'; }).join('') + '</tr>'
            + (d.dishi ? classicRows('yun-dishi', 'dishi') : '')
            + '</tbody></table></div>'
          : '');
    }

    var palaceHtml = '';
    if (d.liunian && (r.taiyuan || r.minggong)) {
      var tai = r.taiyuan || {};
      var ming = r.minggong || {};
      palaceHtml = '<div class="palace-row">'
        + '<div><span>胎元</span><b>' + esc(tai.ganzhi || '') + '</b>'
        + (tai.nayin ? '<em>（' + esc(tai.nayin) + '）</em>' : '') + '</div>'
        + '<div><span>命宫</span><b>' + esc(ming.ganzhi || '') + '</b>'
        + (ming.nayin ? '<em>（' + esc(ming.nayin) + '）</em>' : '') + '</div>'
        + '</div>';
    }

    $('result-content').innerHTML = ''
      + '<div class="result-info">' + info + '</div>'
      + '<div class="pillars">' + pillars + '</div>'
      + yunHtml
      + palaceHtml
      + '<div class="result-remark" data-edit-remark="result">'
      + '<div class="result-remark-head"><span>备注</span><span class="result-remark-edit">点击修改</span></div>'
      + '<div class="result-remark-text' + (r.input.remark ? '' : ' empty') + '">'
      + (r.input.remark ? esc(r.input.remark) : '暂无备注，点击添加')
      + '</div></div>'
      + '<div class="result-tail">八字排盘 ' + APP_VERSION + ' · 结果仅供传统文化研究参考</div>';
  }

  /* ---------- 命例页 ---------- */
  function visibleCases() {
    var all = CaseStore.list();
    var q = String(state.searchQuery || '').trim().toLowerCase();
    if (!q) return all;
    return all.filter(function (c) {
      var lunar = (c.calendar === 'lunar' && c.displayDate && c.displayDate.year)
        ? formatDisplayDate('lunar', c.displayDate) : '';
      var fields = [c.name, c.remark, c.date, c.time, (c.region && c.region.name), lunar];
      for (var i = 0; i < fields.length; i++) {
        if (String(fields[i] || '').toLowerCase().indexOf(q) !== -1) return true;
      }
      return false;
    });
  }

  function renderCases() {
    var cases = visibleCases();
    var listEl = $('cases-list');
    $('cases-empty').classList.toggle('hidden', cases.length > 0);
    var searching = !!String(state.searchQuery || '').trim();
    $('cases-empty-title').textContent = searching ? '没有找到匹配的命例' : '还没有保存任何命例';
    $('cases-empty-sub').textContent = searching ? '试试其他姓名、备注或日期关键词' : '在排盘界面打开“保存此八字”后排盘即可保存';
    $('btn-empty-to-input').classList.toggle('hidden', searching);
    listEl.classList.toggle('manage-mode', state.manageMode);
    $('btn-manage-cases').textContent = state.manageMode ? '完成' : '管理';
    $('case-toolbar').classList.toggle('hidden', !state.manageMode);
    $('cases-footer').classList.toggle('hidden', state.manageMode);

    listEl.innerHTML = cases.map(function (c) {
      var selected = !!state.selected[c.id];
      var meta = (c.calendar === 'lunar' && c.displayDate && c.displayDate.year)
        ? formatDisplayDate('lunar', c.displayDate)
        : '公历：' + c.date + ' ' + c.time;
      return '<div class="case-item' + (selected ? ' selected' : '') + '" data-id="' + esc(c.id) + '">'
        + '<input type="checkbox" class="case-check" ' + (selected ? 'checked' : '') + ' data-id="' + esc(c.id) + '" aria-label="选择命例">'
        + '<div class="case-main" data-open="' + esc(c.id) + '">'
        + '<div class="case-meta">'
        + '<span class="case-name">' + esc(c.name || '未命名') + '</span>'
        + '<span class="case-gender">' + (c.gender === 0 ? '女' : '男') + '</span>'
        + '<span class="case-time">' + esc(meta) + '</span>'
        + '</div>'
        + '<div class="case-remark' + (c.remark ? '' : ' empty') + '" data-edit-remark="' + esc(c.id) + '">'
        + (c.remark ? '<span class="remark-tag">备注</span>' + esc(c.remark) : '点击添加备注')
        + '</div>'
        + '</div>'
        + '<button type="button" class="case-edit" data-edit-case="' + esc(c.id) + '">修改</button>'
        + '<button type="button" class="case-del" data-del="' + esc(c.id) + '">删除</button>'
        + '</div>';
    }).join('');
  }

  function openCase(id) {
    var c = CaseStore.get(id);
    if (!c) { toast('命例不存在'); return; }
    state.name = c.name || '';
    state.gender = c.gender;
    state.remark = c.remark || '';
    state.date = c.date;
    state.time = c.time;
    state.calendar = c.calendar === 'lunar' ? 'lunar' : 'solar';
    if (c.displayDate && c.displayDate.year) {
      state.displayDate = c.displayDate;
    } else {
      var dd = c.date.split('-');
      var tt = c.time.split(':');
      state.displayDate = {
        year: parseInt(dd[0], 10), month: parseInt(dd[1], 10), day: parseInt(dd[2], 10),
        hour: parseInt(tt[0], 10), minute: parseInt(tt[1], 10)
      };
    }
    state.region = c.region || { name: '未知地-即北京时间', longitude: null };
    state.currentCaseId = id;
    state.resultOrigin = 'cases';
    syncInputUI();
    try {
      var r = Bazi.compute(currentInput());
      state.currentResult = r;
      renderResult(r);
      showView('result');
    } catch (e) { toast('排盘失败：' + e.message); }
  }

  var remarkTarget = null;

  function openRemarkEditor(target) {
    remarkTarget = target;
    var current = '';
    if (target === 'result') {
      current = state.remark || '';
      $('remark-dialog-title').textContent = '修改备注';
    } else {
      var c = CaseStore.get(target);
      current = c ? (c.remark || '') : '';
      $('remark-dialog-title').textContent = '修改命例备注';
    }
    $('remark-input').value = current;
    $('remark-modal').classList.remove('hidden');
    setTimeout(function () { $('remark-input').focus(); }, 50);
  }

  function saveRemark() {
    var value = $('remark-input').value.trim();
    if (remarkTarget === 'result') {
      state.remark = value;
      if (state.currentCaseId) CaseStore.update(state.currentCaseId, { remark: value });
      if (state.currentResult) {
        state.currentResult.input.remark = value;
        renderResult(state.currentResult);
      }
      toast('备注已更新');
    } else if (remarkTarget) {
      var ok = CaseStore.update(remarkTarget, { remark: value });
      if (ok) {
        if (state.currentCaseId === remarkTarget) {
          state.remark = value;
          if (state.currentResult) {
            state.currentResult.input.remark = value;
            renderResult(state.currentResult);
          }
        }
        renderCases();
        toast('备注已保存');
      } else {
        toast('保存失败');
      }
    }
    $('remark-modal').classList.add('hidden');
    remarkTarget = null;
  }

  var editCaseTarget = null;
  var editCaseGender = 1;

  function openCaseEditor(id) {
    var c = CaseStore.get(id);
    if (!c) { toast('命例不存在'); return; }
    editCaseTarget = id;
    editCaseGender = c.gender === 0 ? 0 : 1;
    $('case-edit-name').value = c.name || '';
    document.querySelectorAll('#case-edit-gender .gender-option').forEach(function (b) {
      b.classList.toggle('selected', Number(b.dataset.gender) === editCaseGender);
    });
    $('case-edit-modal').classList.remove('hidden');
    setTimeout(function () { $('case-edit-name').focus(); }, 50);
  }

  function saveCaseEdit() {
    if (!editCaseTarget) return;
    var name = $('case-edit-name').value.trim();
    var ok = CaseStore.update(editCaseTarget, { name: name, gender: editCaseGender });
    if (!ok) { toast('保存失败'); return; }
    // 性别影响大运顺逆：若当前结果页正显示该命例，重新排盘
    if (state.currentCaseId === editCaseTarget) {
      state.name = name;
      state.gender = editCaseGender;
      if (state.currentResult) {
        try {
          var r = Bazi.compute(currentInput());
          state.currentResult = r;
          renderResult(r);
        } catch (e) {}
      }
    }
    renderCases();
    $('case-edit-modal').classList.add('hidden');
    editCaseTarget = null;
    toast('命例已更新');
  }

  function askConfirm(title, message, action) {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    state.confirmAction = action;
    $('confirm-modal').classList.remove('hidden');
  }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
  }

  function exportResults(inputs, baseName) {
    var results = [];
    for (var i = 0; i < inputs.length; i++) {
      try { results.push(Bazi.compute(inputs[i])); }
      catch (e) { toast('第 ' + (i + 1) + ' 例计算失败'); }
    }
    if (!results.length) return;
    WordExport.exportWord(results, baseName, state.display).then(function (ok) {
      toast(ok ? 'Word 已导出' : '导出失败');
    }).catch(function () { toast('导出失败'); });
  }

  /* ---------- 导出命例选择 ---------- */
  function openExportModal() {
    var cases = CaseStore.list();
    if (!cases.length) { toast('没有可导出的命例'); return; }
    state.exportSelected = {};
    cases.forEach(function (c) { state.exportSelected[c.id] = true; });
    renderExportList();
    $('export-modal').classList.remove('hidden');
  }

  function renderExportList() {
    var cases = CaseStore.list();
    $('export-list').innerHTML = cases.map(function (c) {
      var meta = (c.calendar === 'lunar' && c.displayDate && c.displayDate.year)
        ? formatDisplayDate('lunar', c.displayDate) : '公历：' + c.date + ' ' + c.time;
      return '<label class="export-item">'
        + '<input type="checkbox" class="export-check" data-id="' + esc(c.id) + '"'
        + (state.exportSelected[c.id] ? ' checked' : '') + '>'
        + '<span class="export-item-main">'
        + '<span class="export-item-name">' + esc(c.name || '未命名') + '（' + (c.gender === 0 ? '女' : '男') + '）</span>'
        + '<span class="export-item-time">' + esc(meta) + '</span>'
        + '</span></label>';
    }).join('');
  }

  function selectedExportIds() {
    return Object.keys(state.exportSelected).filter(function (k) { return state.exportSelected[k]; });
  }

  function doExportSelected() {
    var ids = selectedExportIds();
    if (!ids.length) { toast('请先选择要导出的命例'); return; }
    var inputs = ids.map(function (id) { return CaseStore.get(id); }).filter(Boolean);
    if (!inputs.length) { toast('命例不存在'); return; }
    $('export-modal').classList.add('hidden');
    exportResults(inputs, '八字命例_共' + inputs.length + '例');
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btn-input-back').onclick = goBack;
    $('btn-goto-cases').onclick = function () { state.currentCaseId = null; showView('cases'); };
    $('btn-result-back').onclick = goBack;
    $('btn-result-to-input').onclick = function () { resetForNewCase(); showView('input'); };
    $('btn-cases-back').onclick = goBack;
    $('btn-empty-to-input').onclick = function () { resetForNewCase(); showView('input'); };

    $('input-name').oninput = function () { state.name = this.value; };
    $('input-remark').oninput = function () { state.remark = this.value; };

    document.querySelectorAll('.gender-option').forEach(function (b) {
      b.onclick = function () {
        state.gender = Number(this.dataset.gender);
        syncInputUI();
      };
    });

    $('switch-save').onclick = function () {
      state.save = !state.save;
      syncInputUI();
    };

    $('btn-pick-datetime').onclick = openPicker;
    document.querySelectorAll('.cal-tab').forEach(function (b) {
      b.onclick = function () { switchCalendar(this.dataset.cal); };
    });
    $('dt-sound-toggle').onclick = function () {
      picker.sound = !picker.sound;
      saveFeedback();
      syncFeedbackUI();
      if (picker.sound) tickSound();
    };
    $('dt-vibrate-toggle').onclick = function () {
      picker.vibrate = !picker.vibrate;
      saveFeedback();
      syncFeedbackUI();
      if (picker.vibrate) tickVibration();
    };
    document.querySelectorAll('.wheel-col').forEach(function (col) {
      var key = col.dataset.key;
      col.addEventListener('scroll', onWheelScroll, { passive: true });
      col.addEventListener('touchstart', function () {
        picker.touching[key] = true;
        clearTimeout(picker.timers[key]);
      }, { passive: true });
      var onTouchEnd = function () {
        picker.touching[key] = false;
        if (picker.pendingRefresh[key]) {
          delete picker.pendingRefresh[key];
          renderWheelCol(key);
        }
        // 手指离开后惯性滚动还会继续，由后续 scroll 事件不断推迟吸附
        scheduleSnap(col, key, 60);
      };
      col.addEventListener('touchend', onTouchEnd, { passive: true });
      col.addEventListener('touchcancel', onTouchEnd, { passive: true });
      if ('onscrollend' in window) {
        col.addEventListener('scrollend', function () { scheduleSnap(col, key, 20); });
      }
    });
    $('btn-datetime-confirm').onclick = function () {
      var s = pickerToSolar(picker);
      state.calendar = picker.cal;
      state.displayDate = {
        year: picker.year, month: picker.month, day: picker.day,
        hour: picker.hour, minute: picker.minute
      };
      state.date = s.year + '-' + pad(s.month) + '-' + pad(s.day);
      state.time = pad(s.hour) + ':' + pad(s.minute);
      syncInputUI();
      resetWheelTimers();
      $('datetime-modal').classList.add('hidden');
    };

    $('btn-pick-region').onclick = function () {
      state.pendingRegionIndex = 0;
      renderRegionChips();
      $('picker-longitude').value = (typeof state.region.longitude === 'number') ? state.region.longitude : '';
      $('region-modal').classList.remove('hidden');
    };
    $('btn-region-confirm').onclick = function () {
      var custom = parseFloat($('picker-longitude').value);
      if (!isNaN(custom) && custom >= 70 && custom <= 140) {
        state.region = { name: '自定义东经' + custom + '°', longitude: custom };
      } else {
        var r = Bazi.REGIONS[state.pendingRegionIndex] || Bazi.REGIONS[0];
        state.region = { name: r.name, longitude: r.longitude };
      }
      syncInputUI();
      $('region-modal').classList.add('hidden');
    };

    $('btn-result-settings').onclick = function () {
      document.querySelectorAll('#settings-modal input[data-opt]').forEach(function (el) {
        el.checked = !!state.display[el.dataset.opt];
      });
      $('settings-modal').classList.remove('hidden');
    };
    $('btn-settings-save').onclick = function () {
      document.querySelectorAll('#settings-modal input[data-opt]').forEach(function (el) {
        state.display[el.dataset.opt] = el.checked;
      });
      saveDisplay(state.display);
      $('settings-modal').classList.add('hidden');
      if (state.currentResult) renderResult(state.currentResult);
      toast('显示设置已保存');
    };

    $('btn-calculate').onclick = function () { calculate(); };

    $('btn-export-current').onclick = function () {
      if (!state.currentResult) { toast('请先排盘'); return; }
      var name = state.currentResult.input.name || '八字命例';
      exportResults([currentInput()], name);
    };
    $('btn-save-current').onclick = function () {
      if (!state.currentResult) { toast('请先排盘'); return; }
      if (state.currentCaseId) {
        CaseStore.update(state.currentCaseId, currentInput());
        toast('命例已更新');
      } else {
        var id = CaseStore.add(currentInput());
        if (id) { state.currentCaseId = id; toast('命例已保存'); }
        else toast('保存失败');
      }
    };

    $('btn-manage-cases').onclick = function () {
      state.manageMode = !state.manageMode;
      if (!state.manageMode) state.selected = {};
      renderCases();
    };
    $('btn-search-cases').onclick = function () {
      state.searchOpen = !state.searchOpen;
      $('search-bar').classList.toggle('hidden', !state.searchOpen);
      if (state.searchOpen) {
        $('search-input').focus();
      } else {
        state.searchQuery = '';
        $('search-input').value = '';
        renderCases();
      }
    };
    $('search-input').oninput = function () {
      state.searchQuery = this.value;
      renderCases();
    };
    $('btn-search-clear').onclick = function () {
      $('search-input').value = '';
      state.searchQuery = '';
      renderCases();
      $('search-input').focus();
    };
    $('btn-select-all').onclick = function () {
      var cases = visibleCases();
      var ids = cases.map(function (c) { return c.id; });
      var allSelected = ids.length > 0 && ids.every(function (id) { return state.selected[id]; });
      state.selected = {};
      if (!allSelected) ids.forEach(function (id) { state.selected[id] = true; });
      renderCases();
    };
    $('btn-export-selected').onclick = function () {
      var ids = selectedIds();
      if (!ids.length) { toast('请先勾选命例'); return; }
      var inputs = ids.map(function (id) { return CaseStore.get(id); }).filter(Boolean);
      exportResults(inputs, '八字命例_共' + inputs.length + '例');
    };
    $('btn-delete-selected').onclick = function () {
      var ids = selectedIds();
      if (!ids.length) { toast('请先勾选命例'); return; }
      askConfirm('批量删除', '确定删除选中的 ' + ids.length + ' 条命例吗？此操作不可恢复。', function () {
        var n = CaseStore.remove(ids);
        state.selected = {};
        renderCases();
        toast('已删除 ' + n + ' 条命例');
      });
    };
    $('btn-export-all').onclick = openExportModal;
    $('btn-export-select-all').onclick = function () {
      CaseStore.list().forEach(function (c) { state.exportSelected[c.id] = true; });
      renderExportList();
    };
    $('btn-export-clear').onclick = function () {
      state.exportSelected = {};
      renderExportList();
    };
    $('btn-export-do').onclick = doExportSelected;
    $('export-list').addEventListener('change', function (e) {
      var box = e.target.closest ? e.target.closest('.export-check') : null;
      if (box) state.exportSelected[box.dataset.id] = box.checked;
    });
    $('btn-backup-cases').onclick = function () {
      var cases = CaseStore.list();
      if (!cases.length) { toast('没有可备份的命例'); return; }
      var blob = new Blob([CaseStore.exportJSON()], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '八字命例备份_' + todayStr() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast('已备份 ' + cases.length + ' 条命例');
    };
    $('btn-import-cases').onclick = function () { $('file-import').click(); };
    $('file-import').onchange = function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var n = CaseStore.importJSON(String(reader.result));
        renderCases();
        toast(n ? '成功导入 ' + n + ' 条命例' : '导入失败或没有有效命例');
      };
      reader.readAsText(file, 'utf-8');
      this.value = '';
    };

    document.addEventListener('click', function (e) {
      var close = e.target.closest('[data-close]');
      if (close) { $(close.dataset.close).classList.add('hidden'); return; }
      var remark = e.target.closest('[data-edit-remark]');
      if (remark) { openRemarkEditor(remark.dataset.editRemark); return; }
      var editCase = e.target.closest('[data-edit-case]');
      if (editCase) {
        e.stopPropagation();
        openCaseEditor(editCase.dataset.editCase);
        return;
      }
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        var id = del.dataset.del;
        askConfirm('删除命例', '确定删除这条命例吗？此操作不可恢复。', function () {
          CaseStore.remove([id]);
          if (state.currentCaseId === id) state.currentCaseId = null;
          delete state.selected[id];
          renderCases();
          toast('已删除');
        });
        return;
      }
      var check = e.target.closest('.case-check');
      if (check) {
        state.selected[check.dataset.id] = check.checked;
        check.closest('.case-item').classList.toggle('selected', check.checked);
        return;
      }
      var open = e.target.closest('[data-open]');
      if (open) { openCase(open.dataset.open); return; }
      var chip = e.target.closest('.region-chip');
      if (chip) {
        state.pendingRegionIndex = Number(chip.dataset.index);
        renderRegionChips();
      }
    });

    $('btn-remark-save').onclick = saveRemark;
    $('btn-case-edit-save').onclick = saveCaseEdit;
    document.querySelectorAll('#case-edit-gender .gender-option').forEach(function (b) {
      b.onclick = function () {
        editCaseGender = Number(this.dataset.gender);
        document.querySelectorAll('#case-edit-gender .gender-option').forEach(function (x) {
          x.classList.toggle('selected', Number(x.dataset.gender) === editCaseGender);
        });
      };
    });
    $('btn-confirm-ok').onclick = function () {
      $('confirm-modal').classList.add('hidden');
      var fn = state.confirmAction;
      state.confirmAction = null;
      if (fn) fn();
    };

    bindSwipeBack();
  }

  // 左边缘右滑返回上一页
  function bindSwipeBack() {
    var EDGE = 40;        // 从屏幕左侧 40px 内开始
    var THRESHOLD = 70;   // 右滑超过 70px 触发返回
    var sx = 0, sy = 0, active = false, view = null, moved = false, blocked = false;

    function anyModalOpen() {
      return !!document.querySelector('.modal:not(.hidden)');
    }

    function resetView() {
      if (view) {
        view.style.transition = '';
        view.style.transform = '';
        view.style.opacity = '';
      }
      view = null;
    }

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      if (t.clientX > EDGE) { blocked = false; return; }
      // 弹层打开时：接管手势但不返回，避免触发浏览器级边缘滑动导航
      if (anyModalOpen()) { blocked = true; active = false; return; }
      // 不在可横向滚动的表格内开始，避免与表格滑动冲突
      if (t.target.closest && t.target.closest('.yun-scroll')) { blocked = false; return; }
      blocked = false;
      sx = t.clientX;
      sy = t.clientY;
      active = true;
      moved = false;
      view = document.querySelector('.view.active');
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (blocked) {
        // 弹层打开时阻止浏览器把边缘右滑当作页面导航
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (!active || !view) return;
      var t = e.touches[0];
      var dx = t.clientX - sx;
      var dy = t.clientY - sy;
      if (dx < 0) return;
      if (dx <= Math.abs(dy)) return; // 以水平滑动为主才响应
      moved = true;
      if (e.cancelable) e.preventDefault();
      var offset = Math.min(dx, window.innerWidth * 0.6);
      view.style.transition = 'none';
      view.style.transform = 'translateX(' + offset + 'px)';
      view.style.opacity = String(Math.max(0.6, 1 - dx / (window.innerWidth * 2)));
    }, { passive: false });

    document.addEventListener('touchend', function (e) {
      if (blocked) { blocked = false; return; }
      if (!active) return;
      active = false;
      if (!view) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx;
      var dy = t.clientY - sy;
      var shouldBack = moved && dx >= THRESHOLD && dx > Math.abs(dy);
      if (shouldBack) {
        view.style.transition = 'transform .2s ease, opacity .2s ease';
        view.style.transform = 'translateX(100%)';
        var target = view;
        setTimeout(function () {
          target.style.transform = '';
          target.style.opacity = '';
          target.style.transition = '';
          goBack();
        }, 180);
      } else {
        view.style.transition = 'transform .18s ease, opacity .18s ease';
        view.style.transform = '';
        view.style.opacity = '';
        setTimeout(function () { if (view) { view.style.transition = ''; } }, 200);
      }
      view = null;
    }, { passive: true });

    document.addEventListener('touchcancel', function () {
      active = false;
      blocked = false;
      resetView();
    }, { passive: true });
  }

  function renderRegionChips() {
    $('region-list').innerHTML = Bazi.REGIONS.map(function (r, i) {
      return '<button type="button" class="region-chip' + (i === state.pendingRegionIndex ? ' selected' : '') + '" data-index="' + i + '">' + esc(r.name) + '</button>';
    }).join('');
  }

  /* ---------- 启动 ---------- */
  var versionEl = $('app-version');
  if (versionEl) versionEl.textContent = '八字排盘 · 版本 ' + APP_VERSION;
  syncInputUI();
  bind();
  syncFeedbackUI();
})();
