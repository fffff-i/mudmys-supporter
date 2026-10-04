const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { evidenceHarness } = require('../scripts/evidenceHarness.cjs');
const { applyAnalysis, completeAction, updateActionNotes } = require('../shared/analysisLifecycle.cjs');
const { getAnalysisContext } = require('../shared/analysisScope.cjs');
const { evidenceBody, evidenceUsage, inferEvidenceTitle } = require('../shared/evidence.mjs');
const { verifyEventQuote, sourceInputsForRows } = require('../shared/pdfSources.cjs');
const { pdfFixture, imageFixture } = require('../test-support/pdfFixtures.cjs');

const originalImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const imageUrl = 'data:image/png;base64,' + originalImage.toString('base64');
const origin = (ids, extra = {}) => ({ version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: ids, ...extra });
const action = (id, grounding, extra = {}) => ({ id, title: id, who: '架空の管理人', step: '架空の記録を確認する', purpose: '確認', rationale: '未確認',
  priority: 1, evidenceIds: [], assumptions: [], status: 'active', createdAt: '2026-10-05T00:00:00Z', grounding, ...extra });
const output = (id, extra = {}) => ({ overview: 'synthetic result', flow: [], events: [], facts: id ? [{ statement: 'synthetic fact', evidenceIds: [id] }] : [],
  hypotheses: [], unknowns: [], actions: [], retirements: [], ...extra });

test('one explicit batch stores text, multiple files and pasted images with inferred names and unknown scope', async (t) => {
  const h = await evidenceHarness(t);
  const scenario = await h.invoke('scenario:create', '架空の資料追加');
  h.controls.paths = [await h.fixture('配布HO.md', Buffer.from('役と目的はHOに含まれる。')), await h.fixture('記録.txt', Buffer.from('短い原文'))];
  const selected = await h.invoke('scenario:choose-files', scenario.id);
  assert.equal((await h.read(scenario.id)).revision, scenario.revision);
  assert.equal(h.requests.length, 0);
  assert.equal(selected.files.some((file) => 'sourcePath' in file), false);
  const saved = await h.invoke('scenario:add-evidence', { id: scenario.id, text: '\n# 新しい証言\n本文は原文のまま。',
    fileTokens: selected.files.map((file) => file.token), images: [{ dataUrl: imageUrl }, { dataUrl: imageUrl }] });
  assert.equal(saved.evidence.length, 5);
  assert.equal(saved.revision, scenario.revision + 1);
  assert.deepEqual(Array.from(saved.evidence, (item) => item.title), ['新しい証言', '配布HO.md', '記録.txt', '貼り付け画像.png', '貼り付け画像.png']);
  assert.ok(saved.evidence.every((item) => item.visibility === 'unknown'));
  assert.equal(saved.roleProfile.role, '');
  assert.equal(saved.evidence[0].extractedText, '\n# 新しい証言\n本文は原文のまま。');
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.invoke('scenario:add-evidence', { id: scenario.id, fileTokens: [selected.files[0].token] }), /選択済み/);
  assert.equal(inferEvidenceTitle('指定の名前', '本文', '元資料.txt'), '指定の名前');
});

test('oversize and vanished candidates do not partially register earlier files, and removing a candidate recovers in the same scenario', async (t) => {
  const h = await evidenceHarness(t);
  const scenario = await h.invoke('scenario:create', '架空の上限');
  const valid = await h.fixture('valid.txt', Buffer.from('保持したい本文'));
  const oversized = await h.fixture('too-large.png', Buffer.alloc(20 * 1024 * 1024 + 1));
  h.controls.paths = [valid, oversized];
  const selected = await h.invoke('scenario:choose-files', scenario.id);
  assert.match(selected.files[1].error, /20MiB/);
  await assert.rejects(h.invoke('scenario:add-evidence', { id: scenario.id, text: '入力中の本文', fileTokens: selected.files.map((file) => file.token) }), /20MiB/);
  assert.equal((await h.read(scenario.id)).evidence.length, 0);
  await assert.rejects(fs.readdir(path.join(h.directory, 'cases', scenario.id, 'attachments')), { code: 'ENOENT' });
  await h.invoke('scenario:release-files', { id: scenario.id, tokens: [selected.files[1].token] });
  const saved = await h.invoke('scenario:add-evidence', { id: scenario.id, text: '入力中の本文', fileTokens: [selected.files[0].token] });
  assert.equal(saved.evidence.length, 2);
  h.controls.paths = [valid];
  const gone = await h.invoke('scenario:choose-files', scenario.id);
  await fs.rm(valid);
  await assert.rejects(h.invoke('scenario:add-evidence', { id: scenario.id, fileTokens: [gone.files[0].token] }), { code: 'ENOENT' });
  assert.equal((await h.read(scenario.id)).evidence.length, 2);
});

