import fs from 'fs/promises';
import path from 'path';

export class NotesService {
  constructor(notesDir, modelService) {
    this.notesDir = notesDir;
    this.modelService = modelService;
  }

  async ensureDir() {
    await fs.mkdir(this.notesDir, { recursive: true });
  }

  _filePath(hash) {
    return path.join(this.notesDir, `${hash}.json`);
  }

  emptyNote(hash) {
    return {
      hash,
      title: '',
      manualContent: '',
      aiGeneratedContent: '',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async get(hash) {
    try {
      const raw = await fs.readFile(this._filePath(hash), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return this.emptyNote(hash);
    }
  }

  async save(hash, data) {
    await this.ensureDir();
    const existing = await this.get(hash);
    const merged = {
      ...existing,
      ...data,
      hash,
      updatedAt: new Date().toISOString()
    };
    if (!merged.createdAt) merged.createdAt = merged.updatedAt;
    await fs.writeFile(this._filePath(hash), JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  async delete(hash) {
    await fs.unlink(this._filePath(hash)).catch(() => {});
  }

  async listHashes() {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.notesDir);
      return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async generateNotesStream(hash, imageUrl, analysisMarkdown, onChunk) {
    return this.modelService.generateNotes({ imageUrl, analysisMarkdown, onChunk });
  }

  async getAll() {
    const hashes = await this.listHashes();
    const notes = [];
    for (const hash of hashes) {
      const note = await this.get(hash);
      const hasContent = note.manualContent || note.aiGeneratedContent || (note.tags && note.tags.length);
      if (hasContent) notes.push(note);
    }
    return notes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async exportAll(captures) {
    const lines = ['# 课堂笔记导出\n', `导出时间：${new Date().toLocaleString('zh-CN')}\n\n---\n`];

    for (const capture of captures) {
      if (!capture.hash) continue;
      const note = await this.get(capture.hash);
      const hasContent = note.manualContent || note.aiGeneratedContent || note.tags?.length;
      if (!hasContent) continue;

      const title = capture.title || note.title || `Slide ${capture.id?.slice(0, 8) || ''}`;
      lines.push(`\n## ${title}\n`);

      if (note.tags?.length) {
        lines.push(`**标签**：${note.tags.map(t => `\`${t}\``).join(' ')}\n`);
      }

      if (note.manualContent) {
        lines.push('\n### 手写笔记\n');
        lines.push(note.manualContent);
        lines.push('\n');
      }

      if (note.aiGeneratedContent) {
        lines.push('\n### AI 生成笔记\n');
        lines.push(note.aiGeneratedContent);
        lines.push('\n');
      }

      lines.push('\n---\n');
    }

    return lines.join('\n');
  }
}
