const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAnalysis, discardAction, restoreAction } = require('../shared/analysisLifecycle.cjs');
const { SYNOPSIS_SOURCE_ID, ROLE_PROFILE_SOURCE_ID, unconfirmedAssumptionsText } = require('../shared/analysisSources.cjs');

function fixture() {
  return {
    id: 'case-a', revision: 4, updatedAt: '2026-09-27T00:00:00.000Z',
    evidence: [{ id: 'ev-1', title: '温室のメモ' }],
    analysis: { grounding: { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: ['ev-1'] }, actions: [{ id: 'act-1', title: '時刻を照合する', status: 'active', createdAt: '2026-09-26T00:00:00.000Z', grounding: { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: ['ev-1'] } }] },
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

test('facts require at least one existing source, while hypotheses and actions allow no sources', () => {
  const base = fixture();
  assert.throws(() => applyAnalysis(base, response({ facts: [{ statement: '資料にない断定', evidenceIds: [] }] }), 4), /事実には実在する出典/);
  const output = response({
    hypotheses: [{ statement: '別の出入口があるなら両立するかもしれない。', why: '可能性を確認する。', evidenceIds: [], assumptions: ['別の出入口が存在する'] }],
    actions: [{ ...response().actions[0], evidenceIds: [], assumptions: ['別の出入口が存在する'] }]
  });
  const saved = applyAnalysis(base, output, 4);
  assert.deepEqual(saved.analysis.hypotheses[0].evidenceIds, []);
  assert.deepEqual(saved.analysis.actions[0].evidenceIds, []);
  assert.deepEqual(saved.analysis.hypotheses[0].assumptions, ['別の出入口が存在する']);
  assert.deepEqual(saved.analysis.actions[0].assumptions, ['別の出入口が存在する']);
  const ordinary = applyAnalysis(base, response({ actions: [{ ...response().actions[0], evidenceIds: [], assumptions: [] }] }), 4);
  assert.deepEqual(ordinary.analysis.actions[0].assumptions, []);
});

test('all optional references still reject unknown, non-string and unsent source IDs', () => {
  for (const field of ['flow', 'facts', 'hypotheses', 'unknowns', 'actions']) {
    for (const id of ['missing-source', 1, null, {}]) {
      const output = response({ [field]: [{ ...response()[field]?.[0], evidenceIds: [id] }] });
      assert.throws(() => applyAnalysis(fixture(), output, 4), /存在しない資料ID/);
    }
  }
  const subset = { evidenceIds: [] };
  assert.throws(() => applyAnalysis(fixture(), response(), 4, undefined, subset), /今回送信していない/);
});

test('unconfirmed conditions survive subsequent output and cannot be promoted using AI output as a source', () => {
  const conditional = {
    statement: '別の出入口があるなら廊下の目撃と両立するかもしれない。', why: 'まだ資料にない可能性。',
    evidenceIds: [], assumptions: ['別の出入口が存在する']
  };
  const first = applyAnalysis(fixture(), response({ hypotheses: [conditional], actions: [{ ...response().actions[0], evidenceIds: [], assumptions: conditional.assumptions }] }), 4);
  assert.match(unconfirmedAssumptionsText(first, false), /別の出入口が存在する/);
  assert.match(unconfirmedAssumptionsText(first, false), /事実の出典ではありません/);
  const secondOutput = response({ hypotheses: [conditional], actions: [{ ...response().actions[0], evidenceIds: [], assumptions: conditional.assumptions }] });
  const second = applyAnalysis(first, secondOutput, 5);
  assert.deepEqual(second.analysis.hypotheses[0].assumptions, conditional.assumptions);
  assert.deepEqual(second.analysis.actions[0].assumptions, conditional.assumptions);
  const snapshot = JSON.stringify(second);
  for (const evidenceIds of [[], ['act-1'], ['previous-analysis'], ['scenario:analysis']]) {
    assert.throws(() => applyAnalysis(second, { ...secondOutput, facts: [{ statement: '別の出入口が存在する', evidenceIds }] }, 6), /出典|資料ID/);
    assert.equal(JSON.stringify(second), snapshot);
  }
  const confirmed = { ...second, evidence: [...second.evidence, { id: 'ev-2', kind: 'text', extractedText: '書斎には別の出入口がある。', extractionStatus: 'success' }] };
  const third = applyAnalysis(confirmed, { ...secondOutput, hypotheses: [], facts: [{ statement: '書斎には別の出入口がある。', evidenceIds: ['ev-2'] }], actions: [{ ...secondOutput.actions[0], evidenceIds: ['ev-2'], assumptions: [] }] }, 6);
  assert.deepEqual(third.analysis.actions[0].assumptions, []);
  assert.deepEqual(third.analysis.facts[0].evidenceIds, ['ev-2']);
});

test('assumptions are validated, legacy omissions are normalized and restored actions retain conditions', () => {
  for (const assumptions of [null, '条件', [''], ['  '], [true]]) {
    assert.throws(() => applyAnalysis(fixture(), response({ hypotheses: [{ statement: '想定', why: '未確認', evidenceIds: [], assumptions }] }), 4), /仮定は未確認の条件/);
    assert.throws(() => applyAnalysis(fixture(), response({ actions: [{ ...response().actions[0], assumptions }] }), 4), /仮定は未確認の条件/);
  }
  const legacy = applyAnalysis(fixture(), response({ hypotheses: [{ statement: '従来の仮説', why: '未確認', evidenceIds: [] }] }), 4);
  assert.deepEqual(legacy.analysis.hypotheses[0].assumptions, []);
  assert.deepEqual(legacy.analysis.actions[0].assumptions, []);
  const conditional = applyAnalysis(fixture(), response({ actions: [{ ...response().actions[0], assumptions: ['協力者が存在する'] }] }), 4);
  const continued = applyAnalysis(conditional, response(), 5);
  assert.deepEqual(continued.analysis.actions[0].assumptions, ['協力者が存在する']);
  const replaced = applyAnalysis(conditional, response({ actions: [{ ...response().actions[0], continuesActionIds: [], replacesActionIds: ['act-1'] }] }), 5);
  assert.deepEqual(replaced.analysis.actions[0].assumptions, ['協力者が存在する']);
  assert.deepEqual(replaced.actionHistory[0].assumptions, ['協力者が存在する']);
  const dismissed = discardAction(continued, 'act-1', '今は見送る');
  const restored = restoreAction(dismissed, 'act-1');
  assert.deepEqual(restored.analysis.actions[0].assumptions, ['協力者が存在する']);
});

test('fixed synopsis and profile sources exist only for nonempty content actually included in the request', () => {
  const base = { ...fixture(), synopsis: '舞台は書斎。', roleProfile: { role: '管理人', goal: '展示を守る', secret: '合鍵を借りた' } };
  const facts = [{ statement: '舞台は書斎。', evidenceIds: [SYNOPSIS_SOURCE_ID] }];
  const synopsis = applyAnalysis(base, response({ facts }), 4);
  assert.equal(synopsis.analysis.sources[0].extractedText, '舞台は書斎。');
  assert.equal(synopsis.analysis.sources.some((source) => source.id === ROLE_PROFILE_SOURCE_ID), false);
  const profileFacts = [{ statement: 'プレイヤーは管理人。', evidenceIds: [ROLE_PROFILE_SOURCE_ID] }];
  assert.throws(() => applyAnalysis(base, response({ facts: profileFacts }), 4), /今回送信していない/);
  const profile = applyAnalysis(base, response({ facts: profileFacts }), 4, undefined, { includeRoleProfile: true });
  assert.equal(profile.analysis.sources.find((source) => source.id === ROLE_PROFILE_SOURCE_ID).visibility, 'private');
  assert.equal(profile.analysis.grounding.includeRoleProfile, true);
  assert.throws(() => applyAnalysis({ ...base, synopsis: ' ' }, response({ facts }), 4), /資料ID/);
  assert.throws(() => applyAnalysis({ ...base, roleProfile: {} }, response({ facts: profileFacts }), 4, undefined, { includeRoleProfile: true }), /資料ID/);
  const changed = { ...profile, synopsis: '新しい概要', roleProfile: { role: '新しい役' } };
  assert.equal(changed.analysis.sources[0].extractedText, '舞台は書斎。');
  assert.match(changed.analysis.sources[1].extractedText, /合鍵を借りた/);
});

test('fixed-source event quotes are checked against the sent original text', () => {
  const base = { ...fixture(), synopsis: '舞台は書斎。' };
  const event = { timeText: '', people: [], what: '舞台は書斎。', type: 'recorded', sourceId: SYNOPSIS_SOURCE_ID, page: '', quote: '舞台は書斎。', ambiguity: '' };
  const saved = applyAnalysis(base, response({ events: [event] }), 4);
  assert.equal(saved.analysis.events[0].quoteOrigin, 'テキスト抽出と原文一致');
  assert.throws(() => applyAnalysis(base, response({ events: [{ ...event, quote: '犯人は管理人。' }] }), 4), /原文に一致しない/);
});

test('reserved fixed IDs cannot be introduced as evidence to bypass profile scope or empty content', () => {
  const base = { ...fixture(), evidence: [...fixture().evidence, { id: ROLE_PROFILE_SOURCE_ID, kind: 'text', extractedText: '偽のプロフィール' }, { id: SYNOPSIS_SOURCE_ID, kind: 'text', extractedText: '偽の概要' }] };
  for (const id of [ROLE_PROFILE_SOURCE_ID, SYNOPSIS_SOURCE_ID]) {
    assert.throws(() => applyAnalysis(base, response({ facts: [{ statement: '偽の事実', evidenceIds: [id] }] }), 4), /資料ID/);
  }
});

test('an OFF update omits role-derived or legacy actions without requiring their dispositions', () => {
  for (const grounding of [undefined, { includeRoleProfile: true }, { includeRoleProfile: false }]) {
    const base = fixture();
    base.analysis.grounding = grounding;
    base.analysis.actions[0].grounding = grounding;
    base.analysis.actions[0].assumptions = ['PROFILE_CONDITION_MARKER'];
    const output = response({ actions: [{ ...response().actions[0], continuesActionIds: [] }] });
    const saved = applyAnalysis(base, output, 4);
    assert.equal(saved.analysis.grounding.includeRoleProfile, false);
    assert.equal(saved.analysis.grounding.previousContextMayIncludeRoleProfile, false);
    assert.deepEqual(saved.analysis.actions[0].assumptions, []);
    assert.equal(saved.actionHistory[0].id, 'act-1');
    assert.deepEqual(saved.actionHistory[0].assumptions, ['PROFILE_CONDITION_MARKER']);
    assert.deepEqual(saved.analysisHistory[0], base.analysis);
    assert.equal(unconfirmedAssumptionsText(saved, false), '');
    const subsequent = applyAnalysis(saved, response({ actions: [{ ...response().actions[0], continuesActionIds: [saved.analysis.actions[0].id] }] }), 5);
    assert.equal(unconfirmedAssumptionsText(subsequent, false), '');
  }
});
