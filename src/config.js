import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const envPath = path.join(rootDir, '.env');
const defaultEnvPath = path.join(rootDir, '.env.default');

if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (fs.existsSync(defaultEnvPath)) {
  dotenv.config({ path: defaultEnvPath });
} else {
  dotenv.config();
}

function resolveFromRoot(targetPath) {
  return path.resolve(rootDir, targetPath);
}

function getBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  return !['0', 'false', 'False', 'FALSE', 'no', 'No', 'NO'].includes(raw);
}

function getNumberEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

export const config = Object.freeze({
  rootDir,
  publicDir: resolveFromRoot('public'),
  captureDir: resolveFromRoot('data/captures'),
  browserDataDir: resolveFromRoot('data/browser'),
  port: getNumberEnv('PORT', 3000),
  yuketangUrl: process.env.YUKETANG_URL || 'https://www.yuketang.cn/web/?index',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiApiKeyFast: process.env.OPENAI_API_KEY_FAST || process.env.OPENAI_API_KEY || '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  openaiModelFast: process.env.OPENAI_MODEL_FAST || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  openaiModelDeep: process.env.OPENAI_MODEL_DEEP || process.env.OPENAI_MODEL || 'gpt-5.4',
  translateApiKey: process.env.TRANSLATE_API_KEY || '',
  translateBaseUrl: process.env.TRANSLATE_BASE_URL || '',
  translateModel: process.env.TRANSLATE_MODEL || '',
  autoOpenDashboard: getBooleanEnv('AUTO_OPEN_DASHBOARD', true),
  disableBrowserMonitor: getBooleanEnv('DISABLE_BROWSER_MONITOR', false),
  browserHeadless: getBooleanEnv('BROWSER_HEADLESS', false),
  pollIntervalMs: getNumberEnv('POLL_INTERVAL_MS', 2500),
  analysisMaxAttempts: getNumberEnv('ANALYSIS_MAX_ATTEMPTS', 3),
  analysisRetryDelayMs: getNumberEnv('ANALYSIS_RETRY_DELAY_MS', 2500),
  imageMinBytes: getNumberEnv('IMAGE_MIN_BYTES', 15000),
  imageMinWidth: getNumberEnv('IMAGE_MIN_WIDTH', 320),
  imageMinHeight: getNumberEnv('IMAGE_MIN_HEIGHT', 180),
  maxHistory: getNumberEnv('MAX_HISTORY', 30)
});
