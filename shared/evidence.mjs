export function enabledEvidence(scenario) {
  return (scenario.evidence || []).filter((item) => item.analysisEnabled !== false &&
    item.id !== 'scenario:synopsis' && item.id !== 'scenario:role-profile');
}

export function evidenceBody(item) {
  return typeof item.editedText === 'string' ? item.editedText : item.extractedText || '';
}

export function inferEvidenceTitle(title, text = '', originalName = '') {
  const explicit = String(title || '').trim();
  const name = String(originalName || '').split(/[\\/]/).pop().trim();
  const firstLine = String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  return (explicit || name || firstLine.replace(/^#{1,6}\s+/, '') || 'メモ').slice(0, 120);
}

export function evidenceUsage(scenario, includeRoleProfile = false) {
  const selected = enabledEvidence(scenario);
  return {
    count: selected.length,
    textCharacters: String(scenario.synopsis || '').length + selected.reduce((sum, item) => sum + evidenceBody(item).length, 0) +
      (includeRoleProfile === true ? JSON.stringify(scenario.roleProfile || {}).length : 0),
    attachmentBytes: selected.reduce((sum, item) => sum + (item.attachmentPath && item.kind !== 'text' ? item.byteSize || 0 : 0), 0),
    retainedBytes: (scenario.evidence || []).reduce((sum, item) => sum + (item.attachmentPath ? item.byteSize || 0 : 0), 0)
  };
}
