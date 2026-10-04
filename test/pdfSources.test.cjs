const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { extractPdfDocument, renderPdfPage } = require('../electron/pdfDocuments.cjs');
const { verifyEventQuote, sourceInputsForRows, parsePdfPage } = require('../shared/pdfSources.cjs');
const { applyAnalysis } = require('../shared/analysisLifecycle.cjs');
const { prepareCodexInput, cleanupCodexInput } = require('../electron/codexInput.cjs');
const { pdfFixture } = require('../test-support/pdfFixtures.cjs');

const event = (page, quote, quoteSource = 'text') => ({ sourceId: 'pdf', page: String(page), quote, quoteSource, timeText: '', people: [], what: quote, type: 'recorded', ambiguity: '' });

test('real mixed PDF records every page, same-page images, blank pages and a short text', async () => {
  const bytes = pdfFixture();
  const original = Buffer.from(bytes);
  const source = await extractPdfDocument(bytes);
  assert.equal(source.pdfPageCount, 5);
  assert.equal(source.extractionStatus, 'mixed');
  assert.deepEqual(source.pdfPages.map((page) => page.extractionStatus), ['success', 'no_text', 'success', 'no_text', 'success']);
  assert.deepEqual(source.pdfPages.map((page) => page.hasImages), [false, true, true, false, false]);
  assert.equal(source.pdfPages[4].text, 'A');
  assert.match(source.extractedText, /\[p\.5\] A/);
  assert.equal(source.pdfPages[1].text, '');
  const second = await renderPdfPage(bytes, 2);
  assert.equal(second.pageNumber, 2);
  assert.equal(second.pageCount, 5);
  assert.match(second.dataUrl, /^data:image\/png;base64,/);
  assert.notEqual(second.dataUrl, (await renderPdfPage(bytes, 1)).dataUrl);
  assert.deepEqual(bytes, original);
  await assert.rejects(renderPdfPage(bytes, 6), /指定したPDFページ/);
  await assert.rejects(renderPdfPage(bytes, '2-3'), /ページ番号/);
});

test('page extraction failures retain other pages and always destroy the worker', async () => {
  let destroyed = 0;
  let cleaned = 0;
  const pdfjsLoader = async () => ({ OPS: { paintImageXObject: 85, constructPath: 91 }, getDocument: () => ({
    promise: Promise.resolve({ numPages: 3, getPage: async (number) => {
      if (number === 3) throw new Error('bad page');
      return { getTextContent: async () => { if (number === 2) throw new Error('bad text'); return { items: [{ str: 'kept text' }] }; },
        getOperatorList: async () => ({ fnArray: number === 2 ? [85] : [] }), cleanup() { cleaned += 1; } };
    } }), destroy: async () => { destroyed += 1; }
  }) });
  const extracted = await extractPdfDocument(Buffer.alloc(1), { pdfjsLoader });
  assert.equal(extracted.pdfPageCount, 3);
  assert.equal(extracted.extractionStatus, 'partial');
  assert.equal(extracted.pdfPages[0].text, 'kept text');
  assert.equal(extracted.pdfPages[1].hasImages, true);
  assert.equal(extracted.pdfPages[1].extractionStatus, 'error');
  assert.equal(extracted.pdfPages[2].readable, false);
  assert.equal(destroyed, 1);
  assert.equal(cleaned, 2);
  const broken = await extractPdfDocument(Buffer.from('not a PDF'));
  assert.equal(broken.pdfPageCount, null);
  assert.deepEqual(broken.pdfPages, []);
  assert.match(broken.extractionMessage, /ページ数は不明/);
});

