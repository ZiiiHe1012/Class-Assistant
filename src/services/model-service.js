import OpenAI from 'openai';

const CATEGORY_NAMES = {
  1: '课件内容',
  2: '选择题',
  3: '填空题',
  4: '主观题',
  5: '非课程内容'
};

const SYSTEM_PROMPT = [
  '你是课堂解析助手。收到课堂图片后分类并输出结构化 JSON。',
  '分类：1 课件内容，2 选择题，3 填空题，4 主观题，5 非课程内容。',
  '只返回 JSON 对象，禁止 Markdown 代码块。',
  '',
  '顶层字段：{"categoryId":1,"categoryName":"课件内容","confidence":0.9,"reason":"","title":"","ocrText":"","renderedMarkdown":"","payload":{}}',
  '',
  '规则：',
  '- 不要使用 emoji 或网络用语',
  '- 语言正式、简洁、学术化',
  '- ocrText：原样提取图片中所有可见文字（保留原始语言、换行和顺序，不翻译不总结）',
  '- 课件内容：提炼要点，给出理解辅助而非复述原文',
  '- renderedMarkdown 使用简洁的 Markdown，用二级标题分节',
  '- 数学公式必须使用 LaTeX 表示：行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹',
  '- 准确识别并还原图片中的数学符号、公式、矩阵、方程组等',
  '',
  'payload 格式：',
  'A. 课件(1)：{ summary(一句话总结), keyPoints(要点数组), tips(学习建议数组) }',
  'B. 选择题(2)：{ questionStem, options([{key,text,isAnswer}]), answers([]), explanation, knowledgePoints }',
  'C. 填空题(3)：{ questionStem, blanks([{index,answer}]), explanation, knowledgePoints }',
  'D. 主观题(4)：{ questionStem, sampleAnswer, keyPoints([]), explanation, knowledgePoints }',
  'E. 非课程(5)：所有字段置空'
].join('\n');

const SYSTEM_PROMPT_DEEP = [
  '你是课堂深度解析助手。收到课堂图片后分类并输出结构化 JSON。',
  '分类：1 课件内容，2 选择题，3 填空题，4 主观题，5 非课程内容。',
  '只返回 JSON 对象，禁止 Markdown 代码块。',
  '',
  '顶层字段：{"categoryId":1,"categoryName":"课件内容","confidence":0.9,"reason":"","title":"","ocrText":"","renderedMarkdown":"","payload":{}}',
  '',
  '规则：',
  '- 不要使用 emoji 或网络用语',
  '- 语言正式、学术化，但内容要详尽深入',
  '- ocrText：原样提取图片中所有可见文字（保留原始语言、换行和顺序，不翻译不总结）',
  '- 课件内容：深入剖析每个知识点，给出详细解释、背景知识、与其他知识点的关联，而非简单提炼',
  '- renderedMarkdown 使用详细的 Markdown，用二级标题分节，每节内容要充实完整',
  '- 数学公式必须使用 LaTeX 表示：行内公式用 $...$ 包裹，独立公式用 $$...$$ 包裹',
  '- 准确识别并还原图片中的数学符号、公式、矩阵、方程组等',
  '- 对于每个要点，给出详细的解释说明，包括原理、推导过程、应用场景',
  '',
  'payload 格式：',
  'A. 课件(1)：{ summary(一句话总结), keyPoints(详细要点数组，每个要点包含充分的解释), tips(详细学习建议数组，包含具体方法和资源推荐) }',
  'B. 选择题(2)：{ questionStem, options([{key,text,isAnswer}]), answers([]), explanation(详细逐步解题过程，包含每个选项的分析和排除理由), knowledgePoints(涉及的所有知识点，附带简要说明) }',
  'C. 填空题(3)：{ questionStem, blanks([{index,answer}]), explanation(详细解题思路和推导过程), knowledgePoints(涉及的所有知识点，附带简要说明) }',
  'D. 主观题(4)：{ questionStem, sampleAnswer(完整详细的参考答案), keyPoints(详细的得分要点数组), explanation(详细解题思路、方法论和常见错误提醒), knowledgePoints(涉及的所有知识点，附带简要说明) }',
  'E. 非课程(5)：所有字段置空'
].join('\n');

