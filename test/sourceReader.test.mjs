import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceReader } from '../shared/sourceReader.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('slow previous pages and scenarios cannot replace the current original', async () => {
  const requests = [];
  const states = [];
  const reader = createSourceReader((request) => { const pending = deferred(); requests.push({ request, ...pending }); return pending.promise; }, (value) => states.push(value));
  const first = reader.open({ id: 'A', evidenceId: 'pdf', page: '1' }, 'text_matched');
  const second = reader.open({ id: 'A', evidenceId: 'pdf', page: '2' }, 'image_unverified');
  requests[1].resolve({ pageNumber: 2 });
  await second;
  requests[0].resolve({ pageNumber: 1 });
  await first;
  assert.equal(states.at(-1).preview.pageNumber, 2);
  assert.equal(states.at(-1).verification, 'image_unverified');
  const oldScenario = reader.open({ id: 'A', evidenceId: 'pdf', page: '3' });
  reader.close();
  const newScenario = reader.open({ id: 'B', evidenceId: 'image' });
  requests[3].resolve({ title: 'B image' });
  await newScenario;
  requests[2].reject(new Error('old private error'));
  await oldScenario;
  assert.equal(states.at(-1).request.id, 'B');
  assert.equal(states.at(-1).error, '');
});

test('closing the original invalidates pending results; current read errors remain visible', async () => {
  const pending = deferred();
  let state;
  const reader = createSourceReader(() => pending.promise, (next) => { state = next; });
  const opened = reader.open({ id: 'A', evidenceId: 'pdf', page: '2' });
  reader.close();
  pending.resolve({ pageNumber: 2 });
  await opened;
  assert.equal(state, null);
  const failing = createSourceReader(async () => { throw new Error('原本を読み取れません'); }, (next) => { state = next; });
  await failing.open({ id: 'A', evidenceId: 'pdf' });
  assert.equal(state.loading, false);
  assert.equal(state.error, '原本を読み取れません');
});