test('PDF quotes use only the named page, preserve text checks and never trust a verification claim', async () => {
  const bytes = pdfFixture();
  const item = { id: 'pdf', kind: 'pdf', attachmentPath: 'attachments/fixture.pdf', ...await extractPdfDocument(bytes) };
  const inputs = sourceInputsForRows([{ item, bytes }], 'openai').pdf;
  const matched = verifyEventQuote(event(1, '08:10   returned key'), item, inputs);
  assert.equal(matched.quoteVerification, 'text_matched');
  assert.throws(() => verifyEventQuote(event(3, '08:10 returned key'), item, inputs), /該当PDFページの原文に一致しない/);
  assert.throws(() => verifyEventQuote(event(1, 'paraphrased text'), item, inputs), /原文に一致しない/);
  assert.throws(() => verifyEventQuote(event(1, 'paraphrased text', 'image'), item, inputs), /画像領域/);
  assert.throws(() => verifyEventQuote(event(4, 'nonexistent words', 'image'), item, inputs), /画像領域/);
  for (const [number, quote] of [[2, '09:00 hidden room unlocked'], [3, '10:30 lantern on']]) {
    const saved = verifyEventQuote({ ...event(number, quote, 'image'), quoteOrigin: '照合済み', quoteVerification: 'text_matched' }, item, inputs);
    assert.equal(saved.quoteVerification, 'image_unverified');
    assert.equal(saved.quoteOrigin, '画像読取・引用未照合');
  }
  assert.equal(verifyEventQuote(event(3, '10:00 courtyard closed'), item, inputs).quoteVerification, 'text_matched');
  for (const page of ['', 0, 6, '-1', '1-2', 'p.2/5']) assert.throws(() => verifyEventQuote(event(page, 'image words', 'image'), item, inputs), /原本ページ番号/);
  assert.equal(parsePdfPage('p. ２'), 2);
  assert.equal(verifyEventQuote(event('', '08:10 returned key'), item, inputs).page, '1');
  assert.throws(() => verifyEventQuote(event(2, 'image words', 'image'), item, { ...inputs, originalAvailable: false }), /原本ページ/);
  const ollama = sourceInputsForRows([{ item, bytes }], 'ollama').pdf;
  assert.equal(verifyEventQuote(event(1, '08:10 returned key'), item, ollama).quoteVerification, 'text_matched');
  assert.throws(() => verifyEventQuote(event(2, 'image words', 'image'), item, ollama), /今回の入力に含めていません/);
  // A model cannot request image fallback for an incorrect explicit text quote.
  assert.throws(() => verifyEventQuote(event(3, '10:30 lantern on'), item, inputs), /原文に一致しない/);
  const response = { overview: 'mixed', events: [event(1, '08:10 returned key'), event(2, '09:00 hidden room unlocked', 'image'), event(3, '10:30 lantern on', 'image')], facts: [], actions: [] };
  const updated = applyAnalysis({ revision: 1, evidence: [item], actionHistory: [] }, response, 1, undefined, { sourceInputs: { pdf: inputs } });
  assert.deepEqual(updated.analysis.events.map((entry) => entry.quoteVerification), ['text_matched', 'image_unverified', 'image_unverified']);
});

test('legacy sources keep text checks without claiming a page match; image originals are mandatory', () => {
  const legacy = { kind: 'pdf', extractedText: '[p.1] legacy text' };
  assert.equal(verifyEventQuote(event('', 'legacy text'), legacy).quoteVerification, 'legacy_text_matched');
  assert.throws(() => verifyEventQuote(event('', 'wrong text'), legacy), /ページ別原文/);
  assert.throws(() => verifyEventQuote(event(1, 'legacy text', 'image'), legacy), /ページ別原文/);
  const image = { kind: 'image' };
  assert.throws(() => verifyEventQuote(event('', 'image quote', 'image'), image), /原本/);
  assert.equal(verifyEventQuote(event('', 'image quote', 'image'), image, { originalAvailable: true, imageSent: true }).quoteVerification, 'image_unverified');
  assert.throws(() => verifyEventQuote(event('', 'bad', 'image'), { kind: 'text', extractedText: 'bad' }), /原文に一致しない/);
});

test('Codex keeps all mixed pages, tracks actual visual pages and cleans partial rendering on limits', async (t) => {
  const tempRoot = path.resolve(__dirname, '../.local');
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'pdf-limits-'));
  t.after(async () => { assert.equal(path.dirname(directory), tempRoot); await fs.rm(directory, { recursive: true, force: true }); });
  const bytes = pdfFixture();
  const item = { id: 'pdf', title: 'synthetic.pdf', kind: 'pdf', ...await extractPdfDocument(bytes) };
  const rows = [{ item, bytes, text: item.extractedText }];
  const prepared = await prepareCodexInput({ synopsis: '' }, { rows }, { tempRoot: directory });
  assert.equal(prepared.pdfPages, 5);
  assert.deepEqual(prepared.pdfPageInputs.pdf, [1, 2, 3, 4, 5]);
  assert.equal(prepared.input.filter((part) => part.type === 'localImage').length, 5);
  assert.ok(prepared.input.some((part) => part.type === 'text' && part.text.includes('[p.2] [本文抽出なし・画像あり]')));
  await cleanupCodexInput(prepared);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(prepareCodexInput({ synopsis: '' }, { rows }, { tempRoot: directory, maxPdfPages: 4 }), /全ページ画像化する上限を4ページ/);
  await assert.rejects(prepareCodexInput({ synopsis: '' }, { rows }, { tempRoot: directory, maxImageBytes: 1 }), /画像入力上限/);
  assert.deepEqual(await fs.readdir(directory), []);
  const oversized = pdfFixture([{ text: 'oversized', width: 10000, height: 10000 }]);
  await assert.rejects(prepareCodexInput({ synopsis: '' }, { rows: [{ item, bytes: oversized, text: '' }] }, { tempRoot: directory }), /画像化上限/);
  assert.deepEqual(await fs.readdir(directory), []);
});
