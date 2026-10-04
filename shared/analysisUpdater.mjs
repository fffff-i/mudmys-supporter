// The queue holds one running request and one latest intent per scenario.
// Analysis-result saves are observations, never new input notifications.
const SETTINGS_FIELDS = ['provider', 'model', 'effort', 'ollamaUrl', 'ollamaModel', 'codexModel', 'codexEffort', 'codexCliPath', 'includeRoleProfile', 'cloudConsent', 'codexConsent'];

export function analysisSettingsKey(settings, includeAutomation = false) {
  const fields = includeAutomation ? [...SETTINGS_FIELDS, 'autoUpdate'] : SETTINGS_FIELDS;
  const normalized = { provider: settings.provider || 'none', model: settings.model || 'gpt-6-luna', effort: settings.effort || 'medium',
    ollamaUrl: settings.ollamaUrl || 'http://localhost:11434', ollamaModel: settings.ollamaModel || '', codexModel: settings.codexModel || '',
    codexEffort: settings.codexEffort || '', codexCliPath: settings.codexCliPath || '', includeRoleProfile: settings.includeRoleProfile === true,
    cloudConsent: settings.cloudConsent === true, codexConsent: settings.codexConsent === true, autoUpdate: settings.autoUpdate === true };
  return JSON.stringify(fields.map((field) => normalized[field]));
}

export function canAnalyze(settings) {
  if (settings.provider === 'openai') return settings.cloudConsent === true && settings.hasKey !== false;
  if (settings.provider === 'codex') return settings.codexConsent === true;
  return settings.provider === 'ollama' && Boolean(settings.ollamaModel);
}