const DEEP_THINK_PROMPT = [
  '你是学科专家。对以下课堂内容做深度分析。',
  '要求：正式学术语言，无 emoji，结构清晰。',
  '数学公式使用 LaTeX：行内 $...$ ，独立 $$...$$。',
  '输出 Markdown，包含：',
  '## 核心概念剖析',
  '## 推导与原理',
  '## 关联知识',
  '## 典型考题',
  '## 常见误区'
].join('\n');

const CHAT_SYSTEM_PROMPT = [
  '你是课堂助教。用简洁准确的语言回答学生问题。',
  '不使用 emoji 和网络用语。必要时用公式或代码辅助说明。',
  '数学公式使用 LaTeX：行内 $...$ ，独立 $$...$$。',
  '回答使用 Markdown 格式。'
].join('\n');


class RetryableAnalysisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryableAnalysisError';
    this.retryable = true;
  }
}

function extractJson(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new RetryableAnalysisError('模型返回中没有找到合法 JSON。');
  }
  let jsonStr = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    // Fix trailing commas before } or ]
    let fixed = jsonStr.replace(/,\s*([}\]])/g, '$1');
    // Fix double closing braces like ",}}" → "}}"
    fixed = fixed.replace(/,\s*}/g, '}');
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Try fixing unescaped newlines in string values
      try {
        const fixed2 = fixed.replace(/(?<=:\s*")([\s\S]*?)(?="(?:\s*[,}\]]))/g, (match) => {
          return match.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        });
        return JSON.parse(fixed2);
      } catch (e3) {
        try {
          return (new Function('return ' + fixed))();
        } catch (e4) {
          console.error('[extractJson] Failed to parse. First 500 chars:', jsonStr.slice(0, 500));
          throw new RetryableAnalysisError('模型返回的 JSON 无法解析。');
        }
      }
    }
  }
}

function asString(v) { return typeof v === 'string' ? v.trim() : ''; }
function asNumber(v, f = 0) { const n = Number(v); return Number.isFinite(n) ? n : f; }
function asStringArray(v) { return Array.isArray(v) ? v.map(i => asString(i)).filter(Boolean) : []; }

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, i) => {
    if (typeof item === 'string') return { key: String.fromCharCode(65+i), text: item.trim(), isAnswer: false };
    if (!item || typeof item !== 'object') return null;
    return { key: asString(item.key) || String.fromCharCode(65+i), text: asString(item.text), isAnswer: Boolean(item.isAnswer) };
  }).filter(item => item && item.text);
}

function normalizeBlanks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, i) => {
    if (typeof item === 'string') return { index: i+1, prompt: '', answer: item.trim() };
    if (!item || typeof item !== 'object') return null;
    return { index: asNumber(item.index, i+1), prompt: asString(item.prompt), answer: asString(item.answer) };
  }).filter(item => item && item.answer);
}

function normalizePayload(categoryId, rawPayload) {
  const p = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const answers = asStringArray(p.answers);
  const knowledgePoints = asStringArray(p.knowledgePoints);
  const options = normalizeOptions(p.options).map(o => ({
    ...o, isAnswer: o.isAnswer || answers.includes(o.key) || answers.includes(o.text)
  }));

  return {
    summary: asString(p.summary),
    keyPoints: asStringArray(p.keyPoints || p.coreConcepts),
    tips: asStringArray(p.tips || p.examTips),
    questionStem: asString(p.questionStem),
    options,
    blanks: normalizeBlanks(p.blanks),
    answers,
    knowledgePoints,
    explanation: asString(p.explanation),
    sampleAnswer: asString(p.sampleAnswer),
    keyPointsAnswer: asStringArray(p.keyPoints),
    difficulty: asNumber(p.difficulty, 3),
    rawCategory: categoryId
  };
}


function wrapModelError(error) {
  const message = error?.message || String(error);
  const retryable = error?.retryable ||
    /service_unavailable|timeout|timed out|temporar|overloaded|429|500|502|503|504|reset/i.test(message);
  return retryable ? new RetryableAnalysisError(`模型暂时不可用：${message}`) : new Error(message);
}

