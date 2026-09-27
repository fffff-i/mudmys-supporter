const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAnalysis, discardAction, restoreAction } = require('../shared/analysisLifecycle.cjs');

function fixture() {
  return {
    id: 'case-a', revision: 4, updatedAt: '2026-09-27T00:00:00.000Z',
    evidence: [{ id: 'ev-1', title: '温室のメモ' }],
    analysis: { actions: [{ id: 'act-1', title: '時刻を照合する', status: 'active', createdAt: '2026-09-26T00:00:00.000Z' }] },
    actionHistory: []
  };
}

function response(overrides = {}) {
  return {
    overview: '停電前後の証言を照合する段階。',
    flow: [{ moment: '午前8時', summary: '温室で音を聞いたという証言。', evidenceIds: ['ev-1'] }],
    facts: [{ statement: '証言では8時ごろに音がした。', evidenceIds: ['ev-1'] }],
    hypotheses: [], unknowns: [],
    actions: [{ title: '時刻を照合する', step: '二人へ停電の時刻を確認する。', rationale: '時刻のずれが未確認。', priority: 1, evidenceIds: ['ev-1'], continuesActionIds: ['act-1'], replacesActionIds: [] }],
    retirements: [], ...overrides
  };
}

test('keeps action identity while updating a plan from cited evidence', () => {
  const updated = applyAnalysis(fixture(), response(), 4, '2026-09-27T01:00:00.000Z');
  assert.equal(updated.analysis.actions[0].id, 'act-1');
  assert.equal(updated.analysis.inputRevision, 4);
  assert.equal(updated.revision, 5);
});

test('rejects evidence IDs that do not exist in this scenario', () => {
  assert.throws(() => applyAnalysis(fixture(), response({ facts: [{ statement: 'x', evidenceIds: ['case-b-secret'] }] }), 4), /存在しない資料ID/);
});

test('rejects stale analysis without touching newer scenario state', () => {
  assert.throws(() => applyAnalysis(fixture(), response(), 3), /新しい変更/);
});

test('requires a disposition for every active action and a reason for retirement', () => {
  const missing = response({ actions: [{ title: '別の案', step: '聞く', rationale: '確認', priority: 1, evidenceIds: ['ev-1'], continuesActionIds: [], replacesActionIds: [] }] });
  assert.throws(() => applyAnalysis(fixture(), missing, 4), /更新先が決まっていない/);
  const noReason = response({ actions: [], retirements: [{ actionId: 'act-1', reason: '' }] });
  assert.throws(() => applyAnalysis(fixture(), noReason, 4), /理由がありません/);
});

test('a dismissed action cannot silently return after later analysis', () => {
  const dismissed = discardAction(fixture(), 'act-1', '相手の証言と矛盾し、現状では意味がない。', '2026-09-27T01:00:00.000Z');
  const later = { ...dismissed, revision: 5, evidence: [...dismissed.evidence, { id: 'ev-2', title: '新しい証言' }] };
  const revived = response({ actions: [{ title: '時刻を照合する', step: '二人に再度聞く。', rationale: '時刻の一致を見る。', priority: 1, evidenceIds: ['ev-1'], continuesActionIds: [], replacesActionIds: [] }], retirements: [] });
  assert.throws(() => applyAnalysis(later, revived, 5), /手動で棄却/);
  assert.equal(dismissed.actionHistory[0].status, 'discarded');
});

test('a dismissed action returns only after an explicit restore operation', () => {
  const dismissed = discardAction(fixture(), 'act-1', 'ひとまず保留にする。', '2026-09-27T01:00:00.000Z');
  const restored = restoreAction(dismissed, 'act-1', '2026-09-27T02:00:00.000Z');
  assert.equal(restored.analysis.actions.at(-1).restoredFromId, 'act-1');
  assert.equal(restored.actionHistory[0].status, 'restored');
});

test('replaced actions move to history with an explicit replacement link', () => {
  const output = response({ actions: [{ title: '停電の証言を人物別に確認', step: 'アキとレンに時刻を別々に聞く。', rationale: '時刻が食い違う。', priority: 1, evidenceIds: ['ev-1'], continuesActionIds: [], replacesActionIds: ['act-1'] }] });
  const updated = applyAnalysis(fixture(), output, 4, '2026-09-27T01:00:00.000Z');
  assert.equal(updated.actionHistory[0].status, 'retired');
  assert.equal(updated.actionHistory[0].replacedByActionId, updated.analysis.actions[0].id);
  assert.match(updated.actionHistory[0].retirementReason, /置き換え/);
});

test('text and extracted PDF event quotes must match the source, allowing only whitespace changes', () => {
  const base = fixture();
  base.evidence = [{ id: 'ev-1', title: 'statement', kind: 'text', extractionStatus: 'success', extractedText: 'Xは20時にAにいたと話した。' }];
  const exact = response({ events: [{ timeText: '20時', people: ['X'], what: 'XがAにいたと発言した。', type: 'reported', sourceId: 'ev-1', page: '', quote: 'Xは20時にAにいたと話した。', ambiguity: '発言内容は別資料で未確認。' }] });
  const saved = applyAnalysis(base, exact, 4);
  assert.equal(saved.analysis.events[0].quoteOrigin, 'テキスト抽出と原文一致');
  const paraphrase = response({ events: [{ ...exact.events[0], quote: 'Xが午後8時にAにいたと言った。' }] });
  assert.throws(() => applyAnalysis(base, paraphrase, 4), /原文に一致しない/);
});

test('image-derived event quotes are labelled as unverified', () => {
  const base = fixture();
  base.evidence = [{ id: 'ev-1', title: 'screenshot', kind: 'image' }];
  const output = response({ events: [{ timeText: '夕方', people: ['X?'], what: 'メッセージが表示されている。', type: 'recorded', sourceId: 'ev-1', page: '', quote: 'Aにいた', ambiguity: '人物の呼び名が一致するか不明。' }] });
  const saved = applyAnalysis(base, output, 4);
  assert.match(saved.analysis.events[0].quoteOrigin, /未検証/);
});
