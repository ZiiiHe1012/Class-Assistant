(function() {
  'use strict';

  var markedLib = window.marked || { parse: function(s) { return s; } };
  var $ = function(s) { return document.querySelector(s); };
  var $$ = function(s) { return document.querySelectorAll(s); };

  // ── Electron bridge ──
  var isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

  // ── DOM references ──
  var els = {
    slideDisplay: $('#slide-display'),
    slideNav: $('#slide-nav'),
    navStatus: $('#nav-status'),
    statusText: $('#status-text'),
    analysisBody: $('#analysis-body'),
    chatMessages: $('#chat-messages'),
    chatInput: $('#chat-input'),
    fullscreenModal: $('#fullscreen-modal'),
    modalTitle: $('#modal-title'),
    modalBody: $('#modal-body'),
    settingsModal: $('#settings-modal'),
    testMsg: $('#test-msg'),
    workspace: $('.workspace'),
    sidePanel: $('#side-panel')
  };

  // ── State ──
  var state = {
    snapshot: null,
    focusedId: null,
    autoAnalyze: false,
    followLatest: true,
    analyzeMode: 'fast',
    chatHistory: [],
    chatLoading: false,
    layoutSwapped: false,
    analysisMinimized: false,
    chatMinimized: false,
    appMode: 'online', // 'online' or 'offline'
    chatAttachments: [], // [{name, dataUrl, type}]
    models: null,
    availableModels: [],
    pdfDoc: null,
    pdfCurrentPage: 1,
    pdfTotalPages: 0,
    pdfViewMode: 'scroll', // 'scroll', 'single', 'dual'
    pdfDualScroll: true, // dual-col: true=continuous scroll, false=paged
    pdfZoom: 1.0,
    pdfFileName: '',
    pdfText: '',
    pdfFiles: [], // [{name, data(Uint8Array)}]
    pdfActiveIndex: -1,
    _pdfObserver: null,
    chatModel: '' // custom chat model override
  };

  // ── Background context chips ──
  var contextChips = []; // [{label, text}]

  function addContextChip(label, text) {
    if (!text) return;
    contextChips.push({ label: label || '背景', text: text.trim() });
    renderContextChips();
  }

  function removeContextChip(idx) {
    contextChips.splice(idx, 1);
    renderContextChips();
  }

  function renderContextChips() {
    var container = $('#ctx-chips');
    if (!container) return;
    container.innerHTML = contextChips.map(function(c, i) {
      return '<span class="ctx-chip" title="' + esc(c.text).slice(0, 200) + '">' +
        '<span>' + esc(c.label) + '</span>' +
        '<span class="ctx-chip-del" data-del-chip="' + i + '">&times;</span>' +
        '</span>';
    }).join('');
  }

  function getBackgroundText() {
    var bg = $('#chat-background');
    var parts = contextChips.map(function(c) { return c.text; });
    if (bg && bg.value.trim()) parts.push(bg.value.trim());
    return parts.join('\n\n');
  }

  // ── Utilities ──
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function parseMd(s) {
    try { return markedLib.parse(s || ''); } catch(e) { return esc(s); }
  }

  function autoGrowTextarea(el, maxH) {
    maxH = maxH || 160;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  function maskApiKey(key) {
    if (!key || key.length < 8) return key ? '****' : '';
    return key.slice(0, 5) + '...' + key.slice(-4);
  }

  function showToast(msg, onClick) {
    var existing = document.querySelector('.toast-notify');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'toast-notify';
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (onClick ? '<button class="toast-btn">查看</button>' : '');
    document.body.appendChild(el);
    if (onClick) {
      el.querySelector('.toast-btn').addEventListener('click', function() {
        el.remove();
        onClick();
      });
    }
    setTimeout(function() { if (el.parentNode) el.remove(); }, 5000);
  }

  // ── Main render ──
  function render(snap) {
    state.snapshot = snap;
    renderStatus(snap.status);

    var captures = snap.captures
      .filter(function(c) { return c.status !== 'queued' || c.id === state.focusedId; })
      .sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });

    var latestUpdated = captures.slice().sort(function(a, b) {
      return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    })[0];

    if (latestUpdated && !state.focusedId) {
      state.focusedId = latestUpdated.id;
    }
    var isNewCapture = latestUpdated && state._lastCaptureCount !== undefined && captures.length > state._lastCaptureCount;
    if (isNewCapture && (state.followLatest || state._analyzeInProgress)) {
      state.focusedId = latestUpdated.id;
    }
    if (isNewCapture && !state.followLatest) {
      showToast('新课件已捕获', function() {
        state.focusedId = latestUpdated.id;
        render(snap);
      });
    }
    state._lastCaptureCount = captures.length;

    var focused = captures.find(function(c) { return c.id === state.focusedId; }) || latestUpdated || null;
    if (focused) state.focusedId = focused.id;

    renderSlide(focused);
    renderNav(captures, focused);
    renderAnalysis(focused);

    // Only sync autoAnalyze from server in online mode
    if (state.appMode === 'online') {
      var btn = $('#btn-auto-analyze');
      if (snap.status.autoAnalyze) {
        btn.classList.add('on');
        state.autoAnalyze = true;
      } else {
        btn.classList.remove('on');
        state.autoAnalyze = false;
      }
    }

    renderModeButtons();
  }

  function renderModeButtons() {
    var btns = $$('.pill-btn');
    btns.forEach(function(b) {
      if (b.dataset.mode === state.analyzeMode) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });
    var modelEl = $('#current-model-name');
    if (modelEl && state.models) {
      var m = state.analyzeMode === 'deep' ? state.models.deep : state.models.fast;
      var full = m || '--';
      modelEl.textContent = full;
      modelEl.parentElement.title = full;
    }
    var translateEl = $('#current-translate-model');
    if (translateEl && state.models) {
      var full = state.models.translate || '--';
      translateEl.textContent = full;
      translateEl.parentElement.title = full;
    }
    // Sync chat model label
    var chatLabel = $('#chat-model-label');
    if (chatLabel && state.models) {
      var chatM = state.chatModel || state.models.fast || '--';
      chatLabel.textContent = chatM.length > 15 ? chatM.slice(0, 15) + '…' : chatM;
      chatLabel.parentElement.title = chatM;
    }
  }

  function loadCurrentModels() {
    fetch('/api/current-models')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          state.models = { fast: d.fast, deep: d.deep, translate: d.translate };
          renderModeButtons();
        }
      })
      .catch(function() {});
    loadApiKeyDisplay();
  }

  function loadApiKeyDisplay() {
    var render = function(d) {
      var m = $('#api-popover-main');
      var f = $('#api-popover-fast');
      var tr = $('#api-popover-translate');
      if (m) m.textContent = d.maskedKey || '未配置';
      if (f) f.textContent = d.maskedKeyFast || '同主 API';
      if (tr) tr.textContent = d.maskedTranslateKey || '未配置';
    };
    if (state._configCache) {
      render(state._configCache);
      return;
    }
    fetch('/api/config')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        state._configCache = d;
        render(d);
      })
      .catch(function() {});
  }

  function loadAvailableModels() {
    fetch('/api/models')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok && d.models) {
          state.availableModels = d.models; // [{model, source}]
          var dd = document.querySelector('.model-dropdown');
          if (dd) {
            var empty = dd.querySelector('.model-dropdown-empty');
            if (empty) {
              var mode = dd.dataset.dropdownMode || state.analyzeMode;
              var cur = '';
              if (state.models) {
                if (mode === 'translate') cur = state.models.translate || '';
                else if (mode === 'deep') cur = state.models.deep || '';
                else if (mode === 'chat') cur = state.chatModel || state.models.fast || '';
                else cur = state.models.fast || '';
              }
              empty.outerHTML = renderModelItems(d.models, cur, mode);
              bindDropdownItems(dd);
            }
          }
        }
      })
      .catch(function() {});
  }

  // ── Status ──
  function renderStatus(status) {
    var dot = els.navStatus.querySelector('.status-dot');
    var map = {
      'in-class': '课堂进行中',
      running: '已登录 · 浏览中',
      'waiting-login': '请登录雨课堂',
      starting: '启动中',
      error: '连接异常',
      disabled: state.appMode === 'online' ? '实时模式' : '离线模式'
    };

    var statusText = map[status.browserState] || '准备就绪';
    if (status.queueSize > 0) {
      statusText += ' · 队列 ' + status.queueSize;
    }
    els.statusText.textContent = statusText;

    if (status.browserState === 'in-class') dot.style.background = 'var(--accent)';
    else if (status.browserState === 'running') dot.style.background = '#3b82f6';
    else if (status.browserState === 'waiting-login') dot.style.background = 'var(--amber)';
    else if (status.browserState === 'error') dot.style.background = 'var(--red)';
    else if (status.browserState === 'disabled') dot.style.background = '#8b5cf6';
    else dot.style.background = 'var(--text-3)';
  }

  // ── Slide display ──
  function renderSlide(capture) {
    // In offline mode with PDF loaded, always keep the PDF viewer
    if (state.appMode === 'offline' && state.pdfDoc) {
      if (!document.querySelector('.pdf-viewer')) {
        renderPdfViewer();
      }
      return;
    }

    if (!capture) {
      if (state.appMode === 'offline') {
        els.slideDisplay.innerHTML =
          '<div class="slide-placeholder">' +
            '<div class="upload-zone" id="upload-zone">' +
              '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" style="margin-bottom:12px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              '<span style="font-size:14px;font-weight:600;color:var(--text-1)">拖放文件或点击上传</span>' +
              '<span style="font-size:12px;color:var(--text-3);margin-top:6px">支持 PDF、PNG、JPG、WebP</span>' +
              '<input type="file" id="file-upload-input" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif" style="display:none" />' +
            '</div>' +
          '</div>';
      } else {
        els.slideDisplay.innerHTML = '<div class="slide-placeholder"><svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" stroke-width="1"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="2" y1="20" x2="22" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/></svg><span style="font-size:13px">等待课件载入</span></div>';
      }
      return;
    }
    var ext = (capture.fileName || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') {
      els.slideDisplay.innerHTML = '<div class="slide-placeholder"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span style="font-size:13px;font-weight:500">' + esc(capture.fileName) + '</span></div>';
    } else {
      els.slideDisplay.innerHTML =
        '<div class="slide-img-wrap">' +
          '<img src="' + capture.webPath + '" alt="" />' +
          '<div class="slide-ocr-layer"></div>' +
        '</div>';
      loadOcrLayer(capture.id);
    }
  }

  var ocrDataCache = {};
  function loadOcrLayer(captureId) {
    if (ocrDataCache[captureId]) {
      renderOcrWords(captureId, ocrDataCache[captureId]);
      return;
    }
    fetch('/api/ocr/' + captureId)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok || !d.words || !d.words.length) return;
        ocrDataCache[captureId] = d;
        renderOcrWords(captureId, d);
      })
      .catch(function() {});
  }

  function renderOcrWords(captureId, ocrData) {
    var focused = state.snapshot && state.snapshot.captures.find(function(c) { return c.id === state.focusedId; });
    if (!focused || focused.id !== captureId) return;
    var layer = els.slideDisplay.querySelector('.slide-ocr-layer');
    if (!layer) return;
    var img = els.slideDisplay.querySelector('img');
    if (!img) return;

    var doRender = function() {
      var displayW = img.clientWidth;
      var displayH = img.clientHeight;
      if (!displayW || !displayH) return;
      var scaleX = displayW / ocrData.imageWidth;
      var scaleY = displayH / ocrData.imageHeight;
      layer.innerHTML = '';
      layer.style.width = displayW + 'px';
      layer.style.height = displayH + 'px';
      for (var i = 0; i < ocrData.words.length; i++) {
        var w = ocrData.words[i];
        var span = document.createElement('span');
        span.textContent = w.text;
        span.style.position = 'absolute';
        span.style.left = (w.x * scaleX) + 'px';
        span.style.top = (w.y * scaleY) + 'px';
        span.style.fontSize = (w.h * scaleY) + 'px';
        span.style.width = (w.w * scaleX) + 'px';
        span.style.height = (w.h * scaleY) + 'px';
        span.style.lineHeight = '1';
        span.style.display = 'inline-block';
        layer.appendChild(span);
      }
    };

    if (img.complete && img.naturalWidth) {
      doRender();
    } else {
      img.addEventListener('load', doRender, { once: true });
    }
  }

  // ── Thumbnail nav ──
  function renderNav(captures, focused) {
    if (captures.length === 0) {
      els.slideNav.innerHTML = '';
      return;
    }
    els.slideNav.innerHTML = captures.map(function(c, i) {
      var activeClass = (focused && c.id === focused.id) ? ' active' : '';
      var statusIndicator = '';
      if (c.status === 'analyzing' || c.status === 'retrying') {
        statusIndicator = '<span class="thumb-status analyzing"></span>';
      } else if (c.status === 'error') {
        statusIndicator = '<span class="thumb-status error"></span>';
      }
      var ext = (c.fileName || '').split('.').pop().toLowerCase();
      var thumbContent = ext === 'pdf'
        ? '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:var(--red-dim)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>'
        : '<img src="' + c.webPath + '" alt="" />';
      return '<div class="thumb' + activeClass + '" data-id="' + c.id + '">' +
        thumbContent +
        '<span class="thumb-index">' + (i + 1) + '</span>' +
        statusIndicator +
        '</div>';
    }).join('');
  }

  // ── Analysis panel ──
  var lastRenderedAnalysis = { id: null, status: null, dt: null };

  function renderAnalysis(capture) {
    if (!capture || capture.status === 'captured') {
      if (state._analyzeInProgress) return;
      lastRenderedAnalysis = { id: null, status: null, dt: null };
      els.analysisBody.innerHTML = '<div class="panel-welcome"><p>' +
        (state.appMode === 'offline' ? '上传文件后点击「解析」' : '点击「解析此页」分析当前课件') +
        '</p></div>';
      return;
    }

    state._analyzeInProgress = false;

    var dtStatus = capture.deepThinkStatus || '';
    if (capture.status === 'done' && lastRenderedAnalysis.id === capture.id && lastRenderedAnalysis.status === 'done' && lastRenderedAnalysis.dt === dtStatus) {
      return;
    }

    lastRenderedAnalysis = { id: capture.id, status: capture.status, dt: dtStatus };

    if (capture.status === 'analyzing') {
      var attempt = capture.attemptCount || 1;
      var steps = '';
      for (var s = 1; s <= 3; s++) {
        var cls = s < attempt ? 'done' : (s === attempt ? 'active' : '');
        steps += '<span class="progress-step ' + cls + '"></span>';
      }
      els.analysisBody.innerHTML =
        '<div class="analysis-progress">' +
          '<div class="progress-ring"></div>' +
          '<div class="progress-text">正在分析课件内容</div>' +
          '<div class="progress-sub">AI 模型识别中，通常需要 10-15 秒</div>' +
          '<div class="progress-steps">' + steps + '</div>' +
        '</div>';
      return;
    }

    if (capture.status === 'retrying') {
      var retryMsg = capture.error ? ('上次失败: ' + capture.error) : '正在重试...';
      els.analysisBody.innerHTML =
        '<div class="analysis-progress">' +
          '<div class="progress-ring"></div>' +
          '<div class="progress-text">正在重新分析 (第 ' + (capture.attemptCount || 1) + ' 次)</div>' +
          '<div class="progress-sub">' + esc(retryMsg) + '</div>' +
        '</div>';
      return;
    }

    if (capture.status === 'error') {
      els.analysisBody.innerHTML =
        '<div class="card" style="margin:16px 0">' +
          '<h4>解析失败</h4>' +
          '<p class="prose">' + esc(capture.error) + '</p>' +
          '<button class="btn outline sm" style="margin-top:10px" data-do="retry" data-id="' + capture.id + '">重试</button>' +
        '</div>';
      return;
    }

    if (capture.status !== 'done') {
      els.analysisBody.innerHTML = '<div class="analysis-progress"><div class="progress-ring"></div><div class="progress-text">处理中...</div></div>';
      return;
    }

    var catColors = { 1: 'blue', 2: 'green', 3: 'amber', 4: 'red' };
    var html = '<div class="a-header">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
      '<h3>' + esc(capture.title || '分析结果') + '</h3>' +
      '<span class="tag ' + (catColors[capture.categoryId] || 'blue') + '">' + esc(capture.categoryName) + '</span>' +
      '</div>' +
      '<div class="a-actions">' +
      '<button class="a-btn" data-do="import-to-chat" data-id="' + capture.id + '">导入对话</button>' +
      '<button class="a-btn" data-do="deep-think" data-id="' + capture.id + '">深度思考</button>' +
      '<button class="a-btn" data-do="fullscreen" data-id="' + capture.id + '">全屏</button>' +
      '</div>' +
      '</div>';

    switch (capture.categoryId) {
      case 1: html += buildLecture(capture); break;
      case 2: html += buildChoice(capture); break;
      case 3: html += buildFill(capture); break;
      case 4: html += buildSubjective(capture); break;
      default: html += '<div class="prose">' + parseMd(capture.renderedMarkdown || '') + '</div>';
    }

    if (capture.deepThinkStatus === 'thinking') {
      html += '<div class="deep-think-loading"><div class="progress-ring"></div><span class="progress-text">正在深度思考，请稍候...</span></div>';
    } else if (capture.deepThinkStatus === 'error') {
      html += '<div class="card" style="margin-top:12px;border-color:var(--red-dim)"><span style="color:var(--red);font-size:12px">深度思考失败，请重试</span></div>';
    } else if (capture.deepThinkMarkdown) {
      html += '<div class="card"><h4>深度思考</h4><div class="prose">' + parseMd(capture.deepThinkMarkdown) + '</div></div>';
    }

    els.analysisBody.innerHTML = html;
    els.analysisBody.scrollTop = 0;
  }

  // ── Build helpers ──
  function diffDots(n) {
    n = Math.min(5, Math.max(1, n || 3));
    var dots = '';
    for (var i = 0; i < 5; i++) {
      dots += '<span class="diff-dot' + (i < n ? ' on' : '') + '"></span>';
    }
    return '<div class="diff-row"><span>难度</span><div class="diff-dots">' + dots + '</div></div>';
  }

  function kpTags(pts) {
    if (!pts || !pts.length) return '';
    return '<div class="kp-row">' + pts.map(function(p) { return '<span class="kp">' + esc(p) + '</span>'; }).join('') + '</div>';
  }

  function buildLecture(c) {
    var p = c.payload || {};
    var h = '';

    if (c.renderedMarkdown) {
      h += '<div class="card"><div class="prose">' + parseMd(c.renderedMarkdown) + '</div></div>';
    }

    if (p.coreConcepts && p.coreConcepts.length) {
      h += '<div class="card"><h4>核心概念</h4>';
      for (var i = 0; i < p.coreConcepts.length; i++) {
        var cc = p.coreConcepts[i];
        h += '<p class="prose"><strong>' + esc(cc.name || '') + '：</strong>' + esc(cc.explanation || '') + '</p>';
      }
      h += '</div>';
    }

    if (p.connections && p.connections.length) {
      h += '<div class="card"><h4>知识关联</h4><ul class="prose">' +
        p.connections.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></div>';
    }
    if (p.examTips && p.examTips.length) {
      h += '<div class="card"><h4>考试提示</h4><ul class="prose">' +
        p.examTips.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></div>';
    }
    return h;
  }

  function buildChoice(c) {
    var p = c.payload || {};
    var opts = p.options || [];
    var answers = p.answers || [];
    var h = diffDots(p.difficulty);

    if (p.questionStem) {
      h += '<div class="q-stem">' + esc(p.questionStem) + '</div>';
    }

    h += '<div class="opt-list" data-cid="' + c.id + '">';
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      h += '<button class="opt" data-key="' + esc(o.key) + '">' +
        '<span class="opt-key">' + esc(o.key) + '</span>' +
        '<span class="opt-text">' + esc(o.text) + '</span>' +
        '</button>';
    }
    h += '</div>';

    h += '<div class="submit-row">' +
      '<button class="btn primary sm" data-do="submit" data-cid="' + c.id + '" data-type="choice">提交</button>' +
      '<button class="btn outline sm" data-do="reveal" data-cid="' + c.id + '">答案</button>' +
      '<span class="hint">选择后提交到雨课堂</span>' +
      '</div>';

    if (answers.length) {
      h += '<div class="answer-box" data-ans="' + c.id + '" style="display:none"><h5>参考答案</h5><p>' + answers.join(', ') + '</p></div>';
    }

    if (p.explanation) {
      h += '<div class="explain-box"><h5>解析</h5><div class="prose">' + parseMd(p.explanation) + '</div></div>';
    }

    h += kpTags(p.knowledgePoints);
    return h;
  }

  function buildFill(c) {
    var p = c.payload || {};
    var blanks = p.blanks || [];
    var h = diffDots(p.difficulty);

    if (p.questionStem) {
      h += '<div class="q-stem">' + esc(p.questionStem) + '</div>';
    }

    h += '<div data-blanks="' + c.id + '">';
    var count = Math.max(blanks.length, 1);
    for (var i = 0; i < count; i++) {
      h += '<div class="blank-row"><span class="blank-label">空 ' + (i + 1) + '</span><input class="blank-input" data-idx="' + i + '" placeholder="填写..." /></div>';
    }
    h += '</div>';

    h += '<div class="submit-row">' +
      '<button class="btn primary sm" data-do="submit" data-cid="' + c.id + '" data-type="fill">提交</button>' +
      '<button class="btn outline sm" data-do="reveal" data-cid="' + c.id + '">答案</button>' +
      '</div>';

    var ans = blanks.map(function(b) { return b.answer; }).filter(Boolean);
    if (ans.length) {
      h += '<div class="answer-box" data-ans="' + c.id + '" style="display:none"><h5>参考答案</h5><p>' + ans.join(' | ') + '</p></div>';
    }

    if (p.explanation) {
      h += '<div class="explain-box"><h5>解析</h5><div class="prose">' + parseMd(p.explanation) + '</div></div>';
    }

    h += kpTags(p.knowledgePoints);
    return h;
  }

  function buildSubjective(c) {
    var p = c.payload || {};
    var h = diffDots(p.difficulty);

    if (p.questionStem) {
      h += '<div class="q-stem">' + esc(p.questionStem) + '</div>';
    }

    h += '<textarea class="subj-textarea" data-subj="' + c.id + '" placeholder="输入答案..."></textarea>';

    h += '<div class="submit-row">' +
      '<button class="btn primary sm" data-do="submit" data-cid="' + c.id + '" data-type="subjective">提交</button>' +
      '<button class="btn outline sm" data-do="reveal" data-cid="' + c.id + '">参考答案</button>' +
      '</div>';

    if (p.sampleAnswer) {
      h += '<div class="answer-box" data-ans="' + c.id + '" style="display:none"><h5>参考答案</h5><div class="prose">' + parseMd(p.sampleAnswer) + '</div></div>';
    }

    if (p.keyPoints && p.keyPoints.length) {
      h += '<div class="explain-box"><h5>得分点</h5><ul class="prose">' +
        p.keyPoints.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></div>';
    }

    if (p.explanation) {
      h += '<div class="explain-box"><h5>答题思路</h5><div class="prose">' + parseMd(p.explanation) + '</div></div>';
    }

    h += kpTags(p.knowledgePoints);
    return h;
  }

  // ── Chat rendering ──
  function renderChat() {
    if (!state.chatHistory.length) {
      els.chatMessages.innerHTML = '<div class="chat-bubble system">对当前课件有疑问？直接问我吧</div>';
      return;
    }
    els.chatMessages.innerHTML = state.chatHistory.map(function(m) {
      if (m.role === 'user') {
        var attachHtml = '';
        if (m.attachments && m.attachments.length) {
          attachHtml = '<div class="chat-attachments">' + m.attachments.map(function(a) {
            if (a.type && a.type.startsWith('image')) {
              return '<img src="' + a.dataUrl + '" class="chat-attach-img" />';
            }
            return '<span class="chat-attach-file">' + esc(a.name) + '</span>';
          }).join('') + '</div>';
        }
        return '<div class="chat-bubble user">' + esc(m.content) + attachHtml + '</div>';
      }
      return '<div class="chat-bubble assistant"><div class="prose">' + parseMd(m.content) + '</div></div>';
    }).join('');
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function renderChatAttachments() {
    var container = $('#chat-attach-preview');
    if (!container) return;
    if (!state.chatAttachments.length) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    container.innerHTML = state.chatAttachments.map(function(a, i) {
      var preview = '';
      if (a.type && a.type.startsWith('image')) {
        preview = '<img src="' + a.dataUrl + '" class="attach-thumb" title="' + esc(a.name) + '" />';
      } else {
        preview = '<span style="font-size:10px;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(a.name) + '</span>';
      }
      return '<div class="attach-chip" data-idx="' + i + '">' + preview + '<button class="attach-remove" data-remove-attach="' + i + '">&times;</button></div>';
    }).join('');
  }

  // ── Chat send ──
  function sendChat() {
    var input = els.chatInput;
    var text = input.value.trim();
    if (!text && !state.chatAttachments.length) return;
    if (state.chatLoading) return;
    input.value = '';
    input.style.height = 'auto';

    var msg = { role: 'user', content: text || '(附件)', attachments: state.chatAttachments.slice() };
    state.chatHistory.push(msg);
    state.chatAttachments = [];
    renderChatAttachments();
    renderChat();
    state.chatLoading = true;

    var replyDiv = document.createElement('div');
    replyDiv.className = 'chat-bubble assistant streaming';
    replyDiv.innerHTML = '<span class="chat-thinking-dot">思考中...</span>';
    els.chatMessages.appendChild(replyDiv);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;

    var bg = getBackgroundText();
    var accumulated = '';

    fetchStream('/api/chat-stream', {
      captureId: state.focusedId,
      messages: state.chatHistory.map(function(m) { return { role: m.role, content: m.content }; }),
      background: bg,
      model: state.chatModel || ''
    }, function(chunk) {
      accumulated += chunk;
      replyDiv.innerHTML = parseMd(accumulated);
      replyDiv.classList.remove('streaming');
      els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    }, function() {
      replyDiv.innerHTML = parseMd(accumulated || '无法回答。');
      replyDiv.classList.remove('streaming');
      state.chatHistory.push({ role: 'assistant', content: accumulated || '无法回答。' });
      state.chatLoading = false;
    }, function(err) {
      replyDiv.innerHTML = '<span class="chat-error">请求失败: ' + esc(err) + '</span>';
      replyDiv.classList.remove('streaming');
      state.chatHistory.push({ role: 'assistant', content: '请求失败: ' + err });
      state.chatLoading = false;
    });
  }

  // ── File upload (offline mode) ──
  function handleFileUpload(file) {
    if (!file) return;

    var ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf') {
      loadPdfFile(file);
      return;
    }

    var formData = new FormData();
    formData.append('file', file);

    showToast('正在上传 ' + file.name + '...');

    fetch('/api/upload', { method: 'POST', body: formData })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok) { showToast('上传失败: ' + d.error); return; }
        if (d.type === 'image' && d.capture) {
          state.focusedId = d.capture.id;
          showToast('已上传，点击「解析」分析');
        }
      })
      .catch(function(e) { showToast('上传失败: ' + e.message); });
  }

  // ── PDF Viewer ──
  function loadPdfFile(file) {
    if (!window.pdfjsLib) {
      showToast('PDF.js 未加载，请检查网络');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    showToast('正在加载 ' + file.name + '...');
    var reader = new FileReader();
    reader.onload = function(ev) {
      var typedArray = new Uint8Array(ev.target.result);
      var existIdx = -1;
      for (var i = 0; i < state.pdfFiles.length; i++) {
        if (state.pdfFiles[i].name === file.name) { existIdx = i; break; }
      }
      if (existIdx >= 0) {
        state.pdfFiles[existIdx].data = typedArray;
      } else {
        state.pdfFiles.push({ name: file.name, data: typedArray });
        existIdx = state.pdfFiles.length - 1;
      }
      openPdfByIndex(existIdx);
    };
    reader.readAsArrayBuffer(file);
  }

  function openPdfByIndex(idx) {
    if (idx < 0 || idx >= state.pdfFiles.length) return;
    var entry = state.pdfFiles[idx];
    state.pdfActiveIndex = idx;

    var dataCopy = new Uint8Array(entry.data);
    pdfjsLib.getDocument({ data: dataCopy, cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/', cMapPacked: true }).promise.then(function(pdf) {
      state.pdfDoc = pdf;
      state.pdfTotalPages = pdf.numPages;
      state.pdfCurrentPage = 1;
      state.pdfZoom = 1.0;
      state.pdfFileName = entry.name;
      renderPdfViewer();
      showToast(entry.name + ' (' + pdf.numPages + ' 页)');
    }).catch(function(err) {
      showToast('PDF 加载失败: ' + err.message);
    });
  }

  function removePdfByIndex(idx) {
    if (idx < 0 || idx >= state.pdfFiles.length) return;
    state.pdfFiles.splice(idx, 1);
    if (state.pdfFiles.length === 0) {
      state.pdfDoc = null;
      state.pdfTotalPages = 0;
      state.pdfCurrentPage = 1;
      state.pdfFileName = '';
      state.pdfActiveIndex = -1;
      renderSlide(null);
      return;
    }
    var newIdx = Math.min(idx, state.pdfFiles.length - 1);
    openPdfByIndex(newIdx);
  }

  function renderPdfViewer() {
    var dualPaged = state.pdfViewMode === 'dual' && !state.pdfDualScroll;
    var showPageNav = state.pdfViewMode === 'single' || dualPaged;
    var zoomPct = Math.round(state.pdfZoom * 100);

    var fileListHtml = '';
    if (state.pdfFiles.length > 0) {
      fileListHtml = '<div class="pdf-file-list" id="pdf-file-list">';
      for (var fi = 0; fi < state.pdfFiles.length; fi++) {
        var isActive = fi === state.pdfActiveIndex;
        fileListHtml += '<div class="pdf-file-item' + (isActive ? ' active' : '') + '" data-pdf-idx="' + fi + '">' +
          '<span class="pdf-file-name">' + esc(state.pdfFiles[fi].name) + '</span>' +
          '<button class="pdf-file-remove" data-pdf-remove="' + fi + '" title="移除">&times;</button>' +
          '</div>';
      }
      fileListHtml += '</div>';
    }

    var html =
      '<div class="pdf-viewer">' +
        '<div class="pdf-toolbar">' +
          (showPageNav ? '<button class="btn outline sm" id="pdf-prev">&larr; 上页</button>' : '') +
          '<span class="pdf-page-info" id="pdf-page-info">' + state.pdfCurrentPage + ' / ' + state.pdfTotalPages + '</span>' +
          (showPageNav ? '<button class="btn outline sm" id="pdf-next">下页 &rarr;</button>' : '') +
          '<span class="pdf-toolbar-spacer"></span>' +
          '<span class="pdf-zoom-info" id="pdf-zoom-info" title="点击输入自定义比例" style="cursor:pointer;user-select:none">' + zoomPct + '%</span>' +
          '<button class="btn outline sm" id="pdf-zoom-out" title="缩小 (Ctrl+-)">−</button>' +
          '<button class="btn outline sm" id="pdf-zoom-in" title="放大 (Ctrl++)">+</button>' +
          '<button class="btn outline sm" id="pdf-zoom-reset" title="重置缩放">重置</button>' +
          '<span class="pdf-toolbar-spacer"></span>' +
          '<button class="btn outline sm" id="pdf-add-file" title="添加文件">+ 添加</button>' +
          '<button class="btn outline sm" id="pdf-toggle-files" title="文件列表">' + esc(state.pdfFileName) + ' ▾</button>' +
          '<span class="pdf-toolbar-spacer"></span>' +
          '<div class="pdf-view-mode">' +
            '<button class="pdf-view-btn' + (state.pdfViewMode === 'scroll' ? ' active' : '') + '" data-pdf-view="scroll">连续</button>' +
            '<button class="pdf-view-btn' + (state.pdfViewMode === 'single' ? ' active' : '') + '" data-pdf-view="single">单页</button>' +
            '<button class="pdf-view-btn' + (state.pdfViewMode === 'dual' && state.pdfDualScroll ? ' active' : '') + '" data-pdf-view="dual-scroll">双栏连续</button>' +
            '<button class="pdf-view-btn' + (dualPaged ? ' active' : '') + '" data-pdf-view="dual-paged">双栏翻页</button>' +
          '</div>' +
        '</div>' +
        fileListHtml +
        '<div class="pdf-pages-container' +
          (state.pdfViewMode === 'dual' && state.pdfDualScroll ? ' dual-col' : '') +
          (state.pdfViewMode === 'single' || dualPaged ? ' single-page' : '') +
          (dualPaged ? ' dual-paged' : '') +
          '" id="pdf-pages"></div>' +
      '</div>';

    els.slideDisplay.innerHTML = html;
    els.slideNav.innerHTML = '';

    var fileListEl = document.getElementById('pdf-file-list');
    if (fileListEl) fileListEl.style.display = 'none';

    renderPdfPages();
  }

  function renderPdfPages() {
    var container = document.getElementById('pdf-pages');
    if (!container || !state.pdfDoc) return;
    container.innerHTML = '';

    if (state._pdfObserver) { state._pdfObserver.disconnect(); state._pdfObserver = null; }

    var containerWidth = container.clientWidth - 40;
    var dualPaged = state.pdfViewMode === 'dual' && !state.pdfDualScroll;

    if (state.pdfViewMode === 'single') {
      renderPdfPageFit(state.pdfCurrentPage, container, containerWidth);
    } else if (dualPaged) {
      var startPage = state.pdfCurrentPage % 2 === 0 ? state.pdfCurrentPage - 1 : state.pdfCurrentPage;
      var halfW = (containerWidth - 20) / 2;
      renderPdfPageFit(startPage, container, halfW);
      if (startPage + 1 <= state.pdfTotalPages) {
        renderPdfPageFit(startPage + 1, container, halfW);
      }
    } else {
      var isDual = state.pdfViewMode === 'dual';
      var pageWidth = isDual ? (containerWidth - 20) / 2 : containerWidth * 0.9;
      renderPdfPagesLazy(container, pageWidth);
    }
  }

  function renderPdfPagesLazy(container, maxWidth) {
    var placeholders = [];
    var estimatedHeight = maxWidth * 1.414 * state.pdfZoom;

    for (var i = 1; i <= state.pdfTotalPages; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap pdf-page-placeholder';
      wrap.dataset.page = i;
      wrap.style.width = (maxWidth * state.pdfZoom) + 'px';
      wrap.style.height = estimatedHeight + 'px';
      container.appendChild(wrap);
      placeholders.push(wrap);
    }

    var rendered = {};
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (!entry.isIntersecting) return;
        var pageNum = parseInt(entry.target.dataset.page, 10);
        if (rendered[pageNum]) return;
        rendered[pageNum] = true;
        renderPdfPageInPlace(entry.target, pageNum, maxWidth);
      });
    }, { root: container, rootMargin: '200px 0px' });

    state._pdfObserver = observer;
    placeholders.forEach(function(el) { observer.observe(el); });
  }

  function renderPdfPageInPlace(wrap, pageNum, maxWidth) {
    state.pdfDoc.getPage(pageNum).then(function(page) {
      var unscaledViewport = page.getViewport({ scale: 1.0 });
      var baseScale = maxWidth / unscaledViewport.width;
      var scale = baseScale * state.pdfZoom;
      scale = Math.max(0.3, Math.min(scale, 5.0));
      var viewport = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;

      wrap.classList.remove('pdf-page-placeholder');
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';
      wrap.innerHTML = '';

      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      wrap.appendChild(canvas);

      var textDiv = document.createElement('div');
      textDiv.className = 'pdf-text-layer';
      textDiv.style.width = viewport.width + 'px';
      textDiv.style.height = viewport.height + 'px';
      wrap.appendChild(textDiv);

      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      var renderTask = page.render({ canvasContext: ctx, viewport: viewport });

      renderTask.promise.then(function() {
        return page.getTextContent();
      }).then(function(textContent) {
        renderTextLayer(textContent, textDiv, viewport);
      }).catch(function() {});
    });
  }

  function renderPdfPageFit(pageNum, container, maxWidth) {
    state.pdfDoc.getPage(pageNum).then(function(page) {
      var unscaledViewport = page.getViewport({ scale: 1.0 });
      var baseScale = maxWidth / unscaledViewport.width;
      var scale = baseScale * state.pdfZoom;
      scale = Math.max(0.3, Math.min(scale, 5.0));
      var viewport = page.getViewport({ scale: scale });
      var dpr = window.devicePixelRatio || 1;

      var wrap = document.createElement('div');
      wrap.className = 'pdf-page-wrap';
      wrap.dataset.page = pageNum;
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      var canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      wrap.appendChild(canvas);

      var textDiv = document.createElement('div');
      textDiv.className = 'pdf-text-layer';
      textDiv.style.width = viewport.width + 'px';
      textDiv.style.height = viewport.height + 'px';
      wrap.appendChild(textDiv);

      container.appendChild(wrap);

      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      var renderTask = page.render({ canvasContext: ctx, viewport: viewport });

      renderTask.promise.then(function() {
        return page.getTextContent();
      }).then(function(textContent) {
        renderTextLayer(textContent, textDiv, viewport);
      }).catch(function() {});
    });
  }

  function renderTextLayer(textContent, container, viewport) {
    container.innerHTML = '';
    var items = textContent.items;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.str) continue;

      var tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      var span = document.createElement('span');
      span.textContent = item.str;

      var angle = Math.atan2(tx[1], tx[0]);
      var fontSize = Math.hypot(tx[2], tx[3]);

      span.style.left = tx[4] + 'px';
      span.style.top = (tx[5] - fontSize) + 'px';
      span.style.fontSize = fontSize + 'px';
      span.style.fontFamily = item.fontName ? (item.fontName + ', sans-serif') : 'sans-serif';

      if (item.width > 0) {
        var targetWidth = item.width * viewport.scale;
        span.style.width = targetWidth + 'px';
        span.style.display = 'inline-block';
        span.style.transform = (angle ? 'rotate(' + angle + 'rad)' : '');
      }

      container.appendChild(span);
    }
  }

  function pdfGoToPage(page) {
    page = Math.max(1, Math.min(page, state.pdfTotalPages));
    if (page === state.pdfCurrentPage) return;
    state.pdfCurrentPage = page;
    var info = document.getElementById('pdf-page-info');
    if (info) info.textContent = page + ' / ' + state.pdfTotalPages;

    var isScrollMode = state.pdfViewMode === 'scroll' || (state.pdfViewMode === 'dual' && state.pdfDualScroll);
    if (isScrollMode) {
      var wrap = document.querySelector('.pdf-page-wrap[data-page="' + page + '"]');
      if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      renderPdfPages();
    }

    // Auto-analyze on page navigation in offline mode
    if (state.autoAnalyze && state.appMode === 'offline' && state.pdfDoc) {
      var dualPaged = state.pdfViewMode === 'dual' && !state.pdfDualScroll;
      if (dualPaged) {
        var sp = page % 2 === 0 ? page - 1 : page;
        offlineAnalyzePdfPage(sp);
        if (sp + 1 <= state.pdfTotalPages) offlineAnalyzePdfPage(sp + 1);
      } else {
        offlineAnalyzePdfPage(page);
      }
    }
  }

  function pdfSetZoom(newZoom) {
    newZoom = Math.max(0.5, Math.min(newZoom, 3.0));
    newZoom = Math.round(newZoom * 20) / 20;
    if (newZoom === state.pdfZoom) return;

    var container = document.getElementById('pdf-pages');
    var scrollRatio = 0;
    if (container && container.scrollHeight > container.clientHeight) {
      scrollRatio = container.scrollTop / (container.scrollHeight - container.clientHeight);
    }

    state.pdfZoom = newZoom;
    var info = document.getElementById('pdf-zoom-info');
    if (info) info.textContent = Math.round(state.pdfZoom * 100) + '%';

    renderPdfPages();
    if (container) {
      requestAnimationFrame(function() {
        if (container.scrollHeight > container.clientHeight) {
          container.scrollTop = scrollRatio * (container.scrollHeight - container.clientHeight);
        }
      });
    }
  }

  // ── Offline PDF analysis ──
  function offlineAnalyzePdfPage(pageNum) {
    var wrap = document.querySelector('.pdf-page-wrap[data-page="' + pageNum + '"]');
    var canvas = wrap ? wrap.querySelector('canvas') : null;
    if (!canvas) {
      showToast('无法获取当前页面');
      return;
    }

    showToast('正在解析第 ' + pageNum + ' 页...');

    canvas.toBlob(function(blob) {
      if (!blob) { showToast('截图失败'); return; }
      var formData = new FormData();
      formData.append('file', blob, 'pdf-page-' + pageNum + '.png');

      fetch('/api/upload', { method: 'POST', body: formData })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (!d.ok) { showToast('上传失败: ' + (d.error || '')); return; }
          if (d.capture) {
            state.focusedId = d.capture.id;
          }
        })
        .catch(function(e) { showToast('解析失败: ' + e.message); });
    }, 'image/png');
  }

  // ── Chat attachment add ──
  function addChatAttachment(name, dataUrl, type) {
    state.chatAttachments.push({ name: name, dataUrl: dataUrl, type: type });
    renderChatAttachments();
  }

  // ── Screenshot to chat ──
  function captureSlideToChat() {
    // PDF mode: capture current page canvas
    if (state.pdfDoc) {
      var pageNum = state.pdfCurrentPage;
      var wrap = document.querySelector('.pdf-page-wrap[data-page="' + pageNum + '"]');
      var canvas = wrap ? wrap.querySelector('canvas') : null;
      if (canvas) {
        var dataUrl = canvas.toDataURL('image/png');
        addChatAttachment('PDF第' + pageNum + '页', dataUrl, 'image/png');
        showToast('已添加 PDF 第 ' + pageNum + ' 页到对话');
        return;
      }
    }
    // Online mode: capture current slide image
    var img = els.slideDisplay.querySelector('img');
    if (!img) {
      showToast('当前无可截图内容');
      return;
    }
    addChatAttachment('当前课件截图', img.src, 'image/png');
    showToast('已将课件添加到对话附件');
  }

  // Electron screenshot hook
  if (isElectron && window.electronAPI.onScreenshotSlide) {
    window.electronAPI.onScreenshotSlide(function() {
      captureSlideToChat();
    });
  }

  // ── Model dropdown ──
  function renderModelItems(models, currentModel, dropdownMode) {
    var lastSource = '';
    return models.map(function(item) {
      var m = typeof item === 'string' ? item : item.model;
      var src = typeof item === 'string' ? '' : (item.source || '');
      var active = m === currentModel ? ' active' : '';
      var header = '';
      if (src && src !== lastSource) {
        lastSource = src;
        header = '<div class="model-dropdown-source">' + esc(src) + '</div>';
      }
      return header + '<button class="model-dropdown-item' + active + '" data-select-model="' + esc(m) + '" data-model-mode="' + dropdownMode + '">' + esc(m) + '</button>';
    }).join('');
  }
  function bindDropdownItems(container) {
    container.querySelectorAll('[data-select-model]').forEach(function(item) {
      item.addEventListener('click', function(e) {
        e.stopPropagation();
        var selectedModel = item.dataset.selectModel;
        var mMode = item.dataset.modelMode || state.analyzeMode;

        if (mMode === 'chat') {
          // Chat mode: switch on server (auto-resolves correct API client)
          state.chatModel = selectedModel;
          fetch('/api/switch-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat: selectedModel })
          }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.ok) {
              state.models = { fast: d.fast, deep: d.deep, translate: d.translate };
            }
          }).catch(function() {});
          var label = $('#chat-model-label');
          if (label) {
            label.textContent = selectedModel.length > 15 ? selectedModel.slice(0, 15) + '…' : selectedModel;
            label.parentElement.title = selectedModel;
          }
          showToast('对话模型: ' + selectedModel);
          var dd = document.querySelector('.model-dropdown');
          if (dd) dd.remove();
          resumeYuketangView();
          return;
        }

        var payload = {};
        if (mMode === 'translate') payload.translate = selectedModel;
        else if (mMode === 'deep') payload.deep = selectedModel;
        else payload.fast = selectedModel;
        fetch('/api/switch-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) {
            state.models = { fast: d.fast, deep: d.deep, translate: d.translate };
            renderModeButtons();
            showToast('已切换: ' + selectedModel);
          }
        });
        var dd = document.querySelector('.model-dropdown');
        if (dd) dd.remove();
        resumeYuketangView();
      });
    });
  }
  function showModelDropdown(anchorEl, dropdownMode) {
    var existing = document.querySelector('.model-dropdown');
    if (existing) { existing.remove(); resumeYuketangView(); return; }

    var modeLabel = dropdownMode === 'translate' ? '翻译' : (dropdownMode === 'deep' ? '深度' : (dropdownMode === 'chat' ? '对话' : '快速'));
    var currentModel = '';
    if (dropdownMode === 'chat') {
      currentModel = state.chatModel || (state.models ? state.models.fast : '') || '';
    } else if (state.models) {
      if (dropdownMode === 'translate') currentModel = state.models.translate || '';
      else if (dropdownMode === 'deep') currentModel = state.models.deep || '';
      else currentModel = state.models.fast || '';
    }

    var rect = anchorEl.getBoundingClientRect();
    var dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';
    dropdown.dataset.dropdownMode = dropdownMode;
    // Chat model opens upward (button is near bottom); others open downward
    if (dropdownMode === 'chat') {
      dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
      dropdown.style.left = Math.max(4, rect.left) + 'px';
      dropdown.style.maxHeight = '300px';
    } else {
      dropdown.style.top = (rect.bottom + 4) + 'px';
      dropdown.style.left = Math.max(4, rect.left) + 'px';
    }

    var content = '<div class="model-dropdown-header">切换模型</div>';
    if (state.availableModels.length) {
      content += renderModelItems(state.availableModels, currentModel, dropdownMode);
    } else {
      content += '<div class="model-dropdown-empty">加载模型列表...</div>';
      fetch('/api/models').then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok && d.models) {
          state.availableModels = d.models;
          var dd = document.querySelector('.model-dropdown');
          if (dd) {
            var empty = dd.querySelector('.model-dropdown-empty');
            if (empty) {
              empty.outerHTML = renderModelItems(d.models, currentModel, dropdownMode);
              bindDropdownItems(dd);
            }
          }
        }
      }).catch(function() {});
    }
    dropdown.innerHTML = content;
    document.body.appendChild(dropdown);
    bindDropdownItems(dropdown);
    pauseYuketangView();

    setTimeout(function() {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && !anchorEl.contains(e.target)) {
          dropdown.remove();
          document.removeEventListener('click', closeDropdown);
          resumeYuketangView();
        }
      });
    }, 10);
  }

  // ── Settings ──
  function loadCfg() {
    fetch('/api/config')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.baseUrl) $('#cfg-url').value = d.baseUrl;
        // Use runtime models (state.models) if available, fallback to config file values
        var mFast = (state.models && state.models.fast) || d.modelFast || d.model || '';
        var mDeep = (state.models && state.models.deep) || d.modelDeep || d.model || '';
        var mTrans = (state.models && state.models.translate) || d.translateModel || '';
        $('#cfg-model').value = d.model || '';
        var elF = $('#cfg-model-fast'); if (elF) elF.value = mFast;
        var elD = $('#cfg-model-deep'); if (elD) elD.value = mDeep;
        var elTm = $('#cfg-translate-model'); if (elTm) elTm.value = mTrans;
        if (d.translateBaseUrl) { var el = $('#cfg-translate-url'); if (el) el.value = d.translateBaseUrl; }
        var keyEl = $('#cfg-key');
        if (keyEl) keyEl.placeholder = d.maskedKey ? ('当前: ' + d.maskedKey) : 'sk-...';
        var kfEl = $('#cfg-key-fast');
        if (kfEl) kfEl.placeholder = d.maskedKeyFast ? ('当前: ' + d.maskedKeyFast) : '留空与主密钥相同';
        var tkEl = $('#cfg-translate-key');
        if (tkEl) tkEl.placeholder = d.maskedTranslateKey ? ('当前: ' + d.maskedTranslateKey) : 'sk-...（留空使用主密钥）';
      })
      .catch(function() {});

    loadSettingsModels();

    // Sync selection settings UI
    $$('.chip[data-selection-mode]').forEach(function(c) {
      c.classList.toggle('active', c.dataset.selectionMode === selectionSettings.mode);
    });
    var si = selectionSettings.items;
    var t1 = $('#sel-item-translate'); if (t1) t1.checked = si.translate;
    var e1 = $('#sel-item-explain'); if (e1) e1.checked = si.explain;
    var a1 = $('#sel-item-ask'); if (a1) a1.checked = si.ask;
    var c1 = $('#sel-item-copy'); if (c1) c1.checked = si.copy;
  }

  function loadSettingsModels() {
    fetch('/api/models')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.ok || !d.models || !d.models.length) return;
        state.availableModels = d.models;
        renderModelSuggestions(d.models);
      })
      .catch(function() {});
  }

  function renderModelSuggestions(models) {
    var containers = ['cfg-model', 'cfg-model-fast', 'cfg-model-deep', 'cfg-translate-model'];
    containers.forEach(function(inputId) {
      var input = $('#' + inputId);
      if (!input) return;
      var existing = input.parentElement.querySelector('.model-suggestions');
      if (existing) existing.remove();
      var wrap = document.createElement('div');
      wrap.className = 'model-suggestions';
      wrap.innerHTML = '<small style="margin-top:6px;display:block;color:var(--text-3)">可用模型：</small>' +
        '<div class="model-chips">' +
        models.map(function(item) {
          var m = typeof item === 'string' ? item : item.model;
          var src = typeof item === 'string' ? '' : (item.source || '');
          var title = src ? (m + ' (' + src + ')') : m;
          return '<button type="button" class="model-chip" data-model="' + esc(m) + '" title="' + esc(title) + '">' + esc(m) + '</button>';
        }).join('') +
        '</div>';
      input.parentElement.appendChild(wrap);
    });
  }

  // ── Layout swap ──
  function toggleLayout() {
    state.layoutSwapped = !state.layoutSwapped;
    els.workspace.classList.toggle('layout-swapped', state.layoutSwapped);
  }

  // ── Panel minimize ──
  function toggleMinimize(panel) {
    var section;
    if (panel === 'analysis') {
      section = $('.analysis-section');
      state.analysisMinimized = !state.analysisMinimized;
      section.classList.toggle('minimized', state.analysisMinimized);
    } else if (panel === 'chat') {
      section = $('.chat-section');
      state.chatMinimized = !state.chatMinimized;
      section.classList.toggle('minimized', state.chatMinimized);
    }
  }

  // ── Panel resize ──
  function initPanelResize() {
    var handle = $('#panel-resize-handle');
    if (!handle) return;

    var dragging = false;
    var startY = 0;
    var analysisSection = $('.analysis-section');
    var chatSection = $('.chat-section');
    var startAnalysisH = 0;

    handle.addEventListener('mousedown', function(e) {
      dragging = true;
      startY = e.clientY;
      startAnalysisH = analysisSection.offsetHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var diff = e.clientY - startY;
      var newH = Math.max(80, startAnalysisH + diff);
      var containerH = els.sidePanel.offsetHeight - handle.offsetHeight;
      var maxH = containerH - 120;
      newH = Math.min(newH, maxH);
      analysisSection.style.flex = '0 0 ' + newH + 'px';
      chatSection.style.flex = '1';
    });

    document.addEventListener('mouseup', function() {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // ── Horizontal workspace resize ──
  function initWorkspaceResize() {
    var handle = $('#workspace-resize-handle');
    if (!handle) return;

    var dragging = false;
    var startX = 0;
    var slideStage = $('.slide-stage');
    var sidePanel = els.sidePanel;
    var startSlideW = 0;

    handle.addEventListener('mousedown', function(e) {
      dragging = true;
      startX = e.clientX;
      startSlideW = slideStage.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var diff = e.clientX - startX;
      if (els.workspace.classList.contains('layout-swapped')) diff = -diff;
      var containerW = els.workspace.offsetWidth - handle.offsetWidth;
      var newW = Math.max(300, Math.min(startSlideW + diff, containerW - 280));
      slideStage.style.flex = '0 0 ' + newW + 'px';
      sidePanel.style.flex = '1';
      sidePanel.style.width = 'auto';
      syncViewBounds();
    });

    document.addEventListener('mouseup', function() {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        syncViewBounds();
      }
    });
  }

  // ── Mouse wheel slide navigation ──
  function initWheelNavigation() {
    els.slideDisplay.addEventListener('wheel', function(e) {
      // PDF in continuous scroll modes: let native scroll work
      if (state.pdfDoc && (state.pdfViewMode === 'scroll' || (state.pdfViewMode === 'dual' && state.pdfDualScroll))) return;

      // PDF in paged modes: navigate pages
      if (state.pdfDoc && (state.pdfViewMode === 'single' || (state.pdfViewMode === 'dual' && !state.pdfDualScroll))) {
        e.preventDefault();
        var step = (state.pdfViewMode === 'dual' && !state.pdfDualScroll) ? 2 : 1;
        if (e.deltaY > 0) pdfGoToPage(state.pdfCurrentPage + step);
        else pdfGoToPage(state.pdfCurrentPage - step);
        return;
      }

      // Online mode: navigate slides
      if (!state.snapshot || !state.snapshot.captures) return;
      e.preventDefault();

      var captures = state.snapshot.captures
        .filter(function(c) { return c.status !== 'queued'; })
        .sort(function(a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });

      if (captures.length < 2) return;

      var currentIdx = captures.findIndex(function(c) { return c.id === state.focusedId; });
      if (currentIdx === -1) return;

      var next;
      if (e.deltaY > 0) {
        next = Math.min(currentIdx + 1, captures.length - 1);
      } else {
        next = Math.max(currentIdx - 1, 0);
      }

      if (next !== currentIdx) {
        state.focusedId = captures[next].id;
        render(state.snapshot);
        var activeThumb = els.slideNav.querySelector('.thumb.active');
        if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, { passive: false });
  }

  // ── Drag and drop for upload zone ──
  function initDragDrop() {
    els.slideDisplay.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var zone = $('#upload-zone');
      if (zone) zone.classList.add('drag-over');
    });
    els.slideDisplay.addEventListener('dragleave', function(e) {
      e.preventDefault();
      var zone = $('#upload-zone');
      if (zone) zone.classList.remove('drag-over');
    });
    els.slideDisplay.addEventListener('drop', function(e) {
      e.preventDefault();
      var zone = $('#upload-zone');
      if (zone) zone.classList.remove('drag-over');
      var files = e.dataTransfer.files;
      for (var i = 0; i < files.length; i++) {
        handleFileUpload(files[i]);
      }
    });
  }

  // ── Event delegation ──
  document.addEventListener('click', function(e) {
    var t = e.target;

    // Close API popover on outside click
    var pop = $('#api-popover');
    if (pop && pop.classList.contains('show') && !t.closest('#api-popover') && !t.closest('#btn-api-info')) {
      pop.classList.remove('show');
      resumeYuketangView();
    }

    // Upload zone click
    var uploadZone = t.closest('#upload-zone');
    if (uploadZone && t.tagName !== 'INPUT') {
      var fi = $('#file-upload-input');
      if (fi) fi.click();
      return;
    }

    // PDF viewer controls
    if (t.id === 'pdf-prev' || t.closest('#pdf-prev')) {
      var step = (state.pdfViewMode === 'dual' && !state.pdfDualScroll) ? 2 : 1;
      pdfGoToPage(state.pdfCurrentPage - step);
      return;
    }
    if (t.id === 'pdf-next' || t.closest('#pdf-next')) {
      var step = (state.pdfViewMode === 'dual' && !state.pdfDualScroll) ? 2 : 1;
      pdfGoToPage(state.pdfCurrentPage + step);
      return;
    }
    // PDF zoom buttons
    if (t.id === 'pdf-zoom-in' || t.closest('#pdf-zoom-in')) {
      pdfSetZoom(state.pdfZoom + 0.15);
      return;
    }
    if (t.id === 'pdf-zoom-out' || t.closest('#pdf-zoom-out')) {
      pdfSetZoom(state.pdfZoom - 0.15);
      return;
    }
    if (t.id === 'pdf-zoom-reset' || t.closest('#pdf-zoom-reset')) {
      pdfSetZoom(1.0);
      return;
    }
    if (t.id === 'pdf-zoom-info' || t.closest('#pdf-zoom-info')) {
      var zoomEl = document.getElementById('pdf-zoom-info');
      if (!zoomEl || zoomEl.querySelector('input')) return;
      var curPct = Math.round(state.pdfZoom * 100);
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.value = curPct;
      inp.min = 30; inp.max = 500; inp.step = 10;
      inp.style.cssText = 'width:52px;font-size:11px;text-align:center;border:1px solid var(--accent);border-radius:4px;padding:1px 4px;font-family:var(--mono);outline:none;background:var(--surface);';
      zoomEl.textContent = '';
      zoomEl.appendChild(inp);
      inp.focus();
      inp.select();
      var commit = function() {
        var v = parseInt(inp.value, 10);
        if (v >= 30 && v <= 500) pdfSetZoom(v / 100);
        zoomEl.textContent = Math.round(state.pdfZoom * 100) + '%';
      };
      inp.addEventListener('blur', commit);
      inp.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { zoomEl.textContent = curPct + '%'; }
      });
      return;
    }
    // PDF file management
    if (t.id === 'pdf-toggle-files' || t.closest('#pdf-toggle-files')) {
      var fl = document.getElementById('pdf-file-list');
      if (fl) fl.style.display = fl.style.display === 'none' ? '' : 'none';
      return;
    }
    if (t.id === 'pdf-add-file' || t.closest('#pdf-add-file')) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,.png,.jpg,.jpeg,.webp,.gif';
      input.onchange = function() { if (input.files[0]) handleFileUpload(input.files[0]); };
      input.click();
      return;
    }
    var removeBtn = t.closest('[data-pdf-remove]');
    if (removeBtn) {
      removePdfByIndex(parseInt(removeBtn.dataset.pdfRemove, 10));
      return;
    }
    var fileItem = t.closest('[data-pdf-idx]');
    if (fileItem && !t.closest('[data-pdf-remove]')) {
      var idx = parseInt(fileItem.dataset.pdfIdx, 10);
      if (idx !== state.pdfActiveIndex) openPdfByIndex(idx);
      var fl = document.getElementById('pdf-file-list');
      if (fl) fl.style.display = 'none';
      return;
    }
    var pdfViewBtn = t.closest('[data-pdf-view]');
    if (pdfViewBtn) {
      var pv = pdfViewBtn.dataset.pdfView;
      if (pv === 'dual-scroll') {
        state.pdfViewMode = 'dual';
        state.pdfDualScroll = true;
      } else if (pv === 'dual-paged') {
        state.pdfViewMode = 'dual';
        state.pdfDualScroll = false;
      } else {
        state.pdfViewMode = pv;
      }
      state.pdfZoom = 1.0;
      renderPdfViewer();
      return;
    }

    // Context chip delete
    var delChip = t.closest('[data-del-chip]');
    if (delChip) {
      removeContextChip(Number(delChip.dataset.delChip));
      return;
    }

    // Thumbnail click
    var thumb = t.closest('.thumb');
    if (thumb) {
      state.focusedId = thumb.dataset.id;
      state._analyzeInProgress = false;
      state.followLatest = false;
      render(state.snapshot);
      return;
    }

    // Mode toggle buttons (fast/deep)
    var modeBtn = t.closest('.pill-btn');
    if (modeBtn) {
      state.analyzeMode = modeBtn.dataset.mode || 'fast';
      renderModeButtons();
      loadApiKeyDisplay();
      return;
    }

    // Option click (choice questions)
    var opt = t.closest('.opt');
    if (opt) {
      opt.classList.toggle('selected');
      return;
    }

    // Auto analyze toggle
    if (t.closest('#btn-auto-analyze')) {
      state.autoAnalyze = !state.autoAnalyze;
      $('#btn-auto-analyze').classList.toggle('on', state.autoAnalyze);
      fetch('/api/auto-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: state.autoAnalyze, mode: state.analyzeMode })
      });
      return;
    }

    // Follow latest toggle
    if (t.closest('#btn-follow-latest')) {
      state.followLatest = !state.followLatest;
      $('#btn-follow-latest').classList.toggle('on', state.followLatest);
      return;
    }

    // Translate toggle
    if (t.closest('#btn-translate-toggle')) {
      if (selectionSettings.mode === 'off') {
        selectionSettings.mode = selectionSettings._prevMode || 'toolbar';
      } else {
        selectionSettings._prevMode = selectionSettings.mode;
        selectionSettings.mode = 'off';
      }
      saveSelectionSettings();
      $('#btn-translate-toggle').classList.toggle('on', selectionSettings.mode !== 'off');
      return;
    }

    // Manual analyze
    if (t.closest('#btn-manual-analyze')) {
      var analyzeBtn = t.closest('#btn-manual-analyze') || t;
      analyzeBtn.style.pointerEvents = 'none';
      analyzeBtn.style.opacity = '0.5';
      setTimeout(function() { analyzeBtn.style.pointerEvents = ''; analyzeBtn.style.opacity = ''; }, 4000);

      lastRenderedAnalysis = { id: null, status: null, dt: null };
      state._analyzeInProgress = true;

      // Show loading immediately in the analysis panel
      els.analysisBody.innerHTML =
        '<div class="analysis-progress">' +
          '<div class="progress-ring"></div>' +
          '<div class="progress-text">正在解析内容</div>' +
          '<div class="progress-sub">AI 模型识别中，通常需要 10-15 秒</div>' +
          '<div class="progress-steps"><span class="progress-step active"></span><span class="progress-step"></span><span class="progress-step"></span></div>' +
        '</div>';

      if (state.appMode === 'offline' && state.pdfDoc) {
        var dualPaged = state.pdfViewMode === 'dual' && !state.pdfDualScroll;
        if (dualPaged) {
          var startPage = state.pdfCurrentPage % 2 === 0 ? state.pdfCurrentPage - 1 : state.pdfCurrentPage;
          offlineAnalyzePdfPage(startPage);
          if (startPage + 1 <= state.pdfTotalPages) {
            offlineAnalyzePdfPage(startPage + 1);
          }
        } else {
          offlineAnalyzePdfPage(state.pdfCurrentPage);
        }
      } else if (state.focusedId) {
        fetch('/api/analyze-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captureId: state.focusedId, mode: state.analyzeMode })
        });
      } else {
        if (isElectron && state.appMode === 'online') {
          window.electronAPI.manualScan().then(function(r) {
            if (!r || !r.ok) showToast('扫描失败：请先打开雨课堂视图');
          });
        } else {
          fetch('/api/analyze-current', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: state.analyzeMode })
          });
        }
      }
      return;
    }

    // Toggle slide nav (queue) visibility
    if (t.closest('#btn-toggle-nav')) {
      var nav = $('#slide-nav');
      var btn = $('#btn-toggle-nav');
      if (nav) {
        nav.classList.toggle('collapsed');
        if (btn) btn.textContent = nav.classList.contains('collapsed') ? '▲ 队列' : '▼ 队列';
      }
      return;
    }

    // Layout swap
    if (t.closest('#btn-layout-swap')) {
      toggleLayout();
      return;
    }

    // Panel minimize
    var minBtn = t.closest('[data-minimize]');
    if (minBtn) {
      toggleMinimize(minBtn.dataset.minimize);
      return;
    }

    // Model chip click in settings
    var modelChip = t.closest('.model-chip');
    if (modelChip) {
      var input = modelChip.closest('.field').querySelector('input');
      if (input) input.value = modelChip.dataset.model;
      return;
    }

    // Model dropdown select
    var modelSelect = t.closest('[data-select-model]');
    if (modelSelect) {
      var selectedModel = modelSelect.dataset.selectModel;
      var mMode = modelSelect.dataset.modelMode || state.analyzeMode;
      var payload = {};
      if (mMode === 'translate') payload.translate = selectedModel;
      else if (mMode === 'deep') payload.deep = selectedModel;
      else payload.fast = selectedModel;
      fetch('/api/switch-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          state.models = { fast: d.fast, deep: d.deep, translate: d.translate };
          renderModeButtons();
        }
      });
      var dd = document.querySelector('.model-dropdown');
      if (dd) dd.remove();
      return;
    }

    // Switch model button — dropdown
    if (t.closest('#btn-switch-model')) {
      showModelDropdown(t.closest('#btn-switch-model'), state.analyzeMode);
      return;
    }
    if (t.closest('#btn-switch-translate-model')) {
      showModelDropdown(t.closest('#btn-switch-translate-model'), 'translate');
      return;
    }

    // Chat model selector
    if (t.closest('#btn-chat-model')) {
      showModelDropdown(t.closest('#btn-chat-model'), 'chat');
      return;
    }

    // Chat attachment button
    if (t.closest('#btn-chat-attach')) {
      showAttachMenu(t.closest('#btn-chat-attach'));
      return;
    }

    // Attachment menu items
    var attachAction = t.closest('[data-attach-action]');
    if (attachAction) {
      var action = attachAction.dataset.attachAction;
      handleAttachAction(action);
      var menu = document.querySelector('.attach-menu');
      if (menu) menu.remove();
      return;
    }

    // Remove chat attachment
    var removeAttach = t.closest('[data-remove-attach]');
    if (removeAttach) {
      var idx = parseInt(removeAttach.dataset.removeAttach);
      state.chatAttachments.splice(idx, 1);
      renderChatAttachments();
      return;
    }

    // Attachment image preview lightbox
    if (t.classList.contains('attach-thumb')) {
      var lb = document.createElement('div');
      lb.className = 'attach-lightbox';
      lb.innerHTML = '<img src="' + t.src + '" />';
      lb.addEventListener('click', function() { lb.remove(); });
      document.body.appendChild(lb);
      return;
    }

    // Close lightbox
    if (t.closest('.attach-lightbox')) {
      t.closest('.attach-lightbox').remove();
      return;
    }

    // Screenshot to chat button
    if (t.closest('#btn-screenshot-chat')) {
      captureSlideToChat();
      return;
    }

    // Settings modal open
    if (t.closest('#btn-settings')) {
      pauseYuketangView();
      els.settingsModal.style.display = 'flex';
      loadCfg();
      return;
    }

    // API key tags -> open settings
    if (t.closest('#api-popover-edit-btn')) {
      var pop = $('#api-popover');
      if (pop) pop.classList.remove('show');
      pauseYuketangView();
      els.settingsModal.style.display = 'flex';
      loadCfg();
      return;
    }

    // API info popover toggle
    if (t.closest('#btn-api-info')) {
      var pop = $('#api-popover');
      if (pop) {
        var isShowing = pop.classList.toggle('show');
        if (isShowing) {
          pauseYuketangView();
          var btnRect = document.getElementById('btn-api-info').getBoundingClientRect();
          pop.style.top = (btnRect.bottom + 6) + 'px';
          pop.style.right = (window.innerWidth - btnRect.right) + 'px';
          state._configCache = null;
          loadApiKeyDisplay();
        } else {
          resumeYuketangView();
        }
      }
      return;
    }

    // Help modal open
    if (t.closest('#btn-help')) {
      pauseYuketangView();
      var helpModal = document.getElementById('help-modal');
      if (helpModal) helpModal.style.display = 'flex';
      return;
    }

    // Close help
    if (t.id === 'btn-close-help') {
      document.getElementById('help-modal').style.display = 'none';
      resumeYuketangView();
      return;
    }

    // Close settings
    if (t.id === 'btn-close-settings') {
      els.settingsModal.style.display = 'none';
      resumeYuketangView();
      return;
    }

    // Close fullscreen modal
    if (t.id === 'btn-close-modal') {
      els.fullscreenModal.style.display = 'none';
      resumeYuketangView();
      return;
    }

    // Click on modal overlay background closes it
    if (t.classList.contains('modal-overlay')) {
      t.style.display = 'none';
      return;
    }

    // Chat context toggle
    if (t.id === 'btn-toggle-ctx' || t.closest('#btn-toggle-ctx')) {
      var area = $('#ctx-area');
      area.style.display = area.style.display === 'none' ? '' : 'none';
      return;
    }

    // Selection mode chip (settings - text selection)
    var selChip = t.closest('.chip[data-selection-mode]');
    if (selChip) {
      selChip.closest('.chip-row').querySelectorAll('.chip').forEach(function(x) { x.classList.remove('active'); });
      selChip.classList.add('active');
      selectionSettings.mode = selChip.dataset.selectionMode;
      saveSelectionSettings();
      $('#btn-translate-toggle').classList.toggle('on', selectionSettings.mode !== 'off');
      return;
    }

    // Chip preset (settings - main API)
    var chip = t.closest('.chip[data-preset]');
    if (chip) {
      chip.closest('.chip-row').querySelectorAll('.chip').forEach(function(x) { x.classList.remove('active'); });
      chip.classList.add('active');
      var p = chip.dataset.preset;
      if (p === 'anthropic') {
        $('#cfg-url').value = 'https://api.anthropic.com/v1';
        $('#cfg-model').value = 'claude-sonnet-4-6';
      } else if (p === 'openai') {
        $('#cfg-url').value = 'https://api.openai.com/v1';
        $('#cfg-model').value = 'gpt-4o';
      } else if (p === 'deepseek') {
        $('#cfg-url').value = 'https://api.deepseek.com/v1';
        $('#cfg-model').value = 'deepseek-chat';
      } else if (p === 'glm') {
        $('#cfg-url').value = 'https://open.bigmodel.cn/api/paas/v4';
        $('#cfg-model').value = 'glm-4-plus';
      } else {
        $('#cfg-url').value = '';
        $('#cfg-model').value = '';
      }
      return;
    }

    // Chip preset (settings - translate API)
    var tChip = t.closest('.chip[data-translate-preset]');
    if (tChip) {
      tChip.closest('.chip-row').querySelectorAll('.chip').forEach(function(x) { x.classList.remove('active'); });
      tChip.classList.add('active');
      var tp = tChip.dataset.translatePreset;
      var tuEl = $('#cfg-translate-url');
      var tmEl = $('#cfg-translate-model');
      if (tp === 'openai') {
        if (tuEl) tuEl.value = 'https://api.openai.com/v1';
        if (tmEl) tmEl.value = 'gpt-4o-mini';
      } else if (tp === 'deepseek') {
        if (tuEl) tuEl.value = 'https://api.deepseek.com/v1';
        if (tmEl) tmEl.value = 'deepseek-chat';
      } else if (tp === 'glm') {
        if (tuEl) tuEl.value = 'https://open.bigmodel.cn/api/paas/v4';
        if (tmEl) tmEl.value = 'glm-4-flash';
      } else {
        if (tuEl) tuEl.value = '';
        if (tmEl) tmEl.value = '';
      }
      return;
    }

    // Test connection
    if (t.id === 'btn-test') {
      var msg = els.testMsg;
      msg.className = 'test-msg';
      msg.style.display = 'block';
      msg.textContent = '测试中...';
      fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: $('#cfg-url').value,
          apiKey: $('#cfg-key').value,
          model: $('#cfg-model').value
        })
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        msg.className = d.ok ? 'test-msg ok' : 'test-msg err';
        msg.textContent = d.ok ? ('连接成功: ' + d.reply) : (d.error);
      })
      .catch(function(err) {
        msg.className = 'test-msg err';
        msg.textContent = err.message;
      });
      return;
    }

    // Save config
    if (t.id === 'btn-save-cfg') {
      var cfgPayload = {
        baseUrl: $('#cfg-url').value,
        apiKey: $('#cfg-key').value,
        apiKeyFast: $('#cfg-key-fast') ? $('#cfg-key-fast').value : '',
        model: $('#cfg-model').value
      };
      var mf = $('#cfg-model-fast');
      var md = $('#cfg-model-deep');
      var tk = $('#cfg-translate-key');
      var tu = $('#cfg-translate-url');
      var tm = $('#cfg-translate-model');
      if (mf) cfgPayload.modelFast = mf.value;
      if (md) cfgPayload.modelDeep = md.value;
      if (tk) cfgPayload.translateApiKey = tk.value;
      if (tu) cfgPayload.translateBaseUrl = tu.value;
      if (tm) cfgPayload.translateModel = tm.value;

      fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfgPayload)
      })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) {
          // Also switch models immediately (not just on restart)
          var switchPayload = {};
          if (cfgPayload.modelFast) switchPayload.fast = cfgPayload.modelFast;
          if (cfgPayload.modelDeep) switchPayload.deep = cfgPayload.modelDeep;
          if (cfgPayload.translateModel) switchPayload.translate = cfgPayload.translateModel;
          if (!cfgPayload.modelFast && cfgPayload.model) switchPayload.fast = cfgPayload.model;
          if (!cfgPayload.modelDeep && cfgPayload.model) switchPayload.deep = cfgPayload.model;
          fetch('/api/switch-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(switchPayload)
          }).then(function(r2) { return r2.json(); }).then(function(d2) {
            if (d2.ok) {
              state.models = { fast: d2.fast, deep: d2.deep, translate: d2.translate };
              renderModeButtons();
            }
          }).catch(function() {});

          showToast('配置已保存并生效');
          els.settingsModal.style.display = 'none';
          resumeYuketangView();
          state._configCache = null;
          loadApiKeyDisplay();
          loadAvailableModels();
        } else {
          showToast('保存失败: ' + d.error);
        }
      })
      .catch(function(err) {
        showToast('保存失败: ' + err.message);
      });
      return;
    }

    // Send chat button
    if (t.closest('#btn-send')) {
      sendChat();
      return;
    }

    // data-do actions
    var doEl = t.closest('[data-do]');
    if (doEl) {
      var doAction = doEl.dataset.do;
      var cid = doEl.dataset.cid || doEl.dataset.id;

      if (doAction === 'import-to-chat') {
        var cap = state.snapshot.captures.find(function(c) { return c.id === cid; });
        if (cap && cap.renderedMarkdown) {
          addContextChip(cap.title || '课件解析', cap.renderedMarkdown.slice(0, 2000));
          var area = $('#ctx-area');
          if (area) area.style.display = '';
          showToast('课件已导入对话背景');
        } else {
          showToast('暂无解析内容可导入');
        }
        return;
      }

      if (doAction === 'reveal') {
        var box = $('[data-ans="' + cid + '"]');
        if (box) {
          var showing = box.style.display === 'none';
          box.style.display = showing ? 'block' : 'none';
          doEl.textContent = showing ? '隐藏答案' : '答案';
        }
        var optList = $('.opt-list[data-cid="' + cid + '"]');
        if (optList) {
          if (box && box.style.display !== 'none') {
            var cap = state.snapshot.captures.find(function(c) { return c.id === cid; });
            if (cap && cap.payload && cap.payload.options) {
              optList.querySelectorAll('.opt').forEach(function(el) {
                var o = cap.payload.options.find(function(x) { return x.key === el.dataset.key; });
                if (o && o.isAnswer) el.classList.add('correct');
              });
            }
          } else {
            optList.querySelectorAll('.opt.correct').forEach(function(el) {
              el.classList.remove('correct');
            });
          }
        }
        return;
      }

      if (doAction === 'submit') {
        var type = doEl.dataset.type;
        var answers = [];

        if (type === 'choice') {
          answers = Array.from($$('.opt-list[data-cid="' + cid + '"] .opt.selected')).map(function(x) { return x.dataset.key; });
          if (!answers.length) { showToast('请先选择选项'); return; }
        } else if (type === 'fill') {
          answers = Array.from($$('[data-blanks="' + cid + '"] .blank-input')).map(function(x) { return x.value.trim(); });
        } else if (type === 'subjective') {
          var ta = $('[data-subj="' + cid + '"]');
          answers = [ta ? ta.value.trim() : ''];
        }

        doEl.disabled = true;
        doEl.textContent = '提交中...';
        fetch('/api/submit-answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captureId: cid, answerType: type, answers: answers })
        })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          doEl.textContent = d.ok ? '已提交' : '失败';
          setTimeout(function() { doEl.textContent = '提交'; doEl.disabled = false; }, 2000);
        })
        .catch(function() {
          doEl.textContent = '失败';
          setTimeout(function() { doEl.textContent = '提交'; doEl.disabled = false; }, 2000);
        });
        return;
      }

      if (doAction === 'retry') {
        fetch('/api/analyze-capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captureId: cid, mode: state.analyzeMode })
        });
        return;
      }

      if (doAction === 'deep-think') {
        doEl.classList.add('loading');
        doEl.textContent = '思考中...';
        fetch('/api/deep-think', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ captureId: cid })
        });
        return;
      }

      if (doAction === 'fullscreen') {
        var capFs = state.snapshot.captures.find(function(c) { return c.id === cid; });
        if (!capFs) return;
        els.modalTitle.textContent = capFs.title || '解析详情';
        var content = '<div class="prose">' + parseMd(capFs.renderedMarkdown || '') + '</div>';
        if (capFs.deepThinkMarkdown) {
          content += '<hr style="margin:20px 0;border-color:var(--border)"/><div class="prose">' + parseMd(capFs.deepThinkMarkdown) + '</div>';
        }
        els.modalBody.innerHTML = content;
        pauseYuketangView();
        els.fullscreenModal.style.display = 'flex';
        return;
      }
    }
  });

  // ── Attachment menu ──
  function showAttachMenu(anchorEl) {
    var existing = document.querySelector('.attach-menu');
    if (existing) { existing.remove(); return; }

    var rect = anchorEl.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.className = 'attach-menu';
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';

    var items = [
      { action: 'file', icon: '📎', label: '上传文件' },
      { action: 'clipboard', icon: '📋', label: '粘贴剪贴板图片' },
      { action: 'screenshot', icon: '📷', label: '当前课件截图' }
    ];

    menu.innerHTML = items.map(function(item) {
      return '<button class="attach-menu-item" data-attach-action="' + item.action + '">' +
        '<span>' + item.icon + '</span><span>' + item.label + '</span></button>';
    }).join('');

    document.body.appendChild(menu);
    setTimeout(function() {
      document.addEventListener('click', function closeMenu(ev) {
        if (!menu.contains(ev.target) && !anchorEl.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 10);
  }

  function handleAttachAction(action) {
    if (action === 'file') {
      if (isElectron) {
        window.electronAPI.selectFile().then(function(filePath) {
          if (!filePath) return;
          window.electronAPI.readFile(filePath).then(function(data) {
            var dataUrl = 'data:' + data.mime + ';base64,' + data.buffer;
            addChatAttachment(data.name, dataUrl, data.mime);
          });
        });
      } else {
        var fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = '.pdf,.png,.jpg,.jpeg,.webp,.gif';
        fi.onchange = function() {
          if (!fi.files[0]) return;
          var reader = new FileReader();
          reader.onload = function(ev) {
            addChatAttachment(fi.files[0].name, ev.target.result, fi.files[0].type);
          };
          reader.readAsDataURL(fi.files[0]);
        };
        fi.click();
      }
    } else if (action === 'clipboard') {
      if (isElectron) {
        window.electronAPI.getClipboardImage().then(function(dataUrl) {
          if (dataUrl) addChatAttachment('剪贴板图片', dataUrl, 'image/png');
          else showToast('剪贴板中没有图片');
        });
      } else {
        navigator.clipboard.read().then(function(items) {
          for (var i = 0; i < items.length; i++) {
            var types = items[i].types;
            for (var j = 0; j < types.length; j++) {
              if (types[j].startsWith('image/')) {
                items[i].getType(types[j]).then(function(blob) {
                  var reader = new FileReader();
                  reader.onload = function(ev) {
                    addChatAttachment('剪贴板图片', ev.target.result, blob.type);
                  };
                  reader.readAsDataURL(blob);
                });
                return;
              }
            }
          }
          showToast('剪贴板中没有图片');
        }).catch(function() { showToast('无法访问剪贴板'); });
      }
    } else if (action === 'screenshot') {
      captureSlideToChat();
    }
  }

  // ── File input change handler (offline upload zone) ──
  document.addEventListener('change', function(e) {
    if (e.target.id === 'file-upload-input') {
      if (e.target.files[0]) handleFileUpload(e.target.files[0]);
    }
    // Selection toolbar item checkboxes
    if (e.target.id === 'sel-item-translate') { selectionSettings.items.translate = e.target.checked; saveSelectionSettings(); }
    if (e.target.id === 'sel-item-explain') { selectionSettings.items.explain = e.target.checked; saveSelectionSettings(); }
    if (e.target.id === 'sel-item-ask') { selectionSettings.items.ask = e.target.checked; saveSelectionSettings(); }
    if (e.target.id === 'sel-item-copy') { selectionSettings.items.copy = e.target.checked; saveSelectionSettings(); }
  });

  // ── Ctrl+/- zoom for PDF ──
  document.addEventListener('keydown', function(e) {
    if (!state.pdfDoc) return;
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      pdfSetZoom(state.pdfZoom + 0.15);
    } else if (e.key === '-') {
      e.preventDefault();
      pdfSetZoom(state.pdfZoom - 0.15);
    } else if (e.key === '0') {
      e.preventDefault();
      pdfSetZoom(1.0);
    }
  });

  // ── Chat keyboard ──
  els.chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  // ── Ctrl+V paste image into chat ──
  els.chatInput.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        var blob = items[i].getAsFile();
        var reader = new FileReader();
        reader.onload = function(ev) {
          addChatAttachment('粘贴图片', ev.target.result, blob.type);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });

  // ── Text Selection Toolbar (划词翻译) ──
  var translatePopup = null;
  var selectionSettings = {
    mode: 'toolbar', // 'toolbar', 'direct', 'off'
    items: { translate: true, explain: true, ask: true, copy: false }
  };

  // Load from localStorage
  try {
    var saved = JSON.parse(localStorage.getItem('selectionSettings'));
    if (saved) {
      if (saved.mode) selectionSettings.mode = saved.mode;
      if (saved.items) Object.assign(selectionSettings.items, saved.items);
    }
  } catch(e) {}

  function saveSelectionSettings() {
    localStorage.setItem('selectionSettings', JSON.stringify(selectionSettings));
  }

  function initTextSelection() {
    document.addEventListener('mouseup', function(e) {
      if (selectionSettings.mode === 'off') return;
      if (e.target.closest('.translate-popup, .translate-result, .translate-drag-bar, .topbar, .chat-composer, .welcome-screen, .modal-overlay, .online-bar')) return;

      var sel = window.getSelection();
      var text = sel ? sel.toString().trim() : '';

      if (translatePopup) { translatePopup.remove(); translatePopup = null; }
      if (!text || text.length < 2 || text.length > 3000) return;

      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();

      if (selectionSettings.mode === 'direct') {
        doTranslate(text, rect);
        return;
      }

      // Toolbar below selection
      translatePopup = document.createElement('div');
      translatePopup.className = 'translate-popup';
      var popTop = rect.bottom + 6;
      if (popTop + 40 > window.innerHeight) popTop = Math.max(4, rect.top - 40);
      translatePopup.style.top = popTop + 'px';
      translatePopup.style.left = (rect.left + rect.width / 2) + 'px';

      var buttons = '';
      if (selectionSettings.items.translate) buttons += '<button class="translate-popup-btn" data-translate-text>翻译</button>';
      if (selectionSettings.items.explain) buttons += '<button class="translate-popup-btn" data-explain-text>解释</button>';
      if (selectionSettings.items.ask) buttons += '<button class="translate-popup-btn" data-ask-text>提问</button>';
      if (selectionSettings.items.copy) buttons += '<button class="translate-popup-btn" data-copy-text>复制</button>';

      if (!buttons) return;
      translatePopup.innerHTML = buttons;
      document.body.appendChild(translatePopup);

      var selectedText = text;
      var tBtn = translatePopup.querySelector('[data-translate-text]');
      var eBtn = translatePopup.querySelector('[data-explain-text]');
      var aBtn = translatePopup.querySelector('[data-ask-text]');
      var cBtn = translatePopup.querySelector('[data-copy-text]');

      if (tBtn) tBtn.addEventListener('click', function() { doTranslate(selectedText, rect); });
      if (eBtn) eBtn.addEventListener('click', function() { doExplain(selectedText, rect); });
      if (aBtn) aBtn.addEventListener('click', function() {
        els.chatInput.value = '请解释：' + selectedText;
        autoGrowTextarea(els.chatInput);
        els.chatInput.focus();
        translatePopup.remove();
        translatePopup = null;
      });
      if (cBtn) cBtn.addEventListener('click', function() {
        navigator.clipboard.writeText(selectedText).then(function() { showToast('已复制'); });
        translatePopup.remove();
        translatePopup = null;
      });
    });

    document.addEventListener('mousedown', function(e) {
      if (translatePopup && !translatePopup.contains(e.target)) {
        translatePopup.remove();
        translatePopup = null;
      }
      // Only remove unpinned results
      document.querySelectorAll('.translate-result:not(.pinned)').forEach(function(el) {
        if (!el.contains(e.target)) el.remove();
      });
    });
  }

  function renderTranslateResult(data) {
    try {
      var parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsed.type === 'word') {
        var html = '<div class="dict-card">';
        html += '<div class="dict-header">';
        html += '<span class="dict-word">' + esc(parsed.original) + '</span>';
        if (parsed.phonetic) html += '<span class="dict-phonetic">' + esc(parsed.phonetic) + '</span>';
        if (parsed.wordType) html += '<span class="dict-pos">' + esc(parsed.wordType) + '</span>';
        html += '</div>';
        if (parsed.translation) html += '<div class="dict-main-translation">' + esc(parsed.translation) + '</div>';
        if (parsed.meanings && parsed.meanings.length) {
          html += '<ol class="dict-meanings">';
          for (var i = 0; i < parsed.meanings.length; i++) {
            var m = parsed.meanings[i];
            html += '<li><span class="dict-def">' + esc(m.def) + '</span>';
            if (m.example) html += '<span class="dict-example">' + esc(m.example) + '</span>';
            html += '</li>';
          }
          html += '</ol>';
        }
        html += '</div>';
        return html;
      }
      if (parsed.type === 'sentence') {
        var html = '<div class="dict-sentence">';
        html += '<div class="dict-translation">' + esc(parsed.translation) + '</div>';
        if (parsed.vocabulary && parsed.vocabulary.length) {
          html += '<div class="dict-vocab">';
          for (var i = 0; i < parsed.vocabulary.length; i++) {
            var v = parsed.vocabulary[i];
            html += '<span class="dict-vocab-item"><b>' + esc(v.word) + '</b> ' + esc(v.meaning) + '</span>';
          }
          html += '</div>';
        }
        html += '</div>';
        return html;
      }
      return '<div class="translate-content">' + esc(parsed.translation || data) + '</div>';
    } catch (e) {
      return '<div class="translate-content">' + esc(data) + '</div>';
    }
  }

  function createResultPopup(rect, loadingText) {
    if (translatePopup) { translatePopup.remove(); translatePopup = null; }

    // If there's a pinned popup, reuse it
    var pinned = document.querySelector('.translate-result.pinned');
    if (pinned) {
      var body = pinned.querySelector('.translate-body');
      if (body) body.innerHTML = '<div class="translate-loading">' + esc(loadingText) + '</div>';
      return pinned;
    }

    // Remove any unpinned result popups
    document.querySelectorAll('.translate-result').forEach(function(el) { el.remove(); });

    var popup = document.createElement('div');
    popup.className = 'translate-result';

    var top = rect.bottom + 8;
    var left = Math.max(10, Math.min(rect.left, window.innerWidth - 430));
    if (top + 320 > window.innerHeight) top = Math.max(10, rect.top - 330);
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';

    popup.innerHTML =
      '<div class="translate-drag-bar">' +
        '<span class="drag-hint">⋮⋮</span>' +
        '<div class="translate-bar-actions">' +
          '<button class="pin-btn" title="固定窗口（固定后新翻译更新此窗口）">📌</button>' +
          '<button class="close-btn" title="关闭">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div class="translate-body">' +
        '<div class="translate-loading">' + esc(loadingText) + '</div>' +
      '</div>';

    document.body.appendChild(popup);

    popup.querySelector('.close-btn').addEventListener('click', function() { popup.remove(); });

    var pinBtn = popup.querySelector('.pin-btn');
    pinBtn.addEventListener('click', function() {
      popup.classList.toggle('pinned');
      pinBtn.classList.toggle('pin-active');
    });

    // Drag
    var dragBar = popup.querySelector('.translate-drag-bar');
    var dragging = false, dragOffX = 0, dragOffY = 0;
    dragBar.addEventListener('mousedown', function(e) {
      if (e.target.closest('button')) return;
      dragging = true;
      dragOffX = e.clientX - popup.offsetLeft;
      dragOffY = e.clientY - popup.offsetTop;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      popup.style.left = (e.clientX - dragOffX) + 'px';
      popup.style.top = (e.clientY - dragOffY) + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (dragging) { dragging = false; document.body.style.userSelect = ''; }
    });

    return popup;
  }

  function doTranslate(text, rect) {
    var popup = createResultPopup(rect, '翻译中...');
    var body = popup.querySelector('.translate-body');
    if (!body) return;

    var accumulated = '';
    fetchStream('/api/translate-stream', { text: text, targetLang: '中文' }, function(chunk) {
      accumulated += chunk;
      // JSON is building up — show spinner with character count
      body.innerHTML = '<div class="translate-loading">翻译中... (' + accumulated.length + ' 字)</div>';
    }, function() {
      body.innerHTML = renderTranslateResult(accumulated);
    }, function(err) {
      body.innerHTML = '<div class="translate-error">翻译失败: ' + esc(err) + '</div>';
    });
  }

  function doExplain(text, rect) {
    var popup = createResultPopup(rect, '解释中...');
    var body = popup.querySelector('.translate-body');
    if (!body) return;

    var accumulated = '';
    fetchStream('/api/chat-stream', {
      messages: [{ role: 'user', content: '简短解释以下内容（2-3句话）：\n\n' + text }]
    }, function(chunk) {
      accumulated += chunk;
      body.innerHTML = '<div class="translate-content prose">' + parseMd(accumulated) + '</div>';
    }, function() {
      body.innerHTML = '<div class="translate-content prose">' + parseMd(accumulated) + '</div>';
    }, function(err) {
      body.innerHTML = '<div class="translate-error">解释失败: ' + esc(err) + '</div>';
    });
  }

  function fetchStream(url, payload, onChunk, onDone, onError) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function read() {
        reader.read().then(function(result) {
          if (result.done) { onDone(); return; }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line.startsWith('data: ')) continue;
            var data = line.slice(6);
            if (data === '[DONE]') { onDone(); return; }
            try {
              var parsed = JSON.parse(data);
              if (parsed.error) { onError(parsed.error); return; }
              if (parsed.t) onChunk(parsed.t);
            } catch(e) {}
          }
          read();
        }).catch(function(e) { onError(e.message); });
      }
      read();
    }).catch(function(e) { onError(e.message); });
  }

  // ── SSE + Boot ──
  function boot() {
    // Show welcome screen, wait for mode selection
    var welcomeScreen = document.getElementById('welcome-screen');
    if (welcomeScreen) {
      welcomeScreen.querySelectorAll('[data-start-mode]').forEach(function(card) {
        card.addEventListener('click', function() {
          var mode = card.dataset.startMode;
          welcomeScreen.style.display = 'none';
          startApp(mode);
        });
      });
    }
  }

  function startApp(mode) {
    state.appMode = mode;

    if (mode === 'offline') {
      state.autoAnalyze = false;
      state.followLatest = false;
      $('#btn-auto-analyze').classList.remove('on');
      $('#btn-follow-latest').style.display = 'none';
    } else {
      state.autoAnalyze = true;
      $('#btn-auto-analyze').classList.add('on');
    }

    // Chat textarea auto-grow
    var chatInput = $('#chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', function() { autoGrowTextarea(this); });
    }
    var chatBg = $('#chat-background');
    if (chatBg) {
      chatBg.addEventListener('input', function() { autoGrowTextarea(this, 200); });
      chatBg.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          var val = this.value.trim();
          if (val) {
            addContextChip('自定义', val);
            this.value = '';
            this.style.height = 'auto';
          }
        }
      });
    }

    // Click thumbnail to select and show its analysis
    els.slideNav.addEventListener('click', function(e) {
      var thumb = e.target.closest('.thumb');
      if (!thumb) return;
      var id = thumb.dataset.id;
      if (id && id !== state.focusedId) {
        state.focusedId = id;
        state.followLatest = false;
        if (state.snapshot) render(state.snapshot);
      }
    });

    // Double-click thumbnail to fullscreen image
    els.slideNav.addEventListener('dblclick', function(e) {
      var thumb = e.target.closest('.thumb');
      if (!thumb) return;
      var cap = state.snapshot.captures.find(function(c) { return c.id === thumb.dataset.id; });
      if (!cap) return;
      els.modalTitle.textContent = cap.title || cap.fileName || '课件图片';
      els.modalBody.innerHTML = '<img src="' + cap.webPath + '" style="max-width:100%;max-height:80vh;border-radius:8px" />';
      els.fullscreenModal.style.display = 'flex';
    });

    // Right-click thumbnail for context menu (fullscreen / delete)
    els.slideNav.addEventListener('contextmenu', function(e) {
      var thumb = e.target.closest('.thumb');
      if (!thumb) return;
      e.preventDefault();
      var capId = thumb.dataset.id;
      var cap = state.snapshot.captures.find(function(c) { return c.id === capId; });
      if (!cap) return;

      var existing = document.querySelector('.thumb-ctx-menu');
      if (existing) existing.remove();

      var menu = document.createElement('div');
      menu.className = 'thumb-ctx-menu';
      menu.innerHTML =
        '<button data-ctx-action="fullscreen">全屏查看</button>' +
        '<button data-ctx-action="delete" class="danger">删除</button>';
      menu.style.left = Math.min(e.clientX, window.innerWidth - 120) + 'px';
      menu.style.top = '-9999px';
      document.body.appendChild(menu);
      var menuH = menu.offsetHeight || 60;
      var topPos = e.clientY - menuH - 4;
      if (topPos < 4) topPos = e.clientY + 4;
      menu.style.top = topPos + 'px';

      menu.addEventListener('click', function(ev) {
        var action = ev.target.dataset.ctxAction;
        if (action === 'fullscreen') {
          els.modalTitle.textContent = cap.title || cap.fileName || '课件图片';
          els.modalBody.innerHTML = '<img src="' + cap.webPath + '" style="max-width:100%;max-height:80vh;border-radius:8px" />';
          els.fullscreenModal.style.display = 'flex';
        } else if (action === 'delete') {
          if (state.focusedId === capId) state.focusedId = null;
          fetch('/api/delete-capture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ captureId: capId })
          }).then(function() {
            return fetch('/api/state');
          }).then(function(r) { return r.json(); }).then(function(snap) {
            render(snap);
          }).catch(function() {});
        }
        menu.remove();
      });

      document.addEventListener('click', function closeCtx() {
        menu.remove();
        document.removeEventListener('click', closeCtx);
      }, { once: true });
    });

    fetch('/api/state')
      .then(function(r) { return r.json(); })
      .then(function(data) { render(data); })
      .catch(function() {});

    var src = new EventSource('/api/events');
    src.onmessage = function(e) {
      render(JSON.parse(e.data));
    };

    loadCurrentModels();
    loadAvailableModels();
    initPanelResize();
    initWorkspaceResize();
    initWheelNavigation();
    initDragDrop();
    initTextSelection();

    if (mode === 'online') {
      var onlineBar = $('#online-bar');
      if (onlineBar) onlineBar.classList.add('visible');
      initOnlineControls();

      var customUrl = ($('#online-url') || {}).value || '';
      showToast('正在启动雨课堂...');
      els.statusText.textContent = '启动中';

      if (isElectron) {
        state._ykViewVisible = true;
        window.electronAPI.startYuketang(customUrl).then(function(r) {
          if (!r.ok) { showToast('启动失败: ' + (r.error || '')); return; }
          syncViewBounds();
        });
        initYuketangToolbar();
      } else {
        fetch('/api/start-monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: customUrl })
        })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (!d.ok) showToast('监听启动失败: ' + (d.error || ''));
          })
          .catch(function() {});
      }
    }
  }

  // ── Sync BrowserView bounds to slide-stage ──
  function syncViewBounds() {
    if (!isElectron || !state._ykViewVisible) return;
    var stage = document.querySelector('.slide-stage');
    if (!stage) return;
    var rect = stage.getBoundingClientRect();
    window.electronAPI.setViewBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }

  function pauseYuketangView() {
    if (!isElectron || !state._ykViewVisible) return;
    window.electronAPI.hideYuketangView();
  }

  function resumeYuketangView() {
    if (!isElectron || !state._ykViewVisible) return;
    window.electronAPI.showYuketangView();
    syncViewBounds();
  }

  // ── Yuketang toolbar (buttons now live in .online-bar, not a floating overlay) ──
  function initYuketangToolbar() {
    var liveBtn = $('#yk-btn-live');
    var slidesBtn = $('#yk-btn-slides');
    var newtabBtn = $('#yk-btn-newtab');
    var closeBtn = $('#yk-btn-close');

    if (liveBtn && !liveBtn._bound) {
      liveBtn._bound = true;
      liveBtn.addEventListener('click', function() {
        state._ykViewVisible = true;
        liveBtn.classList.add('active');
        if (slidesBtn) slidesBtn.classList.remove('active');
        window.electronAPI.startYuketang('').then(function() {
          syncViewBounds();
        });
      });
    }

    if (slidesBtn && !slidesBtn._bound) {
      slidesBtn._bound = true;
      slidesBtn.addEventListener('click', function() {
        state._ykViewVisible = false;
        slidesBtn.classList.add('active');
        liveBtn.classList.remove('active');
        window.electronAPI.hideYuketangView();
      });
    }

    if (newtabBtn && !newtabBtn._bound) {
      newtabBtn._bound = true;
      newtabBtn.addEventListener('click', function() {
        window.electronAPI.getYuketangUrl().then(function(url) {
          var openUrl = url || 'https://www.yuketang.cn/web/?index';
          window.electronAPI.openYuketangWindow(openUrl);
          // 关闭内嵌视图，切换回课件
          state._ykViewVisible = false;
          window.electronAPI.stopYuketang();
          if (slidesBtn) { slidesBtn.classList.add('active'); }
          if (liveBtn) { liveBtn.classList.remove('active'); }
          showToast('雨课堂已在独立窗口打开');
        });
      });
    }

    if (closeBtn && !closeBtn._bound) {
      closeBtn._bound = true;
      closeBtn.addEventListener('click', function() {
        state._ykViewVisible = false;
        if (slidesBtn) slidesBtn.classList.add('active');
        if (liveBtn) liveBtn.classList.remove('active');
        window.electronAPI.stopYuketang();
        showToast('已关闭雨课堂视图');
      });
    }

    window.addEventListener('resize', function() { syncViewBounds(); });
  }

  function initOnlineControls() {
    var goBtn = $('#btn-online-go');
    var reloginBtn = $('#btn-online-relogin');
    var stopBtn = $('#btn-online-stop');
    var urlInput = $('#online-url');

    if (goBtn && !goBtn._bound) {
      goBtn._bound = true;
      goBtn.addEventListener('click', function() {
        var url = (urlInput.value || '').trim();
        if (!url) { showToast('请输入课堂链接'); return; }
        showToast('正在跳转...');
        if (isElectron) {
          window.electronAPI.navigateYuketang(url).then(function(r) {
            if (r.ok) showToast('已跳转');
            else showToast('跳转失败: ' + (r.error || ''));
          });
        } else {
          fetch('/api/navigate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: url })
          })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) showToast('已跳转');
              else showToast('跳转失败: ' + (d.error || ''));
            })
            .catch(function() { showToast('请求失败'); });
        }
      });

      urlInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') goBtn.click();
      });
    }

    if (reloginBtn && !reloginBtn._bound) {
      reloginBtn._bound = true;
      reloginBtn.addEventListener('click', function() {
        showToast('正在重新登录...');
        if (isElectron) {
          state._ykViewVisible = true;
          window.electronAPI.reloginYuketang().then(function(r) {
            if (r.ok) {
              showToast('已清除登录，请在左侧重新登录雨课堂');
              var liveBtn = $('#yk-btn-live');
              var slidesBtn = $('#yk-btn-slides');
              if (liveBtn) liveBtn.classList.add('active');
              if (slidesBtn) slidesBtn.classList.remove('active');
              setTimeout(function() { syncViewBounds(); }, 300);
            } else {
              showToast('重新登录失败: ' + (r.error || ''));
            }
          });
        } else {
          fetch('/api/relogin', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) showToast('已清除登录，请在浏览器窗口中重新登录');
              else showToast('重新登录失败: ' + (d.error || ''));
            })
            .catch(function() { showToast('请求失败'); });
        }
      });
    }

    if (stopBtn && !stopBtn._bound) {
      stopBtn._bound = true;
      stopBtn.addEventListener('click', function() {
        if (isElectron) {
          state._ykViewVisible = false;
          window.electronAPI.stopYuketang().then(function() {
            showToast('已停止监听');
          });
        } else {
          fetch('/api/stop-monitor', { method: 'POST' })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) showToast('已停止监听');
            })
            .catch(function() {});
        }
      });
    }
  }

  boot();
})();
