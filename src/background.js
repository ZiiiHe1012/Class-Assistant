const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://pucoding.com/v1',
  apiKey: 'sk-ef534088f2401b7e55accfbfa3163b1f6ca529bde5d252e39fd954c34aa4a5d5',
  model: 'gpt-5.4-mini'
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'START_ANALYSIS' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_DEFAULT_SETTINGS') {
    sendResponse(DEFAULT_SETTINGS);
    return false;
  }

  if (message?.type === 'ANALYZE_IMAGE') {
    analyzeImage(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || '分析失败' }));
    return true;
  }

  return false;
});

async function analyzeImage(payload) {
  const { image, settings, contextText } = payload || {};
  if (!image) throw new Error('缺少图片内容');

  const mergedSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!mergedSettings.apiKey) {
    throw new Error('请先在悬浮栏中填写 API Key');
  }

  const endpoint = `${mergedSettings.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const prompt = [
    '你是一个雨课堂学习助手。请先判断这张图片属于“题目”还是“PPT讲解”。',
    '如果是题目，请给出：type=question, answer=简洁准确的答案, explanation=详细解析。',
    '如果是PPT讲解，请给出：type=ppt, explanation=详细讲解、知识点总结、易错点。',
    '请严格只输出 JSON，不要输出多余文本，JSON 结构如下：',
    '{"type":"question|ppt","title":"一句话概述","answer":"...","explanation":"...","confidence":0.9}',
    contextText ? `页面上下文：${contextText}` : ''
  ].filter(Boolean).join('\n');

  const variants = [
    {
      name: 'chat-completions-standard',
      body: {
        model: mergedSettings.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你必须输出严格 JSON。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ]
      }
    },
    {
      name: 'chat-completions-string-image-url',
      body: {
        model: mergedSettings.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你必须输出严格 JSON。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: image }
            ]
          }
        ]
      }
    },
    {
      name: 'chat-completions-image-url-direct-url-field',
      body: {
        model: mergedSettings.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你必须输出严格 JSON。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', url: image }
            ]
          }
        ]
      }
    },
    {
      name: 'chat-completions-input-image',
      body: {
        model: mergedSettings.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '你必须输出严格 JSON。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'input_image', image_url: image }
            ]
          }
        ]
      }
    }
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mergedSettings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(variant.body)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`AI 接口请求失败：${response.status} ${text}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return parseJsonLike(content);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const shouldRetry = /image_url|input_image|invalid_request_error|400/.test(message);
      if (!shouldRetry) break;
    }
  }

  try {
    const responseEndpoint = `${mergedSettings.apiBaseUrl.replace(/\/$/, '')}/responses`;
    const responsePayload = {
      model: mergedSettings.model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: image }
          ]
        }
      ]
    };

    const resp = await fetch(responseEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mergedSettings.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(responsePayload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`AI 接口请求失败：${resp.status} ${text}`);
    }

    const data = await resp.json();
    const content = extractResponsesText(data);
    return parseJsonLike(content);
  } catch (error) {
    lastError = error;
  }

  throw lastError || new Error('AI 接口请求失败');
}

function extractResponsesText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;

  const output = Array.isArray(data.output) ? data.output : [];
  for (const block of output) {
    const content = Array.isArray(block?.content) ? block.content : [];
    for (const item of content) {
      if (typeof item?.text === 'string' && item.text.trim()) return item.text;
      if (typeof item?.content === 'string' && item.content.trim()) return item.content;
    }
  }

  return '';
}

function parseJsonLike(input) {
  if (!input) return { type: 'ppt', title: '未返回内容', explanation: 'AI 未返回有效内容。', confidence: 0 };
  const cleaned = String(input)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // ignore
      }
    }
  }

  return {
    type: 'ppt',
    title: '解析失败，返回原文',
    explanation: cleaned,
    confidence: 0
  };
}