test('file capabilities are scenario-owned and failed final storage rolls back only the new attachments', async (t) => {
  const h = await evidenceHarness(t);
  const a = await h.invoke('scenario:create', 'A');
  const b = await h.invoke('scenario:create', 'B');
  h.controls.paths = [await h.fixture('fixture.png', originalImage)];
  const selected = await h.invoke('scenario:choose-files', a.id);
  const payload = { id: a.id, fileTokens: [selected.files[0].token] };
  await assert.rejects(h.invoke('scenario:add-evidence', { ...payload, id: b.id }), /このシナリオ/);
  h.controls.failWrite = true;
  await assert.rejects(h.invoke('scenario:add-evidence', payload), /Synthetic write failure/);
  assert.equal((await h.read(a.id)).evidence.length, 0);
  assert.deepEqual(await fs.readdir(path.join(h.directory, 'cases', a.id, 'attachments')), []);
  h.controls.failWrite = false;
  const recovered = await h.invoke('scenario:add-evidence', payload);
  assert.deepEqual(await fs.readFile(path.join(h.directory, 'cases', a.id, recovered.evidence[0].attachmentPath)), originalImage);
  if (process.platform === 'win32') {
    h.controls.renameFailures = 1;
    const busyRecovered = await h.invoke('scenario:add-evidence', { id: a.id, text: '一時的なファイル使用中から復帰' });
    assert.equal(busyRecovered.evidence.length, 2);
    assert.equal((await h.read(a.id)).evidence.length, 2);
  }
});

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' sends edited PDF and image prose with honest quote verification and preserves binary originals', async (t) => {
    const h = await evidenceHarness(t);
    let scenario = await h.invoke('scenario:create', '架空のPDF・画像編集');
    const originals = [pdfFixture([{ text: 'PDF_ORIGINAL_MARKER' }]), imageFixture('IMAGE_ORIGINAL_MARKER')];
    h.controls.paths = [await h.fixture('原本.pdf', originals[0]), await h.fixture('原本.jpg', originals[1])];
    const selected = await h.invoke('scenario:choose-files', scenario.id);
    scenario = await h.invoke('scenario:add-evidence', { id: scenario.id, fileTokens: selected.files.map((file) => file.token) });
    for (const item of scenario.evidence) {
      scenario = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: item.id, expectedUpdatedAt: item.createdAt,
        title: '編集した' + item.kind, text: 'EDITED_' + item.kind });
    }
    await h.store(scenario, provider);
    h.controls.output = output(scenario.evidence[0].id, { events: scenario.evidence.map((item) => ({
      sourceId: item.id, quote: 'EDITED_' + item.kind, quoteSource: 'edited', page: '', timeText: '', people: [], what: 'edited', type: 'recorded', ambiguity: ''
    })) });
    const result = await h.analyzeCase(scenario.id, scenario.revision);
    assert.equal(result.status, 'ok', result.message);
    const sent = JSON.stringify(h.requests.at(-1).request);
    assert.match(sent, /EDITED_pdf/); assert.match(sent, /EDITED_image/);
    assert.doesNotMatch(sent, /PDF_ORIGINAL_MARKER/);
    assert.ok(result.scenario.analysis.events.every((event) => event.quoteVerification === 'edited_text_matched' && event.page === ''));
    for (let index = 0; index < scenario.evidence.length; index++) {
      assert.deepEqual(await fs.readFile(path.join(h.directory, 'cases', scenario.id, scenario.evidence[index].attachmentPath)), originals[index]);
    }
  });

  test(provider + ' excludes raw materials and every derived input, including source-free records and unknown origins', async (t) => {
    const h = await evidenceHarness(t);
    let scenario = await h.invoke('scenario:create', '架空の除外');
    h.controls.modalities = ['text'];
    scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: 'SAFE_BODY' });
    const safeId = scenario.evidence[0].id;
    const excludedId = randomUUID();
    const derived = origin([safeId, excludedId]);
    scenario.evidence.push({ id: excludedId, title: 'EXCLUDED_TITLE_MARKER', kind: 'pdf', extractedText: 'EXCLUDED_BODY_MARKER',
      byteSize: 80 * 1024 * 1024, attachmentPath: 'attachments/not-present.pdf', visibility: 'unknown', analysisEnabled: false });
    scenario.analysis = { overview: 'EXCLUDED_OVERVIEW_MARKER', grounding: derived, revision: scenario.revision, actions: [action('EXCLUDED_ACTION_MARKER', derived)],
      hypotheses: [{ statement: 'EXCLUDED_HYPOTHESIS_MARKER', why: 'EXCLUDED_WHY_MARKER', assumptions: ['EXCLUDED_ASSUMPTION_MARKER'], evidenceIds: [] }] };
    scenario.actionHistory = [action('EXCLUDED_HISTORY_MARKER', derived, { status: 'completed' }), action('UNKNOWN_ORIGIN_MARKER', undefined, { status: 'discarded' })];
    await h.store(scenario, provider, true);
    h.controls.output = output(safeId, { hypotheses: [{ statement: '安全な確認', why: '未確認', assumptions: [], evidenceIds: [] }] });
    const result = await h.analyzeCase(scenario.id, scenario.revision);
    assert.equal(result.status, 'ok', result.message);
    const request = JSON.stringify(h.requests.at(-1).request);
    assert.doesNotMatch(request, /EXCLUDED_|UNKNOWN_ORIGIN_MARKER|not-present/);
    assert.match(request, /SAFE_BODY/);
    assert.equal(h.reads.some((filename) => filename.endsWith('not-present.pdf')), false);
    assert.equal(result.attachmentBytes, 0);
    assert.equal(result.scenario.analysisHistory[0].overview, 'EXCLUDED_OVERVIEW_MARKER');
    assert.equal(result.scenario.actionHistory.find((item) => item.id === 'EXCLUDED_ACTION_MARKER').status, 'retired');
    assert.match(result.scenario.actionHistory.find((item) => item.id === 'EXCLUDED_ACTION_MARKER').retirementReason, /資料/);
    assert.equal(result.scenario.analysis.sources.some((item) => item.id === excludedId), false);
    h.controls.output = output(excludedId);
    const rejected = await h.analyzeCase(result.scenario.id, result.scenario.revision);
    assert.equal(rejected.status, 'error');
    assert.match(rejected.message, /今回送信していない/);
  });

  test(provider + ' edited text is sent and matched as edited content, while history and ordinary reanalysis retain earlier source versions', async (t) => {
    const h = await evidenceHarness(t);
    let scenario = await h.invoke('scenario:create', '架空の編集');
    scenario = await h.invoke('scenario:add-text', { id: scenario.id, title: '元の見出し', text: 'ORIGINAL_BODY' });
    const id = scenario.evidence[0].id;
    await h.store(scenario, provider);
    h.controls.output = output(id, { actions: [{ ...action('ignored', undefined), title: '元の確認', evidenceIds: [id], continuesActionIds: [], replacesActionIds: [] }] });
    let analyzed = await h.analyzeCase(scenario.id, scenario.revision);
    assert.equal(analyzed.status, 'ok', analyzed.message);
    const completed = await h.invoke('scenario:complete-action', { id: scenario.id, actionId: analyzed.scenario.analysis.actions[0].id });
    let item = completed.evidence[0];
    scenario = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: id, expectedUpdatedAt: item.createdAt, title: '編集した見出し', text: 'EDITED_BODY' });
    assert.equal(scenario.evidence[0].extractedText, 'ORIGINAL_BODY');
    assert.equal(scenario.evidence[0].originalTitle, '元の見出し');
    await assert.rejects(h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: id, expectedUpdatedAt: item.createdAt, title: '', text: 'stale edit' }), /別の操作/);
    h.controls.output = output(id, { events: [{ sourceId: id, quote: 'EDITED_BODY', quoteSource: 'edited', page: '', timeText: '', people: [], what: 'edited', type: 'recorded', ambiguity: '' }] });
    analyzed = await h.analyzeCase(scenario.id, scenario.revision);
    assert.equal(analyzed.status, 'ok', analyzed.message);
    const request = JSON.stringify(h.requests.at(-1).request);
    assert.match(request, /EDITED_BODY/);
    assert.doesNotMatch(request, /ORIGINAL_BODY/);
    assert.equal(analyzed.scenario.analysis.events[0].quoteVerification, 'edited_text_matched');
    const historical = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, analysisIndex: 0 });
    assert.equal(historical.text, 'ORIGINAL_BODY');
    assert.equal(historical.editedText, undefined);
    const actionSource = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, actionId: completed.actionHistory[0].id });
    assert.equal(actionSource.text, 'ORIGINAL_BODY');
    assert.equal(actionSource.editedText, undefined);
    const current = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id });
    assert.equal(current.editedText, 'EDITED_BODY');
    item = analyzed.scenario.evidence[0];
    const editedAgain = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: id, expectedUpdatedAt: item.updatedAt, title: '', text: 'LATER_BODY' });
    assert.equal((await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id })).editedText, 'EDITED_BODY');
    assert.equal((await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, current: true })).editedText, 'LATER_BODY');
    h.controls.output = output(id);
    const latest = await h.analyzeCase(editedAgain.id, editedAgain.revision);
    assert.equal(latest.status, 'ok', latest.message);
    assert.equal((await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, analysisIndex: 1 })).editedText, 'EDITED_BODY');
    assert.equal((await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, actionId: completed.actionHistory[0].id })).editedText, undefined);
  });

  test(provider + ' later history notes keep source origin across repeated edits and stop being sent when a note-time material is excluded', async (t) => {
    const h = await evidenceHarness(t);
    let scenario = await h.invoke('scenario:create', '架空の回答メモ');
    scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: '最初の資料' });
    const firstId = scenario.evidence[0].id;
    scenario.analysis = { revision: scenario.revision, actions: [action('safe-action', origin([firstId]))], grounding: origin([firstId]) };
    await h.store(scenario, provider);
    scenario = await h.invoke('scenario:complete-action', { id: scenario.id, actionId: 'safe-action' });
    scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: 'NOTE_TIME_EVIDENCE_MARKER' });
    const noteTimeId = scenario.evidence.at(-1).id;
    scenario = await h.invoke('scenario:action-notes', { id: scenario.id, actionId: 'safe-action', reason: 'NOTE_REASON_MARKER', resultNote: 'NOTE_RESULT_MARKER' });
    assert.equal(scenario.actionHistory[0].resultGrounding.evidenceIds.includes(noteTimeId), true);
    assert.equal(scenario.actionHistory[0].resultGrounding.evidenceIds.includes(firstId), true);
    scenario = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: noteTimeId, enabled: false });
    scenario = await h.invoke('scenario:action-notes', { id: scenario.id, actionId: 'safe-action', resultNote: 'NOTE_EDITED_MARKER' });
    assert.equal(scenario.actionHistory[0].resultGrounding.evidenceIds.includes(noteTimeId), true);
    h.controls.output = output(firstId);
    const result = await h.analyzeCase(scenario.id, scenario.revision);
    assert.equal(result.status, 'ok', result.message);
    assert.doesNotMatch(JSON.stringify(h.requests.at(-1).request), /NOTE_|safe-action/);
    assert.equal(result.scenario.actionHistory[0].resultNote, 'NOTE_EDITED_MARKER');
  });

  test(provider + ' exclusion during an in-flight response preserves originals and rejects that stale result', async (t) => {
    const h = await evidenceHarness(t);
    let scenario = await h.invoke('scenario:create', '架空の遅延');
    scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: '入力した資料' });
    await h.store(scenario, provider);
    h.controls.output = output(scenario.evidence[0].id);
    let release, entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    h.controls.turn = async () => { entered(); await gate; };
    const pending = h.analyzeCase(scenario.id, scenario.revision);
    await ready;
    const newer = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: scenario.evidence[0].id, enabled: false });
    release();
    assert.equal((await pending).status, 'stale');
    assert.equal((await h.read(scenario.id)).revision, newer.revision);
    assert.equal(newer.evidence[0].extractedText, '入力した資料');
  });
}

