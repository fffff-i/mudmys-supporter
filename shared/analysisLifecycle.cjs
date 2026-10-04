const { randomUUID } = require('node:crypto');
const { getAnalysisSources, getFixedAnalysisSources } = require('./analysisSources.cjs');
const { INPUT_PROVENANCE_VERSION, getAnalysisContext, mayIncludeRoleProfile } = require('./analysisScope.cjs');
const { similarity, sameActionIntent, prepareRechecks, coveredHistoryIds } = require('./actionHistory.cjs');
const { verifyEventQuote } = require('./pdfSources.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function applyAnalysis(current, output, expectedRevision, generatedAt = new Date().toISOString(), options = {}) {
  assert(current.revision === expectedRevision, 'この解析より新しい変更があるため、結果を破棄しました。');
  assert(output && typeof output.overview === 'string', '解析結果の形式を確認できませんでした。');

  const evidenceById = new Map(getAnalysisSources(current, options).map((entry) => [entry.id, entry]));
  const evidenceIds = new Set(evidenceById.keys());
  const context = getAnalysisContext(current, options.includeRoleProfile);
  const previous = current.analysis && current.analysis.actions ? current.analysis.actions : [];
  const oldById = new Map(previous.map((action) => [action.id, action]));
  const activeIds = new Set(context.activeActionIds);
  const excludedIds = new Set(context.excludedActionIds);
  const seenDisposition = new Set();
  // These input conditions are app-owned; model output cannot clear them.
  const grounding = {
    version: INPUT_PROVENANCE_VERSION,
    includeRoleProfile: options.includeRoleProfile === true,
    previousContextMayIncludeRoleProfile: context.previousContextMayIncludeRoleProfile || options.previousContextMayIncludeRoleProfile === true,
    evidenceIds: [...evidenceIds],
    contextActionIds: context.activeActionIds,
    contextHistoryActionIds: context.historyActionIds
  };

  const validateRefs = (records, label, required = false) => {
    for (const record of records || []) {
      assert(Array.isArray(record.evidenceIds), label + 'に根拠IDがありません。');
      if (required) assert(record.evidenceIds.length > 0, '事実には実在する出典が必要です。');
      for (const id of record.evidenceIds) assert(typeof id === 'string' && evidenceIds.has(id), '存在しない資料IDまたは今回送信していない出典IDが解析結果に含まれました。');
    }
  };
  validateRefs(output.flow, '流れ');
  validateRefs(output.facts, '事実', true);
  validateRefs(output.hypotheses, '仮説');
  validateRefs(output.unknowns, '未確認事項');
  validateRefs(output.actions, '方針');
  const assumptionsFor = (record, fallback = []) => {
    // Legacy results omit this field. Newly generated output always supplies it.
    const assumptions = record.assumptions === undefined ? fallback : record.assumptions;
    assert(Array.isArray(assumptions) && assumptions.every((value) => typeof value === 'string' && value.trim()), '仮定は未確認の条件を表す文字列の配列にしてください。');
    return assumptions.map((value) => value.trim());
  };
  const hypotheses = (output.hypotheses || []).map((item) => ({
    ...item,
    assumptions: assumptionsFor(item, (context.caseRecord.analysis.hypotheses || []).find((old) => old.statement === item.statement)?.assumptions || [])
  }));
  for (const action of output.actions || []) assumptionsFor(action);
  const events = (output.events || []).map((event) => {
    const source = evidenceById.get(event.sourceId);
    assert(source, 'イベントに存在しない資料IDが含まれました。');
    return verifyEventQuote(event, source, options.sourceInputs?.[source.id]);
  });

  const retiredActions = Array.isArray(output.retirements) ? output.retirements : [];
  for (const item of retiredActions) {
    assert(activeIds.has(item.actionId), '履歴にない方針を廃棄しようとしました。');
    assert(!seenDisposition.has(item.actionId), '同じ方針が複数回処理されています。');
    assert(String(item.reason || '').trim().length > 0, '方針を履歴へ移す理由がありません。');
    seenDisposition.add(item.actionId);
  }

  const prepared = [];
  for (const action of output.actions || []) {
    assert(Number.isInteger(action.priority) && action.priority >= 1 && action.priority <= 5, '優先順位が範囲外です。');
    for (const field of ['continuesActionIds', 'replacesActionIds']) {
      const ids = Array.isArray(action[field]) ? action[field] : [];
      for (const id of ids) {
        assert(activeIds.has(id), '現在の方針ではないIDが解析結果に含まれました。');
        assert(!seenDisposition.has(id), '同じ方針が複数回処理されています。');
        seenDisposition.add(id);
      }
    }
    assert((action.continuesActionIds || []).length <= 1, '継続元の方針が複数指定されています。');
    prepared.push(action);
  }
  for (const id of activeIds) assert(seenDisposition.has(id), '既存方針の更新先が決まっていないため、前回結果を保持しました。');

  const terminalHistory = context.caseRecord.actionHistory.filter((action) => ['completed', 'discarded'].includes(action.status));
  const rechecks = prepared.map((action) => {
    const inherited = [...new Set([...(action.continuesActionIds || []), ...(action.replacesActionIds || [])])]
      .flatMap((id) => oldById.get(id)?.rechecks || []);
    return prepareRechecks(action, terminalHistory, inherited);
  });
  prepared.forEach((proposed, index) => {
    const covered = coveredHistoryIds(rechecks[index], terminalHistory);
    const blocked = terminalHistory.find((old) => sameActionIntent(proposed, old) && !covered.has(old.id));
    assert(!blocked, '完了または手動で棄却（見送り）した行動と同じ案が、前提の違いを示さず再提案されたため、前回結果を保持しました。');
  });

  const assigned = prepared.map((action, index) => {
    const continuedId = (action.continuesActionIds || [])[0];
    const old = continuedId ? oldById.get(continuedId) : null;
    const inheritedAssumptions = [...new Set([...(action.continuesActionIds || []), ...(action.replacesActionIds || [])]
      .flatMap((id) => oldById.get(id)?.assumptions || []))];
    return {
      id: old ? old.id : randomUUID(),
      title: action.title,
      who: action.who || '',
      step: action.step,
      suggestedLine: action.suggestedLine || '',
      purpose: action.purpose || '',
      secretRisk: action.secretRisk || '',
      rationale: action.rationale,
      priority: action.priority,
      evidenceIds: action.evidenceIds,
      assumptions: assumptionsFor(action, inheritedAssumptions),
      rechecks: rechecks[index],
      grounding,
      status: 'active',
      createdAt: old ? old.createdAt : generatedAt,
      updatedAt: generatedAt
    };
  });

  const history = [...(current.actionHistory || [])];
  const replacementOwners = new Map();
  prepared.forEach((action, index) => {
    for (const id of action.replacesActionIds || []) replacementOwners.set(id, assigned[index].id);
  });
  for (const item of retiredActions) replacementOwners.set(item.actionId, null);

  const retireReason = new Map(retiredActions.map((item) => [item.actionId, item.reason]));
  for (const action of previous) {
    if (excludedIds.has(action.id)) {
      history.push({
        ...action,
        status: 'retired',
        retiredAt: generatedAt,
        retirementReason: '役情報の送信設定により今回の更新対象から除外。内容はこのPCの履歴に保持。',
        retirementGrounding: grounding,
        replacedByActionId: null
      });
      continue;
    }
    if (action.status !== 'active' || !seenDisposition.has(action.id)) continue;
    const replacementId = replacementOwners.get(action.id);
    const inferredOwner = assigned.find((candidate) => {
      const outputAction = prepared.find((entry) => (entry.continuesActionIds || []).includes(action.id));
      return outputAction && candidate.id === action.id;
    });
    if (inferredOwner) continue;
    history.push({
      ...action,
      status: 'retired',
      retiredAt: generatedAt,
      retirementReason: retireReason.get(action.id) || (replacementId ? '新しい方針へ置き換え' : '解析結果を受けて優先対象から外れた'),
      retirementGrounding: grounding,
      replacedByActionId: replacementId || null
    });
  }

  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: generatedAt,
    analysis: {
      revision: current.revision + 1,
      inputRevision: expectedRevision,
      updatedAt: generatedAt,
      overview: output.overview,
      flow: output.flow || [],
      events,
      facts: output.facts || [],
      hypotheses,
      unknowns: output.unknowns || [],
      actions: assigned.sort((a, b) => a.priority - b.priority),
      provider: output.provider || 'AI',
      sources: getFixedAnalysisSources(current, options),
      grounding
    },
    analysisHistory: context.excludedPreviousAnalysis
      ? [...(current.analysisHistory || []), current.analysis]
      : current.analysisHistory || [],
    actionHistory: history
  };
}

