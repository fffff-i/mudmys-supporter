const test = require('node:test');
const assert = require('node:assert/strict');
const { getAnalysisContext, mayIncludeRoleProfile } = require('../shared/analysisScope.cjs');
const { applyAnalysis, discardAction, restoreAction } = require('../shared/analysisLifecycle.cjs');
const { unconfirmedAssumptionsText, ROLE_PROFILE_SOURCE_ID } = require('../shared/analysisSources.cjs');

const roleFree = { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: ['note'] };
const roleDerived = { ...roleFree, includeRoleProfile: true, evidenceIds: ['note', ROLE_PROFILE_SOURCE_ID] };

function action(id, grounding = roleFree, status = 'active') {
  return { id, title: id + 'の確認', who: '記録係', step: id + 'を聞く', rationale: '確認する', suggestedLine: id + 'ですか',
    purpose: '確認', secretRisk: '', priority: 1, evidenceIds: ['note'], assumptions: [id + 'が存在する'],
    status, createdAt: '2026-10-04T00:00:00.000Z', grounding };
}

function scenario(actions = [action('safe')], grounding = roleFree) {
  return { id: 'fixture', revision: 1, synopsis: '', roleProfile: {},
    evidence: [{ id: 'note', kind: 'text', extractedText: '記録がある。', extractionStatus: 'success' }],
    analysis: { overview: '以前の概要', grounding, actions, hypotheses: [{ statement: '以前の仮説', why: '可能性', evidenceIds: [], assumptions: ['条件'] }] },
    actionHistory: [] };
}

function output(actions = []) {
  return { overview: '今回の概要', facts: [{ statement: '記録がある。', evidenceIds: ['note'] }],
    flow: [], events: [], hypotheses: [], unknowns: [], retirements: [],
    actions: actions.map((entry) => ({ ...entry, continuesActionIds: [entry.id], replacesActionIds: [] })) };
}

test('only complete app-recorded role-free input conditions permit sending with profile OFF', () => {
  for (const grounding of [undefined, {}, { includeRoleProfile: false }, { ...roleFree, version: undefined },
    { ...roleFree, previousContextMayIncludeRoleProfile: undefined }, { ...roleFree, evidenceIds: undefined },
    { ...roleFree, evidenceIds: [null] }, roleDerived, { ...roleFree, previousContextMayIncludeRoleProfile: true }]) {
    assert.equal(mayIncludeRoleProfile(grounding), true);
  }
  assert.equal(mayIncludeRoleProfile(roleFree), false);
});

test('mixed restored actions and every history status are filtered using their own input conditions', () => {
  const base = scenario([action('allowed'), action('protected', roleDerived), action('unknown', undefined)]);
  delete base.analysis.actions[2].grounding;
  base.actionHistory = ['completed', 'discarded', 'retired', 'restored'].flatMap((status) => [
    action('allowed-' + status, roleFree, status), action('protected-' + status, roleDerived, status),
    { ...action('unknown-' + status, roleFree, status), grounding: undefined }
  ]);
  const before = JSON.stringify(base);
  const off = getAnalysisContext(base, false);
  assert.deepEqual(off.activeActionIds, ['allowed']);
  assert.deepEqual(off.excludedActionIds, ['protected', 'unknown']);
  assert.deepEqual(off.caseRecord.actionHistory.map((item) => item.id), ['allowed-completed', 'allowed-discarded', 'allowed-retired', 'allowed-restored']);
  assert.deepEqual(off.historyActionIds, ['allowed-completed', 'allowed-discarded', 'allowed-retired', 'allowed-restored']);
  assert.equal(off.previousContextMayIncludeRoleProfile, false);
  const on = getAnalysisContext(base, true);
  assert.equal(on.activeActionIds.length, 3);
  assert.equal(on.caseRecord.actionHistory.length, 12);
  assert.equal(on.previousContextMayIncludeRoleProfile, true);
  assert.equal(JSON.stringify(base), before);
});

test('protected summaries/hypotheses and individually safe actions are handled independently', () => {
  const base = scenario([action('allowed'), action('protected', roleDerived)], roleDerived);
  const context = getAnalysisContext(base, false);
  assert.equal(context.caseRecord.analysis.overview, undefined);
  assert.equal(context.caseRecord.analysis.hypotheses, undefined);
  const text = unconfirmedAssumptionsText(base, false);
  assert.match(text, /allowedが存在する/);
  assert.doesNotMatch(text, /以前の仮説|protected/);
});

