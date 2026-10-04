const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

// Run after npm run build. All scenarios, browser state and reports stay under
// this checkout's .local directory; Electron and actual AI are never started.
const root = path.resolve(__dirname, '..');
const qaDir = path.join(root, '.local', 'action-history-ui');
const runDir = path.join(qaDir, 'run-' + Date.now());
const data = path.join(runDir, 'synthetic-data');
const browserProfile = path.join(runDir, 'headless-profile');
const handlers = new Map();
const calls = [];
const gates = new Map();
const reports = [];
const errors = [];
let browser;
let server;
let socket;
let evaluate;
let browserCommand;
let syntheticAutoUpdate = false;
let browserLog;
const realRequire = createRequire(path.join(root, 'electron/main.cjs'));
const methods = {
  listScenarios: 'scenario:list', getScenario: 'scenario:get', getSettings: 'settings:get',
  createScenario: 'scenario:create', createDemo: 'scenario:create-demo', saveProfile: 'scenario:save-profile',
  completeAction: 'scenario:complete-action', discardAction: 'scenario:discard-action', updateActionNotes: 'scenario:action-notes', restoreAction: 'scenario:restore-action',
  addEvidence: 'scenario:add-evidence', analyze: 'scenario:analyze', cancelAnalysis: 'scenario:cancel-analysis'
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function findBrowser() {
  const candidates = process.env.MAKUA_HEADLESS_BROWSER ? [process.env.MAKUA_HEADLESS_BROWSER] : [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw new Error('Set MAKUA_HEADLESS_BROWSER to an installed Chromium/Edge/Chrome executable.');
}
async function invoke(method, ...args) { return handlers.get(method)({}, ...args); }
function hold(method, phase = 'before', fail = false) {
  let release;
  const gate = { phase, fail, entered: false, wait: new Promise((resolve) => { release = resolve; }), release };
  if (!gates.has(method)) gates.set(method, []);
  gates.get(method).push(gate);
  return gate;
}
async function until(check, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('Timed out: ' + label);
}
async function boot() {
  const browserExecutable = await findBrowser();
  await fs.access(path.join(root, 'dist', 'index.html'));
  await fs.mkdir(data, { recursive: true });
  const stub = {
    app: { setName() {}, getPath: () => data, getVersion: () => '0.2.1', whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: class { constructor() { throw new Error('GUI launch forbidden'); } },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => { throw new Error('Native dialog forbidden'); }, showMessageBox: async () => ({ response: 0 }) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openPath: async () => { throw new Error('Shell opening forbidden'); } }
  };
  class NoOpenAI { constructor() { throw new Error('Actual AI requests forbidden'); } }
  const code = await fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8');
  vm.runInNewContext(code, {
    require: (name) => name === 'electron' ? stub : name === 'openai' ? { default: NoOpenAI } : realRequire(name),
    module: { exports: {} }, __dirname: path.join(root, 'electron'),
    process, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: async () => { throw new Error('Actual network requests forbidden'); }
  }, { filename: path.join(root, 'electron/main.cjs'), importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const b = await invoke('scenario:create', 'Synthetic B');
  const a = await invoke('scenario:create', 'Synthetic A');
  await fs.writeFile(path.join(data, 'cases', b.id, 'case.json'), JSON.stringify({ ...seededCase(b, false), updatedAt: '2000-01-01T00:00:00.000Z' }));
  await fs.writeFile(path.join(data, 'cases', a.id, 'case.json'), JSON.stringify(seededCase(a, true)));
  const bridge = `window.qaErrors = []; window.addEventListener('error', e => window.qaErrors.push(e.message));
    window.makua = Object.fromEntries(${JSON.stringify(Object.keys(methods))}.map(name => [name, async (...args) => {
      const res = await fetch('/qa-ipc', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name,args}) });
      const result = await res.json(); if(result.error) throw new Error(result.error); return result.value;
    }]));`;
  server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/qa-ipc' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        const { name, args } = JSON.parse(body);
        assert.ok(methods[name], 'Only QA methods are allowed');
        calls.push({ name, args });
        const gate = gates.get(name)?.shift();
        if (gate) gate.entered = true;
        if (gate?.phase === 'before') await gate.wait;
        if (gate?.fail) throw new Error('Synthetic save failure');
        let value;
        if (name === 'analyze') value = { status: 'ok', scenario: await invoke('scenario:get', args[0].id) };
        else value = await invoke(methods[name], ...args);
        if (name === 'getSettings' && syntheticAutoUpdate) value = { ...value, provider: 'ollama', ollamaModel: 'mock-only', autoUpdate: true };
        if (gate?.phase === 'after') await gate.wait;
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value })); return;
      }
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const filename = new URL(request.url, 'http://127.0.0.1').pathname === '/' ? 'index.html' : new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
      const resolved = path.resolve(root, 'dist', filename);
      assert.ok(resolved.startsWith(path.join(root, 'dist') + path.sep));
      let body = await fs.readFile(resolved);
      if (filename === 'index.html') body = Buffer.from(body.toString().replace('<head>', '<head><script>' + bridge + '</script>'));
      response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
      response.end(body);
    } catch (error) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(browserProfile, { recursive: true });
  browserLog = await fs.open(path.join(runDir, 'headless-stderr.txt'), 'w');
  browser = spawn(browserExecutable, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + browserProfile,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu', '--no-sandbox',
    '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant,msEdgeWallet',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'
  ], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', browserLog.fd] });
  browser.on('error', (error) => errors.push(error.message));
  let port;
  await until(async () => {
    try { port = Number((await fs.readFile(path.join(browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return Boolean(port); }
    catch { return false; }
  }, 'headless devtools ready');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Websocket opening timed out')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Websocket opening failed')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) { const promise = pending.get(message.id); pending.delete(message.id); message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out: ' + method)); }, 5000);
    pending.set(id, { resolve: (result) => { clearTimeout(timeout); resolve(result); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  browserCommand = command;
  evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await command('Runtime.enable'); await command('Page.enable');
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(() => evaluate("document.querySelector('.topbar-title')?.textContent === 'Synthetic A'"), 'initial A');
  return { a, b, command };
}
const cleanInput = { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false, evidenceIds: ['synthetic-note'] };
const fixtureTime = '2026-10-05T00:00:00.000Z';
function syntheticAction(id) {
  return { id, title: 'Synthetic inquiry ' + id, who: '記録係', purpose: '返却記録の意味を確かめる', step: '鍵が返却された時刻を記録係へ聞く。', suggestedLine: '鍵はいつ戻りましたか。',
    rationale: '意味が未確認', priority: 1, evidenceIds: [], assumptions: [], secretRisk: '借りた理由を先に明かさない。', grounding: cleanInput, status: 'active', createdAt: fixtureTime };
}
function seededCase(record, isA) {
  const completed = { ...syntheticAction('dismiss-1'), status: 'discarded', retiredAt: fixtureTime, retirementReason: '', retirementGrounding: cleanInput };
  const actions = isA ? ['complete-1', 'dismiss-1', 'sourcefree-1', 'recheck-1', 'delayed-1'].map(syntheticAction) : [];
  if (isA) {
    actions[0].evidenceIds = ['synthetic-note']; actions[0].secretRisk = 'PRIVATE_SPEECH_RISK_MARKER';
    actions[3].rechecks = [{ actionId: 'previous-check', previousPremise: '証人は退場済み', currentPremise: '証人が戻った可能性', reason: '在席しているなら時刻を再確認できる' }];
    actions[3].assumptions = ['証人が戻っている'];
  }
  return { ...record, evidence: [{ id: 'synthetic-note', title: 'Synthetic public note', kind: 'text', extractedText: '08時に鍵が戻ったと記載。', visibility: 'shared', extractionStatus: 'success', createdAt: fixtureTime }],
    actionHistory: isA ? [] : [completed], analysisHistory: [],
    analysis: { revision: record.revision, inputRevision: record.revision, updatedAt: fixtureTime, overview: 'Synthetic overview', provider: 'Synthetic mock', grounding: cleanInput,
      actions, events: [], facts: [], flow: [], hypotheses: [], unknowns: [], sources: [] } };
}
async function fill(selector, value) {
  await evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input) throw new Error('Missing input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await delay(30);
}
async function page(index) {
  await evaluate(`document.querySelectorAll('.side-nav-item')[${index}].click()`);
  await until(() => evaluate(index === 2 ? "Boolean(document.querySelector('.plans-context'))" : index === 3 ? "Boolean(document.querySelector('.history-list'))" : "Boolean(document.querySelector('.play-grid'))"), 'page ' + index);
}
async function select(name, index = 3) {
  await evaluate(`(() => { const button=Array.from(document.querySelectorAll('.scenario-switch')).find(e=>e.querySelector('.scenario-title').textContent===${JSON.stringify(name)}); if(!button) throw new Error('Missing scenario'); button.click(); })()`);
  await until(() => evaluate(`document.querySelector('.topbar-title')?.textContent===${JSON.stringify(name)}`), 'selected ' + name);
  await page(index);
}
function card(id, history = false) { return (history ? '[data-history-id="' : '[data-action-id="') + id + '"]'; }
async function clickAction(id, buttonIndex = 0) {
  await evaluate(`document.querySelector(${JSON.stringify(card(id))}).querySelectorAll('.action-controls button')[${buttonIndex}].click()`);
}
async function openNotes(id) {
  await evaluate(`document.querySelector(${JSON.stringify(card(id, true) + ' .history-note-editor')}).open=true`);
}
async function notes(id) {
  return evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(card(id, true) + ' textarea')})).map(e=>e.value)`);
}
async function submitNotes(id) {
  await evaluate(`document.querySelector(${JSON.stringify(card(id, true) + ' form')}).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
}
async function caseReport(name, body) { await body(); reports.push({ name, passed: true }); console.log('PASS ' + name); }
const saved = async (id) => JSON.parse(JSON.stringify(await invoke('scenario:get', id)));
const count = (method) => calls.filter((call) => call.name === method).length;
async function verify() {
  const { a, b } = await boot();
  await page(2);
  await caseReport('source visibility and speech risk are separate and readable with details closed', async () => {
    const result = await evaluate(`(() => { const card=document.querySelector('[data-action-id="complete-1"]');
      const risk=card.querySelector('.action-care'); const sourcefree=document.querySelector('[data-action-id="sourcefree-1"]');
      const recheck=document.querySelector('[data-action-id="recheck-1"] .action-rechecks'); return {
        source:card.querySelector('.action-source-scope').textContent, risk:risk.textContent, visible:risk.getClientRects().length>0,
        nested:Boolean(risk.closest('details')), open:card.querySelector('details').open, sourcefree:sourcefree.querySelector('.action-source-scope').textContent,
        recheckVisible:recheck.getClientRects().length>0, recheck:recheck.textContent, textareaCount:document.querySelectorAll('.action-card textarea').length
      }; })()`);
    assert.match(result.source, /根拠資料の公開範囲.*全体公開/); assert.match(result.risk, /PRIVATE_SPEECH_RISK_MARKER/);
    assert.equal(result.visible,true); assert.equal(result.nested,false); assert.equal(result.open,false);
    assert.match(result.sourcefree,/参照資料なし/); assert.doesNotMatch(result.sourcefree,/全体公開/);
    assert.equal(result.recheckVisible,true); assert.match(result.recheck,/以前: 証人は退場済み.*今回: 証人が戻った可能性/);
    assert.equal(result.textareaCount,0);
  });
  await caseReport('one completion click saves history without a response, reason or dialog', async () => {
    const before=count('completeAction'); await clickAction('complete-1');
    await until(async()=> (await saved(a.id)).actionHistory.some(e=>e.id==='complete-1'), 'completion saved');
    await until(()=>evaluate("!document.querySelector('[data-action-id=\"complete-1\"]')"),'completion applied');
    const record=(await saved(a.id)).actionHistory.find(e=>e.id==='complete-1');
    assert.equal(record.status,'completed'); assert.equal(record.retirementReason,''); assert.equal(record.resultNote,undefined); assert.ok(record.retiredAt);
    assert.equal(count('completeAction'),before+1); assert.equal(count('analyze'),0);
  });
  await caseReport('one dismissal click immediately saves without requiring a reason', async () => {
    const before=count('discardAction'); await clickAction('dismiss-1',1);
    await until(async()=> (await saved(a.id)).actionHistory.some(e=>e.id==='dismiss-1'),'dismissal saved');
    await until(()=>evaluate("!document.querySelector('[data-action-id=\"dismiss-1\"]')"),'dismissal applied');
    const record=(await saved(a.id)).actionHistory.find(e=>e.id==='dismiss-1');
    assert.equal(record.status,'discarded'); assert.equal(record.retirementReason,''); assert.equal(count('discardAction'),before+1);
    assert.equal(await evaluate("Boolean(document.querySelector('.discard-box'))"),false);
  });
  await caseReport('overview controls complete a source-free action without an AI request', async () => {
    await page(0); await clickAction('sourcefree-1');
    await until(async()=> (await saved(a.id)).actionHistory.some(e=>e.id==='sourcefree-1'),'overview completion saved');
    assert.deepEqual((await saved(a.id)).actionHistory.find(e=>e.id==='sourcefree-1').evidenceIds,[]);
    assert.equal(count('analyze'),0);
  });
  await caseReport('optional history reason and response are saved after completion and dismissal', async () => {
    await page(3); await openNotes('dismiss-1');
    await fill(card('dismiss-1',true)+' textarea:nth-of-type(1)', 'A optional reason');
    // Each textarea is wrapped by its own label.
    await fill(card('dismiss-1',true)+' label:last-of-type textarea', 'A optional response');
    await submitNotes('dismiss-1');
    await until(async()=> (await saved(a.id)).actionHistory.find(e=>e.id==='dismiss-1').resultNote==='A optional response','optional note saved');
    const record=(await saved(a.id)).actionHistory.find(e=>e.id==='dismiss-1');
    assert.equal(record.retirementReason,'A optional reason'); assert.equal(record.status,'discarded'); assert.equal(record.grounding.includeRoleProfile,false);
    await until(()=>evaluate("!document.querySelector('[data-history-id=\"dismiss-1\"] button[type=submit]').disabled"),'notes unlocked');
  });
  await caseReport('unsaved optional history notes belong to their scenario even with matching action IDs', async () => {
    await fill(card('dismiss-1',true)+' label:first-of-type textarea','A unsaved reason');
    await select('Synthetic B'); await openNotes('dismiss-1'); assert.deepEqual(await notes('dismiss-1'),['','']);
    await fill(card('dismiss-1',true)+' label:first-of-type textarea','B unsaved reason');
    await select('Synthetic A'); await openNotes('dismiss-1'); assert.deepEqual(await notes('dismiss-1'),['A unsaved reason','A optional response']);
    assert.equal((await saved(b.id)).actionHistory[0].retirementReason,'');
  });
  await caseReport('edits during an optional note save survive A/B/A and do not overwrite the submitted snapshot', async () => {
    const gate=hold('updateActionNotes'); const before=count('updateActionNotes'); await submitNotes('dismiss-1');
    await until(()=>gate.entered,'note save held'); await select('Synthetic B'); assert.deepEqual(await notes('dismiss-1'),['B unsaved reason','']);
    await select('Synthetic A'); await openNotes('dismiss-1');
    assert.equal(await evaluate("document.querySelector('[data-history-id=\"dismiss-1\"] button[type=submit]').disabled"),true);
    await submitNotes('dismiss-1'); assert.equal(count('updateActionNotes'),before+1);
    await fill(card('dismiss-1',true)+' label:first-of-type textarea','A newer unsaved reason');
    gate.release();
    await until(async()=> (await saved(a.id)).actionHistory.find(e=>e.id==='dismiss-1').retirementReason==='A unsaved reason','snapshot saved');
    await until(()=>evaluate("!document.querySelector('[data-history-id=\"dismiss-1\"] button[type=submit]').disabled"),'note save released');
    assert.deepEqual(await notes('dismiss-1'),['A newer unsaved reason','A optional response']);
    assert.equal((await saved(b.id)).actionHistory[0].retirementReason,'');
  });
  await caseReport('a delayed completion after A/B/A refreshes the current record and blocks duplicate clicks', async () => {
    await page(2); const gate=hold('completeAction'); const before=count('completeAction'); await clickAction('delayed-1');
    await until(()=>gate.entered,'completion held'); await clickAction('delayed-1'); await delay(40); assert.equal(count('completeAction'),before+1);
    await select('Synthetic B',0); await select('Synthetic A',2); gate.release();
    await until(()=>evaluate("!document.querySelector('[data-action-id=\"delayed-1\"]')"),'fresh completed A view');
    assert.equal((await saved(a.id)).actionHistory.filter(e=>e.id==='delayed-1').length,1);
    assert.equal((await saved(b.id)).actionHistory.length,1);
    assert.equal(count('completeAction'),before+1);
  });
  await caseReport('explicit restoration keeps original provenance and saved optional notes in the local history', async () => {
    await page(3);
    await evaluate("document.querySelector('[data-history-id=\"dismiss-1\"] .restore-button').click()");
    await until(async()=> (await saved(a.id)).actionHistory.find(e=>e.id==='dismiss-1').status==='restored','restoration saved');
    const record=await saved(a.id); const active=record.analysis.actions.find(e=>e.restoredFromId==='dismiss-1');
    assert.ok(active); assert.deepEqual(active.grounding,cleanInput);
    assert.equal(record.actionHistory.find(e=>e.id==='dismiss-1').retirementReason,'A unsaved reason');
    assert.equal(count('analyze'),0);
  });
  assert.deepEqual(errors,[]); assert.deepEqual(await evaluate('window.qaErrors'),[]);
  const report={ passed:reports.length,reports,browserErrors:errors,root,data,calls };
  await fs.writeFile(path.join(qaDir,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:reports.length,browserErrors:errors,report:path.join(qaDir,'results.json')}));
}
verify().catch(async (error)=>{
  console.error(error.stack); process.exitCode=1;
}).finally(async()=>{
  if(browserCommand){try{await browserCommand('Browser.close');}catch{}}
  if(socket)socket.close();
  if(browser)browser.kill();
  if(browserLog)await browserLog.close();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
