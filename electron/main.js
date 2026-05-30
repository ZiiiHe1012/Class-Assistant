const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, dialog, globalShortcut, nativeImage, clipboard, shell, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');

let mainWindow = null;
let yuketangView = null;
let yuketangWindow = null;
let tray = null;
let serverProcess = null;
let scanTimer = null;
let captureReady = false;
let inClassroom = false;
let networkInterceptActive = false;
const PORT = 3000;
const interceptedUrls = new Set();
const pendingRequests = new Map();

const isPacked = app.isPackaged;
const appDir = path.resolve(__dirname, '..');
const iconPath = path.join(appDir, 'public', 'assets', 'app-icon.png');
const icoPath = path.join(appDir, 'public', 'assets', 'app-icon.ico');
const browserDataDir = path.join(appDir, 'data', 'browser');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860,
    minWidth: 900, minHeight: 600,
    icon: fs.existsSync(icoPath) ? icoPath : iconPath,
    title: '智慧课堂',
    backgroundColor: '#f8f6f3',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.control || input.meta) && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      event.preventDefault();
    }
  });
  mainWindow.on('close', () => {
    app.isQuitting = true;
    app.quit();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  if (!fs.existsSync(iconPath)) return;
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('智慧课堂');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    function check(n) {
      if (n <= 0) return reject(new Error('timeout'));
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        if (res.statusCode === 200) resolve();
        else setTimeout(() => check(n - 1), 500);
      });
      req.on('error', () => setTimeout(() => check(n - 1), 500));
      req.end();
    }
    check(retries);
  });
}

function startServer() {
  return new Promise((resolve) => {
    const envFile = path.join(appDir, '.env');
    const envDefault = path.join(appDir, '.env.default');
    if (!fs.existsSync(envFile) && fs.existsSync(envDefault)) fs.copyFileSync(envDefault, envFile);

    const serverScript = path.join(appDir, 'src', 'server.js');
    const nodeExe = isPacked ? process.execPath : 'node';
    const env = {
      ...process.env,
      ELECTRON: '1',
      AUTO_OPEN_DASHBOARD: 'false'
    };
    if (isPacked) env.ELECTRON_RUN_AS_NODE = '1';

    serverProcess = spawn(nodeExe, [serverScript], {
      cwd: appDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    serverProcess.stdout.on('data', (d) => console.log('[srv]', d.toString().trim()));
    serverProcess.stderr.on('data', (d) => console.error('[srv]', d.toString().trim()));
    serverProcess.on('error', (e) => { console.error('spawn error:', e); resolve(); });
    serverProcess.on('exit', (code) => console.log('[srv] exit', code));
    waitForServer().then(resolve).catch(() => resolve());
  });
}

// ── BrowserView for 雨课堂 ──

let viewBoundsCache = { x: 0, y: 0, width: 0, height: 0 };

function updateViewBounds(bounds) {
  if (bounds) viewBoundsCache = bounds;
  if (!yuketangView || !mainWindow) return;
  yuketangView.setBounds(viewBoundsCache);
}

function updateBrowserStatus(title, url) {
  const waitingLogin = title.includes('登录');
  const inClass = isClassroomPage(url, title);
  captureReady = !waitingLogin;
  inClassroom = inClass;

  const browserState = captureReady ? (inClass ? 'in-class' : 'running') : 'waiting-login';
  postToServer('/api/browser-status', { browserState, currentPageTitle: title, currentPageUrl: url, inClassroom: inClass });
  if (mainWindow) mainWindow.webContents.send('browser-status', { browserState, title, url });
}

function isClassroomPage(url, title) {
  if (!url) return false;
  const classPatterns = [
    /\/lesson\//, /\/classroom\//, /\/presentation\//,
    /\/pro\/lms\/.*\/studycontent/, /\/v2\/web\/index/,
    /\/v2\/web\//, /changjiang\.yuketang/,
    /problemset/, /quiz/, /exercise/,
    /\/studentCards\//, /\/slideshow\//
  ];
  const titlePatterns = [/课堂/, /课件/, /直播/, /互动/, /答题/, /签到/];
  // If navigated away from homepage, likely in classroom
  const notHomepage = url.includes('yuketang') && !url.endsWith('/web/?index') && !url.endsWith('/web/');
  return classPatterns.some(p => p.test(url)) || titlePatterns.some(p => p.test(title || '')) || notHomepage;
}

function isLikelySlideImage(url) {
  if (!url) return false;
  const ignorePatterns = [
    /avatar/, /icon/, /logo/, /badge/, /emoji/, /banner/,
    /thumbnail.*user/, /profile/, /\.svg$/i, /favicon/,
    /\.gif$/i, /qrcode/, /barcode/, /wechat/, /weixin/,
    /button/, /arrow/, /spinner/, /loading/, /placeholder/,
    /ad[_\-]/, /advert/, /tracker/, /analytics/,
    /1x1/, /pixel/, /spacer/, /blank/
  ];
  if (ignorePatterns.some(p => p.test(url))) return false;

  // YuKetang-specific: only accept /slide/ images, skip static assets and misc
  if (/yuketang\.cn/i.test(url)) {
    return /\/slide\//i.test(url);
  }

  return true;
}

async function startYuketangView(customUrl) {
  if (yuketangView) return;

  const defaultUrl = customUrl || 'https://www.yuketang.cn/web/?index';

  // Ensure browser data dir
  if (!fs.existsSync(browserDataDir)) fs.mkdirSync(browserDataDir, { recursive: true });

  const partition = 'persist:yuketang';

  yuketangView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition,
      sandbox: true,
      zoomFactor: 1.0
    }
  });

  mainWindow.addBrowserView(yuketangView);

  // Handle new window requests (e.g., "进入课堂" opens popup) — navigate in same view
  yuketangView.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url.startsWith('http')) {
      yuketangView.webContents.loadURL(url);
    }
    return { action: 'deny' };
  });

  yuketangView.webContents.on('did-navigate', (_e, url) => {
    if (!yuketangView || yuketangView.webContents.isDestroyed()) return;
    const title = yuketangView.webContents.getTitle();
    updateBrowserStatus(title, url);
  });

  yuketangView.webContents.on('did-navigate-in-page', (_e, url) => {
    if (!yuketangView || yuketangView.webContents.isDestroyed()) return;
    const title = yuketangView.webContents.getTitle();
    updateBrowserStatus(title, url);
  });

  yuketangView.webContents.on('page-title-updated', (_e, title) => {
    if (!yuketangView || yuketangView.webContents.isDestroyed()) return;
    const url = yuketangView.webContents.getURL();
    updateBrowserStatus(title, url);
  });

  yuketangView.webContents.on('destroyed', () => {
    yuketangView = null;
  });

  await yuketangView.webContents.loadURL(defaultUrl);

  // Start network interception via CDP for image capture
  startNetworkInterception();

  // Start scanning for images (fallback for images CDP might miss)
  scanTimer = setInterval(() => scanVisibleImages(), 2500);

  postToServer('/api/browser-status', { browserState: 'waiting-login', currentPageTitle: '', currentPageUrl: defaultUrl });
}

