import OpenAI from 'openai';

const CATEGORY_NAMES = {
  1: '课件内容',
  2: '选择题',
  3: '填空题',
  4: '主观题',
  5: '非课程内容'
};

const SYSTEM_PROMPT = [
  '你是课堂课件分析助手。收到课件图片后，请先识别类型，再输出结构化 JSON。',
  '分类规则：1 课件内容，2 选择题，3 填空题，4 主观题，5 非课程内容。',
  '只返回 JSON 对象，不要返回 Markdown 代码块。',
  '',
  '顶层字段：{"categoryId":1,"categoryName":"课件内容","confidence":0.9,"reason":"","title":"","ocrText":"","renderedMarkdown":"","payload":{}}',
  '',
  '要求：',
  '- 语言正式、简洁，不使用 emoji。',
  '- ocrText 需要尽量保留图片中原始文字顺序，不翻译，不总结。',
  '- renderedMarkdown 需要给出易读的结构化说明。',
  '- 数学公式必须使用 LaTeX：行内 $...$，独立公式 $$...$$。',
  '- 如果检索上下文与当前图片冲突，以当前图片为准。',
  '',
  'payload 模式：',
  'A. 课件内容：{ summary, keyPoints[], tips[] }',
  'B. 选择题：{ questionStem, options[{key,text,isAnswer}], answers[], explanation, knowledgePoints[] }',
  'C. 填空题：{ questionStem, blanks[{index,prompt,answer}], explanation, knowledgePoints[] }',
  'D. 主观题：{ questionStem, sampleAnswer, keyPoints[], explanation, knowledgePoints[] }',
  'E. 非课程内容：payload 置空'
].join('\n');

const SYSTEM_PROMPT_DEEP = [
  '你是课堂深度分析助手。请结合当前课件图片与检索上下文，输出结构化 JSON。',
  '分类规则与普通分析一致：1 课件内容，2 选择题，3 填空题，4 主观题，5 非课程内容。',
  '只返回 JSON 对象，不要返回 Markdown 代码块。',
  '',
  '要求：',
  '- 内容比快速分析更深入，强调原理、关联知识、易错点。',
  '- 如果上下文不一致，以当前图片为准，并在 reason 中说明。',
  '- renderedMarkdown 要更完整、更适合学习复盘。',
  '- 数学公式必须使用 LaTeX：行内 $...$，独立公式 $$...$$。'
].join('\n');

const DEEP_THINK_PROMPT = [
  '你是学科助教，请对当前课件做深度讲解。',
  '输出 Markdown，语言正式，不使用 emoji。',
  '如果提供了检索上下文，请把它当作辅助资料，而不是替代当前课件。',
  '建议包含：',
  '## 核心概念',
  '## 推导与原理',
  '## 关联知识',
  '## 典型考点',
  '## 常见误区'
].join('\n');

const CHAT_SYSTEM_PROMPT = [
  '你是课堂助教，请基于当前课件和检索到的相关上下文回答问题。',
  '优先引用当前课件证据，再使用检索上下文补充。',
  '语言准确、简洁，使用 Markdown。',
  '如有数学公式，用 LaTeX：行内 $...$，独立公式 $$...$$。'
].join('\n');

const NOTES_SYSTEM_PROMPT = [
  '你是课堂学习笔记整理助手。',
  '请基于当前课件、已有笔记、检索上下文生成结构清晰、适合复习的 Markdown 笔记。',
  '不要使用 emoji。',
  '尽量避免和已有笔记重复；若已有笔记缺结构，优先补全结构。',
  '建议包含：',
  '## 核心概念',
  '## 重要知识点',
  '## 记忆技巧',
  '## 可能考点'
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
    throw new RetryableAnalysisError('模型返回中没有找到有效 JSON。');
  }

  let jsonStr = candidate.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(jsonStr);
    } catch (error) {
      console.error('[extractJson] parse failed:', jsonStr.slice(0, 500));
      throw new RetryableAnalysisError(`模型返回 JSON 无法解析：${error.message}`);
    }
  }
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => asString(item)).filter(Boolean) : [];
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return {
        key: String.fromCharCode(65 + index),
        text: item.trim(),
        isAnswer: false
      };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      key: asString(item.key) || String.fromCharCode(65 + index),
      text: asString(item.text),
      isAnswer: Boolean(item.isAnswer)
    };
  }).filter((item) => item && item.text);
}