test('40MiB and 300000-character limits can be recovered by exclusion or editing without deleting the scenario', async (t) => {
  const h = await evidenceHarness(t);
  let scenario = await h.invoke('scenario:create', '架空の復帰');
  const originals = [];
  for (let index = 0; index < 3; index++) {
    scenario = await h.invoke('scenario:add-pasted-image', { id: scenario.id, dataUrl: imageUrl });
    const item = scenario.evidence.at(-1);
    const filename = path.join(h.directory, 'cases', scenario.id, item.attachmentPath);
    const bytes = Buffer.alloc(index === 2 ? 1 : 20 * 1024 * 1024);
    await fs.writeFile(filename, bytes);
    item.byteSize = bytes.length;
    await h.store(scenario);
    originals.push(filename);
  }
  await h.store(scenario);
  await assert.rejects(h.evidenceForRequest(scenario, false, 'openai'), /40MiB.*同じシナリオ/);
  const excluded = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: scenario.evidence[2].id, enabled: false });
  const request = await h.evidenceForRequest(excluded, false, 'openai');
  assert.equal(request.attachmentBytes, 40 * 1024 * 1024);
  assert.equal(evidenceUsage(excluded).attachmentBytes, request.attachmentBytes);
  assert.equal(evidenceUsage(excluded).retainedBytes, request.attachmentBytes + 1);
  assert.equal((await fs.stat(originals[2])).size, 1);
  const restored = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: scenario.evidence[2].id, enabled: true });
  await assert.rejects(h.evidenceForRequest(restored, false, 'openai'), /40MiB/);
  scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: '字'.repeat(300001) });
  for (const item of scenario.evidence.filter((item) => item.kind === 'image')) scenario = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: item.id, enabled: false });
  await assert.rejects(h.evidenceForRequest(scenario, false, 'ollama'), /30万文字/);
  const text = scenario.evidence.at(-1);
  scenario = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: text.id, expectedUpdatedAt: text.createdAt, title: '', text: '字'.repeat(300000) });
  assert.equal((await h.evidenceForRequest(scenario, false, 'ollama')).textCharacters, 300000);
  assert.equal(evidenceUsage(scenario).textCharacters, 300000);
  assert.equal(evidenceBody(scenario.evidence.at(-1)).length, 300000);
  assert.equal(scenario.evidence.at(-1).extractedText.length, 300001);
});

