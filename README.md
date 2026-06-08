# 智慧课堂（Class Assistant）

> 面向在线课堂的 AI 学习助手：实时课件捕获、智能解析、RAG 增强问答、笔记系统与 Electron 桌面交互一体化。

![Node.js](https://img.shields.io/badge/Node.js-18+-green)
![Electron](https://img.shields.io/badge/Electron-33-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 快速开始

### 桌面应用模式（推荐）

```bash
git clone -b final https://github.com/ZiiiHe1012/Class-Assistant.git
cd Class-Assistant
npm install
npm run build
```

打包完成后运行 `dist/win-unpacked/智慧课堂.exe`。

开发模式直接启动：

```bash
npm run electron
```

### Web 面板模式

```bash
npm install
npx playwright install chromium
npm start
```

浏览器访问 `http://127.0.0.1:3000`。

---

## 核心能力

| 功能 | 说明 |
|:---|:---|
| 实时课件捕获 | 监听雨课堂页面中的真实课件内容，自动去重、入队、分析 |
| AI 智能解析 | 识别课件内容 / 选择题 / 填空题 / 主观题，输出结构化结果 |
| 深度思考 | 对当前课件生成更细致的知识点、原理和考点分析 |
| 统一 RAG 上下文 | 解析、深度思考、AI 笔记、AI 对话统一检索当前课件、相邻课件与历史笔记 |
| AI 对话 | 基于当前课件与检索上下文进行追问、总结、答疑 |
| 笔记系统 | 手写笔记、AI 笔记、标签、导出、自动保存 |
| GUI Agent 自动答题 | 保持原有“真实雨课堂题目”执行链，不改识别原理 |

---

## 本次修复与增强

### 笔记系统

| 改动 | 结果 |
|:---|:---|
| 笔记预览状态修复 | 在切换课件后仍保持当前“预览 / 编辑”状态，不再异常跳回 |
| 待保存内容兜底 | 课件切换前会先提交挂起的手写笔记内容，避免输入丢失 |
| AI 笔记区域可拖拽 | 增加分隔条，支持拖动调整 AI 笔记卡片高度 |
| AI 笔记高度持久化 | 面板高度写入 `localStorage`，再次打开仍保留上次布局 |
| 流式请求兼容性修复 | `fetchStream` 支持无 body 请求，避免 Electron 界面流式调用异常 |

### 统一 RAG

以下能力已接入同一套轻量级课堂 RAG：

- 课件解析
- 深度思考
- AI 生成笔记
- AI 对话

RAG 默认优先检索：

- 当前课件的分析结果、OCR、深度思考结果
- 当前课件已有的手写笔记与 AI 笔记
- 当前课件前后若干张相邻课件
- 近期历史课件与历史笔记

设计原则：

- 当前图片优先于检索内容
- 检索只做补充，不覆盖当前课件结论
- AI 笔记尽量复用已有笔记，减少重复生成

---

## GUI Agent 说明

这次改动没有改变 GUI Agent 的原有答题原理。

保留的真实链路是：

`课堂捕获 -> 题目结构化解析 -> 生成答案 -> Monitor / BrowserView 在真实雨课堂页面执行提交`

这次仅在以下位置做了笔记和 RAG 相关增强：

- `public/app.js`
- `public/index.html`
- `src/server.js`
- `src/services/capture-pipeline.js`
- `src/services/model-service.js`
- `src/services/notes-service.js`
- `src/services/rag-service.js`

没有把 GUI Agent 改成“本地假题页识别”方案，也没有替换其真实雨课堂提交逻辑。

---

## 自动化验证

### 检查命令

```bash
npm run check
npm run smoke:notes-ui
npm run smoke:main-flow
npm run smoke:gui-rerun
npm run report:build
```

### 脚本说明

| 命令 | 用途 |
|:---|:---|
| `npm run smoke:notes-ui` | 验证笔记预览切换稳定性与 AI 笔记拖拽高度 |
| `npm run smoke:main-flow` | 重跑“在线课堂捕获 -> 解析 -> 笔记 -> 对话”主流程 |
| `npm run smoke:gui-rerun` | 重跑 Electron 内嵌雨课堂 + AI 生成笔记主流程 |
| `npm run report:build` | 用 XeLaTeX 编译汇报 PDF |

---

## 项目结构

```text
electron/
  main.js                  Electron 主进程，负责 BrowserView 与 GUI Agent 轮询
  preload.js               前端 IPC 桥接
  launch.js                Electron 开发启动器
src/
  server.js                Express API、SSE、状态与 RAG 接线
  app-state.js             全局状态
  config.js                配置加载
  services/
    capture-pipeline.js    课件捕获、去重、分析队列
    gui-agent-service.js   GUI Agent 决策与指令编排
    model-service.js       模型调用、流式输出、提示词
    monitor-service.js     Playwright 监控与真实页面提交
    notes-service.js       笔记 CRUD 与 AI 笔记生成
    ocr-service.js         OCR
    rag-service.js         课堂上下文检索与拼接
public/
  index.html               主界面
  app.js                   前端交互逻辑
scripts/
  e2e/                     主流程验证脚本
docs/
  report/                  汇报 PDF 输出目录
slides.tex                 LaTeX 汇报稿
```

---

## 说明

- 本项目仅用于课堂学习辅助。
- `.env` 不会提交到仓库。
- 登录状态保存在 `data/browser/`。
- 笔记按课件图片 SHA-1 哈希持久化到 `data/notes/`。

## License

MIT