function normalizeBlanks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return { index: index + 1, prompt: '', answer: item.trim() };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      index: asNumber(item.index, index + 1),
      prompt: asString(item.prompt),
      answer: asString(item.answer)
    };
  }).filter((item) => item && item.answer);
}

function normalizePayload(categoryId, rawPayload) {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const answers = asStringArray(payload.answers);
  const options = normalizeOptions(payload.options).map((option) => ({
    ...option,
    isAnswer: option.isAnswer || answers.includes(option.key) || answers.includes(option.text)
  }));

  return {
    summary: asString(payload.summary),
    keyPoints: asStringArray(payload.keyPoints || payload.coreConcepts),
    tips: asStringArray(payload.tips || payload.examTips),
    questionStem: asString(payload.questionStem),
    options,
    blanks: normalizeBlanks(payload.blanks),
    answers,
    knowledgePoints: asStringArray(payload.knowledgePoints),
    explanation: asString(payload.explanation),
    sampleAnswer: asString(payload.sampleAnswer),
    keyPointsAnswer: asStringArray(payload.keyPoints),
    difficulty: asNumber(payload.difficulty, 3),
    rawCategory: categoryId
  };
}

function wrapModelError(error) {
  const message = error?.message || String(error);
  const retryable = error?.retryable ||
    /service_unavailable|timeout|timed out|temporar|overloaded|429|500|502|503|504|reset/i.test(message);
  return retryable ? new RetryableAnalysisError(`模型暂时不可用：${message}`) : new Error(message);
}

function appendSystemSections(base, sections) {
  return [base, ...sections.filter(Boolean)].join('\n\n');
}

