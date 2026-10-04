function profileFrom(scenario) {
  return {
    title: scenario.title,
    synopsis: scenario.synopsis,
    role: scenario.roleProfile?.role || '',
    goal: scenario.roleProfile?.goal || '',
    secret: scenario.roleProfile?.secret || ''
  };
}

export function createScenarioDrafts() {
  const entries = new Map();
  let version = 0;

  function entryFor(scenario) {
    let entry = entries.get(scenario.id);
    if (!entry) {
      entry = {
        text: { title: '', text: '', visibility: 'unknown' },
        candidates: [],
        evidenceEdits: new Map(),
        profile: profileFrom(scenario),
        textVersion: ++version,
        profileVersion: ++version,
        profileRevision: scenario.revision,
        profileDirty: false,
        textSave: null,
        profileSave: null
      };
      entries.set(scenario.id, entry);
    } else if (!entry.profileDirty && scenario.revision > entry.profileRevision) {
      entry.profile = profileFrom(scenario);
      entry.profileRevision = scenario.revision;
      entry.profileVersion = ++version;
    }
    return entry;
  }

  function read(scenario) {
    const entry = entryFor(scenario);
    return {
      text: { ...entry.text },
      candidates: entry.candidates.map((item) => ({ ...item })),
      profile: { ...entry.profile },
      textSaving: Boolean(entry.textSave),
      profileSaving: Boolean(entry.profileSave)
    };
  }

  function editText(scenario, patch) {
    const entry = entryFor(scenario);
    entry.text = { ...entry.text, ...patch };
    entry.textVersion = ++version;
  }

  function editProfile(scenario, profile) {
    const entry = entryFor(scenario);
    entry.profile = { ...profile };
    entry.profileDirty = true;
    entry.profileVersion = ++version;
  }

  function beginTextSave(scenario) {
    const entry = entryFor(scenario);
    if (entry.textSave || (!entry.text.text.trim() && !entry.candidates.length) || entry.candidates.some((item) => item.loading || item.error)) return null;
    entry.textSave = { id: scenario.id, version: entry.textVersion, value: { ...entry.text }, candidates: entry.candidates.map((item) => ({ ...item })) };
    return entry.textSave;
  }

  function finishTextSave(request, saved) {
    const entry = entries.get(request.id);
    if (!entry || entry.textSave !== request) return;
    entry.textSave = null;
    if (saved?.id === request.id) entry.candidates = entry.candidates.filter((item) => !request.candidates.some((sent) => sent.id === item.id));
    // A successful save consumes only the input that was sent, even after a switch.
    if (saved?.id === request.id && entry.textVersion === request.version) {
      entry.text = { title: '', text: '', visibility: entry.text.visibility };
      entry.textVersion = ++version;
    }
  }

  function appendCandidates(scenario, candidates) {
    const entry = entryFor(scenario);
    entry.candidates.push(...candidates.map((item) => ({ ...item })));
  }

  function updateCandidate(scenario, id, patch) {
    const entry = entryFor(scenario);
    entry.candidates = entry.candidates.map((item) => item.id === id ? { ...item, ...patch } : item);
  }

  function removeCandidate(scenario, id) {
    const entry = entryFor(scenario);
    if (entry.textSave?.candidates.some((item) => item.id === id)) return false;
    entry.candidates = entry.candidates.filter((item) => item.id !== id);
    return true;
  }

  function evidenceEntry(scenario, item) {
    const entry = entryFor(scenario);
    let edit = entry.evidenceEdits.get(item.id);
    if (!edit) {
      edit = { value: { title: item.title, text: item.editedText ?? item.extractedText ?? '', expectedUpdatedAt: item.updatedAt || item.createdAt }, version: ++version, pending: null };
      entry.evidenceEdits.set(item.id, edit);
    }
    return edit;
  }

  function readEvidence(scenario, item) {
    const edit = evidenceEntry(scenario, item);
    return { ...edit.value, saving: Boolean(edit.pending) };
  }

  function editEvidence(scenario, item, patch) {
    const edit = evidenceEntry(scenario, item);
    edit.value = { ...edit.value, ...patch };
    edit.version = ++version;
  }

  function beginEvidenceSave(scenario, item) {
    const edit = evidenceEntry(scenario, item);
    if (edit.pending) return null;
    edit.pending = { id: scenario.id, evidenceId: item.id, version: edit.version, value: { ...edit.value } };
    return edit.pending;
  }

  function finishEvidenceSave(request, saved) {
    const entry = entries.get(request.id);
    const edit = entry?.evidenceEdits.get(request.evidenceId);
    if (!edit || edit.pending !== request) return;
    edit.pending = null;
    const item = saved?.evidence?.find((value) => value.id === request.evidenceId);
    if (!item || saved.id !== request.id) return;
    if (edit.version === request.version) entry.evidenceEdits.delete(request.evidenceId);
    else edit.value = { ...edit.value, expectedUpdatedAt: item.updatedAt || item.createdAt };
  }

  function beginProfileSave(scenario) {
    const entry = entryFor(scenario);
    if (entry.profileSave) return null;
    entry.profileSave = { id: scenario.id, version: entry.profileVersion, value: { ...entry.profile } };
    return entry.profileSave;
  }

  function finishProfileSave(request, saved) {
    const entry = entries.get(request.id);
    if (!entry || entry.profileSave !== request) return;
    entry.profileSave = null;
    if (saved?.id !== request.id || saved.revision < entry.profileRevision) return;
    entry.profileRevision = saved.revision;
    if (entry.profileVersion === request.version) {
      entry.profile = profileFrom(saved);
      entry.profileDirty = false;
      entry.profileVersion = ++version;
    }
  }

  return { read, editText, editProfile, appendCandidates, updateCandidate, removeCandidate, readEvidence, editEvidence, beginEvidenceSave, finishEvidenceSave,
    beginTextSave, finishTextSave, beginProfileSave, finishProfileSave, delete: (id) => entries.delete(id) };
}
