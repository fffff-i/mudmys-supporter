import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisUpdater, analysisSettingsKey } from '../shared/analysisUpdater.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const preferences = (patch = {}) => ({ provider: 'ollama', ollamaModel: 'mock', model: 'mock', effort: 'low', ollamaUrl: 'http://localhost:11434',
  codexModel: '', codexEffort: '', codexCliPath: '', includeRoleProfile: false, cloudConsent: true, codexConsent: true, hasKey: true,
  autoUpdate: true, settingsVersion: 0, ...patch });
function record(id = 'a', revision = 1) {
  return { id, revision, title: id, synopsis: '', roleProfile: {}, evidence: [{ id: 'ev-1', extractedText: 'saved-1' }], analysis: null, actionHistory: [] };
}
function fixture(patch = {}) {
  let settings = preferences(patch), sequence = 0;
  const records = new Map([['a', record()], ['b', record('b')]]);
  const timers = new Map(), calls = [], cancellations = [], applied = [], results = [], states = [];
  const queue = createAnalysisUpdater({
    readScenario: async (id) => structuredClone(records.get(id)),
    readSettings: async () => settings,
    analyze: (payload) => new Promise((resolve, reject) => calls.push({ payload, resolve, reject })),
    cancel: async (payload) => { cancellations.push(payload); },
    onScenario: (next, token) => applied.push({ next, token }), onResult: (result) => results.push(result), onState: (state) => states.push(state),
    newRunId: () => 'run-' + ++sequence,
    schedule: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    unschedule: (id) => timers.delete(id)
  });
  queue.setSettings(settings); queue.select({ id: 'a', generation: 1 }); queue.observe(records.get('a'));
  return {
    queue, calls, records, cancellations, applied, results, states,
    save(id = 'a') { const previous = records.get(id); const next = { ...previous, revision: previous.revision + 1,
      evidence: [...previous.evidence, { id: 'ev-' + (previous.revision + 1), extractedText: 'saved-' + (previous.revision + 1) }] };
      records.set(id, next); queue.changed(next); return next; },
    settings(patch) { settings = preferences({ ...settings, ...patch }); queue.setSettings(settings); return settings; },
    async tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await turn(); },
    async finish(index, status = 'ok') {
      const call = calls[index];
      if (status !== 'ok') call.resolve({ status });
      else {
        const source = records.get(call.payload.id);
        const next = { ...source, revision: source.revision + 1, analysis: {
          revision: source.revision + 1, inputRevision: call.payload.expectedRevision, settingsKey: analysisSettingsKey(settings), overview: 'fresh', actions: []
        } };
        records.set(source.id, next); call.resolve({ status: 'ok', scenario: next });
      }
      await turn();
    }
  };
}

test('a burst coalesces into one latest request and result-save revisions do not trigger a loop', async () => {
  const h = fixture();
  h.save(); h.save(); h.save();
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.view().phase, 'queued');
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.expectedRevision, 4);
  await h.finish(0);
  await h.tick(); await h.tick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.queue.view(), { id: 'a', phase: 'idle', pending: false, dirty: false });
});

test('in-flight saves remain accepted, obsolete input is discarded and all changes become one following request', async () => {
  const h = fixture();
  h.save(); await h.tick();
  h.save(); h.save(); h.save();
  assert.equal(h.records.get('a').evidence.length, 5);
  assert.equal(h.queue.view().pending, true);
  await h.tick(); assert.equal(h.calls.length, 1);
  await h.finish(0, 'stale'); await h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].payload.expectedRevision, 5);
  await h.finish(1); await h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.queue.view().dirty, false);
});

test('reversed save responses and a success response older than a later save cannot replace the latest display', async () => {
  const h = fixture();
  const older = h.save(); const newest = h.save();
  h.queue.changed(older);
  await h.tick(); assert.equal(h.calls[0].payload.expectedRevision, newest.revision);
  const committed = { ...newest, revision: 4, analysis: { revision: 4, inputRevision: 3, actions: [] } };
  h.records.set('a', committed);
  const later = h.save();
  h.calls[0].resolve({ status: 'ok', scenario: committed }); await turn();
  assert.equal(h.applied.at(-1).next.revision, newest.revision);
  await h.tick(); assert.equal(h.calls[1].payload.expectedRevision, later.revision);
  await h.finish(1);
});

test('manual OFF saves make no requests; repeated manual updates and their in-flight changes form one transaction', async () => {
  const h = fixture({ autoUpdate: false });
  h.save(); await h.tick(); assert.equal(h.calls.length, 0);
  assert.equal(h.queue.view().dirty, true);
  h.queue.request('a'); h.queue.request('a'); h.queue.request('a'); await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].payload.automatic, false);
  h.save(); h.queue.request('a');
  await h.finish(0, 'stale'); await h.tick();
  assert.equal(h.calls.length, 2);
  await h.finish(1); h.save(); await h.tick(); assert.equal(h.calls.length, 2);
});

