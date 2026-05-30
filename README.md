# 智慧课堂 (Class Assistant)

> 基于 AI 的课堂学习助手 — 实时课件捕获解析 + 离线文档分析 + 翻译词典 + 智能对话

![Node.js](https://img.shields.io/badge/Node.js-18+-green) ![Electron](https://img.shields.io/badge/Electron-33-blue) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## 一分钟上手

> **已内置 API 配置，克隆后直接可用，无需任何额外设置。**

### 方式一：桌面应用（推荐）

```bash
git clone https://github.com/Yangxixi2023/Class-assistent.git
cd Class-assistent
npm install
npm run build                       # 打包 Electron 应用
```

打包完成后在 `dist/win-unpacked/智慧课堂.exe` 双击运行。

或直接开发模式运行：
```bash
npm run electron                    # 启动 Electron 桌面应用
```

### 方式二：命令行（Web 面板模式）

```bash
npm install
npx playwright install chromium     # 仅 CLI 在线模式需要
npm start                           # 启动 Web 服务
```

浏览器访问 `http://127.0.0.1:3000` 使用。

---

## 双模式工作

### 实时模式（在线）

雨课堂网页**直接嵌入应用窗口内**，左侧浏览课件，右侧实时显示 AI 解析结果。

| 步骤 | 说明 |
|:---|:---|
| 启动后选择「实时模式」 | 窗口左侧加载雨课堂页面 |
| 在左侧页面中登录雨课堂 | 登录状态自动保持 |
| 正常上课 | 程序自动捕获课件图片、识别题目、生成解析 |

**控制栏功能**：雨课堂/课件视图切换、新窗口打开、课堂链接输入+跳转、重新登录、停止监听。

### 离线模式

上传 PDF 或图片，AI 解析与翻译。

| 步骤 | 说明 |
|:---|:---|
| 启动后选择「离线模式」 | 进入文件浏览界面 |
| 拖放文件或点击上传 | 支持 PDF、PNG、JPG、WebP |
| PDF 文档可翻页浏览 | 支持自定义缩放比例 |
| 点击「解析」分析页面 | 快速/深度两种模式 |

---

## 功能概览

| 功能 | 说明 |
|:---|:---|
| **实时课件捕获** | 自动监控雨课堂页面，捕获课件图片 |
| **AI 智能解析** | 识别课件类型（内容讲解 / 选择题 / 填空题 / 主观题），给出结构化分析 |
| **快速 / 深度模式** | 快速模式秒出结果，深度模式使用专用提示词更准确详细 |
| **答题辅助** | 选择题高亮正确选项、填空题/主观题给出参考答案 |
| **深度思考** | 对课件做知识点剖析、推导原理、典型考题分析 |
| **AI 对话** | 针对当前课件内容自由提问，支持粘贴图片、上传附件，流式输出实时显示 |
| **对话模型切换** | 在对话窗口直接切换模型（快速/深度/任意可用模型） |
| **背景信息管理** | 模块化背景信息芯片，支持导入课件解析、手动添加、单条删除 |
| **划词翻译** | 选中任意文本弹出工具栏，一键翻译 / 解释 / 提问，流式输出 |
| **词典式翻译** | 单词显示音标、词性、多义项、例句；句子显示完整翻译+关键词 |
| **翻译窗口固定** | 固定翻译窗口后，新翻译内容直接更新到已固定窗口（不弹新窗） |
| **PDF 阅读器** | 离线模式内置 PDF 渲染，支持翻页、缩放、HiDPI |
| **模型切换** | 支持多 API Key / 多模型，在线切换解析和翻译模型 |
| **队列管理** | 底部缩略图队列支持隐藏/展开、单条删除、双击全屏查看 |
| **自适应布局** | 拖拽调整比例、面板最小化、布局互换 |
| **哈希去重** | 翻页回看自动匹配已解析内容，不重复消耗额度 |

---

## 界面操作

| 操作 | 说明 |
|:---|:---|
| 顶部 **快速 / 深度** 按钮 | 切换解析模式 |
| **模型名称** 按钮 | 点击切换 AI 模型 |
| **钥匙图标** | 查看当前 API 配置（脱敏显示） |
| **自动** 开关 | 新课件是否自动分析 |
| **跟随** 开关 | 是否自动跳到最新课件 |
| **划词** 开关 | 启用/禁用划词翻译工具栏 |
| **解析** 按钮 | 手动触发当前页面解析 |
| **导入对话** 按钮 | 将解析结果导入对话背景信息（模块化芯片） |
| **⇆** 按钮 | 课件区和解析区主次互换 |
| **Ctrl+Shift+S** | 截图到对话 |
| **Ctrl+V** 在聊天框 | 粘贴图片发送 |
| 滚轮滚动 | 翻页切换课件 / PDF |
| 拖拽文件到窗口 | 离线模式快速导入 |

### 实时模式专属控制

| 操作 | 说明 |
|:---|:---|
| **雨课堂** 按钮 | 显示/重新打开雨课堂实时页面（关闭后可再次打开） |
| **课件** 按钮 | 切换到已捕获的课件幻灯片视图（隐藏雨课堂） |
| **独立窗口** 按钮 | 在独立 Electron 窗口中打开雨课堂（保留登录状态），应用内切回课件视图 |
| **✕ 关闭** 按钮 | 关闭雨课堂嵌入视图，停止捕获 |
| **课堂链接** 输入框 | 输入自定义雨课堂链接并跳转 |
| **跳转** 按钮 | 导航到输入的课堂链接 |
| **重新登录** 按钮 | 彻底清除登录状态（cookies/缓存/存储），重新显示登录页 |
| **停止监听** 按钮 | 关闭浏览器监听，停止课件捕获 |

---

## 自定义配置（可选）

默认配置已经可以直接使用。如果你想用自己的 API：

### 方法 1：在面板中修改

点击右上角 ⚙️ 设置 → 填入你的接口地址、密钥、模型 → 保存 → 重启

### 方法 2：编辑配置文件

复制 `.env.example` 为 `.env`，修改其中的值：

```env
# 接口地址（中转站填完整路径含 /v1）
OPENAI_BASE_URL=https://api.nuoda.vip/v1

# 密钥
OPENAI_API_KEY=sk-your-key-here
OPENAI_API_KEY_FAST=sk-your-fast-key-here    # 可选，留空则用主密钥

# 模型
OPENAI_MODEL=claude-sonnet-4-6               # 默认模型
OPENAI_MODEL_FAST=claude-haiku-4-5-20251001  # 快速模式
OPENAI_MODEL_DEEP=claude-sonnet-4-6          # 深度模式

# 翻译（独立配置）
TRANSLATE_API_KEY=sk-your-translate-key
TRANSLATE_BASE_URL=https://api.deepseek.com
TRANSLATE_MODEL=deepseek-v4-flash
```

> `.env` 文件不会被上传到 GitHub。如果没有 `.env`，程序自动使用内置的 `.env.default`。

### 支持的模型

通过 OpenAI 兼容接口调用，支持任意模型：
- **Claude**: `claude-haiku-4-5-20251001`、`claude-sonnet-4-6`、`claude-opus-4-6` 等
- **GPT**: `gpt-4o-mini`、`gpt-5.2`、`gpt-5.4` 等
- **DeepSeek**: `deepseek-v4-flash` 等
- 其他 OpenAI API 兼容的模型

---

## 打包为桌面应用

```bash
npm run build       # 使用 electron-builder 打包
```

打包产物在 `dist/win-unpacked/` 目录，`智慧课堂.exe` 为主程序。

> 桌面应用内嵌浏览器，在线模式不需要安装 Playwright。CLI 模式（`npm start`）在线功能需要 Playwright。

---

## 常见问题

<details>
<summary><b>Q: 启动后浏览器没弹出来？</b></summary>

检查终端输出是否有 Playwright 相关错误。运行 `npx playwright install chromium` 重新安装浏览器。
</details>

<details>
<summary><b>Q: 解析失败 / 报错 500？</b></summary>

通常是 API Key 对某个模型没有权限。在设置中切换到有权限的模型，或更换 Key。
</details>

<details>
<summary><b>Q: 怎么只用面板不开浏览器？</b></summary>

选择「离线模式」，或在 `.env` 中设置 `DISABLE_BROWSER_MONITOR=true`。
</details>

<details>
<summary><b>Q: 下次启动还要重新登录吗？</b></summary>

不需要。浏览器登录状态保存在 `data/browser/` 目录，会自动保持。
</details>

<details>
<summary><b>Q: 如何连接自定义课堂链接？</b></summary>

实时模式下，顶部控制栏有「课堂链接」输入框，输入链接后点击「跳转」即可。
</details>

---

## 项目结构

```
├── electron/
│   ├── main.js                # Electron 主进程（BrowserView 管理 + 图片捕获）
│   ├── preload.js             # 预加载脚本（IPC 桥接）
│   └── launch.js              # 开发模式启动器
├── .env.default               # 内置默认配置
├── src/
│   ├── server.js              # Express + SSE + API 路由
│   ├── config.js              # 配置加载（.env → .env.default 回退）
│   ├── app-state.js           # 全局状态 + 实时广播
│   └── services/
│       ├── model-service.js       # AI 调用（多 key / 多模型 / 翻译）
│       ├── capture-pipeline.js    # 图片去重 + 分析队列 + 自动重试
│       └── monitor-service.js     # Playwright 监控（仅 CLI 模式）
├── public/
│   ├── index.html             # 面板 UI（CSS + HTML）
│   ├── app.js                 # 前端交互逻辑
│   └── assets/                # 图标、插画素材
└── data/
    ├── captures/              # 捕获的课件图片
    └── browser/               # 浏览器持久化数据
```

## 开发

```bash
npm run dev          # 文件变动自动重启服务
npm run electron     # 以 Electron 桌面应用模式启动
npm run build        # 打包为可分发的 exe
```

## 注意事项

- 本工具**仅供辅助学习**，请勿在考试中使用
- API Key 仅保存在本地，不会上传到任何服务器
- 浏览器数据保存在 `data/browser/`，支持登录状态持久化

## License

MIT
