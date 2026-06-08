const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');

const APP_DIR = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.resolve(APP_DIR, '..', '..', 'outputs');
const CLASSROOM_URL = 'https://www.yuketang.cn/v2/web/student-lesson-report/31217489/1682459861625105536/54886960';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

async function waitFor(condition, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) {
    throw new Error(`${label}: ${lastError.message}`);
  }
  throw new Error(`${label}: timeout after ${timeoutMs}ms`);
}

async function saveDataUrl(dataUrl, filePath) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return false;
  const base64 = dataUrl.split(',')[1] || '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return true;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_DIR]
  });

  let page;
  let browserScreenshotPath = path.join(OUTPUT_DIR, 'yuketang-browserview.png');
  let windowScreenshotPath = path.join(OUTPUT_DIR, 'yuketang-electron-window.png');

  try {
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.locator('[data-start-mode="online"]').click();
    await page.locator('#online-bar').waitFor({ state: 'visible', timeout: 20000 });

    await page.locator('#online-url').fill(CLASSROOM_URL);
    await page.locator('#btn-online-go').click();

    const inClassState = await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      if (state?.status?.browserState === 'in-class' || state?.status?.browserState === 'running') {
        return state;
      }
      return null;
    }, 120000, 2500, 'wait for classroom page');

    await page.evaluate(() => window.electronAPI.manualScan());

    const capturedState = await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      return state?.captures?.length ? state : null;
    }, 120000, 2500, 'wait for captured slides');

    const browserDataUrl = await page.evaluate(() => window.electronAPI.captureYuketangScreenshot());
    await saveDataUrl(browserDataUrl, browserScreenshotPath);
    await page.screenshot({ path: windowScreenshotPath, fullPage: true });

    const firstCapture = capturedState.captures[0];
    if (!firstCapture?.id) {
      throw new Error('captured state has no capture id');
    }

    await page.locator('#btn-manual-analyze').click();

    const analyzedState = await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      const current = state?.captures?.find((item) => item.id === firstCapture.id) || state?.captures?.[0];
      if (!current) return null;
      if (current.status === 'done') return { state, current };
      if (current.status === 'error') {
        throw new Error(current.error || 'analysis failed');
      }
      return null;
    }, 180000, 2500, 'wait for manual analysis');

    await page.locator('[data-tab="notes"]').click();
    await page.locator('#notes-panel').waitFor({ state: 'visible', timeout: 30000 });

    const noteHash = analyzedState.current.hash;
    await page.locator('#btn-ai-gen-notes').click();

    const streamedText = await waitFor(async () => {
      const text = await page.locator('#notes-ai-content').innerText().catch(() => '');
      if (/生成失败|HTTP 400|请求失败/i.test(text)) {
        throw new Error(text);
      }
      if (text && text.trim().length > 60) return text;
      return null;
    }, 180000, 2500, 'wait for AI notes content');

    const noteData = await waitFor(async () => {
      const noteResp = await fetchJson(`http://127.0.0.1:3000/api/notes/${noteHash}`);
      const saved = noteResp?.note?.aiGeneratedContent || '';
      return saved.trim().length > 60 ? noteResp : null;
    }, 180000, 2500, 'wait for AI notes persisted');

    const stateAfterGenerate = await fetchJson('http://127.0.0.1:3000/api/state');

    const result = {
      ok: true,
      browserState: inClassState.status.browserState,
      captureCount: stateAfterGenerate?.captures?.length || capturedState.captures.length,
      analyzedCaptureId: analyzedState.current.id,
      analyzedCaptureTitle: analyzedState.current.title || '',
      analyzedCaptureStatus: analyzedState.current.status,
      noteHash: noteHash || '',
      streamedTextLength: streamedText.length,
      aiGeneratedLength: noteData?.note?.aiGeneratedContent?.length || 0,
      windowScreenshotPath,
      browserScreenshotPath
    };

    const resultPath = path.join(OUTPUT_DIR, 'gui-rerun-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {
      ok: false,
      error: error.message,
      windowScreenshotPath: '',
      browserScreenshotPath: ''
    };
    try {
      if (page) {
        await page.screenshot({ path: windowScreenshotPath, fullPage: true });
        failure.windowScreenshotPath = windowScreenshotPath;
        const browserDataUrl = await page.evaluate(() => window.electronAPI.captureYuketangScreenshot()).catch(() => null);
        if (browserDataUrl) {
          await saveDataUrl(browserDataUrl, browserScreenshotPath);
          failure.browserScreenshotPath = browserScreenshotPath;
        }
      }
    } catch {}

    const resultPath = path.join(OUTPUT_DIR, 'gui-rerun-result.json');
    fs.writeFileSync(resultPath, JSON.stringify(failure, null, 2), 'utf8');
    console.log(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  } finally {
    await sleep(1500);
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
