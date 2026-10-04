const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAnalysis, completeAction, discardAction, updateActionNotes, restoreAction } = require('../shared/analysisLifecycle.cjs');
const { getAnalysisContext } = require('../shared/analysisScope.cjs');
const { actionContextText } = require('../shared/actionHistory.cjs');

const clean = { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: [] };
const protectedInput = { ...clean, includeRoleProfile: true };
const time = '2026-10-04T01:00:00.000Z';
function action(changes = {}) {
  return { id: 'action-1', title: '鍵箱の記入者に確認する', who: '記入者', purpose: '鍵の返却時刻を確認する',
    step: '記入者に鍵が返却された時刻を聞く。', suggestedLine: '鍵が返却されたのは何時ですか。',
    rationale: '記録の意味を確かめる', secretRisk: '借りた理由を先に明かさない。', evidenceIds: [],
    assumptions: ['記入者は退場済み'], priority: 1, status: 'active', createdAt: '2026-10-04T00:00:00.000Z', grounding: clean,
    ...changes };
}
function scenario(changes = {}) {
  return { id: 'synthetic', revision: 1, evidence: [], roleProfile: { secret: 'ROLE_SECRET_MARKER' }, synopsis: '',
    analysis: { actions: [action()], grounding: clean, hypotheses: [] }, actionHistory: [], analysisHistory: [], ...changes };
}
function output(changes = {}) {
  return { overview: '記録係への確認を整理する', facts: [], flow: [], events: [], hypotheses: [], unknowns: [],
    actions: [{ ...action(), title: '返却の記録を書いた人に尋ねる', continuesActionIds: [], replacesActionIds: [], rechecks: [] }], retirements: [], ...changes };
}
function recheck(changes = {}) {
  return { actionId: 'action-1', previousPremise: '記入者は退場済み', currentPremise: '記入者が戻り再質問できる可能性がある',
    reason: '戻っているなら、まだ確かめられなかった返却時刻を確認する。', ...changes };
}

for (const status of ['completed', 'discarded']) {
  test(status + ' saves once without a reason, response or source and preserves the original action', () => {
    const base = scenario(); const before = JSON.stringify(base);
    const done = status === 'completed' ? completeAction(base, 'action-1', time) : discardAction(base, 'action-1', undefined, time);
    assert.equal(JSON.stringify(base), before);
    assert.equal(done.analysis.actions.length, 0);
    assert.equal(done.revision, 2);
    assert.equal(done.actionHistory[0].status, status);
    assert.equal(done.actionHistory[0].retiredAt, time);
    assert.equal(done.actionHistory[0].retirementReason, '');
    for (const field of ['id', 'who', 'purpose', 'step', 'assumptions', 'grounding', 'createdAt', 'evidenceIds']) assert.deepEqual(done.actionHistory[0][field], base.analysis.actions[0][field]);
    const twice = status === 'completed' ? completeAction(done, 'action-1') : discardAction(done, 'action-1');
    assert.equal(twice, done);
    assert.equal(twice.actionHistory.length, 1);
  });
  test(status + ' rejects a changed heading and rephrased steps for the same finished inquiry', () => {
    const done = status === 'completed' ? completeAction(scenario(), 'action-1', time) : discardAction(scenario(), 'action-1', '', time);
    const before = JSON.stringify(done);
    assert.throws(() => applyAnalysis(done, output(), 2), /同じ案.*前提の違い/);
    const paraphrased = output();
    paraphrased.actions[0].step = '返却時刻について本人に尋ねる。';
    assert.throws(() => applyAnalysis(done, paraphrased, 2), /同じ案/);
    assert.equal(JSON.stringify(done), before);
  });
  test(status + ' allows source-free conditional rechecks only with a recorded premise difference and keeps the explanation on continuation', () => {
    const done = status === 'completed' ? completeAction(scenario(), 'action-1', time) : discardAction(scenario(), 'action-1', '', time);
    const next = output(); next.actions[0].rechecks = [recheck()]; next.actions[0].assumptions = ['記入者が戻っている'];
    const saved = applyAnalysis(done, next, 2, time);
    assert.notEqual(saved.analysis.actions[0].id, 'action-1');
    assert.deepEqual(saved.analysis.actions[0].rechecks, [recheck()]);
    assert.deepEqual(saved.analysis.actions[0].evidenceIds, []);
    assert.equal(saved.actionHistory[0].status, status);
    const continuation = output(); continuation.actions[0].continuesActionIds = [saved.analysis.actions[0].id];
    continuation.actions[0].assumptions = ['記入者が戻っている'];
    const later = applyAnalysis(saved, continuation, 3);
    assert.deepEqual(later.analysis.actions[0].rechecks, [recheck()]);
    assert.deepEqual(later.analysis.actions[0].assumptions, ['記入者が戻っている']);
  });
}

