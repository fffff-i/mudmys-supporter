const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { evidenceHarness } = require('./evidenceHarness.cjs');
const { getAnalysisContext } = require('../shared/analysisScope.cjs');

const root = path.resolve(__dirname, '..');
const qaDir = path.join(root, '.local', 'analysis-update-ui');
const runDir = path.join(qaDir, 'run-' + Date.now());
const browserProfile = path.join(runDir, 'headless-profile');
const cleanups = [], gateReleases = [], reports = [], errors = [], calls = [], responseGates = [], saveGates = [];
let h, server, browser, socket, browserLog, evaluate, command, subject, forceStale = false, malformed = false;
const active = new Map(), peak = new Map(), subjects = new Map();
let pendingIpc = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const methods = {
  listScenarios: 'scenario:list', getScenario: 'scenario:get', getSettings: 'settings:get', saveSettings: 'settings:save', testAi: 'settings:test-ai',
  createScenario: 'scenario:create', createDemo: 'scenario:create-demo', saveProfile: 'scenario:save-profile', deleteScenario: 'scenario:delete',
  addEvidence: 'scenario:add-evidence', chooseFiles: 'scenario:choose-files', releaseFiles: 'scenario:release-files', editEvidence: 'scenario:edit-evidence',
  setEvidenceEnabled: 'scenario:set-evidence-enabled', setVisibility: 'scenario:set-visibility', readSource: 'scenario:read-source',
  completeAction: 'scenario:complete-action', discardAction: 'scenario:discard-action', restoreAction: 'scenario:restore-action',
  updateActionNotes: 'scenario:action-notes', analyze: 'scenario:analyze', cancelAnalysis: 'scenario:cancel-analysis'
};
function gate() {
  let release; const result = { entered: false, wait: new Promise((resolve) => { release = resolve; }), release };
  result.release = release; gateReleases.push(release); return result;
}
function holdResponse() { const result = gate(); responseGates.push(result); return result; }
function holdSave(method, phase = 'after') { const result = { ...gate(), method, phase }; saveGates.push(result); return result; }
async function until(check, label) {
  const end = Date.now() + 9000;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  throw new Error('Timed out: ' + label);
}
async function check(name, body) { await body(); reports.push({ name, passed: true }); console.log('PASS ' + name); }
const saved = (id) => h.read(id);
const count = () => h.requests.length;
async function browserPath() {
  const candidates = process.env.MAKUA_HEADLESS_BROWSER ? [process.env.MAKUA_HEADLESS_BROWSER] : [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'
  ];
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw new Error('Set MAKUA_HEADLESS_BROWSER to a Chromium/Edge/Chrome executable.');
}
async function boot() {
  const executable = await browserPath();
  await fs.access(path.join(root, 'dist', 'index.html'));
  h = await evidenceHarness({ after: (fn) => cleanups.push(fn) });
  const b = await h.invoke('scenario:create', 'Synthetic B');
  await h.store({ ...b, updatedAt: '2000-01-01T00:00:00Z' });
  const a = await h.invoke('scenario:create', 'Synthetic A');
  subjects.set('QA_CASE_A', a.id); subjects.set('QA_CASE_B', b.id);
  await h.invoke('settings:save', { provider: 'ollama', ollamaModel: 'mock-model', cloudConsent: true, codexConsent: true, autoUpdate: true, effort: 'low' });
  h.controls.output = async (_provider, request) => {
    const text = JSON.stringify(request);
    const id = [...subjects].find(([marker]) => text.includes(marker))?.[1] || subject;
    const scenario = await saved(id), preferences = await h.invoke('settings:get');
    if (malformed) return { overview: 'malformed', facts: [{ statement: 'No actual source', evidenceIds: [] }], actions: [], retirements: [] };
    const context = getAnalysisContext(scenario, preferences.includeRoleProfile);
    const old = context.caseRecord.analysis.actions || [];
    const base = { overview: '架空の保存情報を反映しました。', flow: [], events: [], facts: [], hypotheses: [], unknowns: [], retirements: [] };
    const prose = preferences.includeRoleProfile ? 'PROFILE_DERIVED_UI' : '保存済みの情報を確認する。';
    const actions = old.length ? old.map((action) => ({ ...action, rationale: prose, continuesActionIds: [action.id], replacesActionIds: [] }))
      : scenario.actionHistory.length ? [] : ['第一の確認', '第二の確認'].map((title, index) => ({
        title, who: '架空の相手' + index, purpose: '架空の確認' + index, step: '記録' + index + 'を確認する。', rationale: prose, priority: index + 1,
        evidenceIds: [], assumptions: [], continuesActionIds: [], replacesActionIds: []
      }));
    return { ...base, actions };
  };
  h.controls.turn = async (_provider, request) => {
    const text = JSON.stringify(request);
    const id = [...subjects].find(([marker]) => text.includes(marker))?.[1] || subject;
    active.set(id, (active.get(id) || 0) + 1); peak.set(id, Math.max(peak.get(id) || 0, active.get(id)));
    const waiting = responseGates.shift();
    try { if (waiting) { waiting.entered = true; await waiting.wait; } }
    finally { active.set(id, active.get(id) - 1); }
  };
  const bridge = 'window.qaErrors=[]; window.addEventListener("error",e=>window.qaErrors.push(e.message)); window.addEventListener("unhandledrejection",e=>window.qaErrors.push(String(e.reason)));' +
    'window.makua=Object.fromEntries(' + JSON.stringify(Object.keys(methods)) + '.map(name=>[name,async(...args)=>{const response=await fetch("/qa-ipc",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,args})}); const result=await response.json(); if(result.error)throw new Error(result.error);return result.value;} ]));';
  server = http.createServer(async (request, response) => {
    pendingIpc++;
    try {
      if (request.url === '/qa-ipc' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        const { name, args } = JSON.parse(body);
        assert.ok(methods[name]); calls.push({ name, args });
        const index = saveGates.findIndex((entry) => entry.method === name);
        const waiting = index < 0 ? null : saveGates.splice(index, 1)[0];
        if (waiting?.phase === 'before') { waiting.entered = true; await waiting.wait; }
        let value;
        if (name === 'analyze' && forceStale) { forceStale = false; value = { status: 'stale' }; }
        else { if (name === 'analyze') subject = args[0].id; value = await h.invoke(methods[name], args[0]); }
        if (waiting?.phase === 'after') { waiting.entered = true; await waiting.wait; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value })); return;
      }
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const relative = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
      const filename = path.resolve(root, 'dist', relative);
      assert.ok(filename.startsWith(path.join(root, 'dist') + path.sep));
      let body = await fs.readFile(filename);
      if (relative === 'index.html') body = Buffer.from(body.toString().replace('<head>', '<head><script>' + bridge + '</script>'));
      response.writeHead(200, { 'Content-Type': relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html' });
      response.end(body);
    } catch (error) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
    finally { pendingIpc--; }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(browserProfile, { recursive: true });
  browserLog = await fs.open(path.join(runDir, 'headless-stderr.txt'), 'w');
  browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + browserProfile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu', '--no-sandbox',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant,msEdgeWallet',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', browserLog.fd] });
  browser.on('error', (error) => errors.push(error.message));
  let port;
  await until(async () => { try { port = Number((await fs.readFile(path.join(browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return Boolean(port); } catch { return false; } }, 'isolated headless browser');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let seq = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const promise = pending.get(message.id); pending.delete(message.id); message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 7000);
    pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  await until(() => evaluate('document.querySelector(".topbar-title")?.textContent==="Synthetic A"'), 'initial scenario');
  return { a, b };
}
async function fill(selector, value) {
  await evaluate('(()=>{const element=document.querySelector(' + JSON.stringify(selector) + ');if(!element)throw new Error("Missing form element");' +
    'const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;' +
    'Object.getOwnPropertyDescriptor(prototype,"value").set.call(element,' + JSON.stringify(value) + ');element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true}));})()');
  await delay(25);
}
async function nav(index) { await evaluate('document.querySelectorAll(".side-nav-item")[' + index + '].click()'); await delay(30); }
async function evidence() { await nav(1); await until(() => evaluate('Boolean(document.querySelector(".add-note-panel"))'), 'intake'); }
async function submit(form = '.add-note-panel') { await evaluate('document.querySelector(' + JSON.stringify(form) + ').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))'); }
async function status() { return evaluate('document.querySelector(".analysis-status")?.textContent||""'); }
async function idle() { await until(async () => !(await status()).includes('更新中') && !(await status()).includes('まとめて') && !(await status()).includes('停止しています'), 'idle status'); }
async function add(text) {
  await evidence(); const before = calls.filter((call) => call.name === 'addEvidence').length;
  await fill('.add-note-panel textarea', text);
  assert.equal(await evaluate('document.querySelector(".add-note-panel button[type=submit]").disabled'), false);
  await submit();
  await until(() => evaluate('!document.querySelector(".add-note-panel button[type=submit]").textContent.includes("保存中")&&document.querySelector(".add-note-panel textarea").value===""'), 'save completes independently');
  const additions = calls.filter((call) => call.name === 'addEvidence');
  assert.equal(additions.length, before + 1);
  assert.ok((await saved(additions.at(-1).args[0].id)).evidence.some((item) => item.extractedText === text));
  assert.equal(await evaluate('document.querySelector(".add-note-panel button[type=submit]").disabled'), true);
}
async function select(name) {
  await evaluate('(()=>{const button=Array.from(document.querySelectorAll(".scenario-switch")).find(e=>e.querySelector(".scenario-title").textContent===' + JSON.stringify(name) + ');if(!button)throw new Error("Missing scenario");button.click();})()');
  await until(() => evaluate('document.querySelector(".topbar-title")?.textContent===' + JSON.stringify(name)), 'selected ' + name); await evidence();
}
async function topButton(text) {
  await evaluate('(()=>{const button=Array.from(document.querySelectorAll(".topbar-actions button")).find(e=>e.textContent.includes(' + JSON.stringify(text) + '));if(!button)throw new Error("Missing top action");button.click();})()');
}
async function settingsPage() { await evaluate('document.querySelector(".settings-link").click()'); await until(() => evaluate('Boolean(document.querySelector(".settings-scroll form"))'), 'settings'); }
async function setting(patches) {
  await settingsPage();
  for (const [selector, checked] of patches) {
    await evaluate('(()=>{const input=document.querySelector(' + JSON.stringify(selector) + ');if(input.checked!==' + checked + ')input.click();})()'); await delay(20);
  }
  const before = calls.filter((call) => call.name === 'saveSettings').length;
  await submit('.settings-scroll form');
  await until(() => calls.filter((call) => call.name === 'saveSettings').length > before, 'settings IPC');
  await until(() => evaluate('document.querySelector(".test-result")?.textContent.includes("設定を保存")'), 'settings saved');
  await evidence();
}
async function sourceDetail(id) {
  await evaluate('(()=>{const card=document.getElementById("evidence-"+' + JSON.stringify(id) + ');if(!card.querySelector(".evidence-detail"))card.querySelector(".evidence-toggle").click();})()'); await delay(30);
}

async function verify() {
  const { a, b } = await boot();
  await evidence();
  await check('typing is a local draft and never starts saving or analysis', async () => {
    await fill('.add-note-panel textarea', 'QA_CASE_A FIRST_BODY'); await delay(500);
    assert.equal(count(), 0); assert.equal((await saved(a.id)).evidence.length, 0);
  });
  const firstGate = holdResponse();
  await check('saving completes and unlocks the intake while the first inference is still waiting', async () => {
    await submit(); await until(() => firstGate.entered, 'first mock inference');
    assert.equal(await evaluate('document.querySelector(".add-note-panel textarea").value'), '');
    assert.equal(await evaluate('document.querySelector(".add-note-panel button[type=submit]").textContent.includes("保存中")'), false);
    assert.ok((await status()).includes('更新中'));
    assert.equal((await saved(a.id)).evidence.length, 1);
  });
  await check('another saved batch is accepted during inference and remains visibly pending', async () => {
    await add('QA_CASE_A SECOND_BODY');
    assert.equal(count(), 1); assert.equal((await saved(a.id)).evidence.length, 2);
    assert.ok((await status()).includes('追加情報は保存済み'));
  });
  await check('profile edits save during inference without a revision recovery dialog', async () => {
    await fill('.profile-panel > label textarea', 'QA_CASE_A CURRENT_SYNOPSIS');
    await fill('.role-details input', 'PROFILE_ROLE_UI');
    await fill('.role-details label:last-of-type textarea', 'PROFILE_SECRET_UI');
    await submit('.profile-panel');
    await until(async () => (await saved(a.id)).synopsis.includes('CURRENT_SYNOPSIS'), 'profile save');
    assert.equal(count(), 1);
    assert.equal(await evaluate('Boolean(document.querySelector(".toast-error"))'), false);
  });
  await check('scope edits, body edits, exclude and restore all save before inference ends and keep originals', async () => {
    const original = (await saved(a.id)).evidence[0]; await sourceDetail(original.id);
    await fill('#evidence-' + original.id + ' .visibility-field select', 'private');
    await until(async () => (await saved(a.id)).evidence[0].visibility === 'private', 'scope saved');
    await evaluate('document.querySelector(' + JSON.stringify('#evidence-' + original.id + ' .evidence-edit') + ').open=true');
    await fill('#evidence-' + original.id + ' .evidence-edit textarea', 'QA_CASE_A EDITED_LATEST_BODY');
    await submit('#evidence-' + original.id + ' .evidence-edit form');
    await until(async () => (await saved(a.id)).evidence[0].editedText?.includes('EDITED_LATEST_BODY'), 'body edit');
    await evaluate('document.querySelector(' + JSON.stringify('#evidence-' + original.id + ' .evidence-enabled') + ').click()');
    await until(async () => (await saved(a.id)).evidence[0].analysisEnabled === false, 'exclude');
    await evaluate('document.querySelector(' + JSON.stringify('#evidence-' + original.id + ' .evidence-enabled') + ').click()');
    await until(async () => (await saved(a.id)).evidence[0].analysisEnabled === true, 'restore');
    assert.equal((await saved(a.id)).evidence[0].extractedText, original.extractedText);
    assert.equal(count(), 1);
  });
  await check('one following inference consumes the latest complete input and successful self-saving stops', async () => {
    const revision = (await saved(a.id)).revision; firstGate.release();
    await until(async () => (await saved(a.id)).analysis?.inputRevision === revision, 'latest result');
    await idle(); await delay(650);
    assert.equal(count(), 2); assert.equal(await status(), '');
    const sent = JSON.stringify(h.requests.at(-1).request);
    for (const marker of ['EDITED_LATEST_BODY', 'SECOND_BODY', 'CURRENT_SYNOPSIS']) assert.ok(sent.includes(marker), marker);
    assert.doesNotMatch(sent, /PROFILE_SECRET_UI/);
  });
  const historyGate = holdResponse();
  let completedId, dismissedId;
  await check('completion and dismissal remain one-click saves while a manual refresh is waiting', async () => {
    await topButton('状況を更新'); await until(() => historyGate.entered, 'manual history inference'); await nav(2);
    const actions = (await saved(a.id)).analysis.actions; completedId = actions[0].id; dismissedId = actions[1].id;
    await evaluate('document.querySelector(' + JSON.stringify('[data-action-id="' + completedId + '"] .action-controls button:first-child') + ').click()');
    await until(async () => (await saved(a.id)).actionHistory.some((item) => item.id === completedId), 'completed');
    await evaluate('document.querySelector(' + JSON.stringify('[data-action-id="' + dismissedId + '"] .action-controls .danger-link') + ').click()');
    await until(async () => (await saved(a.id)).actionHistory.some((item) => item.id === dismissedId), 'dismissed');
    assert.equal((await saved(a.id)).analysis.actions.length, 0);
  });
  await check('optional history notes and explicit restore save while inference remains active', async () => {
    await nav(3);
    const editor = '[data-history-id="' + completedId + '"] .history-note-editor';
    await evaluate('document.querySelector(' + JSON.stringify(editor) + ').open=true');
    await fill(editor + ' textarea', 'OPTIONAL_REASON_UI');
    const textareas = await evaluate('document.querySelector(' + JSON.stringify(editor) + ').querySelectorAll("textarea").length');
    assert.equal(textareas, 2);
    await fill(editor + ' label:last-of-type textarea', 'OPTIONAL_RESULT_UI');
    await submit(editor + ' form');
    await until(async () => (await saved(a.id)).actionHistory.find((item) => item.id === completedId)?.resultNote === 'OPTIONAL_RESULT_UI', 'optional note');
    await evaluate('document.querySelector(' + JSON.stringify('[data-history-id="' + dismissedId + '"] .restore-button') + ').click()');
    await until(async () => (await saved(a.id)).analysis.actions.length === 1, 'explicit restore');
  });
  await check('history mutations join a single fresh request and their statuses and optional notes reach it', async () => {
    const revision = (await saved(a.id)).revision; historyGate.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision, 'history result'); await idle(); await delay(600);
    assert.equal(count(), 4);
    const request = JSON.stringify(h.requests.at(-1).request);
    for (const marker of ['completed', 'restored', 'OPTIONAL_REASON_UI', 'OPTIONAL_RESULT_UI']) assert.ok(request.includes(marker), marker);
  });
  await check('reversed save responses cannot roll back the displayed result or cause a second self-refresh', async () => {
    await evidence(); const delayedSave = holdSave('addEvidence'), response = holdResponse();
    await fill('.add-note-panel textarea', 'QA_CASE_A REVERSED_SAVE_BODY'); await submit();
    await until(() => delayedSave.entered, 'delayed saved response');
    await fill('.profile-panel > label textarea', 'QA_CASE_A NEWER_PROFILE_BODY'); await submit('.profile-panel');
    await until(() => response.entered, 'newer profile inference');
    const revision = (await saved(a.id)).revision; response.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision, 'newer result before older response');
    const before = count(); delayedSave.release();
    await until(() => evaluate('document.querySelector(".add-note-panel textarea").value===""'), 'old saved draft consumed');
    await idle(); await delay(650); assert.equal(count(), before);
    assert.equal(await evaluate('document.querySelectorAll(".evidence-card").length'), (await saved(a.id)).evidence.length);
  });
  await check('manual OFF stores changes and shows persistent pending information even after the toast closes', async () => {
    await setting([['.toggle input', false]]); const before = count(); await add('QA_CASE_A MANUAL_SAVED_BODY'); await delay(600);
    assert.equal(count(), before); assert.ok((await status()).includes('未反映'));
    await evaluate('document.querySelector(".toast button").click()'); assert.ok((await status()).includes('未反映'));
  });
  await check('manual button repetitions issue one request and its in-flight save receives exactly one follow-up with auto OFF', async () => {
    const response = holdResponse(), before = count();
    await evaluate('(()=>{const button=document.querySelector(".topbar-actions button");button.click();button.click();button.click();})()');
    await until(() => response.entered, 'manual inference'); await add('QA_CASE_A MANUAL_LATEST_BODY');
    const revision = (await saved(a.id)).revision; response.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision, 'manual latest result'); await idle(); await delay(650);
    assert.equal(count(), before + 2);
  });
  await check('settings-only enabling auto does not send, and queued cancellation removes the debounce reservation', async () => {
    const before = count(); await setting([['.toggle input', true]]); await delay(500); assert.equal(count(), before);
    await add('QA_CASE_A CANCEL_BEFORE_DISPATCH'); await topButton('解析を中止'); await idle(); await delay(650);
    assert.equal(count(), before); assert.ok((await status()).includes('未反映'));
  });
  await check('cancelling an in-flight update also cancels its latest reservation and keeps the previous result', async () => {
    const response = holdResponse(), before = count(); await add('QA_CASE_A CANCEL_ACTIVE'); await until(() => response.entered, 'cancel-active inference');
    await add('QA_CASE_A CANCEL_RESERVED'); const current = await saved(a.id); await topButton('解析を中止');
    await until(() => h.requests.at(-1).signal.aborted, 'provider cancellation received');
    response.release(); await idle(); await delay(650);
    assert.equal(count(), before + 1); assert.equal((await saved(a.id)).revision, current.revision);
    assert.equal((await saved(a.id)).analysis.updatedAt, current.analysis.updatedAt); assert.ok((await status()).includes('未反映'));
  });
  await check('A to B to A preserves both saves and lets old B completion leave the new A update active', async () => {
    const oldA = holdResponse(); await add('QA_CASE_A SWITCH_OLD'); await until(() => oldA.entered, 'old A');
    await select('Synthetic B'); const oldB = holdResponse(); await add('QA_CASE_B B_OWN_BODY'); await until(() => oldB.entered, 'old B');
    await select('Synthetic A'); const newA = holdResponse(); await add('QA_CASE_A SWITCH_NEW'); oldA.release();
    await until(() => newA.entered, 'new A');
    const before = count(); oldB.release(); await delay(120);
    assert.equal(await evaluate('document.querySelector(".topbar-title").textContent'), 'Synthetic A');
    assert.ok((await status()).includes('更新中')); assert.equal(count(), before);
    const revision = (await saved(a.id)).revision; newA.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision, 'new A applied'); await idle();
    assert.equal((await saved(b.id)).analysis, null); assert.equal((await saved(b.id)).evidence[0].extractedText, 'QA_CASE_B B_OWN_BODY');
  });
  await check('role ON result records protected provenance locally', async () => {
    const before = count(); await setting([['.role-consent input', true]]); await delay(500); assert.equal(count(), before);
    await add('QA_CASE_A PROFILE_ON_BODY');
    await until(async () => (await saved(a.id)).analysis.grounding.includeRoleProfile === true, 'role ON saved'); await idle();
    assert.match(JSON.stringify(h.requests.at(-1).request), /PROFILE_SECRET_UI/);
  });
  await check('role OFF invalidates old input, continues the authorized request and excludes direct and derived profile prose', async () => {
    const response = holdResponse(); await add('QA_CASE_A PROFILE_ON_PENDING'); await until(() => response.entered, 'role ON pending');
    assert.match(JSON.stringify(h.requests.at(-1).request), /PROFILE_SECRET_UI/);
    await setting([['.role-consent input', false]]); assert.equal(h.requests.at(-1).signal.aborted, true);
    const revision = (await saved(a.id)).revision; response.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision && (await saved(a.id)).analysis.grounding.includeRoleProfile === false, 'role OFF continuation'); await idle();
    assert.doesNotMatch(JSON.stringify(h.requests.at(-1).request), /PROFILE_SECRET_UI|PROFILE_DERIVED_UI/);
    assert.ok((await saved(a.id)).analysisHistory.some((item) => item.grounding.includeRoleProfile));
  });
  await check('provider change continues an authorized request with OpenAI mock settings without an additional consent prompt', async () => {
    const response = holdResponse(); await add('QA_CASE_A PROVIDER_PENDING'); await until(() => response.entered, 'old provider pending');
    await settingsPage(); await evaluate('Array.from(document.querySelectorAll(".provider-option")).find(e=>e.textContent.includes("OpenAI API")).click()');
    await delay(30); await evaluate('document.querySelector(".toggle input").click()');
    await submit('.settings-scroll form'); await until(() => evaluate('document.querySelector(".test-result")?.textContent.includes("設定を保存")'), 'provider setting');
    await evidence(); const revision = (await saved(a.id)).revision; response.release();
    await until(async () => (await saved(a.id)).analysis.inputRevision === revision && h.requests.at(-1).provider === 'openai', 'new provider result'); await idle();
    assert.equal(h.requests.at(-1).provider, 'openai'); assert.equal(await evaluate('Boolean(document.querySelector(".toast-error"))'), false);
  });
  await check('consent withdrawal and auto OFF stop authorized continuation without dropping saved data', async () => {
    const response = holdResponse(); await add('QA_CASE_A CONSENT_PENDING'); await until(() => response.entered, 'consent pending'); const before = count();
    await setting([['.toggle input', false], ['.consent-row input', false]]);
    response.release(); await idle(); await delay(650);
    assert.equal(count(), before); assert.ok((await status()).includes('未反映'));
    assert.equal((await saved(a.id)).evidence.at(-1).extractedText, 'QA_CASE_A CONSENT_PENDING');
  });
  await check('a malformed result retains previous analysis and does not retry the same failed input', async () => {
    await settingsPage(); await evaluate('Array.from(document.querySelectorAll(".provider-option")).find(e=>e.textContent.includes("Ollama ローカル")).click()');
    await delay(30); await evaluate('document.querySelector(".toggle input").click()'); await submit('.settings-scroll form');
    await until(() => evaluate('document.querySelector(".test-result")?.textContent.includes("設定を保存")'), 'local mock selected'); await evidence();
    malformed = true; const previous = (await saved(a.id)).analysis.updatedAt, before = count();
    await add('QA_CASE_A FAILED_INPUT');
    await until(() => evaluate('Boolean(document.querySelector(".toast-error"))'), 'failure reported'); await idle(); await delay(650);
    assert.equal(count(), before + 1); assert.equal((await saved(a.id)).analysis.updatedAt, previous);
    assert.ok((await status()).includes('未反映')); malformed = false;
  });
  await check('same-input stale is refreshed locally once and never becomes an automatic retry loop', async () => {
    forceStale = true; const before = calls.filter((call) => call.name === 'analyze').length, providerBefore = count();
    await add('QA_CASE_A SAME_STALE_INPUT'); await idle(); await delay(900);
    assert.equal(calls.filter((call) => call.name === 'analyze').length, before + 1);
    assert.equal(count(), providerBefore); assert.ok((await status()).includes('未反映'));
  });
  await check('creation invalidates the old run and shows the new scenario without inherited update state', async () => {
    const response = holdResponse(); await add('QA_CASE_A CREATE_PENDING'); await until(() => response.entered, 'create pending');
    await evaluate('document.querySelector(".scenario-head button").click()'); await fill('.quick-create input', 'Synthetic Created'); await submit('.quick-create');
    await until(() => evaluate('document.querySelector(".topbar-title")?.textContent==="Synthetic Created"'), 'created selected');
    response.release(); await idle(); assert.equal(await status(), '');
    const created = (await h.invoke('scenario:list')).find((item) => item.title === 'Synthetic Created'); subjects.set('QA_CASE_C', created.id);
    await evidence();
  });
  await check('deletion cancels the provider and a delayed result cannot recreate the deleted scenario or affect its replacement', async () => {
    const created = (await h.invoke('scenario:list')).find((item) => item.title === 'Synthetic Created');
    const response = holdResponse(); await add('QA_CASE_C DELETE_PENDING'); await until(() => response.entered, 'delete pending');
    h.controls.confirmDelete = 1;
    await evaluate('document.querySelector(".footer-delete").click()');
    await until(() => evaluate('document.querySelector(".topbar-title")?.textContent!=="Synthetic Created"'), 'replacement selected');
    const name = await evaluate('document.querySelector(".topbar-title").textContent');
    response.release(); await delay(650);
    assert.equal(await evaluate('document.querySelector(".topbar-title").textContent'), name);
    await assert.rejects(fs.stat(path.join(h.directory, 'cases', created.id)), { code: 'ENOENT' });
  });
  await check('all synthetic provider runs stayed single per scenario and the actual React screen has no runtime errors', async () => {
    assert.ok([...peak.values()].every((value) => value <= 1));
    assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.qaErrors'), []);
  });
  await fs.mkdir(qaDir, { recursive: true });
  const report = path.join(qaDir, 'results.json');
  await fs.writeFile(report, JSON.stringify({ passed: reports.length, reports, peak: Object.fromEntries(peak), providerCalls: count(), ipcCalls: calls.length, errors, root }, null, 2));
  console.log(JSON.stringify({ passed: reports.length, providerCalls: count(), report }));
}

verify().catch(async (error) => {
  console.error(error.stack); if (evaluate) { try { console.error('UI ' + JSON.stringify(await evaluate('({heading:document.querySelector(".topbar-title")?.textContent,status:document.querySelector(".analysis-status")?.textContent,error:document.querySelector(".toast-error")?.textContent,body:document.body.innerText.slice(-3500)})'))); } catch {} }
  process.exitCode = 1;
}).finally(async () => {
  // Close only the debugger target and child process created with this unique profile.
  if (command) { try { await command('Browser.close'); } catch {} }
  if (socket) socket.close();
  if (browser) browser.kill();
  if (browserLog) await browserLog.close();
  if (h) await Promise.allSettled(calls.filter((call) => call.name === 'analyze').map((call) => h.invoke('scenario:cancel-analysis', call.args[0])));
  for (const release of gateReleases) release();
  if (server) {
    // Even a failed assertion must drain mocked saves before removing their fixture.
    try { await until(() => pendingIpc === 0 && [...active.values()].every((value) => value === 0), 'synthetic requests drained'); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
  for (const cleanup of cleanups.reverse()) await cleanup();
});
