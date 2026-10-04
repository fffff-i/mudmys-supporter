const INPUT_PROVENANCE_VERSION = 1;

function mayIncludeRoleProfile(grounding) {
  // Older records did not track every prior-context input. Missing or partial
  // provenance is therefore protected, even if an old result says profile OFF.
  return !grounding || grounding.version !== INPUT_PROVENANCE_VERSION ||
    grounding.includeRoleProfile !== false ||
    grounding.previousContextMayIncludeRoleProfile !== false ||
    !Array.isArray(grounding.evidenceIds) ||
    !grounding.evidenceIds.every((id) => typeof id === 'string');
}

function mayIncludeActionText(action) {
  return mayIncludeRoleProfile(action.grounding) ||
    Boolean(action.retirementReason && mayIncludeRoleProfile(action.retirementGrounding)) ||
    Boolean(action.resultNote && mayIncludeRoleProfile(action.resultGrounding));
}

function getAnalysisContext(caseRecord, includeRoleProfile) {
  const excludedEvidenceIds = new Set((caseRecord.evidence || []).filter((item) => item.analysisEnabled === false).map((item) => item.id));
  const knownEvidenceOrigin = (grounding) => grounding?.version === INPUT_PROVENANCE_VERSION &&
    Array.isArray(grounding.evidenceIds) && grounding.evidenceIds.every((id) => typeof id === 'string') && grounding.evidenceOriginUnknown !== true;
  const allowed = (grounding) => (includeRoleProfile === true || !mayIncludeRoleProfile(grounding)) &&
    (!excludedEvidenceIds.size || (knownEvidenceOrigin(grounding) && !grounding.evidenceIds.some((id) => excludedEvidenceIds.has(id))));
  const allowedAction = (action) => allowed(action.grounding) &&
    (!action.retirementReason || allowed(action.retirementGrounding)) && (!action.resultNote || allowed(action.resultGrounding));
  const previous = caseRecord.analysis;
  const active = (previous?.actions || []).filter((action) => action.status === 'active');
  const actions = active.filter((action) => allowed(action.grounding));
  const actionHistory = (caseRecord.actionHistory || []).filter(allowedAction);
  const analysisAllowed = allowed(previous?.grounding);
  const hypotheses = analysisAllowed ? previous?.hypotheses || [] : [];
  const sentHistory = actionHistory;
  return {
    caseRecord: {
      analysis: analysisAllowed ? { ...previous, actions } : { actions },
      actionHistory
    },
    activeActionIds: actions.map((action) => action.id),
    historyActionIds: sentHistory.map((action) => action.id),
    excludedActionIds: active.filter((action) => !allowed(action.grounding)).map((action) => action.id),
    excludedPreviousAnalysis: Boolean(previous && !analysisAllowed),
    // Carry every input origin forward, even when the displayed reference list is empty.
    contextEvidenceIds: [...new Set([
      ...(analysisAllowed ? previous?.grounding?.evidenceIds || [] : []),
      ...actions.flatMap((action) => action.grounding?.evidenceIds || []),
      ...sentHistory.flatMap((action) => [action.grounding, action.retirementGrounding, action.resultGrounding].flatMap((origin) => origin?.evidenceIds || []))
    ])],
    evidenceOriginUnknown: Boolean((hypotheses.length && !knownEvidenceOrigin(previous?.grounding)) ||
      actions.some((action) => !knownEvidenceOrigin(action.grounding)) || sentHistory.some((action) =>
        !knownEvidenceOrigin(action.grounding) || (action.retirementReason && !knownEvidenceOrigin(action.retirementGrounding)) ||
        (action.resultNote && !knownEvidenceOrigin(action.resultGrounding)))),
    previousContextMayIncludeRoleProfile: Boolean(
      (hypotheses.length && mayIncludeRoleProfile(previous?.grounding)) ||
      actions.some((action) => mayIncludeRoleProfile(action.grounding)) ||
      sentHistory.some(mayIncludeActionText)
    )
  };
}

module.exports = { INPUT_PROVENANCE_VERSION, mayIncludeRoleProfile, mayIncludeActionText, getAnalysisContext };
