# RainClassroom AI Assistant（Chrome 插件）

在雨课堂页面点击插件图标后，自动采集页面图片并调用 OpenAI 兼容 API：

- 自动分类：`题目` / `PPT讲解`
- 题目：返回答案 + 解析
- PPT讲解：返回详细讲解
- 页面内展示：**可拖拽悬浮栏**（可折叠、可保存配置、可查看结果）

---

## 1. 项目结构

```text
.
├─ manifest.json
└─ src
   ├─ background.js    # 插件点击事件、AI 接口请求
   ├─ content.js       # 悬浮栏 UI、图片采集、结果渲染
   ├─ styles.css       # 悬浮栏样式
   └─ utils
      └─ openai.js     # 预留的 OpenAI 工具函数（可扩展）
```

---

## 2. 本地安装（开发者模式）

1. 打开 Chrome，进入 `chrome://extensions/`
2. 右上角开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前项目根目录（包含 `manifest.json` 的目录）

---

## 3. 使用方法

1. 打开雨课堂相关页面（如 `*.yuketang.cn`）
2. 点击浏览器工具栏中的扩展图标
3. 页面右侧会出现悬浮栏
4. 在悬浮栏填写并保存：
   - `API Base URL`（如 `https://api.openai.com/v1` 或你的兼容网关）
   - `Model`（如 `gpt-4o-mini`）
5. 点击“立即分析”（或再次点击插件图标）
6. 插件会进入持续监听模式：后续新出现的图片会自动加入分析队列

---

## 4. 关键能力说明

### 4.1 图片采集（“抓图”）

插件当前采用两路候选图来源，并持续轮询 + 监听页面变化：

1. 页面可见 `<img>` 元素（优先）
2. `performance.getEntriesByType('resource')` 中疑似图片资源

持续监听机制：

- `MutationObserver` 监听 DOM 中新增/更新图片
- 每 3 秒做一次补充扫描，防止漏采样

> 说明：浏览器扩展受安全限制，无法像代理软件那样完整抓取所有 HTTPS 包。该方案是页面内可用的“抓图近似实现”。

### 4.2 AI 输入

- 优先把图片 URL 拉取为 DataURL（带 cookie 尝试）再送给 AI
- 若转换失败，回退为直接传 URL

### 4.3 输出格式

AI 被要求输出 JSON：

```json
{
  "type": "question|ppt",
  "title": "一句话概述",
  "answer": "题目时给出",
  "explanation": "详细讲解",
  "confidence": 0.9
}
```

---

## 5. 配置与安全建议

- API Key 保存在 `chrome.storage.local`（本机本浏览器）
- 仅建议个人学习场景使用
- 如果你后续要多人共享，建议改成后端中转，避免在前端暴露密钥

---

## 6. 已知限制

1. 若页面用 Canvas 绘制题目，可能抓不到原图（可后续增加区域截图）
2. 跨域图片可能无法转 DataURL，会回退 URL 发送
3. AI 分类/解析依赖模型能力与图片清晰度

---

## 7. 后续可扩展方向

- 支持批量任务历史记录
- 增加“仅分析当前可见区域”
- 支持侧边栏（Chrome Side Panel）
- 加入 OCR 预处理，提升题目识别率