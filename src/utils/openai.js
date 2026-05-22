export async function callOpenAICompatible({ apiBaseUrl, apiKey, model, messages }) {
  const endpoint = `${String(apiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, temperature: 0.2, messages })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`AI 接口请求失败：${response.status} ${text}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

export function parseJsonLike(input) {
  if (!input) return null;
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
        return null;
      }
    }
    return null;
  }
}