export function createAnalysisUpdater({ readScenario, readSettings, analyze, cancel, onScenario = () => {}, onResult = () => {}, onState = () => {},
  delay = 400, schedule = setTimeout, unschedule = clearTimeout, newRunId = () => crypto.randomUUID() }) {
  const entries = new Map();
  let settings = { provider: 'none', autoUpdate: false };
  let settingsKey = analysisSettingsKey(settings, true);
  let selection = { id: null, generation: 0 };

  function entryFor(id) {
    let entry = entries.get(id);
    if (!entry) {
      entry = { id, latest: null, changedRevision: -1, dirty: false, request: null, running: null, timer: null, generation: 0 };
      entries.set(id, entry);
    }
    return entry;
  }

  function view() {
    const entry = selection.id && entries.get(selection.id);
    return {
      id: selection.id,
      phase: entry?.running ? (entry.running.invalidated ? 'stopping' : 'updating') : entry?.request ? 'queued' : 'idle',
      pending: Boolean(entry?.request && (!entry.running || entry.running.expectedRevision < (entry.latest?.revision || 0) || entry.running.invalidated)),
      dirty: Boolean(entry?.dirty)
    };
  }
  function emit() { onState(view()); }
  function permitted(mode) { return canAnalyze(settings) && (mode === 'manual' || settings.autoUpdate === true); }
  function current(run) {
    return !run.invalidated && entries.get(run.id)?.generation === run.generation &&
      selection.id === run.selection.id && selection.generation === run.selection.generation;
  }
  function stopTimer(entry) {
    if (entry.timer !== null) unschedule(entry.timer);
    entry.timer = null;
  }
  function invalidate(entry) {
    entry.generation++;
    if (entry.running && !entry.running.invalidated) {
      entry.running.invalidated = true;
      entry.dirty = true;
      if (entry.running.sent) Promise.resolve(cancel({ id: entry.id, runId: entry.running.runId, expectedRevision: entry.running.expectedRevision })).catch(() => {});
    }
  }
  function arm(entry, wait = delay) {
    stopTimer(entry);
    if (entry.running || !entry.request || selection.id !== entry.id || !permitted(entry.request)) return;
    entry.timer = schedule(() => { entry.timer = null; void pump(entry); }, wait);
  }

  function observe(next) {
    const entry = entryFor(next.id);
    if (entry.latest && entry.latest.revision > next.revision) return false;
    entry.latest = next;
    entry.dirty = entry.dirty || (next.analysis
      ? next.revision > next.analysis.revision || Boolean(next.analysis.settingsKey && next.analysis.settingsKey !== analysisSettingsKey(settings))
      : Boolean(next.evidence?.length || next.synopsis?.trim() || Object.values(next.roleProfile || {}).some(Boolean)));
    emit();
    return true;
  }

  function changed(next) {
    const entry = entryFor(next.id);
    if ((entry.latest && entry.latest.revision > next.revision) || entry.changedRevision >= next.revision) return;
    observe(next);
    entry.changedRevision = next.revision;
    entry.dirty = true;
    // A manual request already in progress follows new saves even with auto OFF.
    if (selection.id === next.id && (entry.request === 'manual' || (settings.autoUpdate && canAnalyze(settings)))) {
      entry.request = entry.request === 'manual' ? 'manual' : 'automatic';
      arm(entry);
    }
    emit();
  }

  function setSettings(next) {
    const nextKey = analysisSettingsKey(next, true) + '/' + (next.settingsVersion ?? '');
    const beforeKey = analysisSettingsKey(settings);
    settings = next;
    if (nextKey === settingsKey) return;
    settingsKey = nextKey;
    for (const entry of entries.values()) {
      if (entry.latest?.analysis && beforeKey !== analysisSettingsKey(next)) entry.dirty = true;
      if (entry.request && !permitted(entry.request)) entry.request = null;
      stopTimer(entry);
      invalidate(entry);
      if (entry.request) arm(entry, 0);
    }
    emit();
  }

  function cancelEntry(entry) {
    stopTimer(entry);
    entry.request = null;
    invalidate(entry);
  }

  function select(token) {
    const old = selection.id && entries.get(selection.id);
    selection = { ...token };
    if (old) cancelEntry(old);
    emit();
  }

  function request(id) {
    if (selection.id !== id) return;
    const entry = entryFor(id);
    if (!canAnalyze(settings)) {
      onResult({ status: 'unconfigured', message: 'AI未接続です。資料は保存済みです。' }, selection);
      emit();
      return;
    }
    entry.request = 'manual';
    arm(entry, 0);
    emit();
  }

  async function pump(entry) {
    if (entry.running || !entry.request || !permitted(entry.request) || selection.id !== entry.id) return;
    const run = { id: entry.id, runId: newRunId(), mode: entry.request, selection: { ...selection }, generation: entry.generation,
      expectedRevision: entry.latest?.revision || 0, settingsKey, invalidated: false, sent: false };
    entry.running = run;
    emit();
    try {
      const fresh = await readScenario(entry.id);
      if (!current(run)) return;
      observe(fresh);
      onScenario(entry.latest, run.selection);
      run.expectedRevision = entry.latest.revision;
      run.settingsKey = settingsKey;
      run.sent = true;
      const result = await analyze({ id: run.id, runId: run.runId, expectedRevision: run.expectedRevision,
        automatic: run.mode === 'automatic', settingsVersion: settings.settingsVersion });
      if (!current(run)) return;

      if (result.status === 'ok' && result.scenario?.id === run.id) {
        if (entry.latest.revision <= result.scenario.revision) {
          observe(result.scenario);
          entry.dirty = false;
          entry.request = null;
          onScenario(result.scenario, run.selection);
          onResult(result, run.selection);
        }
        // A later input may have been saved after the backend committed the result.
        // Its higher revision stays displayed and its single intent stays pending.
      } else {
        if (result.status === 'stale' || result.status === 'busy') {
          const [latest, preferences] = await Promise.all([readScenario(run.id), readSettings ? readSettings() : settings]);
          if (!current(run)) return;
          observe(latest);
          onScenario(entry.latest, run.selection);
          setSettings(preferences);
          if (!current(run)) return;
        }
        const newerInput = entry.latest.revision > run.expectedRevision;
        if (result.status !== 'busy' && !newerInput) {
          entry.request = null;
          entry.dirty = true;
          onResult(result, run.selection);
        }
        if (result.status === 'cancelled' || result.status === 'unconfigured') entry.request = null;
      }
    } catch (error) {
      if (current(run) && (entry.latest?.revision || 0) <= run.expectedRevision) {
        entry.request = null;
        entry.dirty = true;
        onResult({ status: 'error', message: String(error?.message || error) }, run.selection);
      }
    } finally {
      if (entry.running === run) entry.running = null;
      if (entries.get(entry.id) === entry && entry.request) arm(entry);
      emit();
    }
  }

  function remove(id) {
    const entry = entries.get(id);
    if (entry) cancelEntry(entry);
    entries.delete(id);
    emit();
  }
  function dispose() {
    selection = { id: null, generation: selection.generation + 1 };
    for (const entry of entries.values()) cancelEntry(entry);
  }
  return { observe, changed, setSettings, select, request, cancel: (id) => { const entry = entries.get(id); if (entry) cancelEntry(entry); emit(); },
    remove, dispose, view };
}