function ensureVisionContent(userParts, imageUrl) {
  const content = [...userParts];
  if (imageUrl) {
    content.push({ type: 'image_url', image_url: imageUrl });
  }
  return content.length ? content : [{ type: 'text', text: '请根据当前内容进行分析。' }];
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
    const endpoint = this._modelEndpointMap.get(modelId);
    if (!endpoint) return null;
    return new OpenAI({ apiKey: endpoint.key, baseURL: endpoint.url || undefined });
  }

  getModel(mode = 'fast') {
    if (mode === 'deep') return this.overrideDeep || this.config.openaiModelDeep || this.config.openaiModel;
    if (mode === 'translate') return this.overrideTranslate || this.config.translateModel || this.config.openaiModelFast || this.config.openaiModel;
    if (mode === 'chat') return this.overrideChat || this.overrideFast || this.config.openaiModelFast || this.config.openaiModel;
    return this.overrideFast || this.config.openaiModelFast || this.config.openaiModel;
  }

  getClient(mode = 'fast') {
    const model = this.getModel(mode);
    const mapped = this._clientForModel(model);
    if (mapped) return mapped;
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
    const endpoint = this._modelEndpointMap.get(model);
    if (endpoint) return { key: endpoint.key, url: endpoint.url };
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

  async _rawStreamingVision({ model, messages, temperature = 0.1, max_tokens = 4096, mode = 'fast', onChunk }) {
    const endpoint = this._getEndpoint(mode);
    if (!endpoint.key) throw new Error('未配置 API Key');

    const baseUrl = (endpoint.url || 'https://api.openai.com/v1').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.key}`
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature,
        max_tokens,
        messages
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`${response.status} ${errBody.slice(0, 300)}`);
    }

    let acc = '';
    const reader = response.body.getReader();
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
          if (delta) {
            acc += delta;
            if (onChunk) onChunk(delta);
          }
        } catch {}
      }
    }

    return acc;
  }

  _buildVisionMessages(systemPrompt, imageUrl, userParts = []) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: ensureVisionContent(userParts, imageUrl) }
    ];
  }

  async analyzeImage({ imageUrl, mode = 'fast', ragMarkdown = '' }) {
    if (!imageUrl) throw new Error('无效图片');

    const isDeep = mode === 'deep';
    const systemPrompt = appendSystemSections(
      isDeep ? SYSTEM_PROMPT_DEEP : SYSTEM_PROMPT,
      [
        '严格只返回 JSON 对象，不要输出额外文字。',
        ragMarkdown ? '已附带检索上下文，请将其作为辅助证据使用。' : ''
      ]
    );

    const userParts = [
      { type: 'text', text: isDeep ? '请对这张课堂课件图片做深入分析，并返回 JSON。' : '请分析这张课堂课件图片，并返回 JSON。' },
      ...(ragMarkdown ? [{ type: 'text', text: ragMarkdown }] : [])
    ];

    let text;
    try {
      text = await this._rawStreamingVision({
        model: this.getModel(mode),
        messages: this._buildVisionMessages(systemPrompt, imageUrl, userParts),
        temperature: 0.1,
        max_tokens: isDeep ? 8192 : 4096,
        mode
      });
    } catch (error) {
      throw wrapModelError(error);
    }

    if (!text) throw new RetryableAnalysisError('模型没有返回内容');

    const parsed = extractJson(text);
    const categoryId = asNumber(parsed.categoryId, 0);
    const isIgnored = categoryId === 5;
    const payload = normalizePayload(categoryId, parsed.payload);

    return {
      categoryId,
      categoryName: CATEGORY_NAMES[categoryId] || '未识别',
      confidence: asNumber(parsed.confidence, 0),
      reason: isIgnored ? '' : asString(parsed.reason),
      title: isIgnored ? '' : asString(parsed.title) || '分析结果',
      payload,
      ocrText: isIgnored ? '' : asString(parsed.ocrText) || '',
      renderedMarkdown: isIgnored ? '' : asString(parsed.renderedMarkdown) || '',
      renderedHtml: ''
    };
  }

  async deepThink({ imageUrl, contextMarkdown, ragMarkdown = '' }) {
    const userParts = [];
    if (contextMarkdown) {
      userParts.push({ type: 'text', text: `基础分析：\n${contextMarkdown}\n\n请继续做深度讲解。` });
    }
    if (ragMarkdown) {
      userParts.push({ type: 'text', text: ragMarkdown });
    }
    if (!userParts.length) {
      userParts.push({ type: 'text', text: '请对当前课件做深度讲解。' });
    }

    const text = await this._rawStreamingVision({
      model: this.getModel('deep'),
      messages: this._buildVisionMessages(DEEP_THINK_PROMPT, imageUrl, userParts),
      temperature: 0.3,
      max_tokens: 8192,
      mode: 'deep'
    });

    return text || '无法生成深度分析。';
  }

  async generateNotes({ imageUrl, analysisMarkdown, noteMarkdown = '', ragMarkdown = '', onChunk }) {
    const userParts = [];
    if (analysisMarkdown) {
      userParts.push({ type: 'text', text: `当前课件分析：\n${analysisMarkdown}` });
    }
    if (noteMarkdown) {
      userParts.push({ type: 'text', text: `当前已有笔记：\n${noteMarkdown}` });
    }
    if (ragMarkdown) {
      userParts.push({ type: 'text', text: ragMarkdown });
    }
    userParts.push({ type: 'text', text: '请结合这些内容，生成一份结构清晰、去重后的学习笔记。' });

    return this._rawStreamingVision({
      model: this.getModel('fast'),
      messages: this._buildVisionMessages(NOTES_SYSTEM_PROMPT, imageUrl, userParts),
      temperature: 0.3,
      max_tokens: 4096,
      mode: 'fast',
      onChunk
    });
  }

  async chat({ messages: chatHistory, imageUrl, contextMarkdown, background, ragMarkdown = '' }) {
    const client = this.getClient('chat');
    if (!client) throw new Error('未配置 API Key');

    const systemPrompt = appendSystemSections(CHAT_SYSTEM_PROMPT, [
      contextMarkdown ? `当前课件摘要：\n${contextMarkdown}` : '',
      background ? `用户补充背景：\n${background}` : '',
      ragMarkdown || ''
    ]);

    return this._collectStream(client.chat.completions.create({
      model: this.getModel('chat'),
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...chatHistory]
    })) || '无法回答。';
  }

  chatStream({ messages: chatHistory, imageUrl, contextMarkdown, background, model, ragMarkdown = '' }) {
    if (model) this.overrideChat = model;
    const client = this.getClient('chat');
    if (!client) throw new Error('未配置 API Key');

    const systemPrompt = appendSystemSections(CHAT_SYSTEM_PROMPT, [
      contextMarkdown ? `当前课件摘要：\n${contextMarkdown}` : '',
      background ? `用户补充背景：\n${background}` : '',
      ragMarkdown || ''
    ]);

    return client.chat.completions.create({
      model: this.getModel('chat'),
      temperature: 0.3,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...chatHistory]
    });
  }

  async translate({ text, targetLang = '中文', sourceLang = '' }) {
    const client = this.getClient('translate');
    if (!client) throw new Error('未配置翻译 API Key');

    const langHint = sourceLang ? `源语言：${sourceLang}` : '';
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
      return JSON.stringify(JSON.parse(cleaned));
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

    const langHint = sourceLang ? `源语言：${sourceLang}` : '';
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
    return `你是专业的词典式翻译助手。${langHint} 目标语言：${targetLang}。

请先判断用户输入是单词/短语还是完整句子，然后按对应格式只返回 JSON：

单词/短语：
{
  "type": "word",
  "original": "原文",
  "phonetic": "音标或拼音",
  "wordType": "词性",
  "meanings": [
    { "def": "${targetLang}释义", "example": "例句" }
  ],
  "translation": "${targetLang}常用翻译"
}

句子/段落：
{
  "type": "sentence",
  "original": "原文",
  "translation": "${targetLang}翻译",
  "vocabulary": [
    { "word": "关键词", "meaning": "${targetLang}释义" }
  ]
}`;
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
      endpoints.push({ key: this.config.openaiApiKeyFast, url: this.config.openaiBaseUrl, label: `${this._urlLabel(this.config.openaiBaseUrl)} (fast)` });
    }
    if (this.config.translateApiKey && this.config.translateBaseUrl && this.config.translateBaseUrl !== this.config.openaiBaseUrl) {
      endpoints.push({ key: this.config.translateApiKey, url: this.config.translateBaseUrl, label: this._urlLabel(this.config.translateBaseUrl) });
    }

    this._endpoints = endpoints;
    const seen = new Set();
    const results = [];

    const lists = await Promise.all(endpoints.map(async (endpoint) => {
      if (!endpoint.key) return [];
      try {
        const models = await this.listModels(endpoint.key, endpoint.url);
        return models.map((model) => ({ model, endpoint }));
      } catch {
        return [];
      }
    }));

    for (const list of lists) {
      for (const item of list) {
        if (seen.has(item.model)) continue;
        seen.add(item.model);
        results.push(item);
        this._modelEndpointMap.set(item.model, item.endpoint);
      }
    }

    results.sort((a, b) => a.model.localeCompare(b.model));
    return results;
  }

  _urlLabel(url) {
    if (!url) return 'default';
    try {
      return new URL(url).hostname.replace(/^api\./, '').replace(/\.(com|vip|cn|io)$/, '');
    } catch {
      return url;
    }
  }
}
