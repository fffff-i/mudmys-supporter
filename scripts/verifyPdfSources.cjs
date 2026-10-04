const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { pdfFixture, imageFixture } = require('../test-support/pdfFixtures.cjs');

// Run after npm run build. As in verifyScenarioDrafts.cjs, use only a dedicated
// headless browser profile and synthetic IPC data. Never start Electron or AI.
const root = path.resolve(__dirname, '..');
const qaDir = path.join(root, '.local', 'pdf-sources-ui');
const runDir = path.join(qaDir, 'run-' + Date.now());
const data = path.join(runDir, 'synthetic-data');
const browserProfile = path.join(runDir, 'headless-profile');
const handlers = new Map();
const calls = [];
const gates = [];
const reports = [];
const errors = [];
const methods = { listScenarios: 'scenario:list', getScenario: 'scenario:get', getSettings: 'settings:get', readSource: 'scenario:read-source' };
let browser, server, socket, evaluate, browserCommand, browserLog;
let importFiles = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw new Error('Timed out: ' + label);
}
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
const invoke = (name, ...args) => handlers.get(name)({}, ...args);
function holdRead(fail = false) {
  let release;
  const gate = { fail, entered: false, completed: false, wait: new Promise((resolve) => { release = resolve; }), release };
  gates.push(gate);
  return gate;
}
function analysis(revision, overview, events = [], sources = []) {
  return { revision, inputRevision: revision, updatedAt: new Date().toISOString(), provider: 'synthetic-only', overview,
    flow: [], events, facts: [], hypotheses: [], unknowns: [], actions: [], sources };
}
function event(sourceId, page, quote, verification = 'text_matched') {
  return { timeText: '', people: [], what: quote, type: 'recorded', sourceId, page: String(page), quote, ambiguity: '', quoteVerification: verification };
}
async function syntheticData() {
  await fs.mkdir(data, { recursive: true });
  const realRequire = createRequire(path.join(root, 'electron/main.cjs'));
  const forbid = () => { throw new Error('Native GUI and actual AI are forbidden in this verification'); };
  const stub = {
    app: { setName() {}, getPath: () => data, whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: forbid, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: importFiles }), showMessageBox: forbid },
    safeStorage: { isEncryptionAvailable: () => false }, shell: { openPath: forbid }
  };
  vm.runInNewContext(await fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8'), {
    require: (name) => name === 'electron' ? stub : name === 'openai' ? { default: class { constructor() { forbid(); } } } : realRequire(name),
    module: { exports: {} }, __dirname: path.join(root, 'electron'), process, Buffer, URL,
    AbortController, AbortSignal, setTimeout, clearTimeout, fetch: forbid
  }, { filename: path.join(root, 'electron/main.cjs') });
  const b = await invoke('scenario:create', 'Synthetic PDF B');
  const a = await invoke('scenario:create', 'Synthetic PDF A');
  const originals = [
    ['mixed.pdf', pdfFixture()], ['picture.jpg', imageFixture()],
    ['corrupt.pdf', Buffer.from('%PDF-corrupt synthetic fixture')],
    ['oversized-page.pdf', pdfFixture([{ text: 'large page text', width: 100000, height: 100000 }])]
  ];
  for (const [name, bytes] of originals) await fs.writeFile(path.join(runDir, name), bytes);
  importFiles = originals.map(([name]) => path.join(runDir, name));
  const imported = (await invoke('scenario:add-files', a.id)).scenario;
  const [mixed, picture, corrupt, oversized] = imported.evidence;
  const legacy = { ...mixed, id: randomUUID(), title: 'legacy.pdf', extractedText: '[p.1] 08:10 returned key', extractionMessage: '旧形式の保存本文' };
  for (const key of ['pdfMetadataVersion', 'pdfPages', 'pdfPageCount']) delete legacy[key];
  const missing = { ...legacy, id: randomUUID(), title: 'missing.pdf', attachmentPath: 'attachments/missing.pdf', extractedText: 'saved missing original text' };
  const snapshots = ['older', 'newer'].map((marker, index) => analysis(index + 1, marker + ' local history', [
    event(mixed.id, 2, '09:00 hidden room unlocked', 'image_unverified')
  ], [
    { id: 'scenario:role-profile', title: '役プロフィール', kind: 'text', extractedText: marker + ' profile snapshot', visibility: 'private' },
    { id: 'scenario:synopsis', title: 'シナリオ概要', kind: 'text', extractedText: marker + ' synopsis snapshot', visibility: 'shared' }
  ]));
  for (const snapshot of snapshots) snapshot.facts = snapshot.sources.map(source => ({ statement: source.extractedText, evidenceIds: [source.id] }));
  // Current role information differs from both retained OFF-scope snapshots.
  const current = { ...imported, synopsis: 'CURRENT synopsis', roleProfile: { role: 'CURRENT role', goal: 'CURRENT goal', secret: 'CURRENT secret' },
    evidence: [...imported.evidence, legacy, missing], analysis: analysis(3, 'synthetic overview', [
      event(mixed.id, 1, '08:10 returned key'), event(mixed.id, 2, '09:00 hidden room unlocked', 'image_unverified'),
      event(mixed.id, 3, '10:30 lantern on', 'image_unverified')
    ]), analysisHistory: snapshots };
  await fs.writeFile(path.join(data, 'cases', a.id, 'case.json'), JSON.stringify(current));
  await fs.writeFile(path.join(data, 'cases', b.id, 'case.json'), JSON.stringify({ ...b, updatedAt: '2000-01-01T00:00:00.000Z' }));
  return { a: current, b, mixed, picture, corrupt, oversized, legacy, missing, originals };
}
async function boot() {
  const executable = await findBrowser();
  await fs.access(path.join(root, 'dist', 'index.html'));
  const fixtures = await syntheticData();
  const bridge = `window.qaErrors = []; window.addEventListener('error', e => window.qaErrors.push(e.message));
    window.makua = Object.fromEntries(${JSON.stringify(Object.keys(methods))}.map(name => [name, async (...args) => {
      const res = await fetch('/qa-ipc', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({name,args}) });
      const result = await res.json(); if(result.error) throw new Error(result.error); return result.value;
    }]));`;
  server = http.createServer(async (request, response) => {
    let gate;
    try {
      if (request.url === '/qa-ipc' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        const { name, args } = JSON.parse(body);
        assert.ok(methods[name], 'Only read-only QA methods are allowed');
        calls.push({ name, args });
        if (name === 'readSource') { gate = gates.shift(); if (gate) gate.entered = true; }
        const value = await invoke(methods[name], ...args);
        if (gate) { await gate.wait; if (gate.fail) throw new Error('Synthetic delayed read failure'); }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ value })); return;
      }
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      const filename = new URL(request.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
      const resolved = path.resolve(root, 'dist', filename);
      assert.ok(resolved.startsWith(path.join(root, 'dist') + path.sep));
      let body = await fs.readFile(resolved);
      if (filename === 'index.html') body = Buffer.from(body.toString().replace('<head>', '<head><script>' + bridge + '</script>'));
      response.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
      response.end(body);
    } catch (error) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
    finally { if (gate) gate.completed = true; }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fs.mkdir(browserProfile, { recursive: true });
  browserLog = await fs.open(path.join(runDir, 'headless-stderr.txt'), 'w');
  browser = spawn(executable, [
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
  socket.addEventListener('message', ({ data: messageData }) => {
    const message = JSON.parse(messageData);
    if (message.id && pending.has(message.id)) { const promise = pending.get(message.id); pending.delete(message.id); message.error ? promise.reject(new Error(message.error.message)) : promise.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  browserCommand = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timed out: ' + method)); }, 5000);
    pending.set(id, { resolve: (result) => { clearTimeout(timeout); resolve(result); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const result = await browserCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await browserCommand('Runtime.enable'); await browserCommand('Page.enable');
  await browserCommand('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(() => evaluate("document.querySelector('.topbar-title')?.textContent === 'Synthetic PDF A'"), 'initial scenario');
  return fixtures;
}
async function state() {
  return evaluate(`(() => { const panel = document.querySelector('.source-panel'); const image = panel?.querySelector('img'); return {
    heading:document.querySelector('.topbar-title')?.textContent, navigation:document.querySelector('.side-nav-item.selected')?.textContent,
    panel:Boolean(panel), title:panel?.querySelector('h2')?.textContent, page:panel?.querySelector('input')?.value,
    image:image?.alt || '', imageWidth:image?.naturalWidth || 0, text:panel?.querySelector('.raw-source')?.textContent || '',
    extraction:panel?.querySelector('.source-page-state')?.textContent || '', verification:panel?.querySelector('.source-verification')?.textContent || '',
    alert:panel?.querySelector('[role=alert]')?.textContent || '', body:panel?.textContent || '', loading:Boolean(panel?.querySelector('[role=status]'))
  }; })()`);
}
const click = (selector) => evaluate(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item) throw new Error('Missing ' + ${JSON.stringify(selector)}); item.click(); })()`);
const citation = (index) => click(`.event-row:nth-of-type(${index + 1}) .citation-chip`);
async function readyPage(number) { await until(async () => { const s = await state(); return s.page === String(number) && !s.loading && s.imageWidth > 0; }, 'page ' + number); }
async function close() { await click('.source-panel [aria-label="原本を閉じる"]'); await until(async () => !(await state()).panel, 'closed source'); }
async function navigate(index) { await evaluate(`document.querySelectorAll('.side-nav-item')[${index}].click()`); await delay(35); }
async function select(title) {
  await evaluate(`Array.from(document.querySelectorAll('.scenario-switch')).find(e => e.querySelector('.scenario-title').textContent === ${JSON.stringify(title)}).click()`);
  await until(async () => (await state()).heading === title, 'selected ' + title);
}
async function card(item) { await click('#evidence-' + item.id + ' .evidence-source-open'); await until(async () => (await state()).panel && !(await state()).loading, item.title); }
async function jump(number) {
  await evaluate(`(() => { const input = document.querySelector('.source-panel input'); input.value = ${JSON.stringify(String(number))}; input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true})); })()`);
}
async function caseReport(name, body) { await body(); reports.push({ name, passed: true }); console.log('PASS ' + name); }
async function verify() {
  const f = await boot();
  await caseReport('a text citation opens the correct PDF page on the same overview', async () => {
    await citation(0); await readyPage(1); const s = await state();
    assert.equal(s.heading, f.a.title); assert.match(s.navigation, /現在地/);
    assert.equal(s.text, '08:10 returned key'); assert.match(s.verification, /テキスト照合済み/);
    assert.match(s.body, /\/ 5/); assert.match(s.extraction, /本文抽出あり/); await close();
  });
  await caseReport('scan and mixed-page image citations keep the unverified label and real page image', async () => {
    await citation(1); await readyPage(2); let s = await state();
    assert.match(s.verification, /画像読取・引用未照合/); assert.match(s.extraction, /本文抽出なし・画像あり/); assert.equal(s.text, '');
    await citation(2); await readyPage(3); s = await state();
    assert.match(s.verification, /画像読取・引用未照合/); assert.equal(s.text, '10:00 courtyard closed'); assert.match(s.extraction, /本文抽出あり・画像あり/);
  });
  await caseReport('page navigation handles blank pages, short text and both end controls', async () => {
    await click('.source-page-controls button:last-child'); await readyPage(4); assert.match((await state()).extraction, /本文抽出なし/);
    await click('.source-page-controls button:last-child'); await readyPage(5); assert.equal((await state()).text, 'A');
    assert.equal(await evaluate("document.querySelector('.source-page-controls button:last-child').disabled"), true);
    await jump(1); await readyPage(1); assert.equal(await evaluate("document.querySelector('.source-page-controls button:first-child').disabled"), true);
    await click('.source-page-controls button:last-child'); await readyPage(2);
    await click('.source-page-controls button:first-child'); await readyPage(1);
  });
  await caseReport('invalid and nonexistent page requests show an error without another page image', async () => {
    await jump(99); await until(async () => Boolean((await state()).alert), 'missing page error'); let s = await state();
    assert.match(s.alert, /指定したPDFページ/); assert.equal(s.image, ''); assert.equal(s.text, '');
    await jump(0); await until(async () => /ページ番号が不正/.test((await state()).alert), 'invalid page error');
    await jump(3); await readyPage(3);
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await until(async () => !(await state()).panel, 'Escape closes viewer');
  });
  await caseReport('evidence cards expose per-page states and open a PDF page or saved image', async () => {
    await navigate(1); await until(() => evaluate("Boolean(document.querySelector('.evidence-cards'))"), 'evidence cards');
    assert.match(await evaluate(`document.querySelector('#evidence-${f.mixed.id} .pdf-page-states').textContent`), /p\.5/);
    await click('#evidence-' + f.mixed.id + ' .pdf-page-states li:nth-child(3) button'); await readyPage(3); await close();
    await card(f.picture); await until(async () => (await state()).imageWidth > 0, 'standalone original image');
    assert.match((await state()).image, /picture.jpg 原本/); await close();
  });
  await caseReport('legacy PDF records gain per-page viewing without changing the saved record', async () => {
    await card(f.legacy); await readyPage(1); assert.equal((await state()).text, '08:10 returned key');
    await jump(3); await readyPage(3); assert.equal((await state()).text, '10:00 courtyard closed'); await close();
    assert.equal((await invoke('scenario:get', f.a.id)).evidence.find(e => e.id === f.legacy.id).pdfPages, undefined);
  });
  await caseReport('missing originals preserve old text and explain the display failure', async () => {
    await card(f.missing); const s = await state(); assert.match(s.alert, /原本を読み取れません/);
    assert.equal(s.image, ''); assert.equal(s.text, 'saved missing original text'); await close();
  });
  await caseReport('unreadable PDFs show an unknown page count and retain the original', async () => {
    await card(f.corrupt); const s = await state(); assert.match(s.body, /ページ数は不明/); assert.match(s.body, /\/ 不明/);
    assert.match(s.alert, /表示できません/); assert.equal(s.image, ''); assert.doesNotMatch(s.body, /分割|OCR/); await close();
  });
  await caseReport('page render ceilings explain the stop and keep available page text', async () => {
    await card(f.oversized); const s = await state(); assert.match(s.alert, /画像化上限/); assert.match(s.alert, /原本は保持/);
    assert.equal(s.image, ''); assert.equal(s.text, 'large page text'); assert.doesNotMatch(s.body, /分割|OCR/); await close();
  });
  await navigate(0);
  await caseReport('a delayed old page response cannot replace a newer PDF citation', async () => {
    const gate = holdRead(); await citation(1); await until(() => gate.entered, 'delayed page read entered');
    await citation(2); await readyPage(3); gate.release(); await until(() => gate.completed, 'delayed page read completed'); await delay(80);
    assert.equal((await state()).page, '3'); assert.equal((await state()).text, '10:00 courtyard closed'); await close();
  });
  await caseReport('closing a pending source keeps it closed after its response arrives', async () => {
    const gate = holdRead(); await citation(1); await until(() => gate.entered, 'pending close entered'); await close();
    gate.release(); await until(() => gate.completed, 'pending close completed'); await delay(80); assert.equal((await state()).panel, false);
  });
  await caseReport('switching scenarios ignores an earlier source error and closes the viewer', async () => {
    const gate = holdRead(true); await citation(1); await until(() => gate.entered, 'pending switch entered');
    await select(f.b.title); gate.release(); await until(() => gate.completed, 'pending switch completed'); await delay(80);
    assert.equal((await state()).panel, false); assert.equal((await state()).heading, f.b.title);
    assert.equal(await evaluate("Boolean(document.querySelector('.toast-error'))"), false); await select(f.a.title);
  });
  await caseReport('past citations use their own profile and synopsis snapshots while role information is OFF', async () => {
    await navigate(3); await until(() => evaluate("document.querySelectorAll('.previous-analysis').length === 2"), 'local past analyses');
    for (const [index, marker] of ['newer', 'older'].entries()) {
      await evaluate(`document.querySelectorAll('.previous-analysis')[${index}].open = true`);
      for (const [id, expected] of [['scenario:role-profile', marker + ' profile snapshot'], ['scenario:synopsis', marker + ' synopsis snapshot']]) {
        // Add source citations through the real saved fact display, never a test-only React UI.
        await evaluate(`document.querySelectorAll('.previous-analysis')[${index}].querySelectorAll('.citation-chip')[${id === 'scenario:role-profile' ? 1 : 2}].click()`);
        await until(async () => (await state()).text === expected, 'historical ' + id);
        assert.doesNotMatch((await state()).text, /CURRENT/); await close();
      }
      await evaluate(`document.querySelectorAll('.previous-analysis')[${index}].querySelector('.citation-chip').click()`);
      await readyPage(2); assert.match((await state()).verification, /画像読取・引用未照合/); await close();
    }
  });
  assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.qaErrors'), []);
  const saved = await invoke('scenario:get', f.a.id);
  assert.equal(saved.roleProfile.secret, 'CURRENT secret'); assert.equal(saved.analysisHistory.length, 2);
  for (const [name, bytes] of f.originals) {
    const item = saved.evidence.find(e => e.title === name);
    assert.deepEqual(await fs.readFile(path.join(data, 'cases', f.a.id, item.attachmentPath)), bytes);
  }
  const reportPath = path.join(qaDir, 'results.json');
  await fs.writeFile(reportPath, JSON.stringify({ passed: reports.length, reports, browserErrors: errors, data, root, calls }, null, 2));
  console.log(JSON.stringify({ passed: reports.length, browserErrors: errors, report: reportPath }));
}
verify().catch(async (error) => {
  console.error(error.stack); if (evaluate) { try { console.error('QA state ' + JSON.stringify(await state())); } catch {} }
  process.exitCode = 1;
}).finally(async () => {
  for (const gate of gates) gate.release();
  if (browserCommand) { try { await browserCommand('Browser.close'); } catch {} }
  if (socket) socket.close();
  if (browser) browser.kill(); // Only this script's own child process.
  if (browserLog) await browserLog.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
