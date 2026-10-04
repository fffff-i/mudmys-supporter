const { getAnalysisContext } = require('./analysisScope.cjs');
const { enabledEvidence } = require('./evidence.mjs');
const SYNOPSIS_SOURCE_ID = 'scenario:synopsis';
const ROLE_PROFILE_SOURCE_ID = 'scenario:role-profile';

function getFixedAnalysisSources(caseRecord, options = {}) {
  const sources = [];
  const synopsis = String(caseRecord.synopsis || '');
  if (synopsis.trim()) sources.push({
    id: SYNOPSIS_SOURCE_ID, title: 'シナリオ概要', kind: 'text',
    extractedText: synopsis, extractionStatus: 'success', visibility: 'unknown'
  });
  if (options.includeRoleProfile === true) {
    const profile = caseRecord.roleProfile || {};
    const text = [['役', profile.role], ['目的', profile.goal], ['秘密', profile.secret]]
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([label, value]) => label + ': ' + value).join('\n');
    if (text) sources.push({
      id: ROLE_PROFILE_SOURCE_ID, title: '役プロフィール', kind: 'text',
      extractedText: text, extractionStatus: 'success', visibility: 'private'
    });
  }
  return sources;
}

function getAnalysisSources(caseRecord, options = {}) {
  const sentIds = Array.isArray(options.evidenceIds) ? new Set(options.evidenceIds) : null;
  const evidence = enabledEvidence(caseRecord).filter((item) =>
    item.id !== SYNOPSIS_SOURCE_ID && item.id !== ROLE_PROFILE_SOURCE_ID &&
    (!sentIds || sentIds.has(item.id)));
  return [...evidence, ...getFixedAnalysisSources(caseRecord, options)];
}

function renderFixedSource(source) {
  const scope = source.visibility === 'private' ? '自分だけ' : '公開状況不明';
  return '[資料ID: ' + source.id + '] [' + scope + '] [' + source.title + ']\n' + source.extractedText;
}

function synopsisText(caseRecord) {
  const source = getFixedAnalysisSources(caseRecord).find((item) => item.id === SYNOPSIS_SOURCE_ID);
  return source ? renderFixedSource(source) : '[シナリオ概要: 未入力。出典なし]';
}

function roleText(caseRecord, includeRoleProfile) {
  if (!includeRoleProfile) return '[役プロフィール: 今回の解析には含めない。出典として参照しない]';
  const source = getFixedAnalysisSources(caseRecord, { includeRoleProfile }).find((item) => item.id === ROLE_PROFILE_SOURCE_ID);
  return source ? renderFixedSource(source) : '[役プロフィール: 未入力。送信資料のHOに役・目的があれば読み取る]';
}

function unconfirmedAssumptionsText(caseRecord, includeRoleProfile) {
  const { analysis } = getAnalysisContext(caseRecord, includeRoleProfile).caseRecord;
  const hypotheses = (analysis.hypotheses || []).map((item) => ({
    statement: item.statement, why: item.why, assumptions: item.assumptions || [], evidenceIds: item.evidenceIds || []
  }));
  const actions = (analysis.actions || []).filter((item) => item.assumptions?.length).map((item) => ({
    id: item.id, title: item.title, step: item.step, assumptions: item.assumptions, evidenceIds: item.evidenceIds || []
  }));
  if (!hypotheses.length && !actions.length) return '';
  return '\n\n[前回の仮説・未確認の条件。AIの出力であり、事実の出典ではありません。繰り返しや根拠IDの存在だけで条件を確定しない]\n' +
    JSON.stringify({ hypotheses, actions });
}

module.exports = {
  SYNOPSIS_SOURCE_ID, ROLE_PROFILE_SOURCE_ID, getFixedAnalysisSources,
  getAnalysisSources, synopsisText, roleText, unconfirmedAssumptionsText
};