test('a short optional reason is accepted, and later notes retain status, original time and provenance', () => {
  const skipped = discardAction(scenario(), 'action-1', '今', time);
  const saved = updateActionNotes(skipped, 'action-1', { reason: '時間がないため', resultNote: '返答はまだない' }, '2026-10-04T02:00:00.000Z');
  assert.equal(saved.actionHistory[0].retirementReason, '時間がないため');
  assert.equal(saved.actionHistory[0].resultNote, '返答はまだない');
  assert.equal(saved.actionHistory[0].retiredAt, time);
  assert.equal(saved.actionHistory[0].status, 'discarded');
  assert.deepEqual(saved.actionHistory[0].grounding, clean);
  assert.equal(saved.evidence.length, 0);
  assert.match(actionContextText(saved, false), /時間がないため/);
  assert.match(actionContextText(saved, false), /返答はまだない/);
  assert.match(actionContextText(saved, false), /事実の出典ではありません/);
});

test('similar headings do not block inquiries with a different target or purpose', () => {
  const done = completeAction(scenario(), 'action-1', time);
  for (const change of [{ who: '管理人' }, { purpose: '倉庫の別の出入口を探す', step: '倉庫の出入り方法を聞く。', suggestedLine: '他の扉がありますか。' }]) {
    const next = output(); Object.assign(next.actions[0], { title: done.actionHistory[0].title }, change);
    assert.equal(applyAnalysis(done, next, 2).analysis.actions.length, 1);
  }
  const legacy = { ...done, actionHistory: [{ id: 'old', title: done.actionHistory[0].title, status: 'completed', grounding: clean }] };
  assert.equal(applyAnalysis(legacy, output(), 2).analysis.actions.length, 1, 'a heading alone is insufficient');
});

test('invalid, unsent, unchanged and unrelated recheck premises are rejected without mutating history', () => {
  const done = completeAction(scenario(), 'action-1', time);
  const before = JSON.stringify(done);
  for (const records of [null, [{}], [recheck({ actionId: 'missing' })], [recheck({ reason: '' })],
    [recheck({ currentPremise: ' 記入者は退場済み。 ' })], [recheck({ previousPremise: '未登録の別の秘密' })], [recheck(), recheck()]]) {
    const next = output(); next.actions[0].rechecks = records;
    assert.throws(() => applyAnalysis(done, next, 2), /再確認/);
    assert.equal(JSON.stringify(done), before);
  }
  const hidden = { ...done, actionHistory: [{ ...done.actionHistory[0], grounding: protectedInput }] };
  const next = output(); next.actions[0].rechecks = [recheck()];
  assert.throws(() => applyAnalysis(hidden, next, 2), /今回送信していない/);
});

test('an ON analysis retirement reason has its own provenance even for an OFF-origin action', () => {
  const retired = applyAnalysis(scenario(), output({ actions: [], retirements: [{ actionId: 'action-1', reason: 'AI_REASON_SECRET_MARKER' }] }), 1, time, { includeRoleProfile: true });
  assert.deepEqual(retired.actionHistory[0].grounding, clean);
  assert.equal(retired.actionHistory[0].retirementGrounding.includeRoleProfile, true);
  assert.doesNotMatch(actionContextText(retired, false), /AI_REASON_SECRET_MARKER|action-1/);
  assert.match(actionContextText(retired, true), /AI_REASON_SECRET_MARKER/);
  const next = applyAnalysis(retired, output({ actions: [], retirements: [] }), 2);
  assert.deepEqual(next.actionHistory[0].retirementGrounding, retired.actionHistory[0].retirementGrounding);
  assert.equal(next.analysisHistory.length, 1);
  assert.equal(getAnalysisContext(next, false).previousContextMayIncludeRoleProfile, false);
});

