let chromium;

export class MonitorService {
  constructor(config, state, capturePipeline) {
    this.config = config;
    this.state = state;
    this.capturePipeline = capturePipeline;
    this.context = null;
    this.primaryPage = null;
    this.scanTimer = null;
    this.visibleUrls = new Set();
    this.captureReady = false;
    this.inClassroom = false;
  }

  isRunning() {
    return !!this.context;
  }

  async start(customUrl) {
    if (!chromium) {
      try {
        const pw = await import('playwright');
        chromium = pw.chromium;
      } catch {
        throw new Error('Playwright 未安装，请运行 npx playwright install chromium');
      }
    }
    this.context = await chromium.launchPersistentContext(this.config.browserDataDir, {
      headless: this.config.browserHeadless,
      viewport: { width: 1440, height: 960 }
    });

    this.attachContextListeners();
    this.primaryPage = this.context.pages()[0] || (await this.context.newPage());
    this.attachPageListeners(this.primaryPage);

    const targetUrl = customUrl || this.config.yuketangUrl;
    await this.primaryPage.goto(targetUrl, {
      waitUntil: 'domcontentloaded'
    });

    const initialTitle = await this.primaryPage.title().catch(() => '');
    this.updateBrowserStatus(initialTitle, this.primaryPage.url());
    this.state.addLog('已启动雨课堂浏览器，请在打开的 Chromium 窗口中完成登录。');

    this.scanTimer = setInterval(() => {
      void this.scanVisibleImages();
    }, this.config.pollIntervalMs);

    await this.scanVisibleImages();
  }

