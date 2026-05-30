import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const EXTENSION_BY_FORMAT = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  avif: 'avif',
  tiff: 'tiff'
};

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tiff'
};

function getFileExtension(format, mimeType) {
  return EXTENSION_BY_FORMAT[format] || EXTENSION_BY_MIME[mimeType] || 'png';
}

function getErrorMessage(error) {
  if (!error) return '模型分析失败。';
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export class CapturePipeline {
  constructor(config, state, modelService) {
    this.config = config;
    this.state = state;
    this.modelService = modelService;
    this.queue = [];
    this.processing = false;
    this.seenHashes = new Map();
    this.pendingUrls = new Set();
    this.autoAnalyze = false;
    this.analyzeMode = 'fast';
    this.lastSubmittedHash = null;
  }

  setAutoAnalyze(enabled) {
    this.autoAnalyze = enabled;
  }

  setAnalyzeMode(mode) {
    this.analyzeMode = mode;
  }

  async submit({ url, source, buffer, contentType, forceAnalyze = false, inClass = true }) {
    if (!url || !buffer || buffer.length < this.config.imageMinBytes) {
      return;
    }

    if (this.pendingUrls.has(url)) {
      return;
    }

    this.pendingUrls.add(url);

    try {
      const image = sharp(buffer, { failOn: 'none' });
      const metadata = await image.metadata();
      const width = Number(metadata.width || 0);
      const height = Number(metadata.height || 0);

      if (width < this.config.imageMinWidth || height < this.config.imageMinHeight) {
        return;
      }

      // Skip images that are too narrow/tall (likely UI elements, not slides)
      const aspectRatio = width / height;
      if (aspectRatio > 6 || aspectRatio < 0.3) {
        return;
      }

      const hash = crypto.createHash('sha1').update(buffer).digest('hex');

      if (hash === this.lastSubmittedHash) {
        return;
      }
      this.lastSubmittedHash = hash;

      if (this.seenHashes.has(hash)) {
        const existingId = this.seenHashes.get(hash);
        const existing = this.state.findCapture(existingId);
        if (existing) {
          this.state.setStatus({ lastCaptureAt: new Date().toISOString() });
          this.state.broadcast();
          return;
        }
      }

      const extension = getFileExtension(metadata.format, contentType);
      const fileName = `${Date.now()}-${hash.slice(0, 12)}.${extension}`;
      const absolutePath = path.join(this.config.captureDir, fileName);

      await fs.writeFile(absolutePath, buffer);

      const shouldAnalyze = forceAnalyze || (this.autoAnalyze && inClass);

      const capture = {
        id: crypto.randomUUID(),
        source,
        url,
        hash,
        status: shouldAnalyze ? 'queued' : 'captured',
        fileName,
        webPath: `/captures/${fileName}`,
        width,
        height,
        bytes: buffer.length,
        categoryId: null,
        categoryName: '',
        confidence: 0,
        reason: '',
        title: '',
        payload: null,
        renderedHtml: '',
        renderedMarkdown: '',
        ocrText: '',
        deepThinkStatus: '',
        deepThinkMarkdown: '',
        deepThinkHtml: '',
        error: '',
        attemptCount: 0,
        maxAttempts: this.config.analysisMaxAttempts,
        retryAt: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      this.seenHashes.set(hash, capture.id);
      this.state.addCapture(capture);
      this.state.setStatus({ lastCaptureAt: capture.createdAt });

      if (shouldAnalyze) {
        this.queue.push({
          id: capture.id,
          imageUrl: url,
          filePath: absolutePath,
          attemptCount: 1,
          mode: forceAnalyze || this.analyzeMode
        });

        this.state.setStatus({ queueSize: this.queue.length });

        if (!this.processing) {
          void this.processQueue();
        }
      }
    } finally {
      this.pendingUrls.delete(url);
    }
  }

  async submitOffline({ url, buffer, fileName, webPath, forceAnalyze = false }) {
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');

    if (this.seenHashes.has(hash)) {
      const existingId = this.seenHashes.get(hash);
      const existing = this.state.findCapture(existingId);
      if (existing) return existing;
    }

    const image = sharp(buffer, { failOn: 'none' });
    const metadata = await image.metadata();

    const shouldAnalyze = forceAnalyze || this.autoAnalyze;

    const capture = {
      id: crypto.randomUUID(),
      source: 'upload',
      url,
      hash,
      status: shouldAnalyze ? 'queued' : 'captured',
      fileName,
      webPath,
      width: metadata.width || 0,
      height: metadata.height || 0,
      bytes: buffer.length,
      categoryId: null,
      categoryName: '',
      confidence: 0,
      reason: '',
      title: '',
      payload: null,
      renderedHtml: '',
      renderedMarkdown: '',
      ocrText: '',
      deepThinkStatus: '',
      deepThinkMarkdown: '',
      deepThinkHtml: '',
      error: '',
      attemptCount: 0,
      maxAttempts: this.config.analysisMaxAttempts,
      retryAt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.seenHashes.set(hash, capture.id);
    this.state.addCapture(capture);

    if (shouldAnalyze) {
      this.queue.push({
        id: capture.id,
        imageUrl: url,
        filePath: path.join(this.config.captureDir, fileName),
        attemptCount: 1,
        mode: this.analyzeMode
      });
      this.state.setStatus({ queueSize: this.queue.length });
      void this.processQueue();
    }

    return capture;
  }

  async analyzeCapture(captureId, mode) {
    const capture = this.state.findCapture(captureId);
    if (!capture) return;

    this.queue.push({
      id: capture.id,
      imageUrl: capture.url,
      filePath: path.join(this.config.captureDir, capture.fileName),
      attemptCount: 1,
      mode: mode || this.analyzeMode
    });

    this.state.setStatus({ queueSize: this.queue.length });

    if (!this.processing) {
      void this.processQueue();
    }
  }

  async processQueue() {
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      this.state.setStatus({ queueSize: this.queue.length });
      this.state.updateCapture(task.id, {
        status: 'analyzing',
        attemptCount: task.attemptCount,
        retryAt: '',
        error: ''
      });

      try {
        // Read file and convert to base64 data URL for remote API access
        let imageUrl = task.imageUrl;
        if (task.filePath) {
          try {
            const fileBuffer = await fs.readFile(task.filePath);
            const ext = path.extname(task.filePath).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            imageUrl = `data:${mime};base64,${fileBuffer.toString('base64')}`;
          } catch (_) { /* fall back to URL */ }
        }
        const result = await this.modelService.analyzeImage({ imageUrl, mode: task.mode || this.analyzeMode });

        if (result.categoryId === 5) {
          await fs.rm(task.filePath, { force: true }).catch(() => {});
          this.state.removeCapture(task.id);
          continue;
        }

        const nextProcessedCount = this.state.snapshot().status.processedCount + 1;

        this.state.updateCapture(task.id, {
          status: 'done',
          error: '',
          retryAt: '',
          ...result
        });
        this.state.setStatus({ processedCount: nextProcessedCount });
      } catch (error) {
        const errorMessage = getErrorMessage(error);

        if (this.shouldRetry(error, task)) {
          this.scheduleRetry(task, errorMessage);
          continue;
        }

        const nextFailedCount = this.state.snapshot().status.failedCount + 1;

        this.state.updateCapture(task.id, {
          status: 'error',
          error: errorMessage,
          attemptCount: task.attemptCount,
          retryAt: ''
        });
        this.state.setStatus({ failedCount: nextFailedCount });
        this.state.addLog(`图片分析失败：${errorMessage}`, 'error');
      }
    }

    this.processing = false;
  }

  shouldRetry(error, task) {
    if (task.attemptCount >= this.config.analysisMaxAttempts) {
      return false;
    }

    if (error?.retryable) {
      return true;
    }

    const message = getErrorMessage(error);
    return /json|timeout|temporar|service|429|500|502|503|504|overloaded|重试/i.test(message);
  }

  scheduleRetry(task, errorMessage) {
    const delayMs = this.config.analysisRetryDelayMs * task.attemptCount;
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    const nextAttemptCount = task.attemptCount + 1;

    this.state.updateCapture(task.id, {
      status: 'retrying',
      error: errorMessage,
      attemptCount: task.attemptCount,
      retryAt
    });
    this.state.addLog(
      `图片分析第 ${task.attemptCount} 次失败，将在 ${Math.round(delayMs / 1000)} 秒后自动重试。`,
      'warn'
    );

    setTimeout(() => {
      this.queue.push({ ...task, attemptCount: nextAttemptCount });
      this.state.setStatus({ queueSize: this.queue.length });
      if (!this.processing) {
        void this.processQueue();
      }
    }, delayMs);
  }
}
