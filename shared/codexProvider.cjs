function accountEligibility(response) {
  const account = response && response.account;
  if (!account) return { authenticated: false, authType: null, planType: null, reason: 'not-signed-in' };
  if (account.type !== 'chatgpt') {
    return {
      authenticated: false,
      authType: String(account.type || 'unknown').slice(0, 32),
      planType: null,
      reason: account.type === 'apiKey' || account.type === 'apikey' ? 'api-key-not-supported' : 'auth-mode-not-supported'
    };
  }
  const planType = typeof account.planType === 'string' ? account.planType.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) : null;
  return { authenticated: true, authType: 'chatgpt', planType, reason: null };
}

function sanitizeCodexModels(response) {
  const entries = Array.isArray(response && response.data) ? response.data : [];
  return entries.filter((entry) => entry && !entry.hidden && typeof (entry.id || entry.model) === 'string')
    .map((entry) => {
      const id = String(entry.id || entry.model).trim();
      const modalities = Array.isArray(entry.inputModalities)
        ? entry.inputModalities.filter((value) => value === 'text' || value === 'image')
        : ['text'];
      const efforts = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts.map((value) => typeof value === 'string' ? value : value && value.reasoningEffort).filter((value) => typeof value === 'string' && /^[a-z-]{1,24}$/.test(value))
        : [];
      return {
        id: id.slice(0, 120),
        displayName: String(entry.displayName || id).slice(0, 120),
        inputModalities: modalities,
        supportedEfforts: [...new Set(efforts)],
        defaultEffort: typeof entry.defaultReasoningEffort === 'string' && /^[a-z-]{1,24}$/.test(entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : null,
        isDefault: Boolean(entry.isDefault)
      };
    })
    .filter((model) => model.id && model.inputModalities.includes('text'));
}

function chooseCodexModel(models, requestedModel) {
  if (!Array.isArray(models) || !models.length) throw new Error('Codexから利用できるモデル一覧を取得できません。Codex CLIを更新して接続状態を確認してください。');
  if (requestedModel) {
    const selected = models.find((model) => model.id === requestedModel);
    if (!selected) throw new Error('保存されたCodexモデルは現在利用できません。設定で利用可能なモデルを選び直してください。');
    return selected;
  }
  const defaultModel = models.find((model) => model.isDefault);
  if (!defaultModel) throw new Error('Codexが標準モデルを示していません。設定で利用可能なモデルを選んでください。');
  return defaultModel;
}

function chooseCodexEffort(model, requestedEffort) {
  const supported = Array.isArray(model && model.supportedEfforts) ? model.supportedEfforts : [];
  if (requestedEffort) {
    if (!supported.includes(requestedEffort)) {
      throw new Error('選択中のCodexモデルは保存された推論強度に対応していません。設定で選び直してください。');
    }
    return requestedEffort;
  }
  return model && model.defaultEffort && supported.includes(model.defaultEffort)
    ? model.defaultEffort
    : supported[0];
}

function codexModelSupportsImages(model) {
  return Boolean(model && Array.isArray(model.inputModalities) && model.inputModalities.includes('image'));
}

function summarizeRateLimits(response) {
  const byId = response && response.rateLimitsByLimitId;
  const limit = byId && byId.codex ? byId.codex : response && response.rateLimits && response.rateLimits.limitId === 'codex' ? response.rateLimits : null;
  const primary = limit && limit.primary;
  if (!primary || !Number.isFinite(primary.usedPercent)) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, Math.round(primary.usedPercent))),
    windowDurationMins: Number.isFinite(primary.windowDurationMins) ? primary.windowDurationMins : null,
    resetsAt: Number.isFinite(primary.resetsAt) ? primary.resetsAt : null
  };
}

module.exports = { accountEligibility, sanitizeCodexModels, chooseCodexModel, chooseCodexEffort, codexModelSupportsImages, summarizeRateLimits };
