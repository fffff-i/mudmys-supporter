const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { evidenceHarness } = require('../scripts/evidenceHarness.cjs');
const { createAnalysisUpdater } = require('../shared/analysisUpdater.mjs');
const { applyAnalysis } = require('../shared/analysisLifecycle.cjs');
const { getAnalysisContext } = require('../shared/analysisScope.cjs');

function gate() { let release; const wait = new Promise((resolve) => { release = resolve; }); return { wait, release }; }
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  const deadline = Date.now() + 4000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Synthetic boundary timed out'); await new Promise((r) => setTimeout(r, 5)); }
}
const output = { overview: '架空の最新結果', flow: [], events: [], facts: [], hypotheses: [], unknowns: [], actions: [], retirements: [] };
async function setup(t, provider, patch = {}) {
  const h = await evidenceHarness(t);
  const scenario = await h.invoke('scenario:create', 'Synthetic A');
  const saved = await h.invoke('scenario:add-text', { id: scenario.id, text: 'SAVED_BODY' });
  let settings = await h.invoke('settings:save', { provider, model: 'mock-model', effort: 'low', ollamaModel: 'mock-model',
    cloudConsent: true, codexConsent: true, autoUpdate: true, ...patch });
  h.controls.output = output;
  return { ...h, scenario: saved, get settings() { return settings; },
    async preferences(patch) { settings = await h.invoke('settings:save', { ...settings, ...patch }); return settings; },
    start(record = saved, runId = 'run-one', automatic = false) {
      return h.invoke('scenario:analyze', { id: record.id, expectedRevision: record.revision, runId, automatic, settingsVersion: settings.settingsVersion });
    }
  };
}

