const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadMockMain } = require('../test-support/mockPdfMain.cjs');
const { pdfFixture, imageFixture } = require('../test-support/pdfFixtures.cjs');

function scenarioFixture() {
  return { id: randomUUID(), title: '架空PDF検証', revision: 1, synopsis: '', roleProfile: {}, analysis: null, actionHistory: [],
    evidence: [{ id: randomUUID(), title: 'synthetic.pdf', originalName: 'synthetic.pdf', kind: 'pdf', mimeType: 'application/pdf', attachmentPath: 'attachments/synthetic.pdf',
      extractedText: '[p.1] 08:10 returned key', extractionStatus: 'success', visibility: 'unknown' }] };
}
function resultFor(item, page, quote, quoteSource = 'text') {
  return { overview: 'synthetic', flow: [], events: [{ timeText: '', people: [], what: quote, type: 'recorded', sourceId: item.id, page: String(page), quote, quoteSource, ambiguity: '' }],
    facts: [], hypotheses: [], unknowns: [], actions: [], retirements: [] };
}

for (const provider of ['openai', 'codex', 'ollama']) {
  test(provider + ' PDF input and saved quote checks agree, including a legacy metadata upgrade', async (t) => {
    const harness = await loadMockMain(t);
    const scenario = scenarioFixture();
    const item = scenario.evidence[0];
    const bytes = pdfFixture();
    await harness.store(scenario, provider);
    await harness.attachment(scenario, 'synthetic.pdf', bytes);
    harness.setOutput(resultFor(item, 1, '08:10 returned key'));
    const matched = await harness.analyzeCase(scenario.id, 1);
    assert.equal(matched.status, 'ok', matched.message);
    assert.equal(matched.scenario.analysis.events[0].quoteVerification, 'text_matched');
    assert.equal(matched.scenario.evidence[0].pdfPageCount, 5);
    assert.equal(matched.scenario.evidence[0].pdfPages[2].hasImages, true);
    const captured = harness.requests.at(-1);
    const serialized = JSON.stringify(captured.request);
    assert.ok(serialized.includes('[p.2] [本文抽出なし・画像あり]'));
    assert.ok(serialized.includes('[p.3] [本文抽出あり・画像あり]'));
    const schema = provider === 'openai' ? captured.request.text.format.schema : provider === 'codex' ? captured.request.schema : captured.request.format;
    assert.ok(schema.properties.events.items.required.includes('quoteSource'));
    assert.equal('quoteVerification' in schema.properties.events.items.properties, false);
    assert.equal(schema.properties.facts.items.properties.evidenceIds.minItems, 1);
    if (provider === 'openai') {
      const original = captured.request.input[0].content.find((part) => part.type === 'input_file');
      assert.deepEqual(Buffer.from(original.file_data.split(',')[1], 'base64'), bytes);
    } else if (provider === 'codex') {
      assert.equal(captured.images.length, 5);
      assert.equal(captured.images[0].subarray(1, 4).toString(), 'PNG');
      for (const part of captured.request.input.filter((entry) => entry.type === 'localImage')) await assert.rejects(fs.stat(part.path), { code: 'ENOENT' });
    } else {
      assert.deepEqual(Array.from(captured.request.messages[1].images), []);
      assert.ok(serialized.includes('PDFページ画像は送信していません'));
    }
    // Both a scan-only page and an image on a page with text must be usable.
    for (const [page, quote] of [[2, '09:00 hidden room unlocked'], [3, '10:30 lantern on']]) {
      await harness.store(scenario, provider);
      harness.setOutput(resultFor(item, page, quote, 'image'));
      const read = await harness.analyzeCase(scenario.id, 1);
      if (provider === 'ollama') {
        assert.equal(read.status, 'error');
        assert.match(read.message, /今回の入力に含めていません/);
        assert.deepEqual(await harness.read(scenario), scenario);
      } else {
        assert.equal(read.status, 'ok', read.message);
        assert.equal(read.scenario.analysis.events[0].quoteVerification, 'image_unverified');
        assert.equal(read.scenario.analysis.events[0].quoteOrigin, '画像読取・引用未照合');
      }
    }
    for (const output of [resultFor(item, 3, '08:10 returned key'), resultFor(item, 1, 'changed words'), resultFor(item, 99, 'image quote', 'image')]) {
      await harness.store(scenario, provider);
      harness.setOutput(output);
      assert.equal((await harness.analyzeCase(scenario.id, 1)).status, 'error');
      assert.deepEqual(await harness.read(scenario), scenario);
    }
    const savedBytes = await fs.readFile(path.join(harness.directory, 'cases', scenario.id, 'attachments/synthetic.pdf'));
    assert.deepEqual(savedBytes, bytes);
  });
}

