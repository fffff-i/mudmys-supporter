const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const canvasModule = require('@napi-rs/canvas');
const {
  prepareCodexInput,
  cleanupCodexInput,
  parseStructuredResult,
  MAX_CODEX_PDF_PAGES,
  MAX_CODEX_TEXT_CHARACTERS
} = require('../electron/codexInput.cjs');

function createPdfFixture() {
  const content = 'BT /F1 12 Tf 20 150 Td (08:10 returned key) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(content, 'ascii') + ' >>\nstream\n' + content + '\nendstream'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  pdf += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';
  return Buffer.from(pdf, 'ascii');
}

function createImageFixture() {
  const canvas = canvasModule.createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#336699';
  context.fillRect(0, 0, 2, 2);
  return canvas.toBuffer('image/png');
}

test('Codex input retains full extracted text and attaches every PDF page as an image', async () => {
  const original = createPdfFixture();
  const prepared = await prepareCodexInput(
    { synopsis: '概要の全文' },
    { rows: [{ item: { id: 'pdf-1', title: '原本.pdf', kind: 'pdf', visibility: 'unknown' }, bytes: original, text: '[p.1] 08:10 返却したと記録。' }] }
  );
  try {
    assert.equal(prepared.pdfPages, 1);
    assert.equal(prepared.input.filter((part) => part.type === 'localImage').length, 1);
    assert.ok(prepared.input.some((part) => part.type === 'text' && part.text.includes('[p.1] 08:10 返却したと記録。')));
    assert.ok(prepared.input.some((part) => part.type === 'text' && part.text.includes('原本のp.1')));
    const raster = await fs.readFile(prepared.input.find((part) => part.type === 'localImage').path);
    assert.equal(raster.subarray(1, 4).toString('ascii'), 'PNG');
    assert.deepEqual(original, createPdfFixture());
  } finally {
    const tempDirectory = prepared.temporaryDirectory;
    await cleanupCodexInput(prepared);
    if (tempDirectory) await assert.rejects(fs.stat(tempDirectory), { code: 'ENOENT' });
  }
});

test('scan PDFs still contribute a page image when local text extraction is empty', async () => {
  const bytes = createPdfFixture();
  const prepared = await prepareCodexInput(
    { synopsis: '' },
    { rows: [{ item: { id: 'scan-1', title: 'scan.pdf', kind: 'pdf', visibility: 'private' }, bytes, text: '' }] }
  );
  try {
    assert.equal(prepared.pdfPages, 1);
    assert.equal(prepared.input.filter((part) => part.type === 'localImage').length, 1);
    assert.ok(prepared.input.some((part) => part.type === 'text' && part.text.includes('文字を抽出できませんでした')));
  } finally {
    await cleanupCodexInput(prepared);
  }
});

test('PDF over the supported page ceiling stops before a partial page set is sent', async () => {
  const bytes = createPdfFixture();
  await assert.rejects(
    prepareCodexInput(
      { synopsis: '' },
      { rows: [{ item: { id: 'pdf-2', title: 'too-many-pages.pdf', kind: 'pdf', visibility: 'unknown' }, bytes, text: '' }] },
      { maxPdfPages: 0 }
    ),
    /全ページ画像化する上限を0ページ/
  );
  assert.equal(MAX_CODEX_PDF_PAGES, 200);
  assert.equal(createPdfFixture().length, bytes.length);
});

test('complete Codex text and context are measured together and rejected without truncation', async () => {
  const caseRecord = { synopsis: '概要' };
  const requestData = { rows: [{ item: { id: 'text-1', title: 'note', kind: 'text', visibility: 'private' }, bytes: Buffer.alloc(0), text: '本文' }] };
  const baseline = await prepareCodexInput(caseRecord, requestData);
  const baselineCharacters = baseline.textCharacters;
  await cleanupCodexInput(baseline);
  const contextText = '役の目的と方針';
  await assert.rejects(
    prepareCodexInput(
      caseRecord,
      requestData,
      { contextText, maxTextCharacters: baselineCharacters + contextText.length - 1 }
    ),
    new RegExp('上限' + String(baselineCharacters + contextText.length - 1) + '字を超えています')
  );
  assert.equal(MAX_CODEX_TEXT_CHARACTERS, 300000);
});

test('Codex strict JSON parse rejects prose and preserves valid structured results', () => {
  assert.deepEqual(parseStructuredResult('{"overview":"記録の時刻は未確認。"}'), { overview: '記録の時刻は未確認。' });
  assert.throws(() => parseStructuredResult('結果は {"overview":"ok"} です'), /解析JSON/);
  assert.throws(() => parseStructuredResult('[]'), /解析JSON/);
});

test('direct image inputs retain the original image path instead of copying or dropping it', async () => {
  const bytes = createImageFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-image-'));
  const imagePath = path.join(directory, 'synthetic-fixture.png');
  await fs.writeFile(imagePath, bytes);
  try {
    const prepared = await prepareCodexInput(
      { synopsis: 'fixture' },
      { rows: [{ item: { id: 'img-1', title: 'synthetic-fixture.png', kind: 'image', visibility: 'shared' }, bytes, text: '', fullPath: imagePath }] }
    );
    assert.equal(prepared.input.find((part) => part.type === 'localImage').path, path.resolve(imagePath));
    assert.equal(prepared.imageBytes, bytes.length);
    await cleanupCodexInput(prepared);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
