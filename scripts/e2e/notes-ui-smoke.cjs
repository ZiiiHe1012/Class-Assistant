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

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_DIR]
  });

  const screenshotPath = path.join(OUTPUT_DIR, 'notes-ui-smoke.png');
  const resultPath = path.join(OUTPUT_DIR, 'notes-ui-smoke.json');

  let page;
  try {
    page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.locator('[data-start-mode="online"]').click();
    await page.locator('#online-bar').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#online-url').fill(CLASSROOM_URL);
    await page.locator('#btn-online-go').click();

    await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      if (state?.status?.browserState === 'in-class' || state?.status?.browserState === 'running') {
        return state;
      }
      return null;
    }, 120000, 2500, 'wait for classroom page');

    await page.evaluate(() => window.electronAPI.manualScan());

    const capturedState = await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      return state?.captures?.length >= 2 ? state : null;
    }, 120000, 2500, 'wait for captured slides');

    await page.locator('.thumb').first().click();
    await page.locator('#btn-manual-analyze').click();

    const firstCapture = capturedState.captures[0];
    await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      const current = state?.captures?.find((item) => item.id === firstCapture.id);
      if (!current) return null;
      if (current.status === 'done') return current;
      if (current.status === 'error') {
        throw new Error(current.error || 'analysis failed');
      }
      return null;
    }, 180000, 2500, 'wait for manual analysis');

    await page.locator('[data-tab="notes"]').click();
    await page.locator('#notes-panel').waitFor({ state: 'visible', timeout: 30000 });

    const smokeText = `## Preview Smoke ${Date.now()}\n\n- alpha\n- beta`;
    await page.locator('#notes-editor').fill(smokeText);
    await page.locator('#btn-notes-preview-toggle').click();

    const previewText = await waitFor(async () => {
      const previewVisible = await page.locator('#notes-preview').evaluate((el) => getComputedStyle(el).display !== 'none');
      if (!previewVisible) return null;
      const text = await page.locator('#notes-preview').innerText();
      return text.includes('Preview Smoke') ? text : null;
    }, 15000, 250, 'wait for preview render');

    await page.locator('.thumb').nth(1).click();
    await waitFor(async () => {
      const previewVisible = await page.locator('#notes-preview').evaluate((el) => getComputedStyle(el).display !== 'none');
      return previewVisible ? true : null;
    }, 15000, 250, 'wait for preview stay visible on second capture');

    await page.locator('.thumb').first().click();
    const restoredPreview = await waitFor(async () => {
      const text = await page.locator('#notes-preview').innerText();
      return text.includes('Preview Smoke') ? text : null;
    }, 15000, 250, 'wait for preview restore on first capture');

    await page.locator('#btn-ai-gen-notes').click();

    await waitFor(async () => {
      const resizerVisible = await page.locator('#notes-ai-resizer').evaluate((el) => getComputedStyle(el).display !== 'none');
      const blockVisible = await page.locator('#notes-ai-block').evaluate((el) => getComputedStyle(el).display !== 'none');
      return resizerVisible && blockVisible ? true : null;
    }, 30000, 250, 'wait for AI block visible');

    await waitFor(async () => {
      const text = await page.locator('#notes-ai-content').innerText().catch(() => '');
      if (/生成失败|HTTP 400|请求失败/i.test(text)) {
        throw new Error(text);
      }
      return text && text.trim().length > 60 ? text : null;
    }, 180000, 2500, 'wait for AI notes content');

    const metrics = await page.evaluate(() => {
      const block = document.getElementById('notes-ai-block');
      const panel = document.getElementById('notes-panel');
      return {
        blockHeight: block ? Math.round(block.getBoundingClientRect().height) : 0,
        panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : 0
      };
    });
    const initialHeight = metrics.blockHeight;
    const maxHeight = Math.max(Math.floor(metrics.panelHeight * 0.6), 120);
    const resizerBox = await page.locator('#notes-ai-resizer').boundingBox();
    if (!resizerBox) {
      throw new Error('notes-ai-resizer has no bounding box');
    }

    const dragX = resizerBox.x + (resizerBox.width / 2);
    const dragY = resizerBox.y + (resizerBox.height / 2);
    const dragOffset = initialHeight >= maxHeight - 4 ? 90 : -90;
    await page.mouse.move(dragX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragX, dragY + dragOffset, { steps: 12 });
    await page.mouse.up();

    const resizedHeight = await waitFor(async () => {
      const nextHeight = await page.locator('#notes-ai-block').evaluate((el) => Math.round(el.getBoundingClientRect().height));
      return nextHeight !== initialHeight ? nextHeight : null;
    }, 10000, 250, 'wait for AI block resize');

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const result = {
      ok: true,
      previewContains: previewText.slice(0, 80),
      restoredPreviewContains: restoredPreview.slice(0, 80),
      initialAiHeight: initialHeight,
      maxAiHeight: maxHeight,
      resizedAiHeight: resizedHeight,
      screenshotPath
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {
      ok: false,
      error: error.message,
      screenshotPath: ''
    };
    try {
      if (page) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        failure.screenshotPath = screenshotPath;
      }
    } catch {}
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
