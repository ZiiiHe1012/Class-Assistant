const STORAGE_KEY = 'rc_ai_assistant_settings';
const DEFAULT_SETTINGS = {
   apiBaseUrl: 'https://pucoding.com/v1',
  apiKey: 'sk-ef534088f2401b7e55accfbfa3163b1f6ca529bde5d252e39fd954c34aa4a5d5',
  model: 'gpt-5.4-mini'
};

let state = {
  panel: null,
  body: null,
  status: null,
  resultList: null,
  fields: null,
  dragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0,
  collapsed: false,
  running: false,
  listening: false,
  processingQueue: false,
  queue: [],
  seenImages: new Set(),
  cards: new Map(),
  observer: null,
  pollTimer: null
};

init();

function init() {
  createPanelIfNeeded();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'START_ANALYSIS') {
      void startAnalysis();
    }
  });
}

async function startAnalysis() {
  createPanelIfNeeded();
  showPanel();

  if (!state.listening) {
    startWatchingImages();
  }

  if (state.running) {
    setStatus('正在处理，请稍候...', 'info');
    return;
  }

  state.running = true;
  setStatus('准备读取配置...', 'info');
  clearResults();

  try {
    const settings = await getSettings();
    fillSettingsForm(settings);

    if (!settings.apiKey) {
      setStatus('请先填写 API Key 并保存，再点击插件按钮。', 'error');
      state.running = false;
      return;
    }

    setStatus('正在采集页面图片，并开启持续监听...', 'info');
    const candidates = await collectCandidateImages();
    if (candidates.length === 0) {
      setStatus('已开启监听，但当前未找到可分析图片。等待页面后续出现图片...', 'info');
    } else {
      enqueueImages(candidates);
      setStatus(`已捕获 ${candidates.length} 张候选图，正在分析...`, 'info');
      await processQueue();
    }

    setStatus('监听已开启：后续新增图片会自动进入分析队列。', 'success');
  } catch (error) {
    setStatus(`执行失败：${error?.message || '未知错误'}`, 'error');
  }

  state.running = false;
}

function createPanelIfNeeded() {
  if (state.panel && document.body.contains(state.panel)) return;

  const panel = document.createElement('section');
  panel.id = 'rc-ai-panel';
  panel.innerHTML = `
    <header class="rc-ai-header" id="rc-ai-drag-handle">
      <div class="rc-ai-title">RainClassroom AI Assistant</div>
      <div class="rc-ai-header-actions">
        <button id="rc-ai-toggle" type="button" title="折叠">−</button>
      </div>
    </header>
    <div class="rc-ai-body" id="rc-ai-body">
      <div class="rc-ai-status" id="rc-ai-status"></div>
      <div class="rc-ai-settings">
        <label>API Base URL <input id="rc-ai-base" type="text" placeholder="https://api.openai.com/v1" /></label>
        <label>Model <input id="rc-ai-model" type="text" placeholder="gpt-4o-mini" /></label>
        <label>API Key <input id="rc-ai-key" type="password" placeholder="sk-..." /></label>
        <div class="rc-ai-setting-actions">
          <button id="rc-ai-save" type="button">保存配置</button>
          <button id="rc-ai-run" type="button">立即分析</button>
        </div>
      </div>
      <div class="rc-ai-results" id="rc-ai-results"></div>
    </div>
  `;

  document.body.appendChild(panel);

  state.panel = panel;
  state.body = panel.querySelector('#rc-ai-body');
  state.status = panel.querySelector('#rc-ai-status');
  state.resultList = panel.querySelector('#rc-ai-results');
  state.fields = {
    apiBaseUrl: panel.querySelector('#rc-ai-base'),
    model: panel.querySelector('#rc-ai-model'),
    apiKey: panel.querySelector('#rc-ai-key')
  };

  bindPanelEvents(panel);
  void getSettings().then(fillSettingsForm);
}

function bindPanelEvents(panel) {
  const dragHandle = panel.querySelector('#rc-ai-drag-handle');
  const toggleBtn = panel.querySelector('#rc-ai-toggle');
  const saveBtn = panel.querySelector('#rc-ai-save');
  const runBtn = panel.querySelector('#rc-ai-run');

  dragHandle.addEventListener('pointerdown', (event) => {
    state.dragging = true;
    const rect = panel.getBoundingClientRect();
    state.dragOffsetX = event.clientX - rect.left;
    state.dragOffsetY = event.clientY - rect.top;
    dragHandle.setPointerCapture(event.pointerId);
  });

  dragHandle.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    const left = clamp(event.clientX - state.dragOffsetX, 8, window.innerWidth - panel.offsetWidth - 8);
    const top = clamp(event.clientY - state.dragOffsetY, 8, window.innerHeight - 48);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  });

  dragHandle.addEventListener('pointerup', (event) => {
    state.dragging = false;
    dragHandle.releasePointerCapture(event.pointerId);
  });

  toggleBtn.addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    state.body.style.display = state.collapsed ? 'none' : 'block';
    toggleBtn.textContent = state.collapsed ? '+' : '−';
  });

  saveBtn.addEventListener('click', async () => {
    const settings = readSettingsFromForm();
    await saveSettings(settings);
    setStatus('配置已保存。', 'success');
  });

  runBtn.addEventListener('click', () => {
    void startAnalysis();
  });
}

