import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionGuard } from '../shared/selectionGuard.mjs';

test('a response for a prior scenario cannot replace the newly selected scenario', () => {
  const guard = createSelectionGuard();
  const requestForA = guard.select('scenario-a');
  guard.select('scenario-b');

  assert.equal(guard.canApply(requestForA, { id: 'scenario-a', revision: 4 }, { id: 'scenario-b', revision: 1 }), false);
});

test('a delayed IPC result cannot replace scenario B after a rapid A to B switch', async () => {
  const guard = createSelectionGuard();
  const requestForA = guard.select('scenario-a');
  let displayed = { id: 'scenario-a', revision: 1 };
  let resolveA;
  const delayedA = new Promise((resolve) => { resolveA = resolve; }).then((result) => {
    if (guard.canApply(requestForA, result, displayed)) displayed = result;
  });

  const requestForB = guard.select('scenario-b');
  const loadedB = { id: 'scenario-b', revision: 2 };
  if (guard.canApply(requestForB, loadedB, displayed)) displayed = loadedB;
  resolveA({ id: 'scenario-a', revision: 3 });
  await delayedA;

  assert.deepEqual(displayed, loadedB);
});

test('an old response stays stale after switching away and back to the same scenario', () => {
  const guard = createSelectionGuard();
  const oldARequest = guard.select('scenario-a');
  guard.select('scenario-b');
  guard.select('scenario-a');

  assert.equal(guard.canApply(oldARequest, { id: 'scenario-a', revision: 5 }, { id: 'scenario-a', revision: 4 }), false);
});

test('a lower revision cannot replace a newer display in the selected scenario', () => {
  const guard = createSelectionGuard();
  const token = guard.select('scenario-a');

  assert.equal(guard.canApply(token, { id: 'scenario-a', revision: 3 }, { id: 'scenario-a', revision: 4 }), false);
  assert.equal(guard.canApply(token, { id: 'scenario-a', revision: 4 }, { id: 'scenario-a', revision: 3 }), true);
});
