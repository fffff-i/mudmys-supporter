const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { applyAnalysis } = require('../shared/analysisLifecycle.cjs');
const { SYNOPSIS_SOURCE_ID, ROLE_PROFILE_SOURCE_ID, roleText, synopsisText, unconfirmedAssumptionsText } = require('../shared/analysisSources.cjs');

const root = path.resolve(__dirname, '..');

function outputFor(sourceId) {
  return {
    overview: '架空のHOを元に確認する。', flow: [], events: [],
    facts: [{ statement: 'HOに「展示を守る」とある。', evidenceIds: [sourceId] }],
    hypotheses: [{ statement: '別の出入口があるなら確認できるかもしれない。', why: '未公開の可能性。', evidenceIds: [], assumptions: ['別の出入口が存在する'] }],
    unknowns: [], actions: [{
      title: '別の出入り方法を聞く', who: '管理人', step: '他の出入り方法があるか聞く。', suggestedLine: '他に出入りする方法はありますか。',
      purpose: '展示を守る', secretRisk: '', rationale: 'まず条件を確認する。', priority: 1, evidenceIds: [],
      assumptions: ['別の出入口が存在する'], continuesActionIds: [], replacesActionIds: []
    }], retirements: []
  };
}

async function loadMain(t) {
  const tempRoot = path.join(root, '.local');
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'grounding-test-'));
  assert.equal(path.dirname(directory), tempRoot);
  t.after(async () => {
    assert.equal(path.dirname(directory), tempRoot);
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, 'openai-key.bin'), 'synthetic-test-key');
  const requests = [];
  let nextOutput;
  const handlers = new Map();
  const preventUi = () => { throw new Error('GUI must not be opened by grounding tests'); };
  const electron = {
    app: { setName() {}, getPath: () => directory, whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: preventUi,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: preventUi, showMessageBox: preventUi },
    shell: { openPath: preventUi },
    safeStorage: { isEncryptionAvailable: () => true, decryptString: (value) => value.toString() }
  };
  class FakeOpenAI {
    constructor() {
      this.responses = { create: async (request) => {
        requests.push({ provider: 'openai', request });
        return { output_text: JSON.stringify(nextOutput), usage: null };
      } };
    }
  }
  const fakeCodex = {
    request: async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'test' } };
      if (method === 'model/list') return { data: [{ id: 'synthetic-model', inputModalities: ['text'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }] };
      throw new Error('Unexpected mock Codex method: ' + method);
    },
    runStructuredTurn: async (request) => {
      requests.push({ provider: 'codex', request });
      return { text: JSON.stringify(nextOutput) };
    }
  };
  const mainPath = path.join(root, 'electron/main.cjs');
  const realRequire = createRequire(mainPath);
  const context = {
    require: (name) => name === 'electron' ? electron : name === 'openai' ? { default: FakeOpenAI } : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(mainPath), process, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fakeCodex,
    fetch: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/chat');
      requests.push({ provider: 'ollama', request: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(nextOutput) } }) };
    }
  };
  const code = await fs.readFile(mainPath, 'utf8');
  vm.runInNewContext(code + '\ngetCodexClient = async () => fakeCodex;\nmodule.exports = { ANALYSIS_SCHEMA, SYSTEM_PROMPT, analyzeCase };', context, { filename: mainPath });
  return {
    ...context.module.exports, directory, requests, handlers,
    setOutput(value) { nextOutput = value; },
    async store(scenario, preferences) {
      const caseDirectory = path.join(directory, 'cases', scenario.id);
      await fs.mkdir(caseDirectory, { recursive: true });
      await fs.writeFile(path.join(caseDirectory, 'case.json'), JSON.stringify(scenario));
      await fs.writeFile(path.join(directory, 'preferences.json'), JSON.stringify(preferences));
    },
    async read(scenario) {
      return JSON.parse(await fs.readFile(path.join(directory, 'cases', scenario.id, 'case.json'), 'utf8'));
    }
  };
}

function fixture() {
  const sourceId = randomUUID();
  const base = {
    id: randomUUID(), title: '架空の展示室', revision: 1, synopsis: '展示室が舞台。',
    roleProfile: { role: '役プロフィールの管理人', goal: 'プロフィール用の目標', secret: 'PROFILE_SECRET_MARKER' },
    evidence: [{ id: sourceId, title: 'プレイヤーHO', kind: 'text', extractedText: 'あなたは管理人。目的は展示を守る。', extractionStatus: 'success', visibility: 'private' }],
    analysis: null, actionHistory: []
  };
  const first = applyAnalysis(base, outputFor(sourceId), 1);
  return { scenario: first, sourceId };
}