test('all result reference fields reject excluded evidence, including explicit sent IDs and image events', () => {
  const excluded = { id: 'excluded', kind: 'image', analysisEnabled: false, extractedText: 'original' };
  const base = { revision: 1, evidence: [excluded], actionHistory: [] };
  for (const field of ['flow', 'facts', 'hypotheses', 'unknowns', 'actions']) {
    assert.throws(() => applyAnalysis(base, output(null, { [field]: [{ evidenceIds: [excluded.id] }] }), 1, undefined, { evidenceIds: [excluded.id] }), /資料ID/);
  }
  assert.throws(() => applyAnalysis(base, output(null, { events: [{ sourceId: excluded.id, quote: 'original', quoteSource: 'image' }] }), 1), /資料ID/);
});

test('Codex PDF page-limit failure recovers by exclusion in the same scenario and remains enforceable after restoration', async (t) => {
  const h = await evidenceHarness(t);
  let scenario = await h.invoke('scenario:create', '架空のページ上限復帰');
  scenario = await h.invoke('scenario:add-text', { id: scenario.id, text: '安全な短い資料' });
  const safeId = scenario.evidence[0].id;
  const original = pdfFixture(Array.from({ length: 201 }, () => ({ text: 'synthetic page' })));
  h.controls.paths = [await h.fixture('201-pages.pdf', original)];
  const selected = await h.invoke('scenario:choose-files', scenario.id);
  scenario = await h.invoke('scenario:add-evidence', { id: scenario.id, fileTokens: [selected.files[0].token] });
  const pdf = scenario.evidence.at(-1);
  await h.store(scenario, 'codex'); h.controls.output = output(safeId);
  const stopped = await h.analyzeCase(scenario.id, scenario.revision);
  assert.equal(stopped.status, 'error'); assert.match(stopped.message, /200ページ.*同じシナリオ/); assert.equal(h.requests.length, 0);
  scenario = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: pdf.id, enabled: false });
  h.controls.modalities = ['text'];
  assert.equal((await h.analyzeCase(scenario.id, scenario.revision)).status, 'ok');
  scenario = await h.invoke('scenario:set-evidence-enabled', { id: scenario.id, evidenceId: pdf.id, enabled: true });
  h.controls.modalities = ['text', 'image'];
  assert.equal((await h.analyzeCase(scenario.id, scenario.revision)).status, 'error');
  assert.deepEqual(await fs.readFile(path.join(h.directory, 'cases', scenario.id, pdf.attachmentPath)), original);
});