for (const provider of ['openai', 'ollama', 'codex']) {
  test(provider + ' duplicate IPC joins one barrier, saves continue, and a later request uses the complete latest data', async (t) => {
    const h = await setup(t, provider);
    const g = gate(); t.after(g.release);
    let active = 0, max = 0;
    h.controls.turn = async () => { active++; max = Math.max(max, active); await g.wait; active--; };
    const first = h.start();
    const same = h.start(h.scenario, 'run-one');
    await until(() => h.requests.length === 1);
    const duplicate = h.start(h.scenario, 'run-two');
    let latest = h.scenario;
    for (const text of ['SECOND_BODY', 'THIRD_BODY']) latest = await h.invoke('scenario:add-text', { id: latest.id, text });
    assert.equal(active, 1);
    assert.equal(latest.evidence.length, 3);
    assert.equal((await h.read(latest.id)).revision, latest.revision);
    g.release();
    assert.equal((await first).status, 'stale');
    assert.equal((await same).status, 'stale');
    assert.equal((await duplicate).status, 'busy');
    assert.equal(h.requests.length, 1);
    const fresh = await h.start(latest, 'run-three');
    assert.equal(fresh.status, 'ok', fresh.message);
    assert.equal(max, 1);
    assert.equal(h.requests.length, 2);
    const request = JSON.stringify(h.requests.at(-1).request);
    assert.match(request, /SAVED_BODY/); assert.match(request, /SECOND_BODY/); assert.match(request, /THIRD_BODY/);
    assert.equal(fresh.scenario.analysis.inputRevision, latest.revision);
  });

  test(provider + ' explicit cancellation invalidates late output and an old run ID cannot cancel a new run at the same revision', async (t) => {
    const h = await setup(t, provider);
    const g = gate(); t.after(g.release); h.controls.turn = () => g.wait;
    const first = h.start(); await until(() => h.requests.length === 1);
    assert.equal((await h.invoke('scenario:cancel-analysis', { id: h.scenario.id, runId: 'wrong' })).canceled, false);
    assert.equal((await h.invoke('scenario:cancel-analysis', { id: h.scenario.id, expectedRevision: h.scenario.revision })).canceled, false);
    assert.equal((await h.invoke('scenario:cancel-analysis', { id: h.scenario.id, runId: 'run-one' })).canceled, true);
    assert.equal(h.requests[0].signal.aborted, true);
    g.release(); assert.equal((await first).status, 'cancelled');
    assert.equal((await h.read(h.scenario.id)).analysis, null);
    const secondGate = gate(); t.after(secondGate.release); h.controls.turn = () => secondGate.wait;
    const next = h.start(h.scenario, 'new-run'); await until(() => h.requests.length === 2);
    assert.equal((await h.invoke('scenario:cancel-analysis', { id: h.scenario.id, runId: 'run-one' })).canceled, false);
    assert.equal(h.requests[1].signal.aborted, false);
    secondGate.release(); assert.equal((await next).status, 'ok');
  });

  test(provider + ' setting changes invalidate old output and the next scope removes role-derived prose through app grounding', async (t) => {
    const h = await setup(t, provider, { includeRoleProfile: true });
    const protectedRecord = { ...h.scenario, roleProfile: { role: 'ROLE_MARKER', goal: 'GOAL_MARKER', secret: 'SECRET_MARKER' } };
    const proposal = { title: 'DERIVED_TITLE_MARKER', who: '架空の役', step: 'DERIVED_STEP_MARKER', rationale: 'DERIVED_WHY_MARKER', priority: 1,
      evidenceIds: [], assumptions: [], continuesActionIds: [], replacesActionIds: [] };
    const previous = applyAnalysis(protectedRecord, { ...output, actions: [proposal] }, protectedRecord.revision, undefined, { includeRoleProfile: true });
    await h.store(previous, provider, true);
    // Direct fixture writes intentionally keep the current runtime settings epoch.
    const g = gate(); t.after(g.release); h.controls.turn = () => g.wait;
    const pending = h.start(previous);
    await until(() => h.requests.length === 1);
    assert.match(JSON.stringify(h.requests[0].request), /SECRET_MARKER/);
    await h.preferences({ includeRoleProfile: false });
    assert.equal(h.requests[0].signal.aborted, true);
    g.release(); assert.equal((await pending).status, 'stale');
    assert.equal((await h.read(previous.id)).revision, previous.revision);
    h.controls.turn = null;
    const next = await h.start(previous, 'role-off');
    assert.equal(next.status, 'ok', next.message);
    assert.doesNotMatch(JSON.stringify(h.requests[1].request), /ROLE_MARKER|GOAL_MARKER|SECRET_MARKER|DERIVED_.*_MARKER/);
    assert.equal(next.scenario.analysisHistory[0].overview, previous.analysis.overview);
    assert.equal(next.scenario.analysis.grounding.includeRoleProfile, false);
  });

  test(provider + ' input and setting changes during material preparation send no obsolete request', async (t) => {
    const h = await setup(t, provider);
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    let latest = await h.invoke('scenario:add-pasted-image', { id: h.scenario.id, dataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
    const image = latest.evidence.find((e) => e.kind === 'image'), g = gate(); t.after(g.release);
    let entered = false;
    h.controls.beforeRead = async (filename) => { if (filename.includes('attachments')) { entered = true; await g.wait; } };
    const pending = h.start(latest); await until(() => entered);
    latest = await h.invoke('scenario:set-evidence-enabled', { id: latest.id, evidenceId: image.id, enabled: false });
    await h.preferences({ includeRoleProfile: true });
    h.controls.beforeRead = null; g.release();
    assert.equal((await pending).status, 'stale');
    assert.equal(h.requests.length, 0);
    const next = await h.start(latest, 'fresh-preparation');
    assert.equal(next.status, 'ok');
    assert.equal(next.attachmentBytes, 0);
    assert.deepEqual(await fs.readFile(path.join(h.directory, 'cases', latest.id, image.attachmentPath)), bytes);
  });

  test(provider + ' edit, exclude, restore, scope, profile and action-history saves coalesce while inference is waiting', async (t) => {
    const h = await setup(t, provider);
    const initial = { ...h.scenario, roleProfile: { role: '架空の役', goal: '', secret: '' } };
    const proposals = ['act-a', 'act-b'].map((title) => ({ title, who: title, purpose: title, step: '各記録を確認する。', rationale: '未確認', priority: 1,
      evidenceIds: [], assumptions: [], continuesActionIds: [], replacesActionIds: [] }));
    let latest = applyAnalysis(initial, { ...output, actions: proposals }, initial.revision);
    await h.store(latest, provider);
    const settings = await h.invoke('settings:get');
    const g = gate(); t.after(g.release); let gateUsed = false;
    h.controls.turn = async () => { if (!gateUsed) { gateUsed = true; await g.wait; } };
    const timers = new Map(), results = [], token = { id: latest.id, generation: 1 };
    let seq = 0;
    const queue = createAnalysisUpdater({ readScenario: (id) => h.read(id), readSettings: () => h.invoke('settings:get'),
      analyze: (payload) => h.invoke('scenario:analyze', payload), cancel: (payload) => h.invoke('scenario:cancel-analysis', payload),
      onResult: (result) => results.push(result), schedule: (fn) => { const id = ++seq; timers.set(id, fn); return id; }, unschedule: (id) => timers.delete(id),
      newRunId: () => 'integration-' + ++seq });
    t.after(() => queue.dispose());
    queue.setSettings(settings); queue.select(token); queue.observe(latest); queue.request(latest.id);
    const tick = async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await turn(); };
    await tick(); await until(() => h.requests.length === 1);
    async function save(method, payload) { latest = await h.invoke(method, { id: latest.id, ...payload }); queue.changed(latest); }
    const evidenceId = latest.evidence[0].id;
    await save('scenario:edit-evidence', { evidenceId, text: 'EDITED_LATEST_BODY', title: 'LATEST_TITLE', expectedUpdatedAt: latest.evidence[0].createdAt });
    await save('scenario:set-evidence-enabled', { evidenceId, enabled: false });
    await save('scenario:set-evidence-enabled', { evidenceId, enabled: true });
    await save('scenario:set-visibility', { evidenceId, visibility: 'private' });
    await save('scenario:save-profile', { expectedRevision: latest.revision, title: 'LATEST_PROFILE_TITLE', synopsis: 'LATEST_SYNOPSIS', role: '架空の役', goal: '', secret: '' });
    const completed = latest.analysis.actions[0], dismissed = latest.analysis.actions[1];
    await save('scenario:complete-action', { actionId: completed.id });
    await save('scenario:discard-action', { actionId: dismissed.id });
    await save('scenario:action-notes', { actionId: completed.id, reason: 'OPTIONAL_REASON', resultNote: 'OPTIONAL_RESULT' });
    await save('scenario:restore-action', { actionId: dismissed.id });
    await save('scenario:add-evidence', { text: 'NEWEST_EVIDENCE_BODY' });
    const revision = latest.revision;
    h.controls.output = { ...output, retirements: getAnalysisContext(latest, false).activeActionIds.map((actionId) => ({ actionId, reason: '更新済みの履歴を参照' })) };
    assert.equal(h.requests.length, 1);
    assert.equal((await h.read(latest.id)).revision, revision);
    g.release();
    await until(() => queue.view().phase === 'queued');
    await tick(); await until(() => queue.view().phase === 'idle');
    assert.equal(h.requests.length, 2);
    const final = await h.read(latest.id);
    assert.equal(final.analysis.inputRevision, revision);
    assert.equal(final.evidence[0].extractedText, 'SAVED_BODY');
    assert.equal(final.evidence[0].editedText, 'EDITED_LATEST_BODY');
    const sent = JSON.stringify(h.requests[1].request);
    for (const marker of ['EDITED_LATEST_BODY', 'LATEST_TITLE', 'LATEST_SYNOPSIS', 'OPTIONAL_REASON', 'OPTIONAL_RESULT', 'NEWEST_EVIDENCE_BODY', 'completed', 'restored']) assert.ok(sent.includes(marker), marker);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'ok');
    await tick(); assert.equal(h.requests.length, 2);
  });

  test(provider + ' cancellation before the atomic result write leaves both original input and last analysis intact', async (t) => {
    const h = await setup(t, provider);
    const g = gate(); t.after(g.release); let entered = false;
    h.controls.afterWrite = async (filename) => { if (filename.includes('case.json.tmp-')) { entered = true; await g.wait; } };
    const pending = h.start(); await until(() => entered);
    await h.invoke('scenario:cancel-analysis', { id: h.scenario.id, runId: 'run-one' });
    h.controls.afterWrite = null; g.release();
    assert.equal((await pending).status, 'cancelled');
    const stored = await h.read(h.scenario.id);
    assert.equal(stored.revision, h.scenario.revision); assert.equal(stored.analysis, null);
  });
}