test('shared schema requires evidence only for facts and requires AI-managed conditions for hypotheses/actions', async (t) => {
  const { ANALYSIS_SCHEMA, SYSTEM_PROMPT } = await loadMain(t);
  const properties = ANALYSIS_SCHEMA.properties;
  assert.equal(properties.facts.items.properties.evidenceIds.minItems, 1);
  for (const field of ['hypotheses', 'actions']) {
    assert.equal(properties[field].items.properties.evidenceIds.minItems ?? 0, 0);
    assert.ok(properties[field].items.required.includes('assumptions'));
    assert.equal(properties[field].items.properties.assumptions.type, 'array');
  }
  assert.match(SYSTEM_PROMPT, /HO（ハンドアウト）.*別欄への再入力を前提にしません/);
  assert.match(SYSTEM_PROMPT, /事実のevidenceIds.*1件以上/);
  assert.match(SYSTEM_PROMPT, /仮説・行動のevidenceIdsは任意/);
  assert.match(SYSTEM_PROMPT, /資料にないシナリオの正解を事実として補完しません/);
  assert.match(SYSTEM_PROMPT, /以前のAI出力や提案の繰り返し.*裏付けになりません/);
  assert.doesNotMatch(SYSTEM_PROMPT, /根拠資料のない事実・仮説・行動を作らず/);
});

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' request includes fixed source IDs and unconfirmed conditions, then validates the same sent scope', async (t) => {
    const harness = await loadMain(t);
    const { scenario, sourceId } = fixture();
    const preferences = { provider, cloudConsent: true, codexConsent: true, includeRoleProfile: false, ollamaModel: 'synthetic-model' };
    const next = outputFor(sourceId);
    next.actions[0].continuesActionIds = [scenario.analysis.actions[0].id];
    for (const includeRoleProfile of [false, true]) {
      await harness.store(scenario, { ...preferences, includeRoleProfile });
      next.facts = [{ statement: includeRoleProfile ? 'プロフィールの役は管理人。' : '展示室が舞台。', evidenceIds: [includeRoleProfile ? ROLE_PROFILE_SOURCE_ID : SYNOPSIS_SOURCE_ID] }];
      harness.setOutput(next);
      const result = await harness.analyzeCase(scenario.id, scenario.revision);
      assert.equal(result.status, 'ok', result.message);
      const { request } = harness.requests.at(-1);
      const serialized = JSON.stringify(request);
      assert.ok(serialized.includes('[資料ID: ' + SYNOPSIS_SOURCE_ID + ']'));
      assert.ok(serialized.includes('[資料ID: ' + sourceId + ']'));
      assert.ok(serialized.includes('あなたは管理人。目的は展示を守る。'));
      assert.ok(serialized.includes('別の出入口が存在する'));
      assert.ok(serialized.includes('事実の出典ではありません'));
      assert.equal(serialized.includes('[資料ID: ' + ROLE_PROFILE_SOURCE_ID + ']'), includeRoleProfile);
      assert.equal(serialized.includes('PROFILE_SECRET_MARKER'), includeRoleProfile);
      const schema = provider === 'openai' ? request.text.format.schema : provider === 'ollama' ? request.format : request.schema;
      assert.equal(schema.properties.facts.items.properties.evidenceIds.minItems, 1);
      assert.deepEqual(Array.from(result.scenario.analysis.actions[0].assumptions), ['別の出入口が存在する']);
      assert.equal(result.scenario.analysis.sources.some((source) => source.id === ROLE_PROFILE_SOURCE_ID), includeRoleProfile);
      assert.equal(result.scenario.analysis.grounding.includeRoleProfile, includeRoleProfile);
    }
    // Even an existing role profile cannot ground a fact when this request omits it.
    await harness.store(scenario, preferences);
    harness.setOutput({ ...next, facts: [{ statement: '送信されないプロフィールの役', evidenceIds: [ROLE_PROFILE_SOURCE_ID] }] });
    const rejected = await harness.analyzeCase(scenario.id, scenario.revision);
    assert.equal(rejected.status, 'error');
    assert.match(rejected.message, /今回送信していない/);
    assert.deepEqual(await harness.read(scenario), scenario);
    harness.setOutput({ ...next, facts: [{ statement: '以前の条件を確定したという誤出力', evidenceIds: [] }] });
    const ungrounded = await harness.analyzeCase(scenario.id, scenario.revision);
    assert.equal(ungrounded.status, 'error');
    assert.match(ungrounded.message, /事実には実在する出典/);
    assert.deepEqual(await harness.read(scenario), scenario);
  });
}