test('cancel clears the current reservation and delayed success never revives it; only a new save can authorize auto again', async () => {
  const h = fixture();
  h.save(); await h.tick(); h.save();
  h.queue.cancel('a');
  assert.equal(h.cancellations.length, 1);
  assert.equal(h.cancellations[0].runId, h.calls[0].payload.runId);
  await h.finish(0); await h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.queue.view().dirty, true);
  h.save(); await h.tick(); assert.equal(h.calls.length, 2);
  h.queue.cancel('a'); await h.finish(1, 'cancelled');
});

test('cancel before dispatch removes the debounce timer', async () => {
  const h = fixture(); h.save(); h.queue.cancel('a'); await h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.queue.view().phase, 'idle');
});

test('A to B to A keeps old cancellation and completion apart from the new selection and run', async () => {
  const h = fixture(); h.save(); await h.tick();
  h.queue.select({ id: 'b', generation: 2 }); h.queue.observe(h.records.get('b'));
  h.save('b'); await h.tick();
  h.queue.select({ id: 'a', generation: 3 }); h.queue.observe(h.records.get('a')); h.queue.request('a');
  await h.finish(0); await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].payload.id, 'a');
  assert.notEqual(h.calls[2].payload.runId, h.calls[0].payload.runId);
  const before = h.applied.length;
  await h.finish(1); assert.equal(h.applied.length, before);
  assert.equal(h.queue.view().phase, 'updating');
  await h.finish(2);
  assert.equal(h.applied.at(-1).token.generation, 3);
});

for (const patch of [{ provider: 'openai' }, { model: 'other' }, { effort: 'high' }, { includeRoleProfile: true },
  { codexModel: 'other' }, { codexEffort: 'high' }, { ollamaModel: 'other' }]) {
  test('authorized continuation adopts changed settings: ' + JSON.stringify(patch), async () => {
    const h = fixture(); h.save(); await h.tick(); h.save();
    h.settings({ ...patch, settingsVersion: 1 });
    assert.equal(h.cancellations.length, 1);
    await h.finish(0, 'stale'); await h.tick();
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].payload.settingsVersion, 1);
    await h.finish(1); await h.tick(); assert.equal(h.calls.length, 2);
  });
}

for (const patch of [{ autoUpdate: false }, { provider: 'none' }, { provider: 'openai', cloudConsent: false }, { provider: 'codex', codexConsent: false }]) {
  test('stopping settings discard automatic intent and settings-only changes never start a new analysis: ' + JSON.stringify(patch), async () => {
    const h = fixture(); h.settings({ ...patch, settingsVersion: 1 }); await h.tick(); assert.equal(h.calls.length, 0);
    h.settings({ provider: 'ollama', autoUpdate: true, settingsVersion: 2 });
    h.save(); await h.tick(); h.save();
    h.settings({ ...patch, settingsVersion: 3 });
    await h.finish(0, 'stale'); await h.tick();
    assert.equal(h.calls.length, 1); assert.equal(h.queue.view().dirty, true);
    h.settings({ provider: 'ollama', autoUpdate: true, settingsVersion: 4 }); await h.tick();
    assert.equal(h.calls.length, 1);
  });
}

test('same-input stale and failures stop, while new input during a failed request receives one following attempt', async () => {
  for (const status of ['stale', 'error', 'unconfigured', 'cancelled']) {
    const h = fixture(); h.save(); await h.tick(); await h.finish(0, status);
    await h.tick(); await h.tick(); assert.equal(h.calls.length, 1, status);
    assert.equal(h.queue.view().dirty, true);
  }
  const h = fixture(); h.save(); await h.tick(); h.save();
  await h.finish(0, 'error'); await h.tick(); assert.equal(h.calls.length, 2);
  await h.finish(1, 'error'); await h.tick(); assert.equal(h.calls.length, 2);
});

test('a stale start recovers a newer storage revision without any caller having to reload it', async () => {
  const h = fixture(); h.save(); await h.tick();
  h.records.set('a', { ...h.records.get('a'), revision: 8 });
  await h.finish(0, 'stale'); await h.tick();
  assert.equal(h.calls[1].payload.expectedRevision, 8);
  await h.finish(1);
});

test('a backend busy barrier retries after it drains even with unchanged input, without parallel requests', async () => {
  const h = fixture(); h.queue.request('a'); await h.tick();
  await h.finish(0, 'busy'); await h.tick();
  assert.equal(h.calls.length, 2);
  await h.finish(1); await h.tick(); assert.equal(h.calls.length, 2);
});

test('scenario creation selection, deletion and disposal invalidate outstanding responses and timers', async () => {
  const h = fixture(); h.save(); await h.tick();
  h.queue.remove('a'); h.queue.select({ id: 'created', generation: 2 });
  await h.finish(0); await h.tick();
  assert.equal(h.queue.view().id, 'created'); assert.equal(h.results.length, 0);
  h.queue.select({ id: 'b', generation: 3 }); h.save('b'); h.queue.dispose(); await h.tick();
  assert.equal(h.calls.length, 1);
});