test('Codex turn-lock waiting and post-preparation both recheck input/settings immediately before scenario dispatch', async (t) => {
  for (const stage of ['lock', 'prepare']) {
    const h = await setup(t, 'codex', { includeRoleProfile: true });
    let latest = h.scenario;
    const g = gate(); t.after(g.release); let entered = false;
    let holding;
    if (stage === 'lock') holding = h.withCodexTurnLock('codex-analysis', () => { entered = true; return g.wait; });
    else h.controls.afterPrepare = async () => { entered = true; await g.wait; };
    const pending = h.start(); await until(() => entered);
    latest = await h.invoke('scenario:add-text', { id: latest.id, text: 'AFTER_WAIT_BODY' });
    await h.preferences({ includeRoleProfile: false });
    h.controls.afterPrepare = null; g.release(); if (holding) await holding;
    assert.equal((await pending).status, 'stale', stage);
    assert.equal(h.requests.length, 0);
    assert.equal((await h.start(latest, 'fresh-' + stage)).status, 'ok');
    assert.match(JSON.stringify(h.requests[0].request), /AFTER_WAIT_BODY/);
  }
});

test('OpenAI key read is followed by a freshness check before any scenario dispatch', async (t) => {
  const h = await setup(t, 'openai'); const g = gate(); t.after(g.release); let entered = false;
  h.controls.beforeRead = async (filename) => { if (filename.endsWith('openai-key.bin')) { entered = true; await g.wait; } };
  const pending = h.start(); await until(() => entered);
  await h.preferences({ cloudConsent: false, autoUpdate: false });
  h.controls.beforeRead = null; g.release();
  assert.equal((await pending).status, 'stale'); assert.equal(h.requests.length, 0);
  assert.equal((await h.start(h.scenario, 'without-consent')).status, 'unconfigured'); assert.equal(h.requests.length, 0);
});

