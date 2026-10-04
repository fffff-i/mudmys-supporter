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
const qaDir = path.join(root, '.local', 'scenario-drafts-ui');
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
  addText: 'scenario:add-text', analyze: 'scenario:analyze', cancelAnalysis: 'scenario:cancel-analysis'
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
  await fs.writeFile(path.join(data, 'cases', b.id, 'case.json'), JSON.stringify({ ...b, updatedAt: '2000-01-01T00:00:00.000Z' }));
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
const selectors = {
  title: '.add-note-panel input', text: '.add-note-panel textarea', visibility: '.add-note-panel select',
  profileTitle: '.profile-panel input', synopsis: '.profile-panel > label textarea',
  role: '.role-details input', goal: '.role-details label:nth-of-type(2) textarea', secret: '.role-details label:last-of-type textarea'
};
async function fill(selector, value) {
  await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) throw new Error('Missing input');
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', {bubbles:true})); })()`);
  await delay(35);
}
async function evidence() {
  await evaluate("document.querySelectorAll('.side-nav-item')[1].click()");
  await until(() => evaluate("Boolean(document.querySelector('.add-note-panel'))"), 'evidence form');
}
async function select(name) {
  await evaluate(`(() => { const item = Array.from(document.querySelectorAll('.scenario-switch')).find(e => e.querySelector('.scenario-title').textContent === ${JSON.stringify(name)}); if (!item) throw new Error('Missing scenario '+${JSON.stringify(name)}); item.click(); })()`);
  await until(() => evaluate(`document.querySelector('.topbar-title')?.textContent === ${JSON.stringify(name)}`), 'selected ' + name);
  await evidence();
}
async function state() {
  return evaluate(`(() => { const get = selector => document.querySelector(selector)?.value; return {
    title:get('.add-note-panel input'), text:get('.add-note-panel textarea'), visibility:get('.add-note-panel select'),
    profileTitle:get('.profile-panel input'), synopsis:get('.profile-panel > label textarea'), role:get('.role-details input'),
    goal:get('.role-details label:nth-of-type(2) textarea'), secret:get('.role-details label:last-of-type textarea'),
    textDisabled:document.querySelector('.add-note-panel button[type=submit]')?.disabled,
    profileDisabled:document.querySelector('.profile-panel button[type=submit]')?.disabled,
    heading:document.querySelector('.topbar-title')?.textContent,
    evidence:Array.from(document.querySelectorAll('.evidence-title-row strong')).map(e=>e.textContent),
    error:document.querySelector('.toast-error')?.textContent || ''
  }; })()`);
}
async function note(title, text, visibility = 'private') { await fill(selectors.title, title); await fill(selectors.text, text); await fill(selectors.visibility, visibility); }
async function submit(type) { await evaluate(`document.querySelector(${JSON.stringify(type === 'text' ? '.add-note-panel' : '.profile-panel')}).dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))`); }
async function caseReport(name, body) { await body(); reports.push({ name, passed: true }); console.log('PASS ' + name); }
const saved = (id) => invoke('scenario:get', id);
const count = (method) => calls.filter((call) => call.name === method).length;

