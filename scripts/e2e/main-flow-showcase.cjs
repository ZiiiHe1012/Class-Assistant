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

function assistantBubbleTextLocator(page) {
  return page.locator('.chat-bubble.assistant').last();
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [APP_DIR]
  });

  const resultPath = path.join(OUTPUT_DIR, 'main-flow-showcase.json');
  const analysisShot = path.join(OUTPUT_DIR, 'showcase-analysis.png');
  const deepThinkShot = path.join(OUTPUT_DIR, 'showcase-deepthink.png');
  const notesShot = path.join(OUTPUT_DIR, 'showcase-notes.png');
  const chatShot = path.join(OUTPUT_DIR, 'showcase-chat.png');

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
      return state?.captures?.length ? state : null;
    }, 120000, 2500, 'wait for captured slides');

    await page.locator('.thumb').first().click();
    const firstCaptureId = capturedState.captures[0].id;

    await page.locator('#btn-manual-analyze').click();
    const analyzedCapture = await waitFor(async () => {
      const state = await fetchJson('http://127.0.0.1:3000/api/state');
      const capture = state?.captures?.find((item) => item.id === firstCaptureId);
      if (!capture) return null;
      if (capture.status === 'done') return capture;
      if (capture.status === 'error') {
        throw new Error(capture.error || 'analysis failed');
      }
      return null;
    }, 180000, 2500, 'wait for manual analysis');

    await page.screenshot({ path: analysisShot, fullPage: true });

    let deepThought = null;
    let deepThinkCompleted = false;
    try {
      await page.locator('[data-do="deep-think"]').click();
      deepThought = await waitFor(async () => {
        const state = await fetchJson('http://127.0.0.1:3000/api/state');
        const capture = state?.captures?.find((item) => item.id === firstCaptureId);
        if (!capture) return null;
        if (capture.deepThinkStatus === 'done' && capture.deepThinkMarkdown) return capture;
        if (capture.deepThinkStatus === 'error') {
          throw new Error('deep think failed');
        }
        return null;
      }, 120000, 2500, 'wait for deep think');
      await page.screenshot({ path: deepThinkShot, fullPage: true });
      deepThinkCompleted = true;
    } catch (error) {
      deepThought = null;
      deepThinkCompleted = false;
    }

    await page.locator('[data-tab="notes"]').click();
    await page.locator('#notes-panel').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#btn-import-analysis').click();
    await page.locator('#btn-import-deepthink').click();

    const aiContentReady = await (async () => {
      const currentText = await page.locator('#notes-ai-content').innerText().catch(() => '');
      if (currentText && currentText.trim().length > 60) return currentText;
      await page.locator('#btn-ai-gen-notes').click();
      return waitFor(async () => {
        const text = await page.locator('#notes-ai-content').innerText().catch(() => '');
        if (/生成失败|HTTP 400|请求失败/i.test(text)) {
          throw new Error(text);
        }
        return text && text.trim().length > 60 ? text : null;
      }, 180000, 2500, 'wait for AI notes content');
    })();

    await page.locator('#btn-notes-preview-toggle').click();
    await waitFor(async () => {
      const visible = await page.locator('#notes-preview').evaluate((el) => getComputedStyle(el).display !== 'none');
      return visible ? true : null;
    }, 10000, 250, 'wait for notes preview visible');
    await page.screenshot({ path: notesShot, fullPage: true });

    await page.locator('#chat-input').fill('请用两句话总结当前课件的核心内容。');
    await page.locator('#chat-input').press('Enter');
    const chatReply = await waitFor(async () => {
      const text = await assistantBubbleTextLocator(page).innerText().catch(() => '');
      return text && text.trim().length > 20 && !/思考中/.test(text) ? text : null;
    }, 180000, 2500, 'wait for chat reply');
    await page.screenshot({ path: chatShot, fullPage: true });

    const result = {
      ok: true,
      browserState: 'in-class',
      firstCaptureId,
      analyzedTitle: analyzedCapture.title || '',
      analyzedCategory: analyzedCapture.categoryName || '',
      deepThinkCompleted,
      deepThinkLength: deepThought ? (deepThought.deepThinkMarkdown || '').length : 0,
      notesAiLength: aiContentReady.length,
      chatReplyLength: chatReply.length,
      screenshots: {
        analysisShot,
        deepThinkShot,
        notesShot,
        chatShot
      }
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {
      ok: false,
      error: error.message,
      screenshots: {
        analysisShot,
        deepThinkShot,
        notesShot,
        chatShot
      }
    };
    try {
      if (page) {
        await page.screenshot({ path: analysisShot, fullPage: true });
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
