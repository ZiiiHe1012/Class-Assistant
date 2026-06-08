function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .trim();
}

function truncateText(value, maxLength = 1800) {
  const text = normalizeText(value);
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function uniqueStrings(items) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function formatPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  const sections = [];
  if (payload.summary) sections.push(`Summary: ${payload.summary}`);
  if (Array.isArray(payload.keyPoints) && payload.keyPoints.length) {
    sections.push(`Key points:\n${payload.keyPoints.map((item) => `- ${item}`).join('\n')}`);
  }
  if (Array.isArray(payload.tips) && payload.tips.length) {
    sections.push(`Study tips:\n${payload.tips.map((item) => `- ${item}`).join('\n')}`);
  }
  if (payload.questionStem) sections.push(`Question stem: ${payload.questionStem}`);
  if (Array.isArray(payload.options) && payload.options.length) {
    sections.push(`Options:\n${payload.options.map((item) => `- ${item.key || ''} ${item.text || ''}${item.isAnswer ? ' [answer]' : ''}`.trim()).join('\n')}`);
  }
  if (Array.isArray(payload.answers) && payload.answers.length) {
    sections.push(`Answers: ${payload.answers.join(', ')}`);
  }
  if (Array.isArray(payload.blanks) && payload.blanks.length) {
    sections.push(`Blanks:\n${payload.blanks.map((item) => `- #${item.index || ''}: ${item.answer || ''}`.trim()).join('\n')}`);
  }
  if (payload.explanation) sections.push(`Explanation: ${payload.explanation}`);
  if (payload.sampleAnswer) sections.push(`Sample answer: ${payload.sampleAnswer}`);
  if (Array.isArray(payload.knowledgePoints) && payload.knowledgePoints.length) {
    sections.push(`Knowledge points:\n${payload.knowledgePoints.map((item) => `- ${item}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

function tokenize(text) {
  const source = normalizeText(text).toLowerCase();
  if (!source) return [];

  const tokens = new Set();
  for (const match of source.matchAll(/[a-z][a-z0-9_+-]{1,}|\d{2,}/g)) {
    tokens.add(match[0]);
  }

  for (const match of source.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const run = match[0];
    if (run.length <= 8) {
      tokens.add(run);
      continue;
    }
    tokens.add(run.slice(0, 8));
    for (let index = 0; index < run.length - 1 && tokens.size < 120; index += 2) {
      tokens.add(run.slice(index, index + 2));
    }
  }

  return [...tokens].slice(0, 120);
}

function scoreCandidate(candidate, tokens) {
  const text = candidate.searchText;
  let score = candidate.forceInclude ? 1000 : 0;

  if (tokens.length) {
    for (const token of tokens) {
      if (text.includes(token)) {
        score += token.length >= 4 ? 8 : 4;
      }
    }
  }

  if (candidate.distanceFromCurrent !== null && candidate.distanceFromCurrent !== undefined) {
    score += Math.max(0, 8 - candidate.distanceFromCurrent);
  }

  if (typeof candidate.recencyBoost === 'number') {
    score += candidate.recencyBoost;
  }

  score += Math.min(6, Math.floor(candidate.content.length / 400));
  return score;
}

export class RagService {
  constructor(config, state, notesService) {
    this.config = config;
    this.state = state;
    this.notesService = notesService;
    this.maxDocs = 6;
    this.maxChars = 7000;
    this.neighborWindow = 2;
  }

  async buildContext({ captureId = '', hash = '', query = '', purpose = 'general' } = {}) {
    const snapshot = this.state.snapshot();
    const captures = [...(snapshot.captures || [])].sort((a, b) => {
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    const currentCapture = captureId
      ? captures.find((item) => item.id === captureId) || null
      : (hash ? captures.find((item) => item.hash === hash) || null : null);

    const currentHash = hash || currentCapture?.hash || '';
    const currentIndex = currentCapture ? captures.findIndex((item) => item.id === currentCapture.id) : -1;
    const currentNote = currentHash ? await this.notesService.get(currentHash) : null;

    const candidates = [];
    const seen = new Set();
    const addCandidate = (candidate) => {
      if (!candidate || !candidate.content) return;
      const key = candidate.key || `${candidate.kind}:${candidate.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({
        ...candidate,
        content: truncateText(candidate.content),
        searchText: normalizeText(candidate.content).toLowerCase()
      });
    };

    const buildCaptureContent = (capture) => {
      if (!capture) return '';
      return [
        capture.title ? `Title: ${capture.title}` : '',
        capture.categoryName ? `Category: ${capture.categoryName}` : '',
        capture.reason ? `Reason: ${capture.reason}` : '',
        capture.renderedMarkdown ? `Analysis:\n${capture.renderedMarkdown}` : '',
        formatPayload(capture.payload),
        capture.deepThinkMarkdown ? `Deep think:\n${capture.deepThinkMarkdown}` : '',
        capture.ocrText ? `OCR:\n${capture.ocrText}` : ''
      ].filter(Boolean).join('\n\n');
    };

    const buildNoteContent = (note) => {
      if (!note) return '';
      return [
        note.title ? `Note title: ${note.title}` : '',
        note.tags?.length ? `Tags: ${note.tags.join(', ')}` : '',
        note.manualContent ? `Manual notes:\n${note.manualContent}` : '',
        note.aiGeneratedContent ? `AI notes:\n${note.aiGeneratedContent}` : ''
      ].filter(Boolean).join('\n\n');
    };

    if (currentCapture) {
      addCandidate({
        key: `capture:${currentCapture.id}`,
        kind: 'capture',
        label: 'Current slide',
        content: buildCaptureContent(currentCapture),
        distanceFromCurrent: 0,
        recencyBoost: 6,
        forceInclude: true
      });
    }

    if (currentNote) {
      addCandidate({
        key: `note:${currentHash}`,
        kind: 'note',
        label: 'Current slide note',
        content: buildNoteContent(currentNote),
        distanceFromCurrent: 0,
        recencyBoost: 5,
        forceInclude: true
      });
    }

    if (currentIndex >= 0) {
      for (let offset = -this.neighborWindow; offset <= this.neighborWindow; offset += 1) {
        if (offset === 0) continue;
        const capture = captures[currentIndex + offset];
        if (!capture) continue;
        addCandidate({
          key: `capture:${capture.id}`,
          kind: 'capture',
          label: offset < 0 ? `Previous slide ${Math.abs(offset)}` : `Next slide ${offset}`,
          content: buildCaptureContent(capture),
          distanceFromCurrent: Math.abs(offset),
          recencyBoost: 4 - Math.abs(offset),
          forceInclude: false
        });
      }
    }

    const recentCaptures = [...captures]
      .reverse()
      .filter((capture) => !currentCapture || capture.id !== currentCapture.id)
      .slice(0, 8);
    recentCaptures.forEach((capture, index) => {
      addCandidate({
        key: `recent:${capture.id}`,
        kind: 'capture',
        label: `Recent slide ${index + 1}`,
        content: buildCaptureContent(capture),
        distanceFromCurrent: null,
        recencyBoost: Math.max(0, 4 - index),
        forceInclude: false
      });
    });

    const noteHashes = uniqueStrings(await this.notesService.listHashes());
    for (const noteHash of noteHashes.slice(0, 12)) {
      if (noteHash === currentHash) continue;
      const note = await this.notesService.get(noteHash);
      const noteContent = buildNoteContent(note);
      if (!noteContent) continue;
      const relatedCapture = captures.find((item) => item.hash === noteHash) || null;
      const distance = currentIndex >= 0 && relatedCapture
        ? Math.abs(captures.findIndex((item) => item.id === relatedCapture.id) - currentIndex)
        : null;
      addCandidate({
        key: `note:${noteHash}`,
        kind: 'note',
        label: note.title ? `Related note: ${note.title}` : 'Related note',
        content: noteContent,
        distanceFromCurrent: Number.isFinite(distance) ? distance : null,
        recencyBoost: 2,
        forceInclude: false
      });
    }

    const querySeed = [
      query,
      currentCapture?.title,
      currentCapture?.renderedMarkdown,
      currentCapture?.ocrText,
      currentNote?.title,
      currentNote?.manualContent
    ].filter(Boolean).join('\n');
    const queryTokens = tokenize(querySeed);

    const selected = candidates
      .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, queryTokens) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    const blocks = [];
    let totalChars = 0;
    for (const candidate of selected) {
      const block = `### ${candidate.label}\n${candidate.content}`;
      if (!candidate.forceInclude && totalChars + block.length > this.maxChars) continue;
      blocks.push(block);
      totalChars += block.length;
      if (blocks.length >= this.maxDocs || totalChars >= this.maxChars) break;
    }

    if (!blocks.length) return '';

    return [
      `## Retrieved Classroom Context`,
      `Use the following retrieved context only as supporting evidence for ${purpose}. Prioritize the current slide, the user's explicit request, and direct evidence from the uploaded image.`,
      '',
      ...blocks
    ].join('\n');
  }
}
