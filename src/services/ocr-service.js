import Tesseract from 'tesseract.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let worker = null;
const CACHE_DIR = path.join(os.tmpdir(), 'tesseract-cache');

function findLangPath() {
  const localFile = path.join(PROJECT_ROOT, 'chi_sim.traineddata');
  if (fs.existsSync(localFile)) return PROJECT_ROOT;
  return 'https://tessdata.projectnaptha.com/4.0.0';
}

async function getWorker() {
  if (worker) return worker;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const langPath = findLangPath();
  const useGzip = langPath.startsWith('http');
  worker = await Tesseract.createWorker('chi_sim+eng', 1, {
    langPath,
    cachePath: CACHE_DIR,
    gzip: useGzip
  });
  return worker;
}

function parseTsv(tsv) {
  const lines = tsv.split('\n');
  if (lines.length < 2) return { words: [], imageWidth: 0, imageHeight: 0 };

  const firstCols = lines[0].split('\t');
  const imageWidth = parseInt(firstCols[8]) || 0;
  const imageHeight = parseInt(firstCols[9]) || 0;

  const words = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols[0] !== '5') continue;
    const text = (cols[11] || '').trim();
    if (!text) continue;
    words.push({
      text,
      x: parseInt(cols[6]) || 0,
      y: parseInt(cols[7]) || 0,
      w: parseInt(cols[8]) || 0,
      h: parseInt(cols[9]) || 0,
      confidence: parseFloat(cols[10]) || 0
    });
  }

  return { words, imageWidth, imageHeight };
}

export async function ocrImage(imageBuffer) {
  const w = await getWorker();
  const { data } = await w.recognize(imageBuffer, {}, { text: true, tsv: true });

  const { words, imageWidth, imageHeight } = parseTsv(data.tsv || '');

  return {
    text: data.text || '',
    words,
    imageWidth,
    imageHeight
  };
}