test('new prior-assumption context respects profile scope and conservatively omits legacy/role-derived hypotheses', () => {
  const { scenario } = fixture();
  const protectedHypothesis = { statement: 'PROFILE_DERIVED_MARKER', evidenceIds: [], why: '秘密の解釈', assumptions: ['PROFILE_CONDITION_MARKER'] };
  const protectedCase = { ...scenario, analysis: { ...scenario.analysis, hypotheses: [protectedHypothesis], grounding: { includeRoleProfile: true } } };
  assert.equal(unconfirmedAssumptionsText(protectedCase, false), '');
  const legacy = { ...protectedCase, analysis: { ...protectedCase.analysis, grounding: undefined } };
  assert.equal(unconfirmedAssumptionsText(legacy, false), '');
  assert.match(unconfirmedAssumptionsText(protectedCase, true), /PROFILE_CONDITION_MARKER/);
  assert.doesNotMatch(roleText(protectedCase, false), /PROFILE_SECRET_MARKER|scenario:role-profile/);
  assert.match(synopsisText(protectedCase), /scenario:synopsis/);
  assert.doesNotMatch(synopsisText({ synopsis: '' }), /scenario:synopsis/);
});

async function loadDisplay() {
  const ts = require('typescript');
  const appPath = path.join(root, 'src/App.tsx');
  const code = await fs.readFile(appPath, 'utf8');
  const compiled = ts.transpileModule(code + '\nexport { Assumptions, Citations, SignalPanel, PlansPage, Overview, EvidencePage, HistoryPage };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const realRequire = createRequire(appPath);
  const context = { exports: {}, require: (name) => name === '../shared/selectionGuard.mjs' ? {} : realRequire(name) };
  vm.runInNewContext(compiled, context, { filename: appPath });
  return context.exports;
}

test('headless rendering shows only actual assumptions and opens saved fixed-source content', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const display = await loadDisplay();
  const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
  const { scenario } = fixture();
  const noop = () => {};
  assert.equal(render(display.Assumptions, { values: [] }), '');
  assert.equal(render(display.Assumptions, {}), '');
  assert.equal(render(display.Citations, { scenario, ids: [], onEvidence: noop }), '');
  const hypothesisHtml = render(display.SignalPanel, { type: 'hypothesis', label: '仮説', count: 1, items: scenario.analysis.hypotheses, scenario, onEvidence: noop });
  assert.match(hypothesisHtml, /仮定（未確認）/);
  assert.match(hypothesisHtml, /別の出入口が存在する/);
  assert.doesNotMatch(hypothesisHtml, /資料根拠なし|citation-missing/);
  const props = { scenario, settings: { provider: 'none', textLimitCharacters: 300000 }, onEvidence: noop, onAnalyze: noop, onComplete: noop, onDiscardStart: noop, onDiscard: noop, setDiscardReason: noop, onDiscardCancel: noop, discardId: '', discardReason: '' };
  const planHtml = render(display.PlansPage, { ...props, actions: scenario.analysis.actions });
  assert.match(planHtml, /仮定（未確認）/);
  assert.match(planHtml, /別の出入口が存在する/);
  assert.doesNotMatch(planHtml, /資料根拠なし|action-evidence/);
  const overviewHtml = render(display.Overview, { ...props, activeActions: scenario.analysis.actions, onEdit: noop, onPlans: noop, onDiscard: noop });
  assert.ok(overviewHtml.split('別の出入口が存在する').length >= 3);
  const sourceHtml = render(display.Citations, { scenario, ids: [SYNOPSIS_SOURCE_ID], onEvidence: noop });
  assert.match(sourceHtml, /シナリオ概要/);
  assert.doesNotMatch(sourceHtml, /資料なし/);
  const evidenceHtml = render(display.EvidencePage, { ...props, selected: SYNOPSIS_SOURCE_ID, title: '', draft: '', visibility: 'unknown', profile: { title: '', synopsis: '', role: '', goal: '', secret: '' }, totalChars: 0, totalBytes: 0 });
  assert.match(evidenceHtml, /解析に使った内容/);
  assert.match(evidenceHtml, /展示室が舞台。/);
  const historyHtml = render(display.HistoryPage, { scenario, history: [{ ...scenario.analysis.actions[0], status: 'completed' }], onRestore: noop, onEvidence: noop });
  assert.match(historyHtml, /仮定（未確認）/);
});
