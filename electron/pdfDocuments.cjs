const { PDF_METADATA_VERSION, parsePdfPage } = require('../shared/pdfSources.cjs');

const PDF_RENDER_SCALE = 1.5;
const MAX_PAGE_PIXELS = 12_000_000;
const pdfjsLoader = () => import('pdfjs-dist/legacy/build/pdf.mjs');
const documentOptions = (bytes) => ({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });

async function extractPdfDocument(bytes, options = {}) {
  let task;
  try {
    const pdfjs = await (options.pdfjsLoader || pdfjsLoader)();
    task = pdfjs.getDocument(documentOptions(bytes));
    const pdf = await task.promise;
    const pdfPages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const record = { pageNumber: number, text: '', extractionStatus: 'error', extractionMessage: '', readable: false, hasImages: null, hasNonTextContent: null };
      let page;
      try {
        page = await pdf.getPage(number);
        record.readable = true;
        try {
          const content = await page.getTextContent();
          record.text = content.items.map((item) => typeof item.str === 'string' ? item.str : '').filter(Boolean).join(' ');
          record.extractionStatus = record.text.trim() ? 'success' : 'no_text';
        } catch {
          record.extractionMessage = 'このページの本文を抽出できませんでした。';
        }
        try {
          const operators = await page.getOperatorList();
          const imageOps = new Set(['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup',
            'paintInlineImageXObjectGroup', 'paintImageXObjectRepeat', 'paintImageMaskXObjectRepeat', 'paintSolidColorImageMask'].map((key) => pdfjs.OPS[key]));
          const graphicOps = new Set(['constructPath', 'shadingFill'].map((key) => pdfjs.OPS[key]));
          record.hasImages = operators.fnArray.some((op) => imageOps.has(op));
          record.hasNonTextContent = record.hasImages || operators.fnArray.some((op) => graphicOps.has(op));
        } catch {
          record.extractionMessage += (record.extractionMessage ? ' ' : '') + '画像領域の有無を確認できませんでした。';
        }
      } catch {
        record.extractionMessage = 'このページを読み取れませんでした。';
      } finally {
        try { page?.cleanup(); } catch { /* release page resources */ }
      }
      pdfPages.push(record);
    }
    const textCount = pdfPages.filter((page) => page.extractionStatus === 'success').length;
    const errorCount = pdfPages.filter((page) => page.extractionStatus === 'error').length;
    const extractionStatus = errorCount ? 'partial' : textCount === pdf.numPages ? 'success' : textCount ? 'mixed' : 'no_text';
    return {
      pdfMetadataVersion: PDF_METADATA_VERSION, pdfPageCount: pdf.numPages, pdfPages,
      extractedText: pdfPages.filter((page) => page.text.trim()).map((page) => '[p.' + page.pageNumber + '] ' + page.text).join('\n\n'),
      extractionStatus,
      extractionMessage: pdf.numPages + 'ページ・本文抽出 ' + textCount + '・本文なし ' + (pdf.numPages - textCount - errorCount) + (errorCount ? '・抽出エラー ' + errorCount : '')
    };
  } catch {
    return { pdfMetadataVersion: PDF_METADATA_VERSION, pdfPageCount: null, pdfPages: [], extractedText: '',
      extractionStatus: 'error', extractionMessage: 'PDFを読み取れませんでした。ページ数は不明です。原本は保持しています。' };
  } finally {
    try { await task?.destroy(); } catch { /* worker cleanup only */ }
  }
}

async function renderPageImage(page, canvasModule, options = {}) {
  const viewport = page.getViewport({ scale: options.scale ?? PDF_RENDER_SCALE });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  if (!(width > 0 && height > 0 && width * height <= (options.maxPagePixels ?? MAX_PAGE_PIXELS))) {
    throw new Error('PDFのページ寸法がこのアプリの画像化上限を超えています。原本は保持しています。');
  }
  const canvas = canvasModule.createCanvas(width, height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas.toBuffer('image/png');
}

async function renderPdfPage(bytes, pageNumber, options = {}) {
  const number = parsePdfPage(pageNumber);
  if (!number) throw new Error('PDFのページ番号が不正です。');
  const pdfjs = await (options.pdfjsLoader || pdfjsLoader)();
  const task = pdfjs.getDocument(documentOptions(bytes));
  try {
    const pdf = await task.promise;
    if (number > pdf.numPages) throw new Error('指定したPDFページがありません。');
    const page = await pdf.getPage(number);
    const png = await renderPageImage(page, options.canvasModule || require('@napi-rs/canvas'), options);
    if (png.length > 40 * 1024 * 1024) throw new Error('原本ページの表示画像がこのアプリの容量上限を超えています。');
    return { pageNumber: number, pageCount: pdf.numPages, dataUrl: 'data:image/png;base64,' + png.toString('base64') };
  } finally {
    try { await task.destroy(); } catch { /* worker cleanup only */ }
  }
}

module.exports = { extractPdfDocument, renderPdfPage, renderPageImage, PDF_RENDER_SCALE, MAX_PAGE_PIXELS };
