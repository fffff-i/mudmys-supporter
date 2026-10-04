const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { partitionFacts } = require('../shared/factDisplay.mjs');

const source = { id: 'note', kind: 'text', title: '保存された証言', extractedText: '時刻を聞いた', visibility: 'shared' };
const fixed = { id: 'scenario:role-profile', kind: 'text', title: '役プロフィール', extractedText: '目的: 展示を守る', visibility: 'private' };
const noop = () => {};
function fixture() {
  const action = { id: 'act', title: '時刻を聞く', who: '証言者', step: 'まず時刻を確認する', suggestedLine: '何時だったか思い出せますか。',
    secretRisk: '自分の鍵は明かさず時刻だけを聞く', rationale: 'WHY_DETAIL_MARKER', purpose: 'PURPOSE_DETAIL_MARKER',
    priority: 1, evidenceIds: ['note'], assumptions: ['証言者が覚えているなら'], status: 'active' };
  const analysis = { overview: '架空の状況', updatedAt: '', provider: 'mock', revision: 1, inputRevision: 1, sources: [source, fixed], flow: [],
    facts: [{ statement: '時刻を聞いたという発言がある', evidenceIds: ['note'] }], hypotheses: [], unknowns: [],
    events: [], actions: [action] };
  return { id: 'case', title: '架空', evidence: [source], analysis, actionHistory: [], revision: 1, roleProfile: {}, updatedAt: '' };
}
async function display() {
  const ts = require('typescript'), appPath = path.resolve(__dirname, '../src/App.tsx');
  const code = await fs.readFile(appPath, 'utf8');
  const compiled = ts.transpileModule(code + '\nexport { Overview, SignalPanel, ActionCard, EvidenceIntake, HistoryPage, Citation, ExpandableList };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const context = { exports: {}, require: createRequire(appPath) };
  vm.runInNewContext(compiled, context, { filename: appPath });
  return context.exports;
}
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } return null; }
  if (predicate(node)) return node;
  if (typeof node.type === 'function') return find(node.type(node.props), predicate);
  return find(node.props?.children, predicate);
}

