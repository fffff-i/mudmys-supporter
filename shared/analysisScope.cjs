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

function getAnalysisContext(caseRecord, includeRoleProfile) {
  const allowed = (grounding) => includeRoleProfile === true || !mayIncludeRoleProfile(grounding);
  const previous = caseRecord.analysis;
  const active = (previous?.actions || []).filter((action) => action.status === 'active');
  const actions = active.filter((action) => allowed(action.grounding));
  const actionHistory = (caseRecord.actionHistory || []).filter((action) => allowed(action.grounding));
  const analysisAllowed = allowed(previous?.grounding);
  const hypotheses = analysisAllowed ? previous?.hypotheses || [] : [];
  // Only discarded titles currently enter currentActionsText. Keep all history
  // filtered so additional history context cannot reopen this sending route.
  const sentHistory = actionHistory.filter((action) => action.status === 'discarded');
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
      [...actions, ...sentHistory].some((action) => mayIncludeRoleProfile(action.grounding))
    )
  };
}

module.exports = { INPUT_PROVENANCE_VERSION, mayIncludeRoleProfile, getAnalysisContext };
