const test = require('node:test');
const assert = require('node:assert/strict');
const { createSerialLock } = require('../shared/serialLock.cjs');

test('scenario deletion waits for an in-flight attachment import and wins last', async () => {
  const withLock = createSerialLock();
  const data = { exists: true, attachments: [] };
  let enteredImport;
  let finishImport;
  const importEntered = new Promise((resolve) => { enteredImport = resolve; });
  const importGate = new Promise((resolve) => { finishImport = resolve; });
  const importing = withLock('case-id', async () => {
    assert.equal(data.exists, true);
    enteredImport();
    await importGate;
    assert.equal(data.exists, true);
    data.attachments.push('pdf-and-case-json-written');
  });
  await importEntered;
  let deletionFinished = false;
  const deleting = withLock('case-id', async () => { data.exists = false; data.attachments = []; deletionFinished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletionFinished, false);
  finishImport();
  await Promise.all([importing, deleting]);
  assert.equal(data.exists, false);
  assert.deepEqual(data.attachments, []);
  assert.equal(deletionFinished, true);
});

test('an import queued after deletion cannot recreate a deleted scenario', async () => {
  const withLock = createSerialLock();
  const data = { exists: true };
  await withLock('case-id', async () => { data.exists = false; });
  await assert.rejects(withLock('case-id', async () => {
    if (!data.exists) throw new Error('case missing');
    data.exists = true;
  }), /case missing/);
  assert.equal(data.exists, false);
});