export class ModelService {
  constructor(config) {
    this.config = config;
    this.client = config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl || undefined })
      : null;
    this.clientFast = config.openaiApiKeyFast && config.openaiApiKeyFast !== config.openaiApiKey
      ? new OpenAI({ apiKey: config.openaiApiKeyFast, baseURL: config.openaiBaseUrl || undefined })
      : this.client;
    this.clientTranslate = (config.translateApiKey && config.translateBaseUrl && config.translateBaseUrl !== config.openaiBaseUrl)
      ? new OpenAI({ apiKey: config.translateApiKey, baseURL: config.translateBaseUrl })
      : this.client;
    this.overrideFast = '';
    this.overrideDeep = '';
    this.overrideTranslate = '';
    this.overrideChat = '';
    this._endpoints = [];
    this._modelEndpointMap = new Map();
  }

  setModels({ fast, deep, translate, chat }) {
    if (fast) this.overrideFast = fast;
    if (deep) this.overrideDeep = deep;
    if (translate) this.overrideTranslate = translate;
    if (chat) this.overrideChat = chat;
  }

  _clientForModel(modelId) {
    const ep = this._modelEndpointMap.get(modelId);
    if (!ep) return null;
    return new OpenAI({ apiKey: ep.key, baseURL: ep.url || undefined });
  }

  getModel(mode = 'fast') {
    if (mode === 'deep') return this.overrideDeep || this.config.openaiModelDeep || this.config.openaiModel;
    if (mode === 'translate') return this.overrideTranslate || this.config.translateModel || this.config.openaiModelFast || this.config.openaiModel;
    if (mode === 'chat') return this.overrideChat || this.overrideFast || this.config.openaiModelFast || this.config.openaiModel;
    return this.overrideFast || this.config.openaiModelFast || this.config.openaiModel;
  }

  getClient(mode = 'fast') {
    // Always try to find the right client for the actual model being used
    const model = this.getModel(mode);
    const mapped = this._clientForModel(model);
    if (mapped) return mapped;
    // Fallback to configured clients
    if (mode === 'deep') return this.client;
    if (mode === 'translate') return this.clientTranslate;
    if (mode === 'chat') return this.clientFast || this.client;
    return this.clientFast || this.client;
  }

  getCurrentModels() {
    return {
      fast: this.overrideFast || this.config.openaiModelFast || this.config.openaiModel,
      deep: this.overrideDeep || this.config.openaiModelDeep || this.config.openaiModel,
      translate: this.overrideTranslate || this.config.translateModel || this.config.openaiModelFast || this.config.openaiModel,
      chat: this.overrideChat || ''
    };
  }

  _getEndpoint(mode) {
    const model = this.getModel(mode);
    const ep = this._modelEndpointMap.get(model);
    if (ep) return { key: ep.key, url: ep.url };
    if (mode === 'translate' && this.config.translateApiKey && this.config.translateBaseUrl) {
      return { key: this.config.translateApiKey, url: this.config.translateBaseUrl };
    }
    return { key: this.config.openaiApiKey, url: this.config.openaiBaseUrl };
  }

  async _collectStream(streamOrPromise) {
    const stream = await streamOrPromise;
    let acc = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) acc += delta;
    }
    return acc;
  }

  async _rawStreamingVision({ model, messages, temperature = 0.1, max_tokens = 4096, mode = 'fast' }) {
    const ep = this._getEndpoint(mode);
    if (!ep.key) throw new Error('未配置 API Key');

    const baseUrl = (ep.url || 'https://api.openai.com/v1').replace(/\/$/, '');

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ep.key}`
      },
      body: JSON.stringify({ model, stream: true, temperature, max_tokens, messages })
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const errMsg = errBody.slice(0, 300);
      throw new Error(`${resp.status} ${errMsg}`);
    }

    let acc = '';
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) acc += delta;
        } catch {}
      }
    }

    return acc;
  }

  _buildVisionMessages(systemPrompt, imageUrl, userText) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: imageUrl },
        { type: 'text', text: userText }
      ]}
    ];
  }

  async analyzeImage({ imageUrl, mode = 'fast' }) {
    if (!imageUrl) throw new Error('无效图片');

    const isDeep = mode === 'deep';
    const systemPrompt = (isDeep ? SYSTEM_PROMPT_DEEP : SYSTEM_PROMPT) + '\n\n严格只返回 JSON 对象，不要任何其他文字。';
    const userText = isDeep ? '深入解析这张课堂图片，给出详尽分析，返回 JSON。' : '解析这张课堂图片，返回 JSON。';

    let text;
    try {
      text = await this._rawStreamingVision({
        model: this.getModel(mode),
        messages: this._buildVisionMessages(systemPrompt, imageUrl, userText),
        temperature: 0.1,
        max_tokens: isDeep ? 8192 : 4096,
        mode
      });
    } catch (error) { throw wrapModelError(error); }

    if (!text) throw new RetryableAnalysisError('模型没有返回内容');

    const parsed = extractJson(text);
    const categoryId = asNumber(parsed.categoryId, 0);
    const isIgnored = categoryId === 5;
    const payload = normalizePayload(categoryId, parsed.payload);
    const renderedMarkdown = isIgnored ? '' : asString(parsed.renderedMarkdown) || '';
    const ocrText = isIgnored ? '' : asString(parsed.ocrText) || '';

    return {
      categoryId,
      categoryName: CATEGORY_NAMES[categoryId] || '未识别',
      confidence: asNumber(parsed.confidence, 0),
      reason: isIgnored ? '' : asString(parsed.reason),
      title: isIgnored ? '' : asString(parsed.title) || '分析结果',
      payload,
      ocrText,
      renderedMarkdown,
      renderedHtml: ''
    };
  }

  async deepThink({ imageUrl, contextMarkdown }) {
    const userContent = [];
    if (contextMarkdown) userContent.push({ type: 'text', text: `基础解析：\n${contextMarkdown}\n\n请深入分析。` });
    if (imageUrl && (/^https?:\/\//i.test(imageUrl) || /^data:/i.test(imageUrl))) {
      userContent.push({ type: 'image_url', image_url: imageUrl });
    }
    if (!userContent.length) userContent.push({ type: 'text', text: '请深入分析课堂内容。' });

    const text = await this._rawStreamingVision({
      model: this.getModel('deep'),
      messages: [
        { role: 'system', content: DEEP_THINK_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0.3,
      max_tokens: 8192,
      mode: 'deep'
    });

    return text || '无法生成分析。';
  }

  async chat({ messages: chatHistory, imageUrl, contextMarkdown, background }) {
    const client = this.getClient('chat');
    if (!client) throw new Error('未配置 API Key');

    let sys = CHAT_SYSTEM_PROMPT;
    if (contextMarkdown) sys += `\n\n课件摘要：\n${contextMarkdown}`;
    if (background) sys += `\n\n补充信息：\n${background}`;

    return this._collectStream(client.chat.completions.create({
      model: this.getModel('chat'),
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: sys }, ...chatHistory]
    })) || '无法回答。';
  }

  chatStream({ messages: chatHistory, imageUrl, contextMarkdown, background, model }) {
    if (model) this.overrideChat = model;
    const client = this.getClient('chat');
    if (!client) throw new Error('未配置 API Key');

    let sys = CHAT_SYSTEM_PROMPT;
    if (contextMarkdown) sys += `\n\n课件摘要：\n${contextMarkdown}`;
    if (background) sys += `\n\n补充信息：\n${background}`;

    return client.chat.completions.create({
      model: this.getModel('chat'),
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: sys }, ...chatHistory]
    });
  }

  async translate({ text, targetLang = '中文', sourceLang = '' }) {
    const client = this.getClient('translate');
    if (!client) throw new Error('未配置翻译 API Key');

    const langHint = sourceLang ? `源语言：${sourceLang}，` : '';
    const systemPrompt = this._translateSystemPrompt(langHint, targetLang);

    const raw = await this._collectStream(client.chat.completions.create({
      model: this.getModel('translate'),
      temperature: 0.1,
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    }));

    const trimmed = (raw || '').trim();

    try {
      const cleaned = trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      return JSON.stringify(parsed);
    } catch {
      return JSON.stringify({
        type: 'sentence',
        original: text,
        translation: trimmed,
        vocabulary: []
      });
    }
  }

  translateStream({ text, targetLang = '中文', sourceLang = '' }) {
    const client = this.getClient('translate');
    if (!client) throw new Error('未配置翻译 API Key');

    const langHint = sourceLang ? `源语言：${sourceLang}，` : '';
    const systemPrompt = this._translateSystemPrompt(langHint, targetLang);

    return client.chat.completions.create({
      model: this.getModel('translate'),
      temperature: 0.1,
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    });
  }

  _translateSystemPrompt(langHint, targetLang) {
    return `你是一个专业的词典式翻译助手。${langHint}目标语言：${targetLang}。

