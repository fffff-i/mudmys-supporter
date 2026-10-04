const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
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
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const testFs = {
    ...fs,
    async rename(source, target) {
      assert.ok(path.resolve(source).startsWith(directory + path.sep));
      assert.ok(path.resolve(target).startsWith(directory + path.sep));
      // Windows/OneDrive can briefly lock these synthetic files during repeated
      // lifecycle writes. Retry only this test's storage, never user data.
      for (let attempt = 0; ; attempt += 1) {
        try { return await fs.rename(source, target); }
        catch (error) {
          if (error.code !== 'EPERM' || attempt >= 5) throw error;
          await delay(20 * (attempt + 1));
        }
      }
    }
  };
  await fs.writeFile(path.join(directory, 'openai-key.bin'), 'synthetic-test-key');
  const requests = [];
  let nextOutput;
  let responseGate;
  const captureRequest = async (provider, request) => {
    requests.push({ provider, request });
    if (responseGate) await responseGate.wait;
  };
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
        await captureRequest('openai', request);
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
      await captureRequest('codex', request);
      return { text: JSON.stringify(nextOutput) };
    }
  };
  const mainPath = path.join(root, 'electron/main.cjs');
  const realRequire = createRequire(mainPath);
  const context = {
    require: (name) => name === 'electron' ? electron : name === 'openai' ? { default: FakeOpenAI } : name === 'node:fs/promises' ? testFs : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(mainPath), process, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fakeCodex,
    fetch: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/chat');
      await captureRequest('ollama', JSON.parse(options.body));
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(nextOutput) } }) };
    }
  };
  const code = await fs.readFile(mainPath, 'utf8');
  vm.runInNewContext(code + '\ngetCodexClient = async () => fakeCodex;\nmodule.exports = { ANALYSIS_SCHEMA, SYSTEM_PROMPT, analyzeCase, evidenceForRequest };', context, { filename: mainPath });
  return {
    ...context.module.exports, directory, requests, handlers,
    setOutput(value) { nextOutput = value; },
    holdResponse() {
      let release;
      responseGate = { wait: new Promise((resolve) => { release = resolve; }) };
      t.after(() => release());
      return { release };
    },
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
  const protectedCase = { ...scenario, analysis: { ...scenario.analysis, hypotheses: [protectedHypothesis], actions: scenario.analysis.actions.map((action) => ({ ...action, grounding: { includeRoleProfile: true } })), grounding: { includeRoleProfile: true } } };
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
  const compiled = ts.transpileModule(code + '\nexport { Assumptions, Citations, SignalPanel, PlansPage, Overview, EvidencePage, HistoryPage, SettingsPage, ActionControls, ActionCare, ActionSourceScope, RecheckNotes, HistoryNoteEditor };', {
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
  const props = { scenario, settings: { provider: 'none', textLimitCharacters: 300000 }, onEvidence: noop, onAnalyze: noop, onComplete: noop, onDiscard: noop };
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

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' ON-to-OFF excludes derived prose/IDs in all request routes and preserves local lifecycle history', async (t) => {
    const harness = await loadMain(t);
    const { scenario, sourceId } = fixture();
    const preferences = { provider, includeRoleProfile: true, cloudConsent: true, codexConsent: true, ollamaModel: 'synthetic-model' };
    await harness.store(scenario, preferences);
    const fromProfile = outputFor(sourceId);
    fromProfile.overview = 'DERIVED_OVERVIEW_MARKER';
    fromProfile.flow = [{ moment: 'DERIVED_FLOW_MARKER', summary: '秘密に基づく流れ', evidenceIds: [ROLE_PROFILE_SOURCE_ID] }];
    fromProfile.events = [{ timeText: 'DERIVED_EVENT_MARKER', people: [], what: '秘密の記録', type: 'recorded', sourceId: ROLE_PROFILE_SOURCE_ID, page: '', quote: 'PROFILE_SECRET_MARKER', ambiguity: '' }];
    fromProfile.facts = [{ statement: 'DERIVED_FACT_MARKER', evidenceIds: [ROLE_PROFILE_SOURCE_ID] }];
    fromProfile.hypotheses = [{ statement: 'DERIVED_HYPOTHESIS_MARKER', why: 'DERIVED_WHY_MARKER', assumptions: ['DERIVED_CONDITION_MARKER'], evidenceIds: [] }];
    fromProfile.unknowns = [{ question: 'DERIVED_UNKNOWN_MARKER', why: '秘密を確認', evidenceIds: [] }];
    // A model may claim that it did not use the profile. The app owns provenance.
    const fakeClean = { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: [] };
    fromProfile.grounding = fakeClean;
    fromProfile.actions = ['ACTIVE', 'COMPLETED', 'DISCARDED', 'RESTORED'].map((status, index) => ({
      ...fromProfile.actions[0], title: 'DERIVED_' + status + '_MARKER', step: 'DERIVED_STEP_' + status,
      rationale: 'DERIVED_RATIONALE_' + status, who: 'DERIVED_WHO_' + status, suggestedLine: 'DERIVED_LINE_' + status,
      purpose: 'DERIVED_PURPOSE_' + status, secretRisk: 'DERIVED_RISK_' + status, assumptions: ['DERIVED_ACTION_CONDITION_' + status],
      continuesActionIds: index ? [] : [scenario.analysis.actions[0].id], evidenceIds: [ROLE_PROFILE_SOURCE_ID], grounding: fakeClean
    }));
    harness.setOutput(fromProfile);
    const on = await harness.analyzeCase(scenario.id, scenario.revision);
    assert.equal(on.status, 'ok', on.message);
    assert.equal(on.scenario.analysis.grounding.includeRoleProfile, true);
    for (const item of on.scenario.analysis.actions) assert.equal(item.grounding.includeRoleProfile, true);
    const actions = on.scenario.analysis.actions;
    await harness.handlers.get('scenario:complete-action')({}, { id: scenario.id, actionId: actions[1].id });
    await harness.handlers.get('scenario:discard-action')({}, { id: scenario.id, actionId: actions[2].id, reason: 'DERIVED_DISCARD_REASON_MARKER' });
    await harness.handlers.get('scenario:discard-action')({}, { id: scenario.id, actionId: actions[3].id, reason: 'DERIVED_RESTORE_REASON_MARKER' });
    await harness.handlers.get('scenario:restore-action')({}, { id: scenario.id, actionId: actions[3].id });
    const protectedCase = await harness.read(scenario);
    for (const item of [...protectedCase.analysis.actions, ...protectedCase.actionHistory]) assert.equal(item.grounding.includeRoleProfile, true);
    const oldIds = [...protectedCase.analysis.actions, ...protectedCase.actionHistory].map((item) => item.id);
    const offOutput = outputFor(sourceId);
    offOutput.actions[0].title = 'SAFE_NEXT_ACTION_MARKER';
    harness.setOutput(offOutput);
    await harness.store(protectedCase, { ...preferences, includeRoleProfile: false });
    const off = await harness.analyzeCase(protectedCase.id, protectedCase.revision);
    assert.equal(off.status, 'ok', off.message);
    const request = JSON.stringify(harness.requests.at(-1).request);
    assert.doesNotMatch(request, /DERIVED_|PROFILE_SECRET_MARKER/);
    assert.ok(!request.includes('[資料ID: ' + ROLE_PROFILE_SOURCE_ID + ']'));
    for (const oldId of oldIds) assert.ok(!request.includes(oldId), 'excluded ID was sent: ' + oldId);
    assert.ok(request.includes('あなたは管理人。目的は展示を守る。'));
    assert.equal(off.scenario.analysis.grounding.version, 1);
    assert.equal(off.scenario.analysis.grounding.includeRoleProfile, false);
    assert.equal(off.scenario.analysis.grounding.previousContextMayIncludeRoleProfile, false);
    assert.deepEqual(Array.from(off.scenario.analysis.grounding.contextActionIds), []);
    assert.deepEqual(Array.from(off.scenario.analysis.grounding.contextHistoryActionIds), []);
    assert.deepEqual(new Set(off.scenario.analysis.grounding.evidenceIds), new Set([sourceId, SYNOPSIS_SOURCE_ID]));
    assert.equal(off.scenario.analysis.sources.some((source) => source.id === ROLE_PROFILE_SOURCE_ID), false);
    assert.equal(off.scenario.analysisHistory[0].overview, 'DERIVED_OVERVIEW_MARKER');
    assert.equal(off.scenario.analysisHistory[0].sources.find((source) => source.id === ROLE_PROFILE_SOURCE_ID).extractedText.includes('PROFILE_SECRET_MARKER'), true);
    assert.equal(off.scenario.actionHistory.filter((item) => item.retirementReason.includes('送信設定')).length, 2);
    assert.match(JSON.stringify(off.scenario.actionHistory), /DERIVED_COMPLETED_MARKER|DERIVED_DISCARDED_MARKER|DERIVED_RESTORED_MARKER/);
    offOutput.actions[0].continuesActionIds = [off.scenario.analysis.actions[0].id];
    harness.setOutput(offOutput);
    const repeat = await harness.analyzeCase(off.scenario.id, off.scenario.revision);
    assert.equal(repeat.status, 'ok', repeat.message);
    const repeatRequest = JSON.stringify(harness.requests.at(-1).request);
    assert.match(repeatRequest, /SAFE_NEXT_ACTION_MARKER/);
    assert.doesNotMatch(repeatRequest, /DERIVED_|PROFILE_SECRET_MARKER/);
    assert.equal(repeat.scenario.analysisHistory.length, 1);
    assert.equal(repeat.scenario.analysis.actions[0].grounding.previousContextMayIncludeRoleProfile, false);
  });

  test(provider + ' OFF excludes legacy and already-tainted OFF outputs even if they claim profile was not used', async (t) => {
    const harness = await loadMain(t);
    for (const grounding of [undefined, { includeRoleProfile: false, evidenceIds: [] },
      { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: true, evidenceIds: [] }]) {
      const { scenario, sourceId } = fixture();
      scenario.analysis.grounding = grounding;
      scenario.analysis.overview = 'LEGACY_OVERVIEW_MARKER';
      scenario.analysis.hypotheses[0].statement = 'LEGACY_HYPOTHESIS_MARKER';
      scenario.analysis.actions[0] = { ...scenario.analysis.actions[0], title: 'LEGACY_ACTIVE_MARKER', step: 'LEGACY_STEP_MARKER', rationale: 'LEGACY_RATIONALE_MARKER', assumptions: ['LEGACY_ASSUMPTION_MARKER'], grounding };
      scenario.actionHistory = ['completed', 'discarded', 'retired', 'restored'].map((status) => ({
        ...scenario.analysis.actions[0], id: randomUUID(), title: 'LEGACY_' + status + '_MARKER', status, retirementReason: 'LEGACY_REASON_MARKER'
      }));
      scenario.analysisHistory = [{ ...scenario.analysis, overview: 'ARCHIVED_OVERVIEW_MARKER' }];
      await harness.store(scenario, { provider, includeRoleProfile: false, cloudConsent: true, codexConsent: true, ollamaModel: 'synthetic-model' });
      harness.setOutput(outputFor(sourceId));
      const result = await harness.analyzeCase(scenario.id, scenario.revision);
      assert.equal(result.status, 'ok', result.message);
      const request = JSON.stringify(harness.requests.at(-1).request);
      assert.doesNotMatch(request, /LEGACY_|ARCHIVED_|PROFILE_SECRET_MARKER/);
      assert.equal(result.scenario.analysis.grounding.previousContextMayIncludeRoleProfile, false);
      assert.equal(result.scenario.analysisHistory.length, 2);
      assert.equal(result.scenario.analysisHistory[1].overview, 'LEGACY_OVERVIEW_MARKER');
      assert.equal(result.scenario.actionHistory.length, 5);
    }
  });

  test(provider + ' OFF still follows material sending settings when HO contains the same role information', async (t) => {
    const harness = await loadMain(t);
    const { scenario, sourceId } = fixture();
    scenario.evidence[0].extractedText += '\nHOの秘密: PROFILE_SECRET_MARKER';
    scenario.evidence.push({ id: ROLE_PROFILE_SOURCE_ID, kind: 'text', title: '偽の出典', extractedText: 'RESERVED_PROFILE_MARKER' });
    const next = outputFor(sourceId);
    next.actions[0].continuesActionIds = [scenario.analysis.actions[0].id];
    await harness.store(scenario, { provider, includeRoleProfile: false, cloudConsent: true, codexConsent: true, ollamaModel: 'synthetic-model' });
    harness.setOutput(next);
    const result = await harness.analyzeCase(scenario.id, scenario.revision);
    assert.equal(result.status, 'ok', result.message);
    const request = JSON.stringify(harness.requests.at(-1).request);
    assert.match(request, /HOの秘密: PROFILE_SECRET_MARKER/);
    assert.doesNotMatch(request, /RESERVED_PROFILE_MARKER/);
    assert.ok(!request.includes('[資料ID: ' + ROLE_PROFILE_SOURCE_ID + ']'));
    assert.equal(result.scenario.analysis.grounding.includeRoleProfile, false);
    assert.deepEqual(new Set(result.scenario.analysis.grounding.evidenceIds), new Set([sourceId, SYNOPSIS_SOURCE_ID]));
    assert.equal(result.scenario.analysis.actions[0].grounding.includeRoleProfile, false);
  });
}

test('excluded profile text does not consume the material input limit', async (t) => {
  const harness = await loadMain(t);
  const { scenario } = fixture();
  scenario.roleProfile.secret = 'x'.repeat(300001);
  const off = await harness.evidenceForRequest(scenario, false);
  assert.ok(off.textCharacters < 300000);
  await assert.rejects(harness.evidenceForRequest(scenario, true), /30万文字/);
});

test('headless local history keeps protected results and fixed-source snapshots reachable, and settings explain HO scope', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const display = await loadDisplay();
  const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
  const { scenario, sourceId } = fixture();
  const priorOutput = outputFor(sourceId);
  priorOutput.actions[0].continuesActionIds = [scenario.analysis.actions[0].id];
  priorOutput.overview = 'LOCAL_PROTECTED_OVERVIEW_MARKER';
  priorOutput.actions[0].step = 'LOCAL_PROTECTED_STEP_MARKER';
  priorOutput.hypotheses = Array.from({ length: 4 }, (_, index) => ({ statement: 'LOCAL_HYPOTHESIS_' + index, why: 'ローカルの解釈', evidenceIds: [], assumptions: [] }));
  const on = applyAnalysis(scenario, priorOutput, scenario.revision, undefined, { includeRoleProfile: true });
  const off = applyAnalysis(on, outputFor(sourceId), on.revision);
  const noop = () => {};
  const history = render(display.HistoryPage, { scenario: off, history: off.actionHistory, onRestore: noop, onEvidence: noop });
  assert.match(history, /LOCAL_PROTECTED_OVERVIEW_MARKER/);
  assert.match(history, /LOCAL_PROTECTED_STEP_MARKER/);
  assert.match(history, /LOCAL_HYPOTHESIS_3/);
  assert.match(history, /役情報OFFの解析には送信しません/);
  const citation = render(display.Citations, { scenario: off, ids: [ROLE_PROFILE_SOURCE_ID], onEvidence: noop });
  assert.match(citation, /役プロフィール/);
  assert.doesNotMatch(citation, /資料なし/);
  const evidence = render(display.EvidencePage, { scenario: off, settings: { textLimitCharacters: 300000 }, selected: ROLE_PROFILE_SOURCE_ID,
    title: '', draft: '', visibility: 'unknown', profile: { title: '', synopsis: '', role: '', goal: '', secret: '' }, totalChars: 0, totalBytes: 0 });
  assert.match(evidence, /PROFILE_SECRET_MARKER/);
  const settings = render(display.SettingsPage, { settings: { provider: 'none' }, onSettings: noop, onSaved: noop,
    onCodexStatus: noop, codexStatus: null, onDataFolder: noop, onError: noop, onDelete: noop, scenario: off });
  assert.match(settings, /由来不明の過去の方針・仮説・履歴等も送信しません/);
  assert.match(settings, /同じ役情報がHOに含まれる場合は、HOを含む資料の送信設定に従います/);
});

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' single-click completion/dismissal and optional IPC notes are included in the next scoped history input', async (t) => {
    const harness = await loadMain(t);
    const { scenario, sourceId } = fixture();
    const first = scenario.analysis.actions[0];
    const second = { ...first, id: randomUUID(), title: '記録の意味を保管係に確認する', who: '保管係', purpose: '記録の意味を知る', step: '保管係へ日時欄と記号の意味を聞く', assumptions: ['記録が返却を意味する'] };
    scenario.analysis.actions.push(second);
    const preferences = { provider, cloudConsent: true, codexConsent: true, includeRoleProfile: false, ollamaModel: 'synthetic-model' };
    await harness.store(scenario, preferences);
    const completed = await harness.handlers.get('scenario:complete-action')({}, { id: scenario.id, actionId: first.id });
    assert.equal(completed.actionHistory[0].status, 'completed');
    assert.equal(completed.actionHistory[0].retirementReason, '');
    const discarded = await harness.handlers.get('scenario:discard-action')({}, { id: scenario.id, actionId: second.id });
    assert.equal(discarded.actionHistory[1].status, 'discarded');
    assert.equal(discarded.actionHistory[1].retirementReason, '');
    assert.equal(harness.requests.length, 0, 'state changes do not require an AI request');
    const done = await harness.handlers.get('scenario:action-notes')({}, { id: scenario.id, actionId: second.id, reason: 'SAFE_OPTIONAL_REASON_MARKER', resultNote: 'SAFE_OPTIONAL_ANSWER_MARKER' });
    const next = outputFor(sourceId); next.actions = []; next.hypotheses = [];
    harness.setOutput(next);
    const result = await harness.analyzeCase(scenario.id, done.revision);
    assert.equal(result.status, 'ok', result.message);
    const text = JSON.stringify(harness.requests.at(-1).request);
    for (const old of done.actionHistory) {
      for (const value of [old.id, old.status, old.who, old.purpose, old.step, old.retiredAt, ...old.assumptions]) assert.ok(text.includes(value), value);
    }
    for (const value of ['SAFE_OPTIONAL_REASON_MARKER', 'SAFE_OPTIONAL_ANSWER_MARKER']) assert.ok(text.includes(value));
    assert.ok(!text.includes('PROFILE_SECRET_MARKER'));
    assert.deepEqual(Array.from(result.scenario.analysis.grounding.contextHistoryActionIds), [first.id, second.id]);
    assert.equal(result.scenario.evidence.length, scenario.evidence.length, 'a history note is not promoted into a source');
    const schema = harness.ANALYSIS_SCHEMA.properties.actions.items;
    assert.ok(schema.required.includes('rechecks'));
    assert.deepEqual(Array.from(schema.properties.rechecks.items.required), ['actionId', 'previousPremise', 'currentPremise', 'reason']);
  });

  test(provider + ' OFF never resends ON-generated retirement reasons or manual notes attached to an OFF-origin action', async (t) => {
    const harness = await loadMain(t);
    for (const status of ['retired', 'completed', 'discarded']) {
      const { scenario, sourceId } = fixture();
      const original = scenario.analysis.actions[0];
      const preferences = { provider, cloudConsent: true, codexConsent: true, includeRoleProfile: true, ollamaModel: 'synthetic-model' };
      await harness.store(scenario, preferences);
      let saved;
      if (status === 'retired') {
        const next = outputFor(sourceId); next.actions = []; next.hypotheses = [];
        next.retirements = [{ actionId: original.id, reason: 'ON_RETIREMENT_REASON_SECRET_MARKER' }];
        harness.setOutput(next);
        const result = await harness.analyzeCase(scenario.id, scenario.revision);
        assert.equal(result.status, 'ok', result.message);
        saved = result.scenario;
        assert.equal(saved.actionHistory[0].retirementGrounding.includeRoleProfile, true);
      } else {
        saved = await harness.handlers.get(status === 'completed' ? 'scenario:complete-action' : 'scenario:discard-action')({}, { id: scenario.id, actionId: original.id });
        saved = await harness.handlers.get('scenario:action-notes')({}, { id: scenario.id, actionId: original.id, reason: 'ON_MANUAL_REASON_SECRET_MARKER', resultNote: 'ON_RESPONSE_SECRET_MARKER' });
        assert.equal(saved.actionHistory[0].retirementGrounding.includeRoleProfile, true);
        assert.equal(saved.actionHistory[0].resultGrounding.includeRoleProfile, true);
      }
      assert.equal(saved.actionHistory[0].grounding.includeRoleProfile, false);
      await harness.store(saved, { ...preferences, includeRoleProfile: false });
      const offOutput = outputFor(sourceId); offOutput.actions = []; offOutput.hypotheses = [];
      harness.setOutput(offOutput);
      const off = await harness.analyzeCase(saved.id, saved.revision);
      assert.equal(off.status, 'ok', off.message);
      const text = JSON.stringify(harness.requests.at(-1).request);
      for (const marker of ['PROFILE_SECRET_MARKER', 'ON_RETIREMENT_REASON_SECRET_MARKER', 'ON_MANUAL_REASON_SECRET_MARKER', 'ON_RESPONSE_SECRET_MARKER', original.id]) assert.ok(!text.includes(marker), marker);
      assert.deepEqual(Array.from(off.scenario.analysis.grounding.contextHistoryActionIds), []);
      assert.equal(off.scenario.actionHistory[0].retirementReason, saved.actionHistory[0].retirementReason);
      assert.equal(off.scenario.actionHistory[0].status, status);
      assert.equal(off.scenario.analysis.grounding.previousContextMayIncludeRoleProfile, false);
    }
  });
}

