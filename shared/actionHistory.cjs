const { getAnalysisContext } = require('./analysisScope.cjs');

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

function fieldMatch(left, right, field, threshold) {
  return Boolean(normalize(left[field]) && normalize(right[field]) && similarity(left[field], right[field]) >= threshold);
}

function sameActionIntent(left, right) {
  // Titles are deliberately absent: the target, objective and concrete question
  // identify the action. The model also receives these fields for semantic matching.
  for (const field of ['who', 'purpose']) {
    if (normalize(left[field]) && normalize(right[field]) && !fieldMatch(left, right, field, field === 'who' ? 0.85 : 0.72)) return false;
  }
  const detailedStep = normalize(left.step).length >= 6 && normalize(right.step).length >= 6;
  if (detailedStep && fieldMatch(left, right, 'step', 0.82)) return true;
  return fieldMatch(left, right, 'who', 0.85) && fieldMatch(left, right, 'purpose', 0.8) &&
    (fieldMatch(left, right, 'step', 0.52) || fieldMatch(left, right, 'suggestedLine', 0.78));
}

function prepareRechecks(action, history, inherited = []) {
  const records = action.rechecks === undefined ? inherited : action.rechecks;
  if (!Array.isArray(records)) throw new Error('再確認は履歴IDと前提の違いを示す配列にしてください。');
  // Continuing a recheck must keep its explanation on later updates as well.
  const merged = [...records, ...inherited.filter((old) => !records.some((item) => item?.actionId === old.actionId))];
  const seen = new Set();
  return merged.map((record) => {
    if (!record || typeof record.actionId !== 'string' || seen.has(record.actionId)) throw new Error('再確認の履歴IDが不正または重複しています。');
    seen.add(record.actionId);
    for (const field of ['previousPremise', 'currentPremise', 'reason']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) throw new Error('再確認には以前と今回の前提、理由が必要です。');
    }
    const clean = { actionId: record.actionId, previousPremise: record.previousPremise.trim(), currentPremise: record.currentPremise.trim(), reason: record.reason.trim() };
    const sameInherited = inherited.some((old) => Object.keys(clean).every((key) => clean[key] === old[key]));
    if (sameInherited) return clean;
    const source = history.find((old) => old.id === record.actionId && ['completed', 'discarded'].includes(old.status));
    if (!source) throw new Error('今回送信していない完了・見送り履歴IDが再確認に含まれました。');
    if (normalize(clean.previousPremise) === normalize(clean.currentPremise)) throw new Error('再確認の前提が変わっていません。');
    const previousText = [...(source.assumptions || []), source.retirementReason, source.resultNote, source.step, source.purpose, source.rationale];
    if (!previousText.some((value) => normalize(value).includes(normalize(clean.previousPremise)))) throw new Error('再確認の以前の前提が元の履歴と対応していません。');
    return clean;
  });
}

function coveredHistoryIds(rechecks, history) {
  const covered = new Set(rechecks.map((record) => record.actionId));
  const byId = new Map(history.map((record) => [record.id, record]));
  // A later recheck can refer to the latest completed check. Its validated
  // lineage also acknowledges earlier completions of that same inquiry.
  for (const id of covered) {
    for (const ancestor of byId.get(id)?.rechecks || []) covered.add(ancestor.actionId);
  }
  return covered;
}

function actionContextText(caseRecord, includeRoleProfile) {
  const context = getAnalysisContext(caseRecord, includeRoleProfile).caseRecord;
  const describe = (a) => ({
    id: a.id, status: a.status, title: a.title, who: a.who || '', purpose: a.purpose || '', step: a.step || '',
    suggestedLine: a.suggestedLine || '', rationale: a.rationale || '', secretRisk: a.secretRisk || '', assumptions: a.assumptions || [], priority: a.priority,
    evidenceIds: a.evidenceIds || [], createdAt: a.createdAt, updatedAt: a.updatedAt,
    retiredAt: a.retiredAt, notesUpdatedAt: a.notesUpdatedAt, retirementReason: a.retirementReason || '', resultNote: a.resultNote || '',
    rechecks: a.rechecks || [], restoredFromId: a.restoredFromId, replacedByActionId: a.replacedByActionId
  });
  return '\n\n[アプリが保持する行動と履歴。AI出力・操作履歴・任意の回答メモであり、事実の出典ではありません]\n有効方針: ' +
    JSON.stringify(context.analysis.actions.map(describe)) + '\n完了・見送り・更新の履歴: ' + JSON.stringify(context.actionHistory.map(describe)) + '\n';
}

module.exports = { normalize, similarity, sameActionIntent, prepareRechecks, coveredHistoryIds, actionContextText };