for (const refs of [[], undefined, null, 'note', {}, [null], [123], [''], ['note', 'missing'], ['missing']]) {
  test('legacy fact references remain unconfirmed and untouched: ' + JSON.stringify(refs), () => {
    const scenario = fixture(), facts = [{ statement: 'LEGACY_BODY', evidenceIds: refs }];
    const before = JSON.stringify({ scenario, facts });
    const result = partitionFacts(facts, scenario);
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.unconfirmed.length, 1);
    assert.equal(result.unconfirmed[0].statement, 'LEGACY_BODY');
    assert.ok(result.unconfirmed[0].reason);
    assert.equal(JSON.stringify({ scenario, facts }), before);
  });
}
test('fact display accepts own saved sources and real retained evidence, even when excluded or renamed', () => {
  const scenario = fixture();
  scenario.evidence = [{ ...source, title: '現在のタイトル', analysisEnabled: false }];
  const facts = [{ statement: '資料の記述', evidenceIds: ['note'] }, { statement: '当時の役', evidenceIds: [fixed.id] }];
  assert.equal(partitionFacts(facts, scenario).confirmed.length, 2);
  scenario.analysis.sources = [];
  const result = partitionFacts(facts, scenario);
  assert.equal(result.confirmed.length, 1);
  assert.equal(result.unconfirmed.length, 1);
});
test('a fixed source needs its own nonempty text snapshot, and never uses current profile or another history', () => {
  const scenario = fixture();
  scenario.roleProfile = { role: '現在の役', goal: '現在の目標', secret: '現在の秘密' };
  scenario.analysis.sources = [];
  scenario.analysisHistory = [{ ...scenario.analysis, sources: [fixed] }];
  scenario.evidence.push(fixed);
  const facts = [{ statement: '役', evidenceIds: [fixed.id] }];
  assert.equal(partitionFacts(facts, scenario).confirmed.length, 0);
  scenario.analysis.sources = [{ ...fixed, extractedText: '' }];
  assert.equal(partitionFacts(facts, scenario).confirmed.length, 0);
  scenario.analysis.sources = [{ ...fixed, extractedText: undefined, editedText: '当時の補足' }];
  assert.equal(partitionFacts(facts, scenario).confirmed.length, 1);
});
test('malformed record bodies and arrays remain readable without altering old data', () => {
  const hiddenId = '80938264-b0de-4e82-9d00-dd15fe7d1a34';
  const facts = [null, '古い文字列', { statement: { body: '古いオブジェクト', traceId: hiddenId }, evidenceIds: [] },
    { evidenceIds: { id: hiddenId } }];
  const before = JSON.stringify(facts), result = partitionFacts(facts, fixture());
  assert.equal(result.unconfirmed.length, 4);
  assert.equal(result.unconfirmed[1].statement, '古い文字列');
  assert.equal(result.unconfirmed[2].statement, '古いオブジェクト');
  assert.doesNotMatch(result.unconfirmed.map((item) => item.statement).join(' '), /80938264|evidenceIds|traceId|[{}]/);
  assert.equal(JSON.stringify(facts), before);
});
test('current and historical fact panels use the same classification without exposing technical reference data', async () => {
  const d = await display(), scenario = fixture();
  scenario.analysis.facts = [{ statement: 'CONFIRMED_BODY', evidenceIds: ['note'] }, { statement: 'EMPTY_BODY', evidenceIds: [] },
    { statement: 'MISSING_BODY', evidenceIds: ['missing'] }, { statement: 'BAD_TYPE_BODY', evidenceIds: { id: 'note' } },
    { evidenceIds: { id: '80938264-b0de-4e82-9d00-dd15fe7d1a34' } }];
  scenario.analysisHistory = [structuredClone(scenario.analysis)];
  const current = render(d.SignalPanel, { type: 'fact', label: '資料にある事実', items: scenario.analysis.facts, scenario, onEvidence: noop });
  assert.equal((current.match(/data-fact-status="confirmed"/g) || []).length, 1);
  assert.equal((current.match(/data-fact-status="unconfirmed"/g) || []).length, 4);
  assert.match(current, /保存された出典情報を読み取れません/);
  assert.doesNotMatch(current, /legacy-fact-refs|出典ID|citation-missing|80938264|evidenceIds/);
  assert.match(current, /BAD_TYPE_BODY/);
  const history = render(d.HistoryPage, { scenario, history: [], onEvidence: noop, onRestore: noop });
  assert.equal((history.match(/data-fact-status="confirmed"/g) || []).length, 1);
  assert.equal((history.match(/data-fact-status="unconfirmed"/g) || []).length, 4);
  assert.doesNotMatch(history, /80938264|evidenceIds/);
});
test('the overview keeps all lists reachable with independent native disclosure and no forced role input', async () => {
  const d = await display(), scenario = fixture();
  scenario.analysis.events = Array.from({ length: 8 }, (_, i) => ({ what: 'EVENT_' + i, sourceId: 'note', people: [], page: '', type: 'statement' }));
  for (const field of ['facts', 'hypotheses', 'unknowns']) scenario.analysis[field] = Array.from({ length: 5 }, (_, i) =>
    ({ statement: field + i, question: field + i, why: '', evidenceIds: ['note'] }));
  scenario.analysis.actions = Array.from({ length: 5 }, (_, i) => ({ ...scenario.analysis.actions[0], id: 'act' + i, title: 'ACTION_' + i }));
  const html = render(d.Overview, { scenario, settings: { provider: 'none' }, activeActions: scenario.analysis.actions,
    intake: React.createElement('form', { 'data-shared-intake': true }), onEdit: noop, onPlans: noop, onEvidence: noop, onComplete: noop, onDiscard: noop });
  for (const marker of ['EVENT_7', 'facts4', 'hypotheses4', 'unknowns4', 'ACTION_4']) assert.ok(html.includes(marker), marker);
  assert.equal((html.match(/class="list-more"/g) || []).length, 5);
  assert.match(html, /残り3件を表示/);
  assert.match(html, /data-shared-intake/);
  assert.doesNotMatch(html, /役が未入力|役の目的が分かると|required/);
});
test('action cards expose the practical fields and reserve reasons and citations for details', async () => {
  const d = await display(), scenario = fixture(), action = scenario.analysis.actions[0];
  const html = render(d.ActionCard, { scenario, action, onEvidence: noop, onComplete: noop, onDiscard: noop });
  const details = html.indexOf('<details');
  for (const text of [action.who, action.step, action.suggestedLine, action.secretRisk, action.assumptions[0]]) assert.ok(html.indexOf(text) < details);
  for (const text of [action.rationale, action.purpose, 'citation-chip']) assert.ok(html.indexOf(text) > details);
  assert.match(html, /根拠資料の公開範囲/);
  assert.match(html, /秘密への配慮/);
  const plain = render(d.ActionCard, { scenario, action: { ...action, assumptions: [], evidenceIds: [] }, onEvidence: noop, onComplete: noop, onDiscard: noop });
  assert.doesNotMatch(plain, /仮定（未確認）|根拠登録|前提を入力/);
});
test('a historical citation passes its precise original analysis index even with repeated source IDs', async () => {
  const d = await display(), scenario = fixture();
  const older = { ...scenario.analysis, sources: [{ ...fixed, extractedText: 'OLDER_BODY' }],
    facts: [{ statement: 'OLDER_FACT', evidenceIds: [fixed.id] }], actions: [], events: [] };
  scenario.analysisHistory = [older, structuredClone(scenario.analysis)];
  const calls = [], tree = d.HistoryPage({ scenario, history: [], onRestore: noop, onEvidence: (...args) => calls.push(args) });
  const olderPanel = tree.props.children.find((child) => Array.isArray(child) && child[0]?.props.className?.includes('previous-analysis'))[1];
  const citation = find(olderPanel, (node) => node.type === 'button' && node.props.className === 'citation-chip');
  citation.props.onClick();
  assert.equal(calls[0][0], fixed.id);
  assert.equal(calls[0][3], 0);
});