test('profile saving accepts an unchanged profile across an analysis-only revision and still rejects a conflicting profile', async (t) => {
  const h = await setup(t, 'ollama'); const base = h.scenario;
  const expectedProfile = { title: base.title, synopsis: base.synopsis, role: '', goal: '', secret: '' };
  assert.equal((await h.start()).status, 'ok');
  const saved = await h.invoke('scenario:save-profile', { id: base.id, expectedRevision: base.revision, expectedProfile, title: 'Saved during analysis', synopsis: 'LATEST' });
  assert.equal(saved.title, 'Saved during analysis');
  await assert.rejects(h.invoke('scenario:save-profile', { id: base.id, expectedRevision: base.revision, expectedProfile, title: 'conflicting' }), /別の操作/);
});

test('deleting a scenario cancels its actual provider run and a late result cannot recreate it', async (t) => {
  const h = await setup(t, 'ollama'); const g = gate(); t.after(g.release); h.controls.turn = () => g.wait;
  const pending = h.start(); await until(() => h.requests.length === 1);
  h.controls.confirmDelete = 1;
  assert.equal((await h.invoke('scenario:delete', h.scenario.id)).deleted, true);
  g.release(); assert.equal((await pending).status, 'cancelled');
  await assert.rejects(fs.stat(path.join(h.directory, 'cases', h.scenario.id)), { code: 'ENOENT' });
});

test('settings reads wait for the short atomic settings commit; settings alone and revoked consent make no analysis calls', async (t) => {
  const h = await setup(t, 'ollama'); const g = gate(); t.after(g.release); let entered = false;
  h.controls.afterWrite = async (filename) => { if (filename.includes('preferences.json.tmp-')) { entered = true; await g.wait; } };
  const saving = h.preferences({ provider: 'codex', codexConsent: false, autoUpdate: false }); await until(() => entered);
  let readCompleted = false; const reading = h.invoke('settings:get').then((value) => { readCompleted = true; return value; });
  await turn(); assert.equal(readCompleted, false); assert.equal(h.requests.length, 0);
  h.controls.afterWrite = null; g.release(); await saving;
  const settings = await reading;
  assert.equal(settings.codexConsent, false);
  assert.equal((await h.start(h.scenario, 'revoked')).status, 'unconfigured');
  assert.equal(h.requests.length, 0);
});

test('an existing mock Codex client switches to a different synthetic CLI under the turn lock without counting the requesting run as busy', async (t) => {
  const h = await setup(t, 'codex', { codexCliPath: 'synthetic-cli-first' });
  h.controls.clientLifecycle = true;
  const first = await h.start();
  assert.equal(first.status, 'ok', first.message);
  assert.equal(h.controls.clients.length, 1);
  assert.equal(h.controls.clients[0].options.executable, 'synthetic-cli-first');
  await h.preferences({ codexCliPath: 'synthetic-cli-second' });
  const second = await h.start(first.scenario, 'cli-second');
  assert.equal(second.status, 'ok', second.message);
  assert.equal(h.controls.clients.length, 2);
  assert.equal(h.controls.clients[0].closed, true);
  assert.equal(h.controls.clients[1].options.executable, 'synthetic-cli-second');
  assert.equal(h.controls.clients[1].closed, false);
  for (const client of h.controls.clients) {
    assert.ok(client.options.cwd.startsWith(h.directory + path.sep));
    assert.ok(client.options.codexHome.startsWith(h.directory + path.sep));
  }
  const g = gate(); t.after(g.release); h.controls.turn = () => g.wait;
  const pending = h.start(second.scenario, 'old-cli-in-flight');
  await until(() => h.requests.length === 3);
  await h.preferences({ codexCliPath: 'synthetic-cli-third' });
  const blocked = h.start(second.scenario, 'while-draining');
  g.release(); assert.equal((await pending).status, 'stale'); assert.equal((await blocked).status, 'busy');
  h.controls.turn = null;
  const third = await h.start(second.scenario, 'cli-third');
  assert.equal(third.status, 'ok', third.message);
  assert.equal(h.controls.clients.length, 3);
  assert.equal(h.controls.clients[1].closed, true);
  assert.equal(h.controls.clients[2].options.executable, 'synthetic-cli-third');
  assert.equal(h.requests.length, 4);
});