请先判断用户输入是单个词/短语还是完整句子，然后按对应格式返回 **纯 JSON**（不要 markdown 代码块包裹）。

■ 如果是单个单词或短语，返回：
{
  "type": "word",
  "original": "原文",
  "phonetic": "音标或拼音提示（英文给音标，中文给拼音，其他语言给罗马音等）",
  "wordType": "词性，如 n. / v. / adj. / adv. / phrase 等",
  "meanings": [
    { "def": "义项1的${targetLang}释义", "example": "该义项的例句（原语言）" },
    { "def": "义项2的${targetLang}释义", "example": "该义项的例句（原语言）" }
  ],
  "translation": "最常用的${targetLang}翻译"
}

■ 如果是完整句子或段落，返回：
{
  "type": "sentence",
  "original": "原文",
  "translation": "完整的${targetLang}翻译",
  "vocabulary": [
    { "word": "句中关键词1", "meaning": "该词的${targetLang}释义" },
    { "word": "句中关键词2", "meaning": "该词的${targetLang}释义" }
  ]
}

注意：
- meanings 数组至少包含 1 项，最多 4 项，覆盖主要义项。
- vocabulary 挑选 2-5 个关键/难点词汇。
- 遇到专业术语请使用目标语言中该领域的通用译法。
- 只返回合法 JSON，不要附加任何解释文字。`;
  }

  async listModels(apiKey, baseUrl) {
    const client = new OpenAI({
      apiKey: apiKey || this.config.openaiApiKey,
      baseURL: baseUrl || this.config.openaiBaseUrl || undefined
    });
    const list = await client.models.list();
    const models = [];
    for await (const model of list) {
      models.push(model.id);
    }
    models.sort();
    return models;
  }

  async listAllModels() {
    const endpoints = [];
    if (this.config.openaiApiKey) {
      endpoints.push({ key: this.config.openaiApiKey, url: this.config.openaiBaseUrl, label: this._urlLabel(this.config.openaiBaseUrl) });
    }
    if (this.config.openaiApiKeyFast && this.config.openaiApiKeyFast !== this.config.openaiApiKey) {
      endpoints.push({ key: this.config.openaiApiKeyFast, url: this.config.openaiBaseUrl, label: this._urlLabel(this.config.openaiBaseUrl) + ' (fast)' });
    }
    if (this.config.translateApiKey && this.config.translateBaseUrl && this.config.translateBaseUrl !== this.config.openaiBaseUrl) {
      endpoints.push({ key: this.config.translateApiKey, url: this.config.translateBaseUrl, label: this._urlLabel(this.config.translateBaseUrl) });
    }

    this._endpoints = endpoints;
    const seen = new Set();
    const results = [];

    const fetches = endpoints.map(async (ep) => {
      if (!ep.key) return [];
      try {
        const models = await this.listModels(ep.key, ep.url);
        return models.map(m => ({ model: m, endpoint: ep }));
      } catch { return []; }
    });

    const allLists = await Promise.all(fetches);
    for (const list of allLists) {
      for (const item of list) {
        if (!seen.has(item.model)) {
          seen.add(item.model);
          results.push(item);
          this._modelEndpointMap.set(item.model, item.endpoint);
        }
      }
    }
    results.sort((a, b) => a.model.localeCompare(b.model));
    return results;
  }

  _urlLabel(url) {
    if (!url) return 'default';
    try {
      return new URL(url).hostname.replace(/^api\./, '').replace(/\.(com|vip|cn|io)$/, '');
    } catch { return url; }
  }
}