function showPanel() {
  state.panel.style.display = 'block';
  if (state.collapsed) {
    state.collapsed = false;
    state.body.style.display = 'block';
    const toggleBtn = state.panel.querySelector('#rc-ai-toggle');
    if (toggleBtn) toggleBtn.textContent = '−';
  }
}

function clearResults() {
  state.resultList.innerHTML = '';
  state.cards.clear();
}

function startWatchingImages() {
  if (state.listening) return;
  state.listening = true;

  const scanAndEnqueue = () => {
    const candidates = collectCandidateImagesSync();
    enqueueImages(candidates);
    void processQueue();
  };

  state.observer = new MutationObserver(() => {
    scanAndEnqueue();
  });

  state.observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class']
  });

  window.addEventListener('load', scanAndEnqueue, { once: true });
  state.pollTimer = window.setInterval(scanAndEnqueue, 3000);
  scanAndEnqueue();
}

function enqueueImages(images) {
  for (const image of images) {
    if (!image) continue;
    const key = normalizeImageKey(image);
    if (state.seenImages.has(key) || state.queue.includes(image)) continue;
    state.queue.push(image);
  }
}

async function processQueue() {
  if (state.processingQueue) return;
  state.processingQueue = true;

  try {
    const settings = await getSettings();
    if (!settings.apiKey) {
      setStatus('监听中：请先填写并保存 API Key，队列将等待后续自动处理。', 'info');
      return;
    }

    const contextText = collectContextText();

    while (state.queue.length > 0) {
      const imageUrl = state.queue.shift();
      const key = normalizeImageKey(imageUrl);
      if (state.seenImages.has(key)) continue;
      state.seenImages.add(key);

      const card = createResultCard(imageUrl);
      state.cards.set(key, card);

      setStatus(`分析中：${shortenText(imageUrl, 60)}`, 'info');
      const imageData = await tryImageToDataUrl(imageUrl);
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_IMAGE',
        payload: {
          image: imageData || imageUrl,
          settings,
          contextText
        }
      });

      if (!response?.ok) {
        updateResultCardWithError(card, imageUrl, response?.error || '未知错误');
        continue;
      }

      updateResultCardWithResult(card, imageUrl, response.result);
    }

    setStatus('监听中：等待后续新图片...', 'success');
  } catch (error) {
    setStatus(`队列处理失败：${error?.message || '未知错误'}`, 'error');
  } finally {
    state.processingQueue = false;
  }
}

function createResultCard(imageUrl) {
  const card = document.createElement('article');
  card.className = 'rc-ai-result-card pending';
  card.innerHTML = `
    <div class="rc-ai-result-card-media">
      <img class="rc-ai-preview-image" src="${escapeHtml(imageUrl)}" alt="图片预览" loading="lazy" />
    </div>
    <div class="rc-ai-result-card-content">
      <div class="rc-ai-result-head">
        <span class="rc-ai-badge pending">等待分析</span>
        <span class="rc-ai-confidence">识别中...</span>
      </div>
      <div class="rc-ai-rendered markdown-body rc-ai-empty">正在调用 AI 分析这张图片…</div>
    </div>
  `;
  state.resultList.appendChild(card);
  return card;
}

function updateResultCardWithResult(card, imageUrl, result) {
  const type = result?.type === 'question' ? '题目' : 'PPT讲解';
  const title = escapeHtml(result?.title || '(无标题)');
  const confidence = Number(result?.confidence || 0);
  const markdown = buildResultMarkdown(result);

  card.classList.remove('pending', 'error');
  card.classList.add(result?.type === 'question' ? 'question' : 'ppt');
  card.innerHTML = `
    <div class="rc-ai-result-card-media">
      <img class="rc-ai-preview-image" src="${escapeHtml(imageUrl)}" alt="图片预览" loading="lazy" />
    </div>
    <div class="rc-ai-result-card-content">
      <div class="rc-ai-result-head">
        <span class="rc-ai-badge ${result?.type === 'question' ? 'question' : 'ppt'}">${type}</span>
        <span class="rc-ai-confidence">置信度 ${(confidence * 100).toFixed(0)}%</span>
      </div>
      <h4>${title}</h4>
      <div class="rc-ai-rendered markdown-body">${renderMarkdown(markdown)}</div>
      <details>
        <summary>图片来源</summary>
        <div class="rc-ai-source">${escapeHtml(imageUrl)}</div>
      </details>
    </div>
  `;
}