test('editing PDF/image bodies does not weaken original page checks or let edited prose masquerade as original text', () => {
  const pdf = { id: 'pdf', kind: 'pdf', attachmentPath: 'attachments/pdf.pdf', editedText: 'EDITED', extractedText: 'ORIGINAL',
    pdfMetadataVersion: 1, pdfPageCount: 1, pdfPages: [{ pageNumber: 1, text: 'ORIGINAL', hasImages: true, readable: true }] };
  const inputs = sourceInputsForRows([{ item: pdf, bytes: Buffer.from('synthetic') }], 'openai').pdf;
  assert.equal(verifyEventQuote({ quote: 'EDITED', quoteSource: 'edited', page: '1' }, pdf, inputs).page, '');
  assert.throws(() => verifyEventQuote({ quote: 'EDITED', quoteSource: 'text', page: '1' }, pdf, inputs), /今回送信していません/);
  assert.throws(() => verifyEventQuote({ quote: 'ORIGINAL', quoteSource: 'text', page: '1' }, pdf, inputs), /今回送信していません/);
  assert.equal(verifyEventQuote({ quote: '原本画像に見える記録', quoteSource: 'image', page: '1' }, pdf, inputs).quoteVerification, 'image_unverified');
  assert.throws(() => verifyEventQuote({ quote: '原本画像に見える記録', quoteSource: 'image', page: '1' }, pdf, sourceInputsForRows([{ item: pdf, bytes: Buffer.from('synthetic') }], 'ollama').pdf), /今回の入力/);
  assert.throws(() => verifyEventQuote({ quote: 'OTHER', quoteSource: 'edited' }, pdf, inputs), /一致しない/);
  const image = { id: 'image', kind: 'image', editedText: '画像への補足' };
  assert.equal(verifyEventQuote({ quote: '画像への補足', quoteSource: 'edited' }, image, { editedTextSent: true }).quoteVerification, 'edited_text_matched');
});

