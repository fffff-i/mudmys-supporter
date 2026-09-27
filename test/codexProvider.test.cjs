const test = require('node:test');
const assert = require('node:assert/strict');
const {
  accountEligibility,
  sanitizeCodexModels,
  chooseCodexModel,
  chooseCodexEffort,
  codexModelSupportsImages,
  summarizeRateLimits
} = require('../shared/codexProvider.cjs');

test('only Codex-managed ChatGPT auth is eligible and account email is not included in the public summary', () => {
  const account = accountEligibility({ account: { type: 'chatgpt', planType: 'plus', email: 'private@example.test', accessToken: 'secret' } });
  assert.deepEqual(account, { authenticated: true, authType: 'chatgpt', planType: 'plus', reason: null });
  assert.deepEqual(accountEligibility({ account: { type: 'apiKey', email: 'private@example.test' } }), {
    authenticated: false, authType: 'apiKey', planType: null, reason: 'api-key-not-supported'
  });
  assert.equal(accountEligibility({ account: null }).reason, 'not-signed-in');
  assert.equal(accountEligibility({ account: { type: 'chatgptAuthTokens' } }).authenticated, false);
});

test('model selection uses only the returned Codex catalog and does not fall back from a missing choice', () => {
  const models = sanitizeCodexModels({ data: [
    { id: 'gpt-6-sol', displayName: 'Sol', hidden: false, inputModalities: ['text', 'image'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], isDefault: true },
    { id: 'text-only', displayName: 'Text only', hidden: false, inputModalities: ['text'], supportedReasoningEfforts: [] },
    { id: 'hidden', hidden: true, inputModalities: ['text', 'image'] }
  ] });
  assert.deepEqual(models.map((model) => model.id), ['gpt-6-sol', 'text-only']);
  assert.equal(chooseCodexModel(models, '').id, 'gpt-6-sol');
  assert.equal(chooseCodexModel(models, 'text-only').id, 'text-only');
  assert.throws(() => chooseCodexModel(models, 'gpt-6-luna'), /現在利用できません/);
  assert.equal(chooseCodexEffort(models[0], 'low'), 'low');
  assert.throws(() => chooseCodexEffort(models[0], 'max'), /対応していません/);
  assert.equal(codexModelSupportsImages(models[0]), true);
  assert.equal(codexModelSupportsImages(models[1]), false);
});

test('model catalogs without image modality metadata are treated as text-only', () => {
  const models = sanitizeCodexModels({ data: [{ id: 'legacy-model', isDefault: true }] });
  assert.deepEqual(models[0].inputModalities, ['text']);
  assert.equal(codexModelSupportsImages(models[0]), false);
});

test('rate-limit display contains only the Codex bucket and normalized safe fields', () => {
  assert.deepEqual(summarizeRateLimits({
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 35.4, windowDurationMins: 300, resetsAt: 123456 } },
      unrelated: { limitId: 'unrelated', primary: { usedPercent: 99 } }
    },
    rateLimitResetCredits: { availableCount: 8, credits: [{ id: 'private-credit-id' }] }
  }), { usedPercent: 35, windowDurationMins: 300, resetsAt: 123456 });
  assert.equal(summarizeRateLimits({ rateLimits: { limitId: 'other', primary: { usedPercent: 10 } } }), null);
});