  async stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }

  attachContextListeners() {
    this.context.on('page', (page) => {
      this.attachPageListeners(page);
    });
    this.context.on('response', (response) => {
      void this.handleResponse(response);
    });
  }

  attachPageListeners(page) {
    page.on('load', async () => {
      const title = await page.title().catch(() => '');
      this.updateBrowserStatus(title, page.url());
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        void page.title().catch(() => '').then((title) => {
          this.updateBrowserStatus(title, frame.url());
        });
      }
    });
  }

  async handleResponse(response) {
    if (!this.captureReady) return;

    const request = response.request();
    if (request.resourceType() !== 'image') return;

    const url = response.url();
    if (!this.isTrackableUrl(url)) return;
    if (!this.isLikelySlideImage(url)) return;

    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    if (!contentType.startsWith('image/')) return;

    const buffer = await response.body().catch(() => null);
    if (!buffer) return;

    await this.capturePipeline.submit({
      url, source: 'network', buffer, contentType,
      inClass: this.inClassroom
    });
  }

  async scanVisibleImages() {
    if (!this.primaryPage || this.primaryPage.isClosed()) return;

    try {
      const title = await this.primaryPage.title().catch(() => '');
      this.updateBrowserStatus(title, this.primaryPage.url(), {
        lastVisibleScanAt: new Date().toISOString()
      });

      if (!this.captureReady) return;

      const visibleImages = await this.primaryPage.evaluate(() => {
        function isVisible(element) {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return (
            rect.width > 40 &&
            rect.height > 40 &&
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity || '1') > 0
          );
        }

        return Array.from(document.images)
          .map((image) => ({
            url: image.currentSrc || image.src,
            displayedArea: image.clientWidth * image.clientHeight
          }))
          .filter((image) => image.url && image.url.startsWith('http') && image.displayedArea > 10000)
          .filter((image) => {
            const domImage = Array.from(document.images).find(
              (item) => (item.currentSrc || item.src) === image.url
            );
            return domImage ? isVisible(domImage) : false;
          })
          .sort((left, right) => right.displayedArea - left.displayedArea)
          .slice(0, 8);
      });

      const currentUrls = new Set(visibleImages.map(i => i.url));
      this.visibleUrls = currentUrls;

      for (const image of visibleImages) {
        await this.fetchVisibleImage(image.url);
      }
    } catch (error) {
      this.state.addLog(`扫描页面图片时出错: ${error.message}`, 'warn');
    }
  }

  async triggerManualCapture(mode) {
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      throw new Error('浏览器未就绪');
    }

    const visibleImages = await this.primaryPage.evaluate(() => {
      return Array.from(document.images)
        .map((image) => ({
          url: image.currentSrc || image.src,
          displayedArea: image.clientWidth * image.clientHeight
        }))
        .filter((image) => image.url && image.url.startsWith('http') && image.displayedArea > 10000)
        .sort((left, right) => right.displayedArea - left.displayedArea)
        .slice(0, 3);
    });

    for (const image of visibleImages) {
      await this.fetchVisibleImage(image.url, mode || true);
    }
  }

  async fetchVisibleImage(url, forceAnalyze = false) {
    if (!this.context) return false;

    const response = await this.context.request.get(url, {
      failOnStatusCode: false,
      timeout: 15000
    });

    if (!response.ok()) return false;

    const responseHeaders = response.headers();
    const contentType = responseHeaders['content-type'] || 'image/png';
    const buffer = await response.body();

    await this.capturePipeline.submit({
      url,
      source: 'visible',
      buffer,
      contentType,
      forceAnalyze
    });

    return true;
  }

  async submitAnswer({ captureId, answerType, answers }) {
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      throw new Error('浏览器未就绪');
    }

    try {
      if (answerType === 'choice') {
        await this.primaryPage.evaluate((selectedKeys) => {
          const options = document.querySelectorAll('.option-item, .tm-option, [class*="option"]');
          options.forEach((option) => {
            const keyEl = option.querySelector('.option-key, .key, [class*="key"]');
            const key = keyEl?.textContent?.trim();
            if (key && selectedKeys.includes(key)) {
              option.click();
            }
          });
        }, answers);

        await this.primaryPage.waitForTimeout(500);

        await this.primaryPage.evaluate(() => {
          const submitBtn = document.querySelector(
            'button[class*="submit"], .submit-btn, [class*="Submit"], button:has-text("提交")'
          );
          if (submitBtn) submitBtn.click();
        });
      } else if (answerType === 'fill') {
        await this.primaryPage.evaluate((fillAnswers) => {
          const inputs = document.querySelectorAll(
            'input[class*="blank"], input[class*="fill"], textarea[class*="answer"], .blank-input input'
          );
          fillAnswers.forEach((answer, index) => {
            if (inputs[index]) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set;
              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(inputs[index], answer);
              } else {
                inputs[index].value = answer;
              }
              inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
              inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
        }, answers);

        await this.primaryPage.waitForTimeout(500);

        await this.primaryPage.evaluate(() => {
          const submitBtn = document.querySelector(
            'button[class*="submit"], .submit-btn, [class*="Submit"]'
          );
          if (submitBtn) submitBtn.click();
        });
      } else if (answerType === 'subjective') {
        await this.primaryPage.evaluate((text) => {
          const textarea = document.querySelector(
            'textarea[class*="answer"], textarea[class*="input"], .answer-area textarea'
          );
          if (textarea) {
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, answers[0] || '');

        await this.primaryPage.waitForTimeout(500);

        await this.primaryPage.evaluate(() => {
          const submitBtn = document.querySelector(
            'button[class*="submit"], .submit-btn, [class*="Submit"]'
          );
          if (submitBtn) submitBtn.click();
        });
      }

      this.state.addLog(`已尝试提交答案到雨课堂（类型: ${answerType}）`);
    } catch (error) {
      this.state.addLog(`提交答案失败: ${error.message}`, 'error');
      throw error;
    }
  }

  async relogin() {
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      throw new Error('浏览器未就绪');
    }
    await this.context.clearCookies();
    await this.primaryPage.goto(this.config.yuketangUrl, { waitUntil: 'domcontentloaded' });
    this.captureReady = false;
    this.inClassroom = false;
    this.state.setStatus({ browserState: 'waiting-login' });
    this.state.addLog('已清除登录状态，请重新登录雨课堂。');
  }

  async navigate(url) {
    if (!this.primaryPage || this.primaryPage.isClosed()) {
      throw new Error('浏览器未就绪');
    }
    await this.primaryPage.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await this.primaryPage.title().catch(() => '');
    this.updateBrowserStatus(title, url);
    this.state.addLog(`已导航到：${url}`);
  }

  isTrackableUrl(url) {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  isClassroomPage(url, title) {
    if (!url) return false;
    const classPatterns = [
      /\/lesson\//, /\/classroom\//, /\/presentation\//,
      /\/pro\/lms\/.*\/studycontent/,
      /\/v2\/web\/index/,
      /problemset/, /quiz/, /exercise/
    ];
    const titlePatterns = [/课堂/, /课件/, /直播/, /互动/, /答题/, /签到/];
    return classPatterns.some(p => p.test(url)) ||
           titlePatterns.some(p => p.test(title || ''));
  }

  isLikelySlideImage(url) {
    if (!url) return false;
    const ignorePatterns = [
      /avatar/, /icon/, /logo/, /badge/, /emoji/,
      /banner/, /thumbnail.*user/, /profile/,
      /\.svg$/i, /favicon/, /\.gif$/i,
      /button/, /arrow/, /spinner/, /loading/, /placeholder/
    ];
    if (ignorePatterns.some(p => p.test(url))) return false;
    if (/yuketang\.cn/i.test(url)) {
      return /\/slide\//i.test(url);
    }
    return true;
  }

  updateBrowserStatus(title, url, extra = {}) {
    const waitingLogin = title.includes('登录');
    const inClass = this.isClassroomPage(url, title);
    this.captureReady = !waitingLogin;
    this.inClassroom = inClass;
    this.state.setStatus({
      browserState: this.captureReady ? (inClass ? 'in-class' : 'running') : 'waiting-login',
      currentPageTitle: title,
      currentPageUrl: url,
      inClassroom: inClass,
      ...extra
    });
  }
}