function updateResultCardWithError(card, imageUrl, errorText) {
  card.classList.remove('pending', 'question', 'ppt');
  card.classList.add('error');
  card.innerHTML = `
    <div class="rc-ai-result-card-media">
      <img class="rc-ai-preview-image" src="${escapeHtml(imageUrl)}" alt="图片预览" loading="lazy" />
    </div>
    <div class="rc-ai-result-card-content">
      <div class="rc-ai-result-head"><span class="rc-ai-badge error">失败</span></div>
      <div class="rc-ai-rendered markdown-body">${renderMarkdown(errorText)}</div>
      <details>
        <summary>图片来源</summary>
        <div class="rc-ai-source">${escapeHtml(imageUrl)}</div>
      </details>
    </div>
  `;
}

function buildResultMarkdown(result) {
  const title = String(result?.title || '').trim();
  const answer = String(result?.answer || '').trim();
  const explanation = String(result?.explanation || '').trim();

  if (result?.type === 'question') {
    return [
      title ? `### ${title}` : '',
      answer ? `## 答案\n${answer}` : '## 答案\n（未返回）',
      explanation ? `## 解析\n${explanation}` : '## 解析\n（未返回）'
    ].filter(Boolean).join('\n\n');
  }

  return [
    title ? `### ${title}` : '',
    explanation ? `## 详细讲解\n${explanation}` : '## 详细讲解\n（未返回）'
  ].filter(Boolean).join('\n\n');
}

function setStatus(text, type) {
  state.status.textContent = text;
  state.status.dataset.type = type;
}

function renderMarkdown(markdownText) {
  const source = String(markdownText || '').replace(/\r\n/g, '\n');
  if (!source.trim()) return '<p>（无内容）</p>';

  const placeholderMap = [];
  let html = escapeHtml(source);

  html = html.replace(/```([\s\S]*?)```/g, (_, code) => {
    const token = `__CODE_BLOCK_${placeholderMap.length}__`;
    placeholderMap.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return token;
  });

  html = html
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>')
    .replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  html = html.replace(/^\-\s+(.+)$/gm, '<li>$1</li>');
  html = html.replace(/(?:<li>.*?<\/li>\n?)+/gs, (match) => `<ul>${match}</ul>`);

  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  html = html.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />');
  html = `<p>${html}</p>`;

  placeholderMap.forEach((item, index) => {
    html = html.replace(`__CODE_BLOCK_${index}__`, item);
  });

  html = html
    .replace(/<p>\s*<h1>/g, '<h1>')
    .replace(/<\/h1>\s*<\/p>/g, '</h1>')
    .replace(/<p>\s*<h2>/g, '<h2>')
    .replace(/<\/h2>\s*<\/p>/g, '</h2>')
    .replace(/<p>\s*<h3>/g, '<h3>')
    .replace(/<\/h3>\s*<\/p>/g, '</h3>')
    .replace(/<p>\s*<blockquote>/g, '<blockquote>')
    .replace(/<\/blockquote>\s*<\/p>/g, '</blockquote>')
    .replace(/<p>\s*<ul>/g, '<ul>')
    .replace(/<\/ul>\s*<\/p>/g, '</ul>');

  return html;
}

async function collectCandidateImages() {
  return collectCandidateImagesSync().slice();
}

function collectCandidateImagesSync() {
  const urls = new Set();

  for (const img of Array.from(document.images)) {
    if (!img?.src) continue;
    if (!isLikelySlideImage(img)) continue;
    urls.add(img.currentSrc || img.src);
  }

  const entries = performance.getEntriesByType('resource');
  for (const entry of entries) {
    if (!entry?.name) continue;
    const name = String(entry.name);
    const looksImage = /\.(png|jpg|jpeg|webp|bmp|gif)(\?|$)/i.test(name) || entry.initiatorType === 'img';
    if (looksImage) urls.add(name);
  }

  return Array.from(urls).filter(Boolean);
}

function normalizeImageKey(url) {
  return String(url || '').trim();
}

function shortenText(text, maxLength) {
  const value = String(text || '');
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function isLikelySlideImage(img) {
  const rect = img.getBoundingClientRect();
  const hasArea = (img.naturalWidth || rect.width) >= 120 && (img.naturalHeight || rect.height) >= 120;
  const visible = rect.bottom >= 0 && rect.right >= 0 && rect.left <= window.innerWidth && rect.top <= window.innerHeight;
  return hasArea && visible;
}

async function tryImageToDataUrl(url) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function collectContextText() {
  const title = document.title || '';
  const h1 = document.querySelector('h1')?.textContent || '';
  const h2 = document.querySelector('h2')?.textContent || '';
  return [title, h1, h2].map((v) => (v || '').trim()).filter(Boolean).join(' | ');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fillSettingsForm(settings) {
  if (!state.fields) return;
  state.fields.apiBaseUrl.value = settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
  state.fields.model.value = settings.model || DEFAULT_SETTINGS.model;
  state.fields.apiKey.value = settings.apiKey || '';
}

function readSettingsFromForm() {
  return {
    apiBaseUrl: state.fields.apiBaseUrl.value.trim() || DEFAULT_SETTINGS.apiBaseUrl,
    model: state.fields.model.value.trim() || DEFAULT_SETTINGS.model,
    apiKey: state.fields.apiKey.value.trim()
  };
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEY] || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}