test('unknown context origins stay unknown through ON analysis and manual-note edits, preventing laundering when any material is excluded', () => {
  const id = 'current';
  const base = { revision: 1, evidence: [{ id, kind: 'text', extractedText: '原文' }], actionHistory: [],
    analysis: { actions: [action('old', undefined)], hypotheses: [], grounding: undefined } };
  const first = applyAnalysis(base, output(id, { actions: [{ ...action('old', undefined), continuesActionIds: ['old'], replacesActionIds: [] }] }), 1, undefined, { includeRoleProfile: true });
  assert.equal(first.analysis.grounding.evidenceOriginUnknown, true);
  const completed = completeAction(first, first.analysis.actions[0].id);
  const noted = updateActionNotes(completed, completed.actionHistory[0].id, { resultNote: '古い由来のメモ' });
  const excluded = { ...noted, evidence: [...noted.evidence, { id: 'another', analysisEnabled: false }] };
  assert.deepEqual(getAnalysisContext(excluded, true).caseRecord.actionHistory, []);
});

test('replacing an action after editing retains its old source and the archived action opens by analysis index', async (t) => {
  const h = await evidenceHarness(t);
  let scenario = await h.invoke('scenario:create', '架空の置き換え');
  scenario = await h.invoke('scenario:add-text', { id: scenario.id, title: 'OLD_TITLE', text: 'OLD_BODY' });
  const id = scenario.evidence[0].id;
  await h.store(scenario, 'openai');
  h.controls.output = output(id, { actions: [{ ...action('ignored', undefined), evidenceIds: [id], continuesActionIds: [], replacesActionIds: [] }] });
  const first = await h.analyzeCase(scenario.id, scenario.revision);
  assert.equal(first.status, 'ok');
  const oldActionId = first.scenario.analysis.actions[0].id;
  scenario = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: id, expectedUpdatedAt: scenario.evidence[0].createdAt,
    title: 'NEW_TITLE', text: 'NEW_BODY' });
  h.controls.output = output(id, { actions: [{ ...action('ignored', undefined), evidenceIds: [id], continuesActionIds: [], replacesActionIds: [oldActionId] }] });
  const second = await h.analyzeCase(scenario.id, scenario.revision);
  assert.equal(second.status, 'ok', second.message);
  const old = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, actionId: oldActionId });
  assert.equal(old.title, 'OLD_TITLE'); assert.equal(old.text, 'OLD_BODY'); assert.equal(old.editedText, undefined);
  const archived = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, analysisIndex: 0 });
  assert.equal(archived.title, 'OLD_TITLE');
  assert.equal((await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id })).title, 'NEW_TITLE');
});