function manualNoteGrounding(action, options = {}, previousGrounding) {
  return {
    version: INPUT_PROVENANCE_VERSION,
    includeRoleProfile: options.includeRoleProfile === true,
    previousContextMayIncludeRoleProfile: mayIncludeRoleProfile(action.grounding) ||
      Boolean(previousGrounding && mayIncludeRoleProfile(previousGrounding)),
    evidenceIds: [...(action.grounding?.evidenceIds || [])],
    contextActionIds: [action.id], contextHistoryActionIds: [action.id]
  };
}

function retireManually(current, actionId, status, reason, generatedAt, options) {
  const actions = current.analysis?.actions || [];
  const selected = actions.find((action) => action.id === actionId && action.status === 'active');
  if (!selected && (current.actionHistory || []).some((action) => action.id === actionId && action.status === status)) return current;
  assert(selected, '現在有効な方針を選んでください。');
  assert(reason === undefined || typeof reason === 'string', '任意の理由は文章で入力してください。');
  const text = (reason || '').trim();
  return {
    ...current,
    revision: current.revision + 1, updatedAt: generatedAt,
    analysis: { ...current.analysis, actions: actions.filter((action) => action.id !== actionId) },
    actionHistory: [...(current.actionHistory || []), {
      ...selected, status, retiredAt: generatedAt, retirementReason: text,
      retirementGrounding: text ? manualNoteGrounding(selected, options) : selected.grounding,
      replacedByActionId: null
    }]
  };
}

