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
const qaDir = path.join(root, '.local', 'evidence-intake-ui');
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
let nextChosenPaths = [];
const realRequire = createRequire(path.join(root, 'electron/main.cjs'));
const methods = {
  listScenarios: 'scenario:list', getScenario: 'scenario:get', getSettings: 'settings:get',
  createScenario: 'scenario:create', createDemo: 'scenario:create-demo', saveProfile: 'scenario:save-profile',
  addEvidence: 'scenario:add-evidence', chooseFiles: 'scenario:choose-files', releaseFiles: 'scenario:release-files', editEvidence: 'scenario:edit-evidence', setEvidenceEnabled: 'scenario:set-evidence-enabled', readSource: 'scenario:read-source', analyze: 'scenario:analyze', cancelAnalysis: 'scenario:cancel-analysis'
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
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: nextChosenPaths }), showMessageBox: async () => ({ response: 0 }) },
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

async function pasteImages(count = 1, text = '') {
  await evaluate('(() => { const canvas=document.createElement("canvas"); canvas.width=2; canvas.height=2; canvas.getContext("2d").fillRect(0,0,2,2); const bytes=Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]), c=>c.charCodeAt(0)); const data=new DataTransfer(); for(let i=0;i<' + count + ';i++) data.items.add(new File([bytes],"synthetic.png",{type:"image/png"})); if(' + JSON.stringify(text) + ') data.setData("text/plain",' + JSON.stringify(text) + '); document.querySelector(".add-note-panel").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true})); })()');
}
async function candidates() { return evaluate('Array.from(document.querySelectorAll(".intake-candidates li")).map(e=>({name:e.querySelector("strong").textContent,loading:e.textContent.includes("読込中")}))'); }
async function openItem(id) { await evaluate('document.getElementById("evidence-"+' + JSON.stringify(id) + ').querySelector(".evidence-toggle").click()'); }
async function editDetails(id) { await evaluate('document.getElementById("evidence-"+' + JSON.stringify(id) + ').querySelector(".evidence-edit").open=true'); }
async function verify() {
  syntheticAutoUpdate = true;
  const { a, b } = await boot();
  const fixtures = path.join(runDir, 'fixtures'); await fs.mkdir(fixtures, {recursive:true});
  const fileOne = path.join(fixtures, 'HO.md'); const fileTwo = path.join(fixtures, 'clue.txt');
  await fs.writeFile(fileOne, 'Role and goal are already in this synthetic HO.'); await fs.writeFile(fileTwo, 'A synthetic file clue.');
  await evidence();
  await caseReport('typing, multiple file selection and multiple image paste never save or analyze before explicit confirmation', async () => {
    await fill(selectors.text, 'A batch heading\nA original text');
    nextChosenPaths=[fileOne,fileTwo]; await evaluate('document.querySelector(".drop-zone").click()');
    await until(async()=> (await candidates()).length===2,'two selected files');
    await pasteImages(2); await until(async()=> (await candidates()).length===4 && !(await candidates()).some(e=>e.loading),'two pasted images');
    assert.equal((await saved(a.id)).evidence.length,0); assert.equal(count('analyze'),0); assert.equal(count('addEvidence'),0);
    await evaluate('document.querySelector(".add-note-panel textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))');
    await delay(50); assert.equal(count('addEvidence'),0);
    await evaluate('document.querySelector(".add-note-panel input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
    await delay(50); assert.equal(count('addEvidence'),0);
    const revision=(await saved(a.id)).revision;
    await evaluate('document.querySelector(".add-note-panel textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}))');
    await until(async()=> (await saved(a.id)).evidence.length===5 && count('analyze')===1,'one explicit batch');
    const record=await saved(a.id); assert.equal(record.revision,revision+1); assert.equal(record.evidence[0].title,'A batch heading'); assert.ok(record.evidence.every(e=>e.visibility==='unknown'));
    assert.equal(record.roleProfile.role,''); assert.equal(count('addEvidence'),1);
    await until(async()=> (await state()).text==='' && (await candidates()).length===0,'consumed batch draft');
  });
  await caseReport('file selection completed after a scenario switch belongs only to the initiating draft', async()=>{
    nextChosenPaths=[fileOne]; const gate=hold('chooseFiles','after'); await evaluate('document.querySelector(".drop-zone").click()'); await until(()=>gate.entered,'A chooser entered');
    await select('Synthetic B'); await fill(selectors.text,'B own draft'); gate.release(); await delay(100);
    assert.equal((await candidates()).length,0); assert.equal((await state()).text,'B own draft');
    await select('Synthetic A'); await until(async()=> (await candidates()).length===1,'A selected candidate'); assert.equal((await state()).text,'');
    await evaluate('document.querySelector(".intake-candidates button").click()'); await until(async()=> (await candidates()).length===0,'candidate removed');
  });
  await caseReport('asynchronous image reads remain in A after switching and removed loading images are never revived', async()=>{
    await evaluate('window.qaReaders=[]; window.qaNativeReader=window.FileReader; window.FileReader=class extends window.qaNativeReader { readAsDataURL(file) { window.qaReaders.push(()=>super.readAsDataURL(file)); } };');
    await pasteImages(); await until(async()=> (await candidates()).some(e=>e.loading),'A loading image'); assert.equal((await state()).textDisabled,true);
    await select('Synthetic B'); await evaluate('window.qaReaders.shift()()'); await delay(80); assert.equal((await candidates()).length,0);
    await select('Synthetic A'); await until(async()=> (await candidates()).length===1 && !(await candidates())[0].loading,'A image ready');
    await evaluate('document.querySelector(".intake-candidates button").click()'); await until(async()=> (await candidates()).length===0,'A image removed');
    await pasteImages(); await until(async()=> (await candidates()).length===1,'new loading image');
    await evaluate('document.querySelector(".intake-candidates button").click(); window.qaReaders.shift()(); window.FileReader=window.qaNativeReader;'); await delay(80);
    assert.equal((await candidates()).length,0); assert.equal((await saved(a.id)).evidence.length,5);
  });
  await caseReport('saving after A/B/A consumes only sent candidates and preserves newer text and images', async()=>{
    await fill(selectors.text,'A submitted batch'); await pasteImages(); await until(async()=> (await candidates()).length===1 && !(await candidates())[0].loading,'submitted image ready');
    const gate=hold('addEvidence'); const before=count('addEvidence'); await submit('text'); await until(()=>gate.entered,'batch save entered');
    await select('Synthetic B'); await select('Synthetic A'); await submit('text'); await delay(40); assert.equal(count('addEvidence'),before+1);
    await fill(selectors.text,'A later unsaved text'); await pasteImages(); await until(async()=> (await candidates()).length===2 && !(await candidates()).some(e=>e.loading),'later image ready');
    gate.release(); await until(async()=> (await saved(a.id)).evidence.length===7 && !(await state()).textDisabled,'batch saved');
    assert.equal((await state()).text,'A later unsaved text'); assert.equal((await candidates()).length,1);
    await select('Synthetic B'); assert.equal((await state()).text,'B own draft'); assert.equal((await candidates()).length,0);
    await select('Synthetic A'); assert.equal((await state()).text,'A later unsaved text');
  });
  await caseReport('failed saving keeps all staged input and can be retried without partial registration', async()=>{
    const gate=hold('addEvidence','before',true); await submit('text'); await until(()=>gate.entered,'failure entered');
    await select('Synthetic B'); gate.release(); await delay(80); assert.equal((await state()).error,'');
    await select('Synthetic A'); assert.equal((await state()).text,'A later unsaved text'); assert.equal((await candidates()).length,1);
    assert.equal((await saved(a.id)).evidence.length,7); await submit('text'); await until(async()=> (await saved(a.id)).evidence.length===9 && (await candidates()).length===0,'retry saved');
  });
  await caseReport('oversize candidates are removable without losing valid candidates or typed text', async()=>{
    const oversized=path.join(fixtures,'too-large.png'); await fs.writeFile(oversized,Buffer.alloc(20*1024*1024+1));
    nextChosenPaths=[fileTwo,oversized]; await fill(selectors.text,'A preserved for recovery'); await evaluate('document.querySelector(".drop-zone").click()');
    await until(async()=> (await candidates()).length===2,'oversized candidate visible'); assert.equal((await state()).textDisabled,true);
    assert.equal((await saved(a.id)).evidence.length,9);
    await evaluate('document.querySelectorAll(".intake-candidates button")[1].click()'); await until(async()=> !(await state()).textDisabled,'valid batch enabled');
    assert.equal((await state()).text,'A preserved for recovery'); await submit('text'); await until(async()=> (await saved(a.id)).evidence.length===11,'same-scenario recovery');
  });
  await caseReport('body/title edits survive switching and retain later edits made while saving', async()=>{
    const item=(await saved(a.id)).evidence[0]; await openItem(item.id); await editDetails(item.id);
    const editor='#evidence-'+item.id+' .evidence-edit';
    await fill(editor+' input','A edited source name'); await fill(editor+' textarea','A edited body');
    await select('Synthetic B'); await select('Synthetic A'); await openItem(item.id); await editDetails(item.id);
    assert.equal(await evaluate('document.querySelector('+JSON.stringify(editor+' textarea')+').value'),'A edited body');
    const gate=hold('editEvidence'); await evaluate('document.querySelector('+JSON.stringify(editor+' form')+').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))'); await until(()=>gate.entered,'edit saved entered');
    await select('Synthetic B'); await select('Synthetic A'); await openItem(item.id); await editDetails(item.id); await fill(editor+' textarea','A later edit draft'); gate.release();
    await until(async()=> (await saved(a.id)).evidence[0].editedText==='A edited body','edit saved');
    await until(()=> evaluate('!document.querySelector('+JSON.stringify(editor+' button[type=submit]')+').disabled'),'edit unlocked');
    assert.equal(await evaluate('document.querySelector('+JSON.stringify(editor+' textarea')+').value'),'A later edit draft');
    assert.equal((await saved(a.id)).evidence[0].extractedText,'A batch heading\nA original text');
    await evaluate('document.querySelector('+JSON.stringify(editor+' form')+').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
    await until(async()=> (await saved(a.id)).evidence[0].editedText==='A later edit draft','later edit saved');
  });
  await caseReport('exclude and restore remain ordinary detail actions and retain originals and visible edited content', async()=>{
    const image=(await saved(a.id)).evidence.find(e=>e.kind==='image'); await openItem(image.id);
    await evaluate('document.getElementById("evidence-"+'+JSON.stringify(image.id)+').querySelector(".evidence-enabled").click()');
    await until(async()=> (await saved(a.id)).evidence.find(e=>e.id===image.id).analysisEnabled===false,'excluded');
    assert.ok(await fs.stat(path.join(data,'cases',a.id,image.attachmentPath)));
    assert.equal(await evaluate('document.getElementById("evidence-"+'+JSON.stringify(image.id)+').textContent.includes("解析対象外")'),true);
    await evaluate('document.getElementById("evidence-"+'+JSON.stringify(image.id)+').querySelector(".evidence-enabled").click()');
    await until(async()=> (await saved(a.id)).evidence.find(e=>e.id===image.id).analysisEnabled===true,'restored');
    assert.ok(await fs.stat(path.join(data,'cases',a.id,image.attachmentPath)));
  });
  assert.deepEqual(errors,[]); assert.deepEqual(await evaluate('window.qaErrors'),[]);
  assert.equal(calls.filter(call=>call.name==='addEvidence').every(call=>call.args[0].id===a.id),true);
  await fs.mkdir(qaDir,{recursive:true}); const reportPath=path.join(qaDir,'results.json');
  await fs.writeFile(reportPath,JSON.stringify({passed:reports.length,reports,browserErrors:errors,data,root,calls},null,2));
  console.log(JSON.stringify({passed:reports.length,browserErrors:errors,report:reportPath}));
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
