const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { synopsisText } = require('../shared/analysisSources.cjs');

const MAX_CODEX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_CODEX_TEXT_CHARACTERS = 300000;
const MAX_CODEX_PDF_PAGES = 200;
const PDF_RENDER_SCALE = 1.5;
const MAX_PAGE_PIXELS = 12_000_000;

function renderEvidenceLabel(item) {
  const visibility = item.visibility === 'shared' ? '全体公開' : item.visibility === 'private' ? '自分だけ' : '公開状況不明';
  const kind = item.kind === 'image' ? '画像' : item.kind === 'pdf' ? 'PDF' : 'テキスト';
  return '[資料ID: ' + item.id + '] [' + visibility + '] [' + kind + '] ' + item.title;
}

function buildCodexDeveloperInstructions(systemPrompt) {
  return String(systemPrompt || '');
}

async function prepareCodexInput(caseRecord, requestData, options = {}) {
  const pdfjsLoader = options.pdfjsLoader || (() => import('pdfjs-dist/legacy/build/pdf.mjs'));
  const canvasModule = options.canvasModule || require('@napi-rs/canvas');
  const tempRoot = options.tempRoot || os.tmpdir();
  const maxImageBytes = options.maxImageBytes ?? MAX_CODEX_IMAGE_BYTES;
  const maxTextCharacters = options.maxTextCharacters ?? MAX_CODEX_TEXT_CHARACTERS;
  const maxPdfPages = options.maxPdfPages ?? MAX_CODEX_PDF_PAGES;
  const signal = options.signal;
  let temporaryDirectory = null;
  let imageBytes = 0;
  let textCharacters = 0;
  let pageCount = 0;
  const input = [];
  const addText = (value) => {
    const text = String(value || '');
    textCharacters += text.length;
    if (textCharacters > maxTextCharacters) {
      throw new Error('Codexへ渡す全文字数がこのアプリの上限' + maxTextCharacters.toLocaleString('ja-JP') + '字を超えています。資料や方針を省略せず解析を停止しました。保存済み原本は保持しています。');
    }
    input.push({ type: 'text', text });
  };
  addText(synopsisText(caseRecord));
  const checkCancelled = () => {
    if (!signal || !signal.aborted) return;
    const error = new Error('Codex解析をキャンセルしました。');
    error.code = 'CANCELLED';
    throw error;
  };

  try {
    for (const { item, bytes, text, fullPath } of requestData.rows) {
      checkCancelled();
      addText(renderEvidenceLabel(item));
      if (item.kind === 'text') {
        addText(text || '[テキスト本文は空です]');
        continue;
      }
      if (item.kind === 'image') {
        if (!fullPath) throw new Error('画像資料の保存先を確認できません。原本は保持されています。');
        imageBytes += bytes.length;
        if (imageBytes > maxImageBytes) throw new Error('画像入力がこのアプリの上限40 MiBを超えるため解析を停止しました。資料は切り捨てず、原本を保持しています。');
        input.push({ type: 'localImage', path: path.resolve(fullPath) });
        continue;
      }
      if (item.kind !== 'pdf') throw new Error('Codexで扱えない資料形式が含まれています。資料は原本のまま保持しています。');

      const pdfjs = await pdfjsLoader();
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
      let pdf;
      try {
        pdf = await task.promise;
        if (pageCount + pdf.numPages > maxPdfPages) {
          throw new Error('このアプリではPDFを全ページ画像化する上限を' + maxPdfPages.toLocaleString('ja-JP') + 'ページにしています。ページを省かず解析を停止しました。PDF原本は保持しています。');
        }
        addText(text
          ? '[PDFからローカル抽出した全文です。PDFの全ページ画像も続けて添付します。]\n' + text
          : '[PDFから文字を抽出できませんでした。テキストの代替はありません。以下の全ページ画像を読み取り、画像由来の引用は原文一致未検証として扱ってください。]');
        if (!temporaryDirectory) temporaryDirectory = await fs.mkdtemp(path.join(tempRoot, 'makua-codex-pages-'));
        for (let number = 1; number <= pdf.numPages; number += 1) {
          checkCancelled();
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
          const width = Math.ceil(viewport.width);
          const height = Math.ceil(viewport.height);
          if (width <= 0 || height <= 0 || width * height > MAX_PAGE_PIXELS) {
            throw new Error('PDFのページ寸法がこのアプリの画像化上限を超えています。ページを省かず解析を停止しました。PDF原本は保持しています。');
          }
          const canvas = canvasModule.createCanvas(width, height);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const png = canvas.toBuffer('image/png');
          imageBytes += png.length;
          if (imageBytes > maxImageBytes) {
            throw new Error('画像資料とPDF全ページ画像の合計がこのアプリの画像入力上限40 MiBを超えました。ページを省かず解析を停止し、原本は保持しています。');
          }
          const pagePath = path.join(temporaryDirectory, item.id + '-page-' + String(number).padStart(4, '0') + '.png');
          await fs.writeFile(pagePath, png, { flag: 'wx' });
          addText('[PDF資料ID: ' + item.id + '] 原本のp.' + number + '（ページ順は原本と同じ）');
          input.push({ type: 'localImage', path: pagePath });
          pageCount += 1;
        }
      } finally {
        if (pdf) {
          try { await task.destroy(); } catch { /* PDF worker cleanup only */ }
        } else {
          try { await task.destroy(); } catch { /* PDF worker cleanup only */ }
        }
      }
    }

    if (options.contextText) addText(options.contextText);
    return { input, temporaryDirectory, imageBytes, textCharacters, pdfPages: pageCount };
  } catch (error) {
    if (temporaryDirectory) {
      try { await fs.rm(temporaryDirectory, { recursive: true, force: true }); } catch { /* keep the original PDFs; only temp rasters are removed */ }
    }
    throw error;
  }
}

async function cleanupCodexInput(prepared) {
  if (!prepared || !prepared.temporaryDirectory) return;
  await fs.rm(prepared.temporaryDirectory, { recursive: true, force: true });
}

function parseStructuredResult(text) {
  try {
    const result = JSON.parse(text);
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('object required');
    return result;
  } catch {
    throw new Error('Codexから解析JSONを受け取れませんでした。前回の状況と方針は保持されています。');
  }
}

module.exports = {
  prepareCodexInput,
  cleanupCodexInput,
  buildCodexDeveloperInstructions,
  parseStructuredResult,
  MAX_CODEX_IMAGE_BYTES,
  MAX_CODEX_TEXT_CHARACTERS,
  MAX_CODEX_PDF_PAGES,
  PDF_RENDER_SCALE
};
