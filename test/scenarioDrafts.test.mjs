import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioDrafts } from '../shared/scenarioDrafts.mjs';
import { createSelectionGuard } from '../shared/selectionGuard.mjs';

function scenario(id, revision = 1) {
  return { id, revision, title: `Scenario ${id}`, synopsis: '', roleProfile: { role: `${id} role`, goal: '', secret: '' } };
}

const a = scenario('a');
const b = scenario('b');
const privateNote = { title: 'A handout', text: 'A private clue', visibility: 'private' };
const aProfile = { title: 'A draft title', synopsis: 'A draft synopsis', role: 'A draft role', goal: 'A draft goal', secret: 'A draft secret' };

test('each scenario restores its own heading, text, visibility and entire profile draft', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  drafts.editProfile(a, aProfile);

  assert.deepEqual(drafts.read(b).text, { title: '', text: '', visibility: 'unknown' });
  assert.deepEqual(drafts.read(b).profile, { title: b.title, synopsis: '', role: 'b role', goal: '', secret: '' });
  drafts.editText(b, { title: 'B note', text: 'B shared clue', visibility: 'shared' });
  drafts.editProfile(b, { ...drafts.read(b).profile, secret: 'B secret' });

  assert.deepEqual(drafts.read(a).text, privateNote);
  assert.deepEqual(drafts.read(a).profile, aProfile);
  assert.equal(drafts.read(b).profile.secret, 'B secret');
  assert.equal(drafts.read(b).text.visibility, 'shared');
});

test('a newer scenario record preserves unsaved profile edits and text', () => {
  const drafts = createScenarioDrafts();
  drafts.editProfile(a, aProfile);
  drafts.editText(a, privateNote);

  assert.deepEqual(drafts.read({ ...a, revision: 4, roleProfile: { role: 'saved role', goal: 'saved goal', secret: 'saved secret' } }).profile, aProfile);
  assert.deepEqual(drafts.read(a).text, privateNote);
});

test('a clean profile follows saved records, while an older load cannot roll it back', () => {
  const drafts = createScenarioDrafts();
  drafts.read(a);
  const updated = { ...a, revision: 2, title: 'Saved title', roleProfile: { role: 'Saved role', goal: 'Saved goal', secret: 'Saved secret' } };
  const profile = drafts.read(updated).profile;

  assert.equal(profile.title, 'Saved title');
  assert.equal(profile.secret, 'Saved secret');
  assert.deepEqual(drafts.read(a).profile, profile);
});

test('reads and save requests cannot mutate the stored draft through shared form values', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  const visible = drafts.read(a);
  visible.text.text = 'changed outside the store';
  visible.profile.secret = 'changed outside the store';
  const request = drafts.beginTextSave(a);
  request.value.text = 'changed by a consumer';

  assert.deepEqual(drafts.read(a).text, privateNote);
  assert.equal(drafts.read(a).profile.secret, '');
});

test('blank text cannot be submitted and duplicate text/profile submissions are blocked per scenario', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, { text: '  \n ' });
  assert.equal(drafts.beginTextSave(a), null);
  drafts.editText(a, privateNote);
  const textRequest = drafts.beginTextSave(a);
  const profileRequest = drafts.beginProfileSave(a);

  assert.equal(drafts.beginTextSave(a), null);
  assert.equal(drafts.beginProfileSave(a), null);
  assert.equal(drafts.read(a).textSaving, true);
  assert.equal(drafts.read(a).profileSaving, true);
  assert.equal(drafts.read(b).textSaving, false);
  assert.ok(drafts.beginProfileSave(b));
  drafts.finishTextSave(textRequest, null);
  drafts.finishProfileSave(profileRequest, null);
  assert.ok(drafts.beginTextSave(a));
  assert.ok(drafts.beginProfileSave(a));
});

test('a delayed successful text save consumes only the original scenario draft after switching away', async () => {
  const drafts = createScenarioDrafts();
  const guard = createSelectionGuard();
  const token = guard.select(a.id);
  drafts.editText(a, privateNote);
  const request = drafts.beginTextSave(a);
  let resolve;
  const pending = new Promise((done) => { resolve = done; }).then((saved) => {
    drafts.finishTextSave(request, saved);
    return guard.canApply(token, saved, b);
  });

  guard.select(b.id);
  drafts.editText(b, { title: 'B note', text: 'B clue', visibility: 'shared' });
  resolve({ ...a, revision: 2 });
  assert.equal(await pending, false);
  assert.deepEqual(drafts.read(a).text, { title: '', text: '', visibility: 'private' });
  assert.deepEqual(drafts.read(b).text, { title: 'B note', text: 'B clue', visibility: 'shared' });
  assert.equal(request.id, a.id);
  assert.deepEqual(request.value, privateNote);
});

test('an A to B to A switch keeps the old selection response stale but clears the saved A draft', () => {
  const drafts = createScenarioDrafts();
  const guard = createSelectionGuard();
  const token = guard.select(a.id);
  drafts.editText(a, privateNote);
  const request = drafts.beginTextSave(a);
  guard.select(b.id);
  guard.select(a.id);

  assert.equal(drafts.read(a).textSaving, true);
  const saved = { ...a, revision: 2 };
  drafts.finishTextSave(request, saved);
  assert.equal(guard.canApply(token, saved, a), false);
  assert.equal(drafts.read(a).text.text, '');
  assert.equal(drafts.read(a).textSaving, false);
});