test('excluded active IDs are locally retired while sent actions still require complete dispositions', () => {
  const base = scenario([action('allowed'), action('protected', roleDerived)]);
  const result = applyAnalysis(base, output([base.analysis.actions[0]]), 1);
  assert.deepEqual(result.analysis.actions.map((item) => item.id), ['allowed']);
  assert.deepEqual(result.analysis.grounding.contextActionIds, ['allowed']);
  assert.equal(result.actionHistory[0].id, 'protected');
  assert.deepEqual(result.actionHistory[0].grounding, roleDerived);
  assert.match(result.actionHistory[0].retirementReason, /送信設定/);
  assert.equal(result.analysis.grounding.previousContextMayIncludeRoleProfile, false);
  assert.throws(() => applyAnalysis(base, output(), 1), /更新先が決まっていない/);
  for (const changes of [
    { actions: [{ ...output([base.analysis.actions[1]]).actions[0] }] },
    { actions: [{ ...output([base.analysis.actions[0]]).actions[0], replacesActionIds: ['protected'] }] },
    { retirements: [{ actionId: 'protected', reason: '除外対象' }] }
  ]) {
    assert.throws(() => applyAnalysis(base, { ...output([base.analysis.actions[0]]), ...changes }, 1), /方針|ID/);
  }
});

test('OFF results remain protected when an actual previous input was tainted, regardless of model self-report', () => {
  const base = scenario();
  const fakeClean = { ...roleFree };
  const result = applyAnalysis(base, { ...output(base.analysis.actions), grounding: fakeClean,
    actions: output(base.analysis.actions).actions.map((item) => ({ ...item, grounding: fakeClean })) }, 1, undefined,
  { includeRoleProfile: false, previousContextMayIncludeRoleProfile: true });
  assert.equal(result.analysis.grounding.includeRoleProfile, false);
  assert.equal(result.analysis.grounding.previousContextMayIncludeRoleProfile, true);
  assert.equal(result.analysis.actions[0].grounding.previousContextMayIncludeRoleProfile, true);
  assert.deepEqual(getAnalysisContext(result, false).activeActionIds, []);
});

test('a continued/replaced action cannot clear role provenance and every retirement keeps it', () => {
  const base = scenario([action('protected', roleDerived)], roleDerived);
  for (const replace of [false, true]) {
    const entry = { ...output(base.analysis.actions).actions[0], evidenceIds: [], assumptions: [],
      continuesActionIds: replace ? [] : ['protected'], replacesActionIds: replace ? ['protected'] : [],
      grounding: roleFree };
    const result = applyAnalysis(base, { ...output(), actions: [entry], grounding: roleFree }, 1, undefined, { includeRoleProfile: true });
    assert.equal(result.analysis.actions[0].grounding.includeRoleProfile, true);
    assert.equal(result.analysis.actions[0].grounding.previousContextMayIncludeRoleProfile, true);
    assert.deepEqual(getAnalysisContext(result, false).activeActionIds, []);
    if (replace) assert.deepEqual(result.actionHistory[0].grounding, roleDerived);
  }
});

test('discard and restore retain original provenance instead of inheriting the current analysis', () => {
  for (const grounding of [roleDerived, undefined]) {
    const base = scenario([action('old')]);
    base.analysis.actions[0].grounding = grounding;
    const discarded = discardAction(base, 'old', '今は見送る');
    discarded.analysis.grounding = roleFree;
    const restored = restoreAction(discarded, 'old');
    assert.deepEqual(restored.actionHistory[0].grounding, grounding);
    assert.deepEqual(restored.analysis.actions[0].grounding, grounding);
    assert.deepEqual(getAnalysisContext(restored, false).activeActionIds, []);
    const fresh = applyAnalysis(restored, output(), restored.revision);
    assert.deepEqual(fresh.actionHistory.at(-1).grounding, grounding);
  }
});

test('protected rejected titles cannot constrain a response that never received that history', () => {
  const base = scenario([]);
  base.actionHistory = [action('same-title', roleDerived, 'discarded')];
  const next = { ...output(), actions: [{ ...action('same-title'), continuesActionIds: [], replacesActionIds: [] }] };
  const result = applyAnalysis(base, next, 1);
  assert.equal(result.analysis.actions[0].title, base.actionHistory[0].title);
  assert.deepEqual(result.actionHistory, base.actionHistory);
  assert.deepEqual(result.analysis.grounding.contextHistoryActionIds, []);
  const allowed = { ...base, actionHistory: [action('same-title', roleFree, 'discarded')] };
  assert.throws(() => applyAnalysis(allowed, next, 1), /手動で棄却/);
});