test('manual ON notes and response notes stay excluded after OFF edits without laundering original provenance', () => {
  const done = completeAction(scenario(), 'action-1', time);
  const on = updateActionNotes(done, 'action-1', { reason: 'NOTE_REASON_SECRET_MARKER', resultNote: 'NOTE_ANSWER_SECRET_MARKER' }, time, { includeRoleProfile: true });
  assert.deepEqual(on.actionHistory[0].grounding, clean);
  assert.doesNotMatch(actionContextText(on, false), /NOTE_.*SECRET_MARKER|action-1/);
  const edited = updateActionNotes(on, 'action-1', { reason: 'EDITED_SECRET_MARKER', resultNote: 'ANSWER_EDITED_SECRET_MARKER' }, time);
  assert.doesNotMatch(actionContextText(edited, false), /EDITED_SECRET_MARKER|action-1/);
  assert.equal(edited.actionHistory[0].retirementGrounding.previousContextMayIncludeRoleProfile, true);
  assert.equal(edited.actionHistory[0].resultGrounding.previousContextMayIncludeRoleProfile, true);
  const unknownReason = { ...done, actionHistory: [{ ...done.actionHistory[0], retirementReason: 'LEGACY_REASON_MARKER', retirementGrounding: undefined }] };
  assert.doesNotMatch(actionContextText(unknownReason, false), /LEGACY_REASON_MARKER/);
  assert.match(actionContextText(unknownReason, true), /LEGACY_REASON_MARKER/);
});

test('completion, dismissal, note editing and explicit restore preserve protected or unknown action provenance', () => {
  for (const grounding of [protectedInput, undefined]) {
    const base = scenario({ analysis: { grounding: clean, actions: [action({ grounding })] } });
    const done = completeAction(base, 'action-1', time);
    assert.deepEqual(done.actionHistory[0].grounding, grounding);
    assert.deepEqual(getAnalysisContext(done, false).historyActionIds, []);
    const skipped = discardAction(base, 'action-1', '', time);
    const edited = updateActionNotes(skipped, 'action-1', { reason: '見送りの任意理由' }, time);
    const restored = restoreAction(edited, 'action-1', time);
    assert.deepEqual(restored.analysis.actions[0].grounding, grounding);
    assert.deepEqual(restored.actionHistory[0].grounding, grounding);
    assert.deepEqual(getAnalysisContext(restored, false).activeActionIds, []);
    assert.equal(restored.actionHistory[0].retirementReason, '見送りの任意理由');
  }
});

test('all sendable history states include their IDs, contents, original timestamp and optional notes', () => {
  const base = scenario({ analysis: { actions: [], grounding: clean }, actionHistory: ['completed', 'discarded', 'retired', 'restored'].map((status) => action({ id: status, status, retiredAt: time, retirementReason: '任意の理由', retirementGrounding: clean, resultNote: '任意の回答', resultGrounding: clean })) });
  const context = getAnalysisContext(base, false);
  assert.deepEqual(context.historyActionIds, ['completed', 'discarded', 'retired', 'restored']);
  const text = actionContextText(base, false);
  for (const value of ['completed', 'discarded', 'retired', 'restored', '記入者', '鍵の返却時刻を確認する', '記入者は退場済み', time, '任意の理由', '任意の回答']) assert.ok(text.includes(value), value);
  assert.equal(context.previousContextMayIncludeRoleProfile, false);
});

test('a later recheck acknowledges earlier completed inquiries through the latest history lineage', () => {
  const first = completeAction(scenario(), 'action-1', time);
  const next = output(); next.actions[0].rechecks = [recheck()]; next.actions[0].assumptions = ['記入者が戻っている'];
  const second = applyAnalysis(first, next, first.revision, time);
  const repeated = second.analysis.actions[0];
  const done = completeAction(second, repeated.id, time);
  const third = output();
  third.actions[0].rechecks = [recheck({ actionId: repeated.id, previousPremise: '記入者が戻っている', currentPremise: '別の記録と食い違う可能性がある', reason: '別の記録と食い違うなら、同じ記入者へ詳しい時刻を確認する' })];
  third.actions[0].assumptions = ['別の記録と食い違う'];
  assert.equal(applyAnalysis(done, third, done.revision).analysis.actions.length, 1);
  assert.equal(done.actionHistory.length, 2);
  assert.throws(() => applyAnalysis(done, output(), done.revision), /同じ案/);
});