test('typing after a text submission survives completion, including an away-and-back switch', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  const request = drafts.beginTextSave(a);
  drafts.read(b);
  const newNote = { title: 'Next note', text: 'More clues entered while saving', visibility: 'unknown' };
  drafts.editText(a, newNote);
  drafts.finishTextSave(request, { ...a, revision: 2 });

  assert.deepEqual(request.value, privateNote);
  assert.deepEqual(drafts.read(a).text, newNote);
  assert.equal(drafts.read(a).textSaving, false);
});

test('editing a heading or visibility after submission also preserves the newer draft', () => {
  for (const patch of [{ title: 'New heading' }, { visibility: 'unknown' }]) {
    const drafts = createScenarioDrafts();
    drafts.editText(a, privateNote);
    const request = drafts.beginTextSave(a);
    drafts.editText(a, patch);
    drafts.finishTextSave(request, { ...a, revision: 2 });
    assert.deepEqual(drafts.read(a).text, { ...privateNote, ...patch });
  }
});

test('failed text and profile saves retain their original drafts even while another scenario is selected', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  drafts.editProfile(a, aProfile);
  const textRequest = drafts.beginTextSave(a);
  const profileRequest = drafts.beginProfileSave(a);
  drafts.read(b);
  drafts.finishTextSave(textRequest, null);
  drafts.finishProfileSave(profileRequest, null);

  assert.deepEqual(drafts.read(a).text, privateNote);
  assert.deepEqual(drafts.read(a).profile, aProfile);
  assert.equal(drafts.read(a).textSaving, false);
  assert.equal(drafts.read(a).profileSaving, false);
});

test('profile save completion restores the normalized saved profile of its own scenario', () => {
  const drafts = createScenarioDrafts();
  drafts.editProfile(a, { ...aProfile, title: '  A draft title  ' });
  const request = drafts.beginProfileSave(a);
  drafts.editProfile(b, { ...drafts.read(b).profile, secret: 'B secret' });
  const saved = { ...a, revision: 2, title: aProfile.title, synopsis: aProfile.synopsis, roleProfile: { role: aProfile.role, goal: aProfile.goal, secret: aProfile.secret } };
  drafts.finishProfileSave(request, saved);

  assert.deepEqual(drafts.read(saved).profile, aProfile);
  assert.deepEqual(drafts.read(a).profile, aProfile);
  assert.equal(drafts.read(b).profile.secret, 'B secret');
});

test('profile changes typed while saving are restored without replacing them with the submitted profile', () => {
  const drafts = createScenarioDrafts();
  drafts.editProfile(a, aProfile);
  const request = drafts.beginProfileSave(a);
  drafts.read(b);
  const laterProfile = { ...aProfile, secret: 'A newly edited secret' };
  drafts.editProfile(a, laterProfile);
  const saved = { ...a, revision: 2, title: aProfile.title, roleProfile: { role: aProfile.role, goal: aProfile.goal, secret: aProfile.secret } };
  drafts.finishProfileSave(request, saved);

  assert.deepEqual(request.value, aProfile);
  assert.deepEqual(drafts.read(saved).profile, laterProfile);
  assert.equal(drafts.read(saved).profileSaving, false);
});

test('text and profile saves are independent and a repeated completion cannot clear new input', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  drafts.editProfile(a, aProfile);
  const textRequest = drafts.beginTextSave(a);
  const profileRequest = drafts.beginProfileSave(a);
  drafts.finishTextSave(textRequest, { ...a, revision: 2 });
  assert.equal(drafts.read(a).profileSaving, true);
  assert.deepEqual(drafts.read(a).profile, aProfile);
  drafts.editText(a, { text: 'Next unsaved clue' });
  drafts.finishTextSave(textRequest, { ...a, revision: 2 });
  drafts.finishProfileSave(profileRequest, null);

  assert.equal(drafts.read(a).text.text, 'Next unsaved clue');
  assert.deepEqual(drafts.read(a).profile, aProfile);
});

test('responses for a different scenario are never allowed to consume a draft', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  drafts.editProfile(a, aProfile);
  drafts.finishTextSave(drafts.beginTextSave(a), { ...b, revision: 2 });
  drafts.finishProfileSave(drafts.beginProfileSave(a), { ...b, revision: 2 });

  assert.deepEqual(drafts.read(a).text, privateNote);
  assert.deepEqual(drafts.read(a).profile, aProfile);
});

test('deleting a scenario removes its drafts and invalidates pending saves without affecting other scenarios', () => {
  const drafts = createScenarioDrafts();
  drafts.editText(a, privateNote);
  drafts.editProfile(a, aProfile);
  drafts.editText(b, { text: 'B clue' });
  const textRequest = drafts.beginTextSave(a);
  const profileRequest = drafts.beginProfileSave(a);
  assert.equal(drafts.delete(a.id), true);
  drafts.editText(a, { text: 'Fresh draft after deletion' });
  drafts.finishTextSave(textRequest, { ...a, revision: 2 });
  drafts.finishProfileSave(profileRequest, { ...a, revision: 2 });

  assert.equal(drafts.read(a).text.text, 'Fresh draft after deletion');
  assert.equal(drafts.read(a).profile.secret, '');
  assert.equal(drafts.read(b).text.text, 'B clue');
});
