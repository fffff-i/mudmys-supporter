// Display-only interpretation of saved facts. Never migrates or rewrites a record.
// Fixed sources must belong to this analysis: today's profile is not a snapshot.
const fixedIds = new Set(['scenario:synopsis', 'scenario:role-profile']);
const records = (value) => Array.isArray(value) ? value : [];
const isSource = (source, id) => source && typeof source === 'object' && source.id === id &&
  ['text', 'pdf', 'image'].includes(source.kind);
function sourceExists(scenario, id) {
  const snapshot = records(scenario?.analysis?.sources).find((source) => isSource(source, id));
  if (fixedIds.has(id)) return Boolean(snapshot?.kind === 'text' &&
    [snapshot.extractedText, snapshot.editedText].some((text) => typeof text === 'string' && text.trim()));
  return Boolean(snapshot || records(scenario?.evidence).some((source) => isSource(source, id)));
}
function displayText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const field of ['statement', 'body', 'text', 'question', 'summary']) {
      if (typeof value[field] === 'string') return value[field];
    }
  }
  return '保存された記述を表示できません。元の記述は保持されています。';
}
export function partitionFacts(facts, scenario) {
  const confirmed = [], unconfirmed = [];
  for (const original of Array.isArray(facts) ? facts : facts === undefined || facts === null ? [] : [facts]) {
    const refs = original?.evidenceIds;
    const evidenceIds = Array.isArray(refs) ? [...new Set(refs.filter((id) => typeof id === 'string' && id.trim()))] : [];
    const reason = !Array.isArray(refs) || refs.some((id) => typeof id !== 'string' || !id.trim())
      ? '保存された出典情報を読み取れません。'
      : !refs.length ? '保存された出典がありません。'
      : refs.some((id) => !sourceExists(scenario, id)) ? 'この整理結果の出典を確認できません。' : '';
    const item = { statement: displayText(original?.statement ?? original), evidenceIds: evidenceIds.filter((id) => sourceExists(scenario, id)), reason };
    (reason ? unconfirmed : confirmed).push(item);
  }
  return { confirmed, unconfirmed };
}