function startNetworkInterception() {
  if (!yuketangView || networkInterceptActive) return;
  try {
    const dbg = yuketangView.webContents.debugger;
    dbg.attach('1.3');
    dbg.sendCommand('Network.enable');
    dbg.on('message', (_event, method, params) => {
      if (method === 'Network.responseReceived') {
        onResponseReceived(params);
      } else if (method === 'Network.loadingFinished') {
        onLoadingFinished(params);
      }
    });
    networkInterceptActive = true;
  } catch (e) {
    console.error('[cdp] attach failed:', e.message);
  }
}

function stopNetworkInterception() {
  if (!yuketangView || !networkInterceptActive) return;
  try {
    const dbg = yuketangView.webContents.debugger;
    if (dbg.isAttached()) dbg.detach();
  } catch (_) {}
  networkInterceptActive = false;
  interceptedUrls.clear();
  pendingRequests.clear();
}

function onResponseReceived(params) {
  if (!captureReady || !inClassroom) return;
  const { response, requestId } = params;
  if (!response || !response.url) return;

  const contentType = response.headers['content-type'] || response.headers['Content-Type'] || '';
  if (!contentType.startsWith('image/')) return;
  if (contentType.includes('gif') || contentType.includes('svg')) return;

  const url = response.url;
  if (!url.startsWith('http')) return;
  if (!isLikelySlideImage(url)) return;
  if (interceptedUrls.has(url)) return;

  // Store info for when loading finishes
  pendingRequests.set(requestId, { url, contentType });
}

