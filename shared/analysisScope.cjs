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
  const allowed = (grounding) => includeRoleProfile === true || !mayIncludeRoleProfile(grounding);
  const previous = caseRecord.analysis;
  const active = (previous?.actions || []).filter((action) => action.status === 'active');
  const actions = active.filter((action) => allowed(action.grounding));
  const actionHistory = (caseRecord.actionHistory || []).filter((action) => includeRoleProfile === true || !mayIncludeActionText(action));
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
    previousContextMayIncludeRoleProfile: Boolean(
      (hypotheses.length && mayIncludeRoleProfile(previous?.grounding)) ||
      actions.some((action) => mayIncludeRoleProfile(action.grounding)) ||
      sentHistory.some(mayIncludeActionText)
    )
  };
}

module.exports = { INPUT_PROVENANCE_VERSION, mayIncludeRoleProfile, mayIncludeActionText, getAnalysisContext };
