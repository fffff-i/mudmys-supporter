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
    if (entry.textSave || !entry.text.text.trim()) return null;
    entry.textSave = { id: scenario.id, version: entry.textVersion, value: { ...entry.text } };
    return entry.textSave;
  }

  function finishTextSave(request, saved) {
    const entry = entries.get(request.id);
    if (!entry || entry.textSave !== request) return;
    entry.textSave = null;
    // A successful save consumes only the input that was sent, even after a switch.
    if (saved?.id === request.id && entry.textVersion === request.version) {
      entry.text = { title: '', text: '', visibility: entry.text.visibility };
      entry.textVersion = ++version;
    }
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

  return { read, editText, editProfile, beginTextSave, finishTextSave, beginProfileSave, finishProfileSave, delete: (id) => entries.delete(id) };
}
