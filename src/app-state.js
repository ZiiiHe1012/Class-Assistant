import crypto from 'crypto';

export class AppState {
  constructor(config) {
    this.config = config;
    this.subscribers = new Set();
    this.autoAnalyze = false;
    this.analyzeMode = 'fast';
    this.state = {
      status: {
        appStartedAt: new Date().toISOString(),
        browserState: config.disableBrowserMonitor ? 'disabled' : 'starting',
        currentPageUrl: '',
        currentPageTitle: '',
        lastVisibleScanAt: '',
        lastCaptureAt: '',
        queueSize: 0,
        processedCount: 0,
        failedCount: 0,
        autoAnalyze: false,
        analyzeMode: 'fast'
      },
      captures: [],
      logs: []
    };
  }

  snapshot() {
    return this.state;
  }

  subscribe(response) {
    this.subscribers.add(response);
  }

  unsubscribe(response) {
    this.subscribers.delete(response);
  }

  broadcast() {
    const payload = `data: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const subscriber of this.subscribers) {
      subscriber.write(payload);
    }
  }

  setStatus(patch) {
    this.state.status = { ...this.state.status, ...patch };
    this.broadcast();
  }

  setAutoAnalyze(enabled) {
    this.autoAnalyze = enabled;
    this.state.status.autoAnalyze = enabled;
    this.broadcast();
  }

  setAnalyzeMode(mode) {
    this.analyzeMode = mode;
    this.state.status.analyzeMode = mode;
    this.broadcast();
  }

  addLog(message, level = 'info') {
    this.state.logs.unshift({
      id: crypto.randomUUID(),
      message,
      level,
      timestamp: new Date().toISOString()
    });
    this.state.logs = this.state.logs.slice(0, 80);
    this.broadcast();
  }

  addCapture(record) {
    this.state.captures.unshift(record);
    this.state.captures = this.state.captures.slice(0, this.config.maxHistory);
    this.broadcast();
  }

  updateCapture(id, patch) {
    this.state.captures = this.state.captures.map((item) => {
      if (item.id !== id) return item;
      return { ...item, ...patch, updatedAt: new Date().toISOString() };
    });
    this.broadcast();
  }

  removeCapture(id) {
    this.state.captures = this.state.captures.filter((item) => item.id !== id);
    this.broadcast();
  }

  findCapture(id) {
    return this.state.captures.find((item) => item.id === id) || null;
  }
}