test('real import records mixed PDF pages and preview IPC reaches the cited page without GUI calls', async (t) => {
  const harness = await loadMockMain(t);
  const scenario = scenarioFixture();
  scenario.evidence = [];
  await harness.store(scenario);
  const importPath = path.join(harness.directory, 'mixed.pdf');
  const bytes = pdfFixture();
  await fs.writeFile(importPath, bytes);
  harness.selectFiles([importPath]);
  const imported = await harness.invoke('scenario:add-files', scenario.id);
  const item = imported.scenario.evidence[0];
  assert.equal(item.pdfPageCount, 5);
  assert.equal(item.extractionStatus, 'mixed');
  assert.equal(item.pdfPages[4].extractionStatus, 'success');
  const request = { id: scenario.id, evidenceId: item.id, page: '2' };
  const page = await harness.invoke('scenario:read-source', request);
  assert.equal(page.pageNumber, 2);
  assert.equal(page.pageCount, 5);
  assert.equal(page.text, '');
  assert.match(page.dataUrl, /^data:image\/png;base64,/);
  assert.equal(page.pdfPages[1].hasImages, true);
  const text = await harness.invoke('scenario:read-source', { ...request, page: '3' });
  assert.equal(text.text, '10:00 courtyard closed');
  const badPage = await harness.invoke('scenario:read-source', { ...request, page: '99' });
  assert.match(badPage.error, /指定したPDFページ/);
  assert.equal(badPage.dataUrl, '');
  assert.equal(badPage.text, '');
  const invalid = await harness.invoke('scenario:read-source', { ...request, page: '2-3' });
  assert.match(invalid.error, /ページ番号/);
  await assert.rejects(harness.invoke('scenario:read-source', { ...request, id: '../other' }), /不正なシナリオID/);
  await assert.rejects(harness.invoke('scenario:read-source', { ...request, evidenceId: 'other-case-source' }), /資料が見つかりません/);
  assert.deepEqual(await fs.readFile(importPath), bytes);
});

test('legacy originals can be viewed without rewriting saved data and missing originals preserve text', async (t) => {
  const harness = await loadMockMain(t);
  const scenario = scenarioFixture();
  const item = scenario.evidence[0];
  await harness.store(scenario);
  await harness.attachment(scenario, 'synthetic.pdf', pdfFixture());
  const shown = await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id, page: '2' });
  assert.equal(shown.pageNumber, 2);
  assert.deepEqual(await harness.read(scenario), scenario);
  item.attachmentPath = 'attachments/missing.pdf';
  await harness.store(scenario);
  const missing = await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id, page: '2' });
  assert.match(missing.error, /原本を読み取れません/);
  assert.equal(missing.text, item.extractedText);
  harness.setOutput(resultFor(item, 2, 'image quote', 'image'));
  assert.equal((await harness.analyzeCase(scenario.id, 1)).status, 'error');
  assert.equal(harness.requests.length, 0);
  item.attachmentPath = 'attachments/../preferences.json';
  await harness.store(scenario);
  assert.match((await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id })).error, /原本を読み取れません/);
});

test('unreadable PDFs, page ceilings and oversized pages stop before a Codex request and preserve originals', async (t) => {
  const harness = await loadMockMain(t);
  const scenario = scenarioFixture();
  const item = scenario.evidence[0];
  for (const bytes of [Buffer.from('not a PDF'), pdfFixture(Array.from({ length: 201 }, () => ({}))), pdfFixture([{ width: 10000, height: 10000 }])]) {
    await harness.store(scenario, 'codex');
    await harness.attachment(scenario, 'synthetic.pdf', bytes);
    harness.setOutput(resultFor(item, 1, 'image quote', 'image'));
    const stopped = await harness.analyzeCase(scenario.id, 1);
    assert.equal(stopped.status, 'error');
    assert.equal(harness.requests.length, 0);
    assert.doesNotMatch(stopped.message, /分割|分けて|OCR/);
    assert.deepEqual(await harness.read(scenario), scenario);
    const display = await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id, page: '1' });
    if (bytes.toString().startsWith('not')) {
      assert.equal(display.pageCount, null);
      assert.match(display.extractionMessage, /ページ数は不明/);
      assert.ok(display.error);
    } else if (display.pageCount === 201) {
      assert.match(stopped.message, /200ページ/);
      assert.equal(display.pageNumber, 1);
      assert.match(display.dataUrl, /^data:image\/png;base64,/);
    } else assert.match(display.error, /画像化上限/);
    assert.deepEqual(await fs.readFile(path.join(harness.directory, 'cases', scenario.id, item.attachmentPath)), bytes);
  }
});

test('standalone image originals are sent and viewable, while text and fixed sources keep exact content', async (t) => {
  const harness = await loadMockMain(t);
  const scenario = scenarioFixture();
  const item = scenario.evidence[0];
  Object.assign(item, { kind: 'image', title: 'image.jpg', originalName: 'image.jpg', attachmentPath: 'attachments/image.jpg', extractedText: '', mimeType: 'image/jpeg' });
  const bytes = imageFixture();
  for (const provider of ['openai', 'ollama', 'codex']) {
    await harness.store(scenario, provider);
    await harness.attachment(scenario, 'image.jpg', bytes);
    harness.setOutput(resultFor(item, '', '09:00 hidden room unlocked', 'image'));
    const saved = await harness.analyzeCase(scenario.id, 1);
    assert.equal(saved.status, 'ok', saved.message);
    assert.equal(saved.scenario.analysis.events[0].quoteVerification, 'image_unverified');
    const preview = await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id });
    assert.deepEqual(Buffer.from(preview.dataUrl.split(',')[1], 'base64'), bytes);
  }
  scenario.analysis = { sources: [{ id: 'scenario:synopsis', kind: 'text', title: '解析した概要', extractedText: '以前の概要' }] };
  scenario.synopsis = '現在の概要';
  scenario.evidence = [{ id: item.id, kind: 'text', title: '原文', extractedText: '一字一句そのまま' }];
  await harness.store(scenario);
  assert.equal((await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: item.id })).text, '一字一句そのまま');
  assert.equal((await harness.invoke('scenario:read-source', { id: scenario.id, evidenceId: 'scenario:synopsis' })).text, '以前の概要');
});
