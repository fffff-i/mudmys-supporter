const { randomUUID } = require('node:crypto');

function normalize(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s、。！？!?・.,:：;；「」『』()（）]/g, '');
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (a === b) return 1;
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function applyAnalysis(current, output, expectedRevision, generatedAt = new Date().toISOString()) {
  assert(current.revision === expectedRevision, 'この解析より新しい変更があるため、結果を破棄しました。');
  assert(output && typeof output.overview === 'string', '解析結果の形式を確認できませんでした。');

  const evidenceById = new Map((current.evidence || []).map((entry) => [entry.id, entry]));
  const evidenceIds = new Set(evidenceById.keys());
  const previous = current.analysis && current.analysis.actions ? current.analysis.actions : [];
  const oldById = new Map(previous.map((action) => [action.id, action]));
  const activeIds = new Set(previous.filter((action) => action.status === 'active').map((action) => action.id));
  const seenDisposition = new Set();

  const validateRefs = (records, label) => {
    for (const record of records || []) {
      assert(Array.isArray(record.evidenceIds), label + 'に根拠IDがありません。');
      for (const id of record.evidenceIds) assert(evidenceIds.has(id), '存在しない資料IDが解析結果に含まれました。');
    }
  };
  validateRefs(output.flow, '流れ');
  validateRefs(output.facts, '事実');
  validateRefs(output.hypotheses, '仮説');
  validateRefs(output.unknowns, '未確認事項');
  validateRefs(output.actions, '方針');
  const events = (output.events || []).map((event) => {
    const source = evidenceById.get(event.sourceId);
    assert(source, 'イベントに存在しない資料IDが含まれました。');
    let quoteOrigin = source.kind === 'image' ? '画像からの読取（原文一致は未検証）' : 'PDF画像からの読取（原文一致は未検証）';
    if ((source.kind === 'text' || source.kind === 'pdf') && source.extractedText && source.extractionStatus !== 'no_text') {
      const normalizeSpaces = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const quote = normalizeSpaces(event.quote);
      const original = normalizeSpaces(source.extractedText);
      assert(quote && original.includes(quote), '資料の原文に一致しないイベント引用があったため、前回結果を保持しました。');
      quoteOrigin = 'テキスト抽出と原文一致';
    }
    return { ...event, quoteOrigin };
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

  const discarded = (current.actionHistory || []).filter((action) => action.status === 'discarded');
  for (const proposed of prepared) {
    const blocked = discarded.find((old) => similarity(proposed.title, old.title) >= 0.86);
    assert(!blocked, '手動で棄却した方針と同じ案が再提案されたため、前回結果を保持しました。');
  }

  const assigned = prepared.map((action) => {
    const continuedId = (action.continuesActionIds || [])[0];
    const old = continuedId ? oldById.get(continuedId) : null;
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
      hypotheses: output.hypotheses || [],
      unknowns: output.unknowns || [],
      actions: assigned.sort((a, b) => a.priority - b.priority),
      provider: output.provider || 'AI'
    },
    actionHistory: history
  };
}

function discardAction(current, actionId, reason, generatedAt = new Date().toISOString()) {
  const actions = current.analysis && current.analysis.actions ? current.analysis.actions : [];
  const selected = actions.find((action) => action.id === actionId && action.status === 'active');
  assert(selected, '現在有効な方針を選んでください。');
  assert(String(reason || '').trim().length >= 2, '棄却理由を入力してください。');
  return {
    ...current,
    revision: current.revision + 1,
    updatedAt: generatedAt,
    analysis: { ...current.analysis, actions: actions.filter((action) => action.id !== actionId) },
    actionHistory: [...(current.actionHistory || []), {
      ...selected,
      status: 'discarded',
      retiredAt: generatedAt,
      retirementReason: String(reason).trim(),
      replacedByActionId: null
    }]
  };
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

module.exports = { applyAnalysis, discardAction, restoreAction, similarity };