function onLoadingFinished(params) {
  const { requestId } = params;
  const info = pendingRequests.get(requestId);
  if (!info) return;
  pendingRequests.delete(requestId);

  const { url, contentType } = info;
  if (interceptedUrls.has(url)) return;
  interceptedUrls.add(url);

  // Limit set size to prevent memory leak
  if (interceptedUrls.size > 500) {
    const first = interceptedUrls.values().next().value;
    interceptedUrls.delete(first);
  }

  // Now body is fully downloaded — safe to read
  const dbg = yuketangView && yuketangView.webContents && yuketangView.webContents.debugger;
  if (!dbg || !dbg.isAttached()) return;

  dbg.sendCommand('Network.getResponseBody', { requestId }).then((result) => {
    if (!result || !result.body) return;
    const buffer = result.base64Encoded
      ? Buffer.from(result.body, 'base64')
      : Buffer.from(result.body);
    if (buffer.length < 5000) return;
    submitCaptureToServer(url, buffer, contentType, false);
  }).catch(() => {});
}

function stopYuketangView() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  stopNetworkInterception();
  if (yuketangView) {
    try {
      if (mainWindow) mainWindow.removeBrowserView(yuketangView);
      if (!yuketangView.webContents.isDestroyed()) yuketangView.webContents.close();
    } catch (_) {}
    yuketangView = null;
  }
  captureReady = false;
  inClassroom = false;
  postToServer('/api/browser-status', { browserState: 'disabled' });
}

async function scanVisibleImages() {
  if (!yuketangView || !captureReady || !inClassroom) return;

  try {
    const visibleImages = await yuketangView.webContents.executeJavaScript(`
      (function() {
        function isVisible(el) {
          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          return rect.width > 40 && rect.height > 40 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < window.innerHeight && rect.left < window.innerWidth &&
            style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0;
        }
        var results = [];
        // Collect <img> tags
        Array.from(document.images).forEach(function(img) {
          var url = img.currentSrc || img.src;
          if (url && url.startsWith('http') && img.clientWidth * img.clientHeight > 10000 && isVisible(img)) {
            results.push({ url: url, area: img.clientWidth * img.clientHeight });
          }
        });
        // Collect background-image URLs from large visible elements
        document.querySelectorAll('[style*="background"], .slide, .ppt, .courseware, .presentation, canvas').forEach(function(el) {
          var style = window.getComputedStyle(el);
          var bg = style.backgroundImage;
          if (bg && bg !== 'none') {
            var match = bg.match(/url\\(["']?(https?:\\/\\/[^"')]+)["']?\\)/);
            if (match && isVisible(el)) {
              results.push({ url: match[1], area: el.clientWidth * el.clientHeight });
            }
          }
        });
        // Deduplicate
        var seen = {};
        return results.filter(function(img) {
          if (seen[img.url]) return false;
          seen[img.url] = true;
          return true;
        }).sort(function(a, b) { return b.area - a.area; }).slice(0, 8);
      })()
    `);

    for (const img of visibleImages) {
      if (!isLikelySlideImage(img.url)) continue;
      fetchAndSubmitImage(img.url);
    }
  } catch (e) {
    // Page might be navigating
  }
}

function fetchAndSubmitImage(imageUrl, forceAnalyze) {
  // Use the BrowserView's session to fetch with cookies (authenticated)
  if (yuketangView && !yuketangView.webContents.isDestroyed()) {
    const ses = yuketangView.webContents.session;
    const req = ses.fetch ? ses : null;
    if (req && typeof ses.fetch === 'function') {
      ses.fetch(imageUrl).then(async (response) => {
        if (!response.ok) return;
        const contentType = response.headers.get('content-type') || 'image/png';
        if (!contentType.startsWith('image/')) return;
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        if (buffer.length < 5000) return;
        submitCaptureToServer(imageUrl, buffer, contentType, forceAnalyze);
      }).catch(() => {});
      return;
    }
  }

  // Fallback: fetch without cookies
  const mod = imageUrl.startsWith('https') ? https : http;
  const req = mod.get(imageUrl, { timeout: 15000 }, (res) => {
    if (res.statusCode !== 200) return;
    const contentType = res.headers['content-type'] || 'image/png';
    if (!contentType.startsWith('image/')) return;

    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 5000) return;
      submitCaptureToServer(imageUrl, buffer, contentType, forceAnalyze);
    });
  });
  req.on('error', () => {});
  req.end();
}