test('action cards distinguish source scope, show care and premise changes outside details, and permit optional-only history forms', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const display = await loadDisplay();
  const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
  const { scenario, sourceId } = fixture();
  const action = { ...scenario.analysis.actions[0], evidenceIds: [sourceId], secretRisk: 'PRIVATE_SPEECH_RISK_MARKER',
    rechecks: [{ actionId: 'old-action', previousPremise: '証人は退場済み', currentPremise: '証人が戻った可能性', reason: '在席しているなら聞き直せる' }] };
  scenario.evidence[0].visibility = 'shared';
  const noop = () => {};
  const props = { scenario, actions: [action], settings: { provider: 'none' }, onAnalyze: noop, onComplete: noop, onDiscard: noop, onEvidence: noop };
  const html = render(display.PlansPage, props);
  assert.match(html, /根拠資料の公開範囲/);
  assert.match(html, /全体公開/);
  assert.ok(html.indexOf('PRIVATE_SPEECH_RISK_MARKER') < html.indexOf('<details'));
  assert.ok(html.indexOf('証人が戻った可能性') < html.indexOf('<details'));
  assert.match(html, /以前: 証人は退場済み/);
  assert.doesNotMatch(html, /discard-box|理由を保存して棄却/);
  const withoutSources = render(display.ActionSourceScope, { scenario, action: { ...action, evidenceIds: [] } });
  assert.match(withoutSources, /参照資料なし/);
  assert.doesNotMatch(withoutSources, /全体公開/);
  const missing = render(display.ActionSourceScope, { scenario, action: { ...action, evidenceIds: [sourceId, 'missing'] } });
  assert.match(missing, /公開状況不明/);
  assert.doesNotMatch(missing, /全体公開/);
  scenario.evidence[0].visibility = 'private';
  assert.match(render(display.ActionSourceScope, { scenario, action }), /自分だけ/);
  assert.match(render(display.ActionCare, { action: { ...action, secretRisk: '' } }), /未確認/);
  const overview = render(display.Overview, { ...props, activeActions: [action], onEdit: noop, onPlans: noop });
  assert.match(overview, /PRIVATE_SPEECH_RISK_MARKER/);
  assert.match(overview, /見送る/);
  const calls = [];
  const controls = display.ActionControls({ action, onComplete: (value) => calls.push(['completed', value.id]), onDiscard: (value) => calls.push(['discarded', value.id]) });
  controls.props.children[0].props.onClick();
  controls.props.children[1].props.onClick();
  assert.deepEqual(calls, [['completed', action.id], ['discarded', action.id]]);
  const pending = display.ActionControls({ action, onComplete: noop, onDiscard: noop, pending: true });
  assert.ok(pending.props.children.every((button) => button.props.disabled));
  let saved; let prevented = false;
  const editor = display.HistoryNoteEditor({ action: { ...action, status: 'discarded' }, notes: { reason: '', resultNote: '' }, onChange: noop, onSave: (value) => { saved = value; } });
  editor.props.children[1].props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual({ ...saved }, { reason: '', resultNote: '' });
  const editorHtml = render(display.HistoryNoteEditor, { action, notes: { reason: '', resultNote: '' }, onChange: noop, onSave: noop });
  assert.doesNotMatch(editorHtml, /required|disabled/);
});

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' a completion during analysis preserves the recorded history and rejects the older result', async (t) => {
    const harness = await loadMain(t);
    const { scenario, sourceId } = fixture();
    await harness.store(scenario, { provider, cloudConsent: true, codexConsent: true, includeRoleProfile: false, ollamaModel: 'synthetic-model' });
    const next = outputFor(sourceId); next.actions[0].continuesActionIds = [scenario.analysis.actions[0].id];
    harness.setOutput(next);
    const gate = harness.holdResponse();
    const running = harness.analyzeCase(scenario.id, scenario.revision);
    try {
      for (let attempt = 0; attempt < 200 && harness.requests.length === 0; attempt += 1) await delay(5);
      assert.equal(harness.requests.length, 1);
      const completed = await harness.handlers.get('scenario:complete-action')({}, { id: scenario.id, actionId: scenario.analysis.actions[0].id });
      assert.equal(completed.actionHistory[0].status, 'completed');
      gate.release();
      const result = await running;
      assert.equal(result.status, 'stale');
      assert.deepEqual(await harness.read(scenario), JSON.parse(JSON.stringify(completed)));
      assert.equal((await harness.read(scenario)).analysis.actions.length, 0);
    } finally { gate.release(); await running; }
  });
}
