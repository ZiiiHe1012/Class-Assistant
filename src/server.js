import fs from 'fs/promises';
import http from 'http';
import path from 'path';

import express from 'express';
import multer from 'multer';
import open from 'open';

import { AppState } from './app-state.js';
import { config } from './config.js';
import { CapturePipeline } from './services/capture-pipeline.js';
import { ModelService } from './services/model-service.js';
import { MonitorService } from './services/monitor-service.js';
import { ocrImage } from './services/ocr-service.js';

async function ensureDirectories() {
  await fs.mkdir(config.captureDir, { recursive: true });
  await fs.mkdir(path.join(config.captureDir, 'uploads'), { recursive: true });
  await fs.mkdir(config.browserDataDir, { recursive: true });
}

async function main() {
  await ensureDirectories();

  const app = express();
  const server = http.createServer(app);
  const state = new AppState(config);
  const modelService = new ModelService(config);
  const capturePipeline = new CapturePipeline(config, state, modelService);
  const monitorService = new MonitorService(config, state, capturePipeline);

  app.use(express.json({ limit: '25mb' }));
  app.use(express.static(config.publicDir));
  app.use('/captures', express.static(config.captureDir));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, now: new Date().toISOString() });
  });

  app.get('/api/state', (_req, res) => {
    res.json(state.snapshot());
  });

  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });

    res.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
    state.subscribe(res);

    req.on('close', () => {
      state.unsubscribe(res);
    });
  });

  app.post('/api/auto-analyze', (req, res) => {
    const { enabled, mode } = req.body;
    if (enabled !== undefined) {
      state.setAutoAnalyze(Boolean(enabled));
      capturePipeline.setAutoAnalyze(Boolean(enabled));
    }
    if (mode) {
      state.setAnalyzeMode(mode);
      capturePipeline.setAnalyzeMode(mode);
    }
    res.json({ ok: true, autoAnalyze: state.state.status.autoAnalyze, mode: state.state.status.analyzeMode });
  });

  app.get('/api/current-models', (_req, res) => {
    res.json({ ok: true, ...modelService.getCurrentModels() });
  });

  app.post('/api/switch-model', (req, res) => {
    const { fast, deep, translate, chat } = req.body;
    modelService.setModels({ fast, deep, translate, chat });
    const current = modelService.getCurrentModels();
    state.setStatus({ modelFast: current.fast, modelDeep: current.deep, modelTranslate: current.translate });
    res.json({ ok: true, ...current });
  });

  app.post('/api/analyze-current', async (req, res) => {
    const { mode } = req.body || {};
    try {
      await monitorService.triggerManualCapture(mode || state.state.status.analyzeMode || 'fast');
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/deep-think', async (req, res) => {
    const { captureId } = req.body;
    const capture = state.findCapture(captureId);
    if (!capture) {
      return res.status(404).json({ ok: false, error: '未找到对应内容' });
    }

    try {
      state.updateCapture(captureId, { deepThinkStatus: 'thinking' });

      let imageUrl = capture.url;
      if (capture.fileName) {
        try {
          const filePath = path.join(config.captureDir, capture.fileName);
          const fileBuffer = await fs.readFile(filePath);
          const ext = path.extname(capture.fileName).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          imageUrl = `data:${mime};base64,${fileBuffer.toString('base64')}`;
        } catch (_) { }
      }

      const result = await modelService.deepThink({
        imageUrl,
        contextMarkdown: capture.renderedMarkdown
      });
      state.updateCapture(captureId, {
        deepThinkStatus: 'done',
        deepThinkMarkdown: result,
        deepThinkHtml: ''
      });
      res.json({ ok: true, markdown: result });
    } catch (error) {
      state.updateCapture(captureId, { deepThinkStatus: 'error' });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const { captureId, messages, background } = req.body;
    const capture = captureId ? state.findCapture(captureId) : null;

    try {
      const reply = await modelService.chat({
        messages: messages || [],
        imageUrl: capture?.url,
        contextMarkdown: capture?.renderedMarkdown,
        background: background || ''
      });
      res.json({ ok: true, reply });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/chat-stream', async (req, res) => {
    const { captureId, messages, background, model } = req.body;
    const capture = captureId ? state.findCapture(captureId) : null;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await modelService.chatStream({
        messages: messages || [],
        imageUrl: capture?.url,
        contextMarkdown: capture?.renderedMarkdown,
        background: background || '',
        model: model || undefined
      });

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) res.write(`data: ${JSON.stringify({ t: delta })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  });

  app.post('/api/submit-answer', async (req, res) => {
    const { captureId, answerType, answers } = req.body;
    try {
      await monitorService.submitAnswer({ captureId, answerType, answers });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/relogin', async (_req, res) => {
    try {
      await monitorService.relogin();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/navigate', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: '未提供 URL' });
    try {
      await monitorService.navigate(url);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/translate', async (req, res) => {
    const { text, targetLang, sourceLang } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: '未提供文本' });
    try {
      const result = await modelService.translate({ text, targetLang, sourceLang });
      res.json({ ok: true, translation: result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/translate-stream', async (req, res) => {
    const { text, targetLang, sourceLang } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: '未提供文本' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await modelService.translateStream({ text, targetLang, sourceLang });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) res.write(`data: ${JSON.stringify({ t: delta })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  });

  app.get('/api/config', (_req, res) => {
    const mask = (k) => k && k.length >= 8 ? k.slice(0, 5) + '...' + k.slice(-4) : (k ? '****' : '');
    res.json({
      baseUrl: config.openaiBaseUrl,
      model: config.openaiModel,
      modelFast: config.openaiModelFast,
      modelDeep: config.openaiModelDeep,
      translateModel: config.translateModel,
      translateBaseUrl: config.translateBaseUrl,
      hasKey: Boolean(config.openaiApiKey),
      hasTranslateKey: Boolean(config.translateApiKey),
      maskedKey: mask(config.openaiApiKey),
      maskedKeyFast: mask(config.openaiApiKeyFast),
      maskedTranslateKey: mask(config.translateApiKey)
    });
  });

  app.get('/api/models', async (req, res) => {
    const { apiKey, baseUrl } = req.query;
    try {
      if (apiKey) {
        const models = await modelService.listModels(apiKey, baseUrl || '');
        res.json({ ok: true, models: models.map(m => ({ model: m, source: '' })) });
      } else {
        const items = await modelService.listAllModels();
        res.json({ ok: true, models: items.map(i => ({ model: i.model, source: i.endpoint.label })) });
      }
    } catch (error) {
      res.json({ ok: false, models: [], error: error.message });
    }
  });

  app.post('/api/config', async (req, res) => {
    const { baseUrl, apiKey, apiKeyFast, model, modelFast, modelDeep, translateApiKey, translateBaseUrl, translateModel } = req.body;
    try {
      const envPath = path.join(config.rootDir, '.env');
      let envContent = await fs.readFile(envPath, 'utf-8').catch(() => '');

      const upsert = (key, val) => {
        if (val === undefined) return;
        const re = new RegExp(`^${key}=.*$`, 'm');
        if (re.test(envContent)) {
          envContent = envContent.replace(re, `${key}=${val}`);
        } else {
          envContent += `\n${key}=${val}`;
        }
      };

      upsert('OPENAI_BASE_URL', baseUrl);
      if (apiKey && apiKey !== '') upsert('OPENAI_API_KEY', apiKey);
      if (apiKeyFast && apiKeyFast !== '') upsert('OPENAI_API_KEY_FAST', apiKeyFast);
      upsert('OPENAI_MODEL', model);
      upsert('OPENAI_MODEL_FAST', modelFast);
      upsert('OPENAI_MODEL_DEEP', modelDeep);
      if (translateApiKey && translateApiKey !== '') upsert('TRANSLATE_API_KEY', translateApiKey);
      upsert('TRANSLATE_BASE_URL', translateBaseUrl);
      upsert('TRANSLATE_MODEL', translateModel);

      await fs.writeFile(envPath, envContent.trim() + '\n', 'utf-8');

      res.json({ ok: true, message: '配置已保存，重启后生效。' });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/test-connection', async (req, res) => {
    const { baseUrl, apiKey, model } = req.body;
    try {
      const { default: OpenAI } = await import('openai');
      const testClient = new OpenAI({
        apiKey: apiKey || config.openaiApiKey,
        baseURL: baseUrl || config.openaiBaseUrl || undefined
      });
      const completion = await testClient.chat.completions.create({
        model: model || config.openaiModel,
        messages: [{ role: 'user', content: '回复"连接成功"两个字即可' }],
        max_tokens: 20
      });
      const reply = completion.choices?.[0]?.message?.content || '';
      res.json({ ok: true, reply });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ── File upload (offline mode / attachments) ──
  const upload = multer({
    dest: path.join(config.captureDir, 'uploads'),
    limits: { fileSize: 20 * 1024 * 1024 }
  });

  app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: '未上传文件' });

    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const isPdf = ext === '.pdf';
      const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);

      if (!isPdf && !isImage) {
        await fs.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ ok: false, error: '不支持的文件格式' });
      }

      const newName = `${Date.now()}-upload${ext}`;
      const newPath = path.join(config.captureDir, newName);
      await fs.rename(req.file.path, newPath);

      if (isPdf) {
        const pdfParse = await import('pdf-parse');
        const pdfBuffer = await fs.readFile(newPath);
        const pdfData = await pdfParse.default(pdfBuffer);
        const textContent = pdfData.text || '';

        res.json({
          ok: true,
          type: 'pdf',
          fileName: newName,
          webPath: `/captures/${newName}`,
          text: textContent.slice(0, 50000),
          pages: pdfData.numpages
        });
      } else {
        const webPath = `/captures/${newName}`;
        const imageUrl = `http://127.0.0.1:${config.port}${webPath}`;
        const buffer = await fs.readFile(newPath);

        const capture = await capturePipeline.submitOffline({
          url: imageUrl,
          buffer,
          fileName: newName,
          webPath,
          forceAnalyze: true
        });

        res.json({ ok: true, type: 'image', capture });
      }
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/chat-with-attachment', upload.single('file'), async (req, res) => {
    const { messages: messagesJson, captureId, background } = req.body;
    let messages = [];
    try { messages = JSON.parse(messagesJson || '[]'); } catch { }

    const capture = captureId ? state.findCapture(captureId) : null;
    let attachmentContext = '';

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.pdf') {
        try {
          const pdfParse = await import('pdf-parse');
          const pdfBuffer = await fs.readFile(req.file.path);
          const pdfData = await pdfParse.default(pdfBuffer);
          attachmentContext = `\n\n附件PDF内容（前5000字）：\n${(pdfData.text || '').slice(0, 5000)}`;
        } catch { }
      }
      await fs.unlink(req.file.path).catch(() => {});
    }

    try {
      const reply = await modelService.chat({
        messages,
        imageUrl: capture?.url,
        contextMarkdown: (capture?.renderedMarkdown || '') + attachmentContext,
        background: background || ''
      });
      res.json({ ok: true, reply });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/analyze-upload', async (req, res) => {
    const { fileName, mode } = req.body;
    if (!fileName) return res.status(400).json({ ok: false, error: '未指定文件' });

    const filePath = path.join(config.captureDir, fileName);
    try {
      const fileBuffer = await fs.readFile(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const imageUrl = `data:${mime};base64,${fileBuffer.toString('base64')}`;
      const result = await modelService.analyzeImage({ imageUrl, mode: mode || 'fast' });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/analyze-capture', async (req, res) => {
    const { captureId, mode } = req.body;
    if (!captureId) return res.status(400).json({ ok: false, error: '未指定 captureId' });
    try {
      await capturePipeline.analyzeCapture(captureId, mode || 'fast');
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  const ocrCache = new Map();

  app.get('/api/ocr/:id', async (req, res) => {
    const capture = state.findCapture(req.params.id);
    if (!capture) return res.status(404).json({ ok: false, error: '未找到' });

    if (ocrCache.has(capture.id)) {
      return res.json({ ok: true, ...ocrCache.get(capture.id) });
    }

    try {
      const filePath = path.join(config.captureDir, capture.fileName);
      const buffer = await fs.readFile(filePath);
      const result = await ocrImage(buffer);
      ocrCache.set(capture.id, result);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/delete-capture', async (req, res) => {
    const { captureId } = req.body;
    if (!captureId) return res.status(400).json({ ok: false, error: '未指定 captureId' });
    const capture = state.findCapture(captureId);
    if (!capture) return res.status(404).json({ ok: false, error: '未找到' });
    if (capture.fileName) {
      await fs.unlink(path.join(config.captureDir, capture.fileName)).catch(() => {});
    }
    state.removeCapture(captureId);
    res.json({ ok: true });
  });

  // ── Electron BrowserView: receive captured images ──
  app.post('/api/submit-capture', async (req, res) => {
    const { url, buffer: base64, contentType, inClass, forceAnalyze } = req.body;
    if (!url || !base64) return res.status(400).json({ ok: false });
    try {
      const buffer = Buffer.from(base64, 'base64');
      await capturePipeline.submit({ url, source: 'electron', buffer, contentType, inClass, forceAnalyze: forceAnalyze || false });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/browser-status', (req, res) => {
    const { browserState, currentPageTitle, currentPageUrl, inClassroom } = req.body;
    state.setStatus({ browserState, currentPageTitle, currentPageUrl, inClassroom });
    res.json({ ok: true });
  });

  // ── Start/stop browser monitor (CLI fallback, non-Electron) ──
  app.post('/api/start-monitor', async (req, res) => {
    if (process.env.ELECTRON === '1') {
      return res.json({ ok: true, message: '请通过应用界面启动在线模式' });
    }
    if (monitorService.isRunning()) {
      return res.json({ ok: true, message: '监听已在运行' });
    }
    try {
      state.setStatus({ browserState: 'starting' });
      const { url } = req.body || {};
      await monitorService.start(url || '');
      res.json({ ok: true });
    } catch (error) {
      state.setStatus({ browserState: 'error' });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/stop-monitor', async (_req, res) => {
    if (process.env.ELECTRON !== '1') {
      await monitorService.stop().catch(() => {});
    }
    state.setStatus({ browserState: 'disabled' });
    res.json({ ok: true });
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });

  server.listen(config.port, async () => {
    const dashboardUrl = `http://127.0.0.1:${config.port}`;
    state.addLog(`面板已启动：${dashboardUrl}`);

    if (config.autoOpenDashboard) {
      await open(dashboardUrl).catch(() => {
        state.addLog('自动打开本地面板失败，请手动访问面板地址。', 'warn');
      });
    }

    state.setStatus({ browserState: 'disabled' });
    state.addLog('等待用户选择模式...');
  });

  const shutdown = async () => {
    state.addLog('正在关闭服务...');
    await monitorService.stop().catch(() => {});
    server.close(() => { process.exit(0); });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