function submitCaptureToServer(url, buffer, contentType, forceAnalyze) {
  const body = JSON.stringify({
    url,
    buffer: buffer.toString('base64'),
    contentType,
    inClass: inClassroom,
    forceAnalyze: forceAnalyze || false
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/api/submit-capture',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function postToServer(path, data) {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT,
    path,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

// ── App lifecycle ──

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow) mainWindow.webContents.send('screenshot-slide');
  });
});

app.on('activate', () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  stopYuketangView();
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { app.quit(); });

// ── IPC handlers ──

ipcMain.handle('select-file', async (_, opts) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: opts?.filters || [{ name: 'Documents', extensions: ['pdf','png','jpg','jpeg','webp','gif'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('read-file', (_, filePath) => {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.pdf':'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif' };
  return { buffer: buffer.toString('base64'), mime: mime[ext] || 'application/octet-stream', name: path.basename(filePath) };
});

ipcMain.handle('get-clipboard-image', () => {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : img.toDataURL();
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('open-yuketang-window', async (_, url) => {
  const openUrl = url || 'https://www.yuketang.cn/web/?index';
  if (yuketangWindow && !yuketangWindow.isDestroyed()) {
    yuketangWindow.loadURL(openUrl);
    yuketangWindow.focus();
    return { ok: true };
  }
  yuketangWindow = new BrowserWindow({
    width: 1100, height: 750,
    icon: fs.existsSync(icoPath) ? icoPath : iconPath,
    title: '雨课堂',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:yuketang',
      sandbox: true
    }
  });
  yuketangWindow.loadURL(openUrl);
  yuketangWindow.on('closed', () => { yuketangWindow = null; });
  return { ok: true };
});

ipcMain.handle('start-yuketang', async (_, customUrl) => {
  try {
    if (yuketangView) {
      // View already exists, just make sure it's attached
      if (mainWindow && !mainWindow.getBrowserViews().includes(yuketangView)) {
        mainWindow.addBrowserView(yuketangView);
      }
      if (customUrl) await yuketangView.webContents.loadURL(customUrl);
      return { ok: true };
    }
    await startYuketangView(customUrl || '');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stop-yuketang', () => {
  stopYuketangView();
  return { ok: true };
});

ipcMain.handle('navigate-yuketang', async (_, url) => {
  if (!yuketangView) return { ok: false, error: '浏览器未启动' };
  try {
    await yuketangView.webContents.loadURL(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('relogin-yuketang', async () => {
  try {
    // 完全销毁旧视图再重建，避免 session 残留问题
    if (yuketangView) stopYuketangView();

    // 清除持久化 session 数据
    const ses = session.fromPartition('persist:yuketang');
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();

    captureReady = false;
    inClassroom = false;
    postToServer('/api/browser-status', { browserState: 'waiting-login' });

    // 重新创建 BrowserView
    await startYuketangView('https://www.yuketang.cn/web/?index');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('set-view-bounds', (_, bounds) => {
  if (!bounds || !bounds.width || !bounds.height) return;
  updateViewBounds({ x: bounds.x || 0, y: bounds.y || 0, width: Math.round(bounds.width), height: Math.round(bounds.height) });
});

ipcMain.handle('show-yuketang-view', () => {
  if (!yuketangView || !mainWindow) return;
  mainWindow.addBrowserView(yuketangView);
  updateViewBounds();
});

ipcMain.handle('hide-yuketang-view', () => {
  if (!yuketangView || !mainWindow) return;
  mainWindow.removeBrowserView(yuketangView);
});

ipcMain.handle('get-yuketang-url', () => {
  if (!yuketangView) return '';
  return yuketangView.webContents.getURL();
});

ipcMain.handle('capture-yuketang-screenshot', async () => {
  if (!yuketangView) return null;
  try {
    const img = await yuketangView.webContents.capturePage();
    return img.toDataURL();
  } catch { return null; }
});

ipcMain.handle('manual-scan-yuketang', async () => {
  if (!yuketangView) return { ok: false, error: '浏览器未启动' };
  try {
    const visibleImages = await yuketangView.webContents.executeJavaScript(`
      (function() {
        return Array.from(document.images)
          .map(function(img) { return { url: img.currentSrc || img.src, area: img.clientWidth * img.clientHeight }; })
          .filter(function(img) { return img.url && img.url.startsWith('http') && img.area > 10000; })
          .sort(function(a, b) { return b.area - a.area; })
          .slice(0, 3);
      })()
    `);
    for (const img of visibleImages) {
      if (isLikelySlideImage(img.url)) fetchAndSubmitImage(img.url, true);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