async function verify() {
  const { a, b, command } = await boot();
  await evidence();
  await caseReport('unsaved text, scope and all profile fields survive A/B switching without mixing', async () => {
    await note('A unsaved heading', 'A unsaved private clue');
    await fill(selectors.profileTitle, 'A unsaved title'); await fill(selectors.synopsis, 'A unsaved synopsis');
    await fill(selectors.role, 'A unsaved role'); await fill(selectors.goal, 'A unsaved goal'); await fill(selectors.secret, 'A unsaved secret');
    await select('Synthetic B');
    let visible = await state(); assert.equal(visible.text, ''); assert.equal(visible.title, ''); assert.equal(visible.visibility, 'unknown'); assert.equal(visible.secret, '');
    await submit('text'); assert.equal((await saved(b.id)).evidence.length, 0);
    await note('B unsaved heading', 'B unsaved clue', 'shared'); await fill(selectors.secret, 'B unsaved secret');
    await select('Synthetic A'); visible = await state();
    assert.deepEqual([visible.title, visible.text, visible.visibility, visible.profileTitle, visible.synopsis, visible.role, visible.goal, visible.secret],
      ['A unsaved heading', 'A unsaved private clue', 'private', 'A unsaved title', 'A unsaved synopsis', 'A unsaved role', 'A unsaved goal', 'A unsaved secret']);
  });
  await caseReport('a pending scenario load already displays the destination draft and preserves new typing', async () => {
    const gate = hold('getScenario', 'after'); await select('Synthetic B'); await until(() => gate.entered, 'B get entered');
    await note('B while loading', 'B typed while loading', 'shared'); gate.release();
    await until(async () => (await state()).text === 'B typed while loading', 'B input retained');
    await select('Synthetic A'); assert.equal((await state()).text, 'A unsaved private clue');
  });
  await caseReport('successful save after switching clears A only and persists the clue under A', async () => {
    const gate = hold('addText'); await submit('text'); await until(() => gate.entered, 'A save entered');
    await select('Synthetic B'); gate.release(); await until(async () => (await saved(a.id)).evidence.length === 1, 'A saved');
    assert.equal((await saved(b.id)).evidence.length, 0); assert.equal((await state()).text, 'B typed while loading');
    await select('Synthetic A'); const visible = await state(); assert.equal(visible.text, ''); assert.equal(visible.title, ''); assert.equal(visible.visibility, 'private');
    const record = await saved(a.id); assert.equal(record.evidence[0].extractedText, 'A unsaved private clue'); assert.equal(record.evidence[0].visibility, 'private');
  });
  await caseReport('returning before completion blocks duplicate submission and refreshes the current A result', async () => {
    await note('A delayed heading', 'A delayed clue'); const gate = hold('addText'); const before = count('addText');
    await submit('text'); await until(() => gate.entered, 'A second save entered'); await select('Synthetic B'); await select('Synthetic A');
    assert.equal((await state()).textDisabled, true); await submit('text'); await delay(40); assert.equal(count('addText'), before + 1);
    gate.release(); await until(async () => (await state()).text === '' && (await state()).evidence.includes('A delayed heading'), 'A current result and cleared draft');
    assert.equal((await saved(a.id)).evidence.length, 2);
  });
  await caseReport('text edited after returning during a save remains unsaved and never replaces the submitted clue', async () => {
    await note('A sent heading', 'A sent clue'); const gate = hold('addText'); await submit('text'); await until(() => gate.entered, 'A third save entered');
    await select('Synthetic B'); await select('Synthetic A'); await note('A next heading', 'A next unsaved clue', 'unknown'); gate.release();
    await until(async () => (await state()).evidence.includes('A sent heading') && !(await state()).textDisabled, 'A saved and unlocked');
    const visible = await state(); assert.deepEqual([visible.title, visible.text, visible.visibility], ['A next heading', 'A next unsaved clue', 'unknown']);
    assert.equal((await saved(a.id)).evidence.at(-1).extractedText, 'A sent clue');
  });
  await caseReport('a failed save while away retains A input and leaves B input and messages intact', async () => {
    const gate = hold('addText', 'before', true); await submit('text'); await until(() => gate.entered, 'failed A save entered');
    await select('Synthetic B'); gate.release(); await delay(80); assert.equal((await state()).error, ''); assert.equal((await state()).text, 'B typed while loading');
    await select('Synthetic A'); assert.equal((await state()).text, 'A next unsaved clue'); assert.equal((await state()).textDisabled, false);
  });
  await caseReport('profile saved while away restores normalized A values and preserves B profile edits', async () => {
    await fill(selectors.profileTitle, '  A saved title  '); const gate = hold('saveProfile'); await submit('profile'); await until(() => gate.entered, 'A profile save entered');
    await select('Synthetic B'); gate.release(); await until(async () => (await saved(a.id)).title === 'A saved title', 'A profile saved');
    assert.equal((await state()).secret, 'B unsaved secret'); await select('A saved title');
    const visible = await state(); assert.equal(visible.profileTitle, 'A saved title'); assert.equal(visible.secret, 'A unsaved secret'); assert.equal(visible.synopsis, 'A unsaved synopsis');
    assert.equal((await saved(b.id)).roleProfile.secret, ''); assert.equal(visible.text, 'A next unsaved clue');
  });
  await caseReport('profile completion after A/B/A keeps later secret edits and refreshes the saved scenario title', async () => {
    await fill(selectors.profileTitle, 'A profile version 2'); await fill(selectors.secret, 'A sent secret v2');
    const gate = hold('saveProfile'); await submit('profile'); await until(() => gate.entered, 'A profile v2 entered');
    await select('Synthetic B'); await select('A saved title'); assert.equal((await state()).profileDisabled, true);
    await fill(selectors.secret, 'A edited secret after submit'); gate.release();
    await until(async () => (await state()).heading === 'A profile version 2' && !(await state()).profileDisabled, 'profile current result');
    assert.equal((await state()).secret, 'A edited secret after submit'); assert.equal((await saved(a.id)).roleProfile.secret, 'A sent secret v2');
    await select('Synthetic B'); await select('A profile version 2'); assert.equal((await state()).secret, 'A edited secret after submit');
  });
  await caseReport('failed profile save keeps edits after switching and permits retry', async () => {
    const gate = hold('saveProfile', 'before', true); await submit('profile'); await until(() => gate.entered, 'failed profile entered');
    await select('Synthetic B'); gate.release(); await delay(80); await select('A profile version 2');
    assert.equal((await state()).secret, 'A edited secret after submit'); assert.equal((await state()).profileDisabled, false);
    await submit('profile'); await until(async () => (await saved(a.id)).roleProfile.secret === 'A edited secret after submit', 'profile retry');
  });
  await caseReport('a stale load from B cannot replace the selected A form or its secrets', async () => {
    const gate = hold('getScenario', 'after'); await select('Synthetic B'); await until(() => gate.entered, 'stale B load entered');
    await select('A profile version 2'); gate.release(); await delay(100);
    const visible = await state(); assert.equal(visible.heading, 'A profile version 2'); assert.equal(visible.secret, 'A edited secret after submit'); assert.equal(visible.text, 'A next unsaved clue');
  });
  await caseReport('the fresh read after a stale save remains guarded if the user switches again', async () => {
    const saving = hold('addText'); await submit('text'); await until(() => saving.entered, 'save before fresh read entered');
    await select('Synthetic B'); await select('A profile version 2'); const reading = hold('getScenario', 'after'); saving.release();
    await until(() => reading.entered, 'fresh read entered'); await select('Synthetic B'); reading.release(); await delay(100);
    const visible = await state(); assert.equal(visible.heading, 'Synthetic B'); assert.equal(visible.text, 'B typed while loading'); assert.equal(visible.secret, 'B unsaved secret');
    await select('A profile version 2'); assert.equal((await state()).text, '');
  });
  await caseReport('automatic analysis receives the destination ID and only that scenario gets its submitted text', async () => {
    syntheticAutoUpdate = true; await command('Page.reload'); await until(() => evaluate("Boolean(document.querySelector('.topbar-title'))"), 'reloaded app');
    await until(() => evaluate("document.querySelector('.topbar-title')?.textContent === 'A profile version 2'"), 'A after reload');
    await evidence(); await note('A auto unsaved', 'A auto private draft'); await select('Synthetic B');
    assert.equal((await state()).text, ''); await note('B auto heading', 'B auto clue', 'shared'); await submit('text');
    await until(() => calls.some((call) => call.name === 'analyze' && call.args[0].id === b.id), 'mock B auto analysis');
    assert.equal((await saved(b.id)).evidence.length, 1); assert.equal((await saved(b.id)).evidence[0].extractedText, 'B auto clue');
    assert.equal((await saved(a.id)).evidence.some((entry) => entry.extractedText === 'A auto private draft'), false);
    await select('A profile version 2'); assert.equal((await state()).text, 'A auto private draft');
  });
  assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.qaErrors'), []);
  assert.equal(calls.filter((call) => call.name === 'addText').every((call) => !call.args[0].text.startsWith('A ') || call.args[0].id === a.id), true);
  const report = { passed: reports.length, reports, browserErrors: errors, data, root, calls };
  await fs.writeFile(path.join(qaDir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: reports.length, browserErrors: errors, data, report: path.join(qaDir, 'results.json') }));
}

verify().catch(async (error) => {
  console.error(error.stack);
  if (evaluate) { try { console.error('QA state ' + JSON.stringify(await state())); } catch {} }
  process.exitCode = 1;
}).finally(async () => {
  if (browserCommand) { try { await browserCommand('Browser.close'); } catch {} }
  if (socket) { socket.close(); }
  if (browser) browser.kill();
  if (browserLog) await browserLog.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