test('legacy history without a source snapshot never displays latest edits as its saved evidence', async (t) => {
  const h = await evidenceHarness(t);
  let scenario = await h.invoke('scenario:create', '架空の旧データ');
  scenario = await h.invoke('scenario:add-text', { id: scenario.id, title: 'FIRST_TITLE', text: 'FIRST_BODY' });
  const id = scenario.evidence[0].id;
  scenario.analysis = { revision: scenario.revision, inputRevision: scenario.revision, actions: [] };
  scenario.actionHistory = [action('legacy', undefined, { evidenceIds: [id], status: 'completed' })];
  scenario.analysisHistory = [{ revision: 0, inputRevision: 0, actions: [] }];
  await h.store(scenario);
  scenario = await h.invoke('scenario:edit-evidence', { id: scenario.id, evidenceId: id, expectedUpdatedAt: scenario.evidence[0].createdAt, title: 'LATEST_TITLE', text: 'LATEST_BODY' });
  for (const scope of [{ actionId: 'legacy' }, { analysisIndex: 0 }]) {
    const old = await h.invoke('scenario:read-source', { id: scenario.id, evidenceId: id, ...scope });
    assert.equal(old.title, 'FIRST_TITLE'); assert.equal(old.text, 'FIRST_BODY');
    assert.equal(old.editedText, undefined); assert.equal(old.snapshotUnavailable, true);
  }
});