function completeAction(current, actionId, generatedAt = new Date().toISOString(), options = {}) {
  return retireManually(current, actionId, 'completed', '', generatedAt, options);
}

function discardAction(current, actionId, reason = '', generatedAt = new Date().toISOString(), options = {}) {
  return retireManually(current, actionId, 'discarded', reason, generatedAt, options);
}

function updateActionNotes(current, actionId, notes, generatedAt = new Date().toISOString(), options = {}) {
  const history = [...(current.actionHistory || [])];
  const index = history.findLastIndex((action) => action.id === actionId);
  assert(index >= 0, 'メモを保存する行動履歴がありません。');
  assert(notes && typeof notes === 'object', '履歴メモを確認できませんでした。');
  const source = history[index];
  const updated = { ...source };
  for (const [input, textField, provenanceField] of [
    ['reason', 'retirementReason', 'retirementGrounding'], ['resultNote', 'resultNote', 'resultGrounding']
  ]) {
    if (notes[input] === undefined) continue;
    assert(typeof notes[input] === 'string', '任意の理由・回答は文章で入力してください。');
    updated[textField] = notes[input].trim();
    // An edited note keeps the provenance of the prose it replaces as well.
    const previous = source[textField] ? source[provenanceField] || { includeRoleProfile: true } : undefined;
    updated[provenanceField] = manualNoteGrounding(source, options, previous);
  }
  updated.notesUpdatedAt = generatedAt;
  history[index] = updated;
  return { ...current, revision: current.revision + 1, updatedAt: generatedAt, actionHistory: history };
}

function restoreAction(current, actionId, generatedAt = new Date().toISOString()) {
  const history = [...(current.actionHistory || [])];
  const index = history.findIndex((action) => action.id === actionId && action.status === 'discarded');
  assert(index >= 0, '棄却履歴から方針を選んでください。');
  const source = history[index];
  const restoredId = randomUUID();
  history[index] = { ...source, status: 'restored', restoredAt: generatedAt, restoredAsActionId: restoredId };
  const restored = {
    id: restoredId,
    title: source.title,
    who: source.who || '',
    step: source.step,
    suggestedLine: source.suggestedLine || '',
    purpose: source.purpose || '',
    secretRisk: source.secretRisk || '',
    rationale: source.rationale,
    priority: source.priority,
    evidenceIds: source.evidenceIds || [],
    assumptions: source.assumptions || [],
    rechecks: source.rechecks || [],
    grounding: source.grounding,
    status: 'active',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    restoredFromId: source.id
  };
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: generatedAt,
    analysis: { ...current.analysis, actions: [...(current.analysis.actions || []), restored].sort((a, b) => a.priority - b.priority) },
    actionHistory: history
  };
}

module.exports = { applyAnalysis, completeAction, discardAction, updateActionNotes, restoreAction, similarity };
