const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getCaseDir } = require('../shared/storage.cjs');

test('each scenario has its own data directory beneath the cases root', () => {
  const root = path.resolve('temporary-user-data', 'cases');
  const first = getCaseDir(root, '11111111-1111-4111-8111-111111111111');
  const second = getCaseDir(root, '22222222-2222-4222-8222-222222222222');
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), root);
});

test('scenario IDs cannot escape the cases root', () => {
  assert.throws(() => getCaseDir('C:/cases', '..\\other'), /不正なシナリオID/);
});
