const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { evidenceHarness } = require('./evidenceHarness.cjs');
const { getAnalysisContext } = require('../shared/analysisScope.cjs');

const root = path.resolve(__dirname, '..');
const qaDir = path.join(root, '.local', 'play-screen-ui');
const runDir = path.join(qaDir, 'run-' + Date.now());
const browserProfile = path.join(runDir, 'headless-profile');
const cleanups = [], gateReleases = [], reports = [], errors = [], calls = [], responseGates = [], saveGates = [];
let fixtureData;
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

async function richFixture(h) {
  const { pdfFixture } = require('../test-support/pdfFixtures.cjs');
  const b = await h.invoke('scenario:create', 'Synthetic B');
  await h.store({ ...b, updatedAt: '2000-01-01T00:00:00Z' });
  let a = await h.invoke('scenario:create', 'Synthetic A');
  const pdfPath = await h.fixture('synthetic-pages.pdf', pdfFixture());
  h.controls.paths = [pdfPath];
  a = (await h.invoke('scenario:add-files', a.id)).scenario;
  a = await h.invoke('scenario:add-text', { id: a.id, title: '証言の原文', text: '8時10分に戻ったと発言した。', visibility: 'shared' });
  const pdf = a.evidence[0], note = a.evidence[1];
  const fixed = { id: 'scenario:role-profile', kind: 'text', title: '保存時の役プロフィール', visibility: 'private', extractedText: 'SAVED_ROLE_SNAPSHOT 目的: 展示を守る' };
  const synopsis = { id: 'scenario:synopsis', kind: 'text', title: '保存時の概要', visibility: 'unknown', extractedText: 'SAVED_SYNOPSIS_SNAPSHOT' };
  const grounding = { version: 1, includeRoleProfile: false, previousContextMayIncludeRoleProfile: false,
    evidenceIds: [pdf.id, note.id], inputRevision: a.revision };
  const actions = Array.from({ length: 6 }, (_, i) => ({
    id: require('node:crypto').randomUUID(), title: '行動' + (i + 1) + '・' + (i === 0 ? '証言の時刻を個別に確かめる' : '記録' + (i + 1) + 'の意味を聞く'),
    who: '架空の証言者' + (i + 1),
    step: '話せる場所で相手に確認し、記録を見た時刻を聞く。覚えていれば前後の出来事も確認する。' + (i === 0 ? '説明が長い場合は一つずつ聞き、得た回答を任意のメモへ残せる。' : ''),
    suggestedLine: '「記録を見たのは何時ごろだったか、覚えている範囲で教えてもらえますか？」',
    purpose: 'PURPOSE_DETAIL_' + i, secretRisk: '自分の鍵を借りた話は先に出さず、公開済みの時刻だけを確認する。',
    rationale: 'REASON_DETAIL_' + i + ' 証言の前後関係を確認するため。', priority: Math.min(i + 1, 5),
    evidenceIds: i === 5 ? [] : [note.id], assumptions: i === 0 ? ['別の出入口があるなら'] : [],
    rechecks: i === 0 ? [{ actionId: 'old-conditional', previousPremise: '証言者が退場していた', currentPremise: '戻っているなら', reason: '在席を確かめてから聞き直せる' }] : [],
    sourceSnapshots: [note], grounding, createdAt: '2026-10-01T01:00:00Z', status: 'active'
  }));
  const facts = Array.from({ length: 5 }, (_, i) => ({ statement: '確認できる事実' + (i + 1) + '：資料には時刻を述べた発言が記録されている。発言内容の真偽は別に確認する。', evidenceIds: [note.id] }));
  facts.push({ statement: '保存当時の役の目的', evidenceIds: [fixed.id] });
  const legacy = [
    { statement: 'EMPTY_LEGACY 未確認の鍵があるという古い記述', evidenceIds: [] },
    { statement: 'MISSING_LEGACY 未登録の資料を指す古い記述', evidenceIds: ['missing-source'] },
    { statement: 'TYPE_LEGACY 配列以外の出典で保存された記述', evidenceIds: note.id },
    { statement: 'MIXED_LEGACY 有効な出典と不明な値が混在する記述', evidenceIds: [note.id, 7] },
    { statement: 'FIXED_MISSING_LEGACY 別の固定出典は保存されていない', evidenceIds: ['scenario:missing-fixed'] }
  ];
  const analysis = { revision: a.revision, inputRevision: a.revision, updatedAt: '2026-10-01T01:00:00Z', provider: '架空モック',
    overview: '証言にある時刻と、資料の記録を比べられる状態です。誰が記録を見たかを確かめると、次の問いを絞れます。',
    flow: Array.from({ length: 4 }, (_, i) => ({ moment: '場面' + (i + 1), summary: '資料を確認して会話を進める。', evidenceIds: [note.id] })),
    events: Array.from({ length: 8 }, (_, i) => ({ timeText: '時刻' + (i + 1), people: ['架空の証言者'], what: '出来事' + (i + 1) + '：記録を確認したという発言。別の場所を通った可能性は未確認のまま扱う。',
      type: 'statement', sourceId: pdf.id, page: i === 0 ? '3' : '2', quote: i === 0 ? '10:30 lantern on' : '09:00 hidden room unlocked', ambiguity: '', quoteVerification: 'image_unverified' })),
    facts: [...facts, ...legacy],
    hypotheses: Array.from({ length: 6 }, (_, i) => ({ statement: '仮説' + (i + 1) + '：別の経路があるなら証言と両立するかもしれない。', why: '確かめる余地がある。', evidenceIds: [], assumptions: ['別の経路が存在するなら'] })),
    unknowns: Array.from({ length: 5 }, (_, i) => ({ question: '問い' + (i + 1) + '：記録は誰が確認したか。', why: '本人に確認できる。', evidenceIds: [] })),
    actions, sources: [...a.evidence, fixed, synopsis], grounding
  };
  const old = structuredClone(analysis);
  old.overview = 'OLDER_ANALYSIS_BODY 保存された以前の整理結果';
  old.sources.find((item) => item.id === fixed.id).extractedText = 'OLDER_ROLE_SNAPSHOT';
  const original = { ...a, analysis, analysisHistory: [old], actionHistory: [], roleProfile: { role: '', goal: '', secret: '' } };
  await h.store(original, 'ollama', false);
  return { a: original, b, pdf, note, fixed, legacy };
}

async function boot() {
  const executable = await browserPath();
  await fs.access(path.join(root, 'dist', 'index.html'));
  h = await evidenceHarness({ after: (fn) => cleanups.push(fn) });
  fixtureData = await richFixture(h);
  const { a, b } = fixtureData;
  subjects.set('QA_CASE_A', a.id); subjects.set('QA_CASE_B', b.id);
  await h.invoke('settings:save', { provider: 'ollama', ollamaModel: 'mock-model', cloudConsent: true, codexConsent: true, autoUpdate: false, includeRoleProfile: false, effort: 'low' });
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
  return fixtureData;
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


const screenshots = [], layouts = [];
async function main() { await nav(0); await until(() => evaluate('Boolean(document.querySelector(".play-page .add-note-panel"))'), 'shared main intake'); }
async function selectPlay(name) { await select(name); await main(); }
async function click(selector) { await evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); await delay(35); }
async function visible(selector) { return evaluate('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');return Boolean(e&&!e.closest("details:not([open])")&&e.checkVisibility());})()'); }
async function savedCount(id, value) { await until(async () => (await saved(id)).evidence.length === value, 'saved count ' + value); }
async function paste() {
  await evaluate('(()=>{const canvas=document.createElement("canvas");canvas.width=3;canvas.height=3;canvas.getContext("2d").fillRect(0,0,3,3);const bytes=Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],"synthetic.png",{type:"image/png"}));document.querySelector(".add-note-panel").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));})()');
  await until(() => evaluate('document.querySelectorAll(".intake-candidates li").length>0&&!document.querySelector(".intake-candidates").textContent.includes("読込中")'), 'synthetic paste ready');
}
async function snap(width, height, name, target = '') {
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.fonts.ready');
  await evaluate(target ? 'document.querySelector(' + JSON.stringify(target) + ').scrollIntoView({block:"start"})' : 'document.querySelector(".main-content").scrollTop=0');
  await delay(180);
  const layout = await evaluate('(()=>{const m=document.querySelector(".main-content"),p=document.querySelector(".source-panel");const b=p?.getBoundingClientRect();return{viewport:[innerWidth,innerHeight],mainHorizontalOverflow:m.scrollWidth-m.clientWidth,panel:b?{left:b.left,right:b.right,top:b.top,bottom:b.bottom}:null};})()');
  assert.ok(layout.mainHorizontalOverflow <= 1, 'main screen fits the viewport');
  if (layout.panel) assert.ok(layout.panel.left >= 0 && layout.panel.right <= width && layout.panel.top >= 0 && layout.panel.bottom <= height, 'source panel stays inside viewport');
  layouts.push({ name, ...layout });
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const filename = path.join(runDir, name + '.png');
  await fs.writeFile(filename, Buffer.from(result.data, 'base64'));
  screenshots.push(filename);
}
async function closeSource() { if (await evaluate('Boolean(document.querySelector(".source-panel"))')) await click('.source-panel-head button'); }

async function verify() {
  const f = await boot(), { a, b, note } = f;
  await fs.writeFile(path.join(runDir, 'original-case.json'), JSON.stringify(a, null, 2));
  await check('main screen combines current situation, actions and the single shared intake without requiring role input', async () => {
    assert.equal(await evaluate('document.querySelectorAll(".add-note-panel").length'), 1);
    for (const selector of ['.situation-panel', '#play-actions', '#play-intake', '#play-results']) assert.ok(await evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))'));
    assert.equal(await evaluate('document.querySelectorAll(".play-page input[required],.play-page textarea[required]").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll(".play-page .profile-panel").length'), 0);
    assert.equal(count(), 0);
  });
  await check('each result category opens independently and exposes every sixth event and fourth classified item', async () => {
    const labels = ['出来事', '資料にある事実', '仮説・読み取り', 'まだ未確認', '未確認の旧解析記述', '次の行動'];
    const expected = [3, 3, 3, 2, 2, 3];
    for (let i = 0; i < labels.length; i++) {
      const selector = '.list-more[data-list="' + labels[i] + '"]';
      assert.match(await evaluate('document.querySelector(' + JSON.stringify(selector + ' summary') + ').textContent'), new RegExp('残り' + expected[i] + '件'));
      assert.equal(await evaluate('document.querySelectorAll(".list-more[open]").length'), i);
      await click(selector + ' summary');
      assert.equal(await evaluate('document.querySelectorAll(".list-more[open]").length'), i + 1);
    }
    assert.equal(await evaluate('document.querySelectorAll(".event-row").length'), 8);
    assert.equal(await evaluate('document.querySelectorAll(".play-page [data-fact-status=confirmed]").length'), 6);
    assert.equal(await evaluate('document.querySelectorAll(".play-page .action-card").length'), 6);
    assert.equal(await evaluate('document.querySelector(".side-nav-item.selected").textContent.includes("プレイ")'), true);
  });
  await check('action target, steps, conditions, example speech, care and recheck reasons are visible before detailed reasoning', async () => {
    const prefix = '.play-page .action-card:first-child ';
    for (const selector of ['.action-step', '.assumption-note', '.action-suggested-line', '.action-care', '.action-rechecks', '.action-source-scope']) assert.equal(await visible(prefix + selector), true, selector);
    assert.equal(await visible(prefix + '.action-details .detail-cell'), false);
    assert.equal(await visible(prefix + '.action-details .citation-chip'), false);
    await click(prefix + '.action-details summary');
    assert.equal(await visible(prefix + '.action-details .detail-cell'), true);
    assert.equal(await visible(prefix + '.action-details .citation-chip'), true);
    await click(prefix + '.action-details summary');
  });
  await check('legacy empty, missing and malformed source arrays appear separately as unconfirmed and remain untouched', async () => {
    assert.equal(await evaluate('document.querySelectorAll(".play-page [data-fact-status=unconfirmed]").length'), 5);
    const text = await evaluate('document.querySelector(".play-page .signal-fact").textContent');
    assert.doesNotMatch(text, /EMPTY_LEGACY|MISSING_LEGACY|TYPE_LEGACY|MIXED_LEGACY|FIXED_MISSING_LEGACY/);
    assert.match(await evaluate('document.querySelector(".unconfirmed-facts").textContent'), /保存された出典情報を読み取れません/);
    assert.equal(await evaluate('document.querySelectorAll(".unconfirmed-facts .citation-missing,.legacy-fact-refs").length'), 0);
    assert.equal(JSON.stringify((await saved(a.id)).analysis.facts), JSON.stringify(a.analysis.facts));
  });
  await check('all expanded lists and long action cards fit desktop and minimum window sizes', async () => {
    await snap(1420, 920, 'desktop-play');
    await snap(1100, 720, 'minimum-play');
    await snap(1420, 920, 'desktop-results', '#play-results');
    await snap(1100, 720, 'minimum-results', '#play-results');
  });
  await check('event citations open the exact mixed PDF image page inside the main screen and preserve expanded lists', async () => {
    await click('.play-page .event-row:first-child .citation-chip');
    await until(() => evaluate('Boolean(document.querySelector(".source-original img"))'), 'PDF page image');
    assert.equal(await evaluate('document.querySelector(".source-page-controls input").value'), '3');
    assert.match(await evaluate('document.querySelector(".source-verification").textContent'), /画像読取・引用未照合/);
    assert.equal(await evaluate('document.querySelectorAll(".list-more[open]").length'), 6);
    await snap(1420, 920, 'desktop-original');
    await snap(1100, 720, 'minimum-original');
    await click('.source-page-controls button:last-child');
    await until(() => evaluate('document.querySelector(".source-page-controls input").value==="4"'), 'next page');
    await closeSource();
    assert.equal(await evaluate('document.querySelectorAll(".list-more[open]").length'), 6);
  });
  await check('historical facts use the same classifier and their own saved fixed-source contents', async () => {
    await nav(3); await click('.previous-analysis > summary');
    assert.equal(await evaluate('document.querySelectorAll(".previous-analysis [data-fact-status=confirmed]").length'), 6);
    assert.equal(await evaluate('document.querySelectorAll(".previous-analysis [data-fact-status=unconfirmed]").length'), 5);
    await evaluate('(()=>{const buttons=Array.from(document.querySelectorAll(".previous-analysis .signal-fact .citation-chip"));buttons.find(b=>b.textContent.includes("役プロフィール")).click();})()');
    await until(() => evaluate('document.querySelector(".source-panel")?.textContent.includes("OLDER_ROLE_SNAPSHOT")'), 'old role snapshot');
    assert.doesNotMatch(await evaluate('document.querySelector(".source-panel").textContent'), /SAVED_ROLE_SNAPSHOT/);
    assert.equal(calls.filter(c => c.name === 'readSource').at(-1).args[0].analysisIndex, 0);
    await closeSource();
    assert.equal(JSON.stringify((await saved(a.id)).analysisHistory), JSON.stringify(a.analysisHistory));
    await main();
  });
  await check('main and material pages share one draft and A to B to A restores its text, visibility and candidates', async () => {
    await click('.intake-options summary'); await fill('.add-note-panel input', 'A optional title'); await fill('.add-note-panel textarea', 'QA_CASE_A 未保存の下書き');
    await fill('.add-note-panel select', 'private'); await paste();
    await evidence(); assert.equal(await evaluate('document.querySelector(".add-note-panel textarea").value'), 'QA_CASE_A 未保存の下書き');
    await main(); assert.equal(await evaluate('document.querySelectorAll(".intake-candidates li").length'), 1);
    await selectPlay('Synthetic B'); assert.equal(await evaluate('document.querySelector(".add-note-panel textarea").value'), '');
    await fill('.add-note-panel textarea', 'QA_CASE_B 独立した下書き');
    await selectPlay('Synthetic A');
    assert.equal(await evaluate('document.querySelector(".add-note-panel textarea").value'), 'QA_CASE_A 未保存の下書き');
    assert.equal(await evaluate('document.querySelector(".add-note-panel select").value'), 'private');
    assert.equal(await evaluate('document.querySelectorAll(".intake-candidates li").length'), 1);
    await selectPlay('Synthetic B'); assert.equal(await evaluate('document.querySelector(".add-note-panel textarea").value'), 'QA_CASE_B 独立した下書き');
    await selectPlay('Synthetic A');
    await click('.intake-candidates button');
    await fill('.add-note-panel input', ''); await fill('.add-note-panel select', 'unknown'); await fill('.add-note-panel textarea', '');
  });
  await check('typing, choosing multiple files and pasted images stay staged until an explicit main-screen Ctrl+Enter', async () => {
    const before = (await saved(a.id)).evidence.length, providerBefore = count();
    const one = await h.fixture('synthetic-ho.md', Buffer.from('Role and goal already belong to this synthetic HO.'));
    const two = await h.fixture('synthetic-clue.txt', Buffer.from('A synthetic clue from a file.'));
    h.controls.paths = [one, two];
    await fill('.add-note-panel textarea', 'QA_CASE_A 新しい会話の記録');
    await click('.add-note-panel .drop-zone'); await until(() => evaluate('document.querySelectorAll(".intake-candidates li").length===2'), 'two file candidates');
    await paste(); assert.equal(await evaluate('document.querySelectorAll(".intake-candidates li").length'), 3);
    await delay(450); assert.equal((await saved(a.id)).evidence.length, before); assert.equal(count(), providerBefore);
    await evaluate('document.querySelector(".add-note-panel textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))');
    await delay(40); assert.equal((await saved(a.id)).evidence.length, before);
    await evaluate('document.querySelector(".add-note-panel textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true,cancelable:true}))');
    await savedCount(a.id, before + 4);
    await until(() => evaluate('document.querySelector(".add-note-panel textarea").value===""'), 'batch draft consumed');
    assert.equal(count(), providerBefore); assert.equal((await saved(a.id)).roleProfile.role, '');
    assert.match(await status(), /未反映/);
  });
  await check('the main screen saves more information during manual inference and converges to a single latest follow-up', async () => {
    const before = count(), gate = holdResponse();
    await topButton('状況を更新'); await until(() => gate.entered, 'manual inference entered');
    const evidenceBefore = (await saved(a.id)).evidence.length;
    await fill('.add-note-panel textarea', 'QA_CASE_A 解析中の追加');
    assert.equal(await evaluate('document.querySelector(".add-note-panel button[type=submit]").disabled'), false);
    await submit(); await savedCount(a.id, evidenceBefore + 1);
    await until(async () => (await status()).includes('次の更新'), 'pending displayed');
    assert.equal(count(), before + 1);
    gate.release(); await until(() => count() === before + 2, 'single follow-up'); await idle();
    await until(async () => (await saved(a.id)).analysis.inputRevision === (await saved(a.id)).revision - 1, 'latest applied');
    assert.ok(JSON.stringify(h.requests.at(-1).request).includes('解析中の追加'));
    assert.equal(await status(), '');
  });
  await check('auto-update settings reuse the same main-screen control and never analyze while text is being typed', async () => {
    await setting([['.automation-panel .toggle input', true]]); await main();
    const before = count(), gate = holdResponse();
    await fill('.add-note-panel textarea', 'QA_CASE_A 自動更新の追加'); await delay(400); assert.equal(count(), before);
    await submit(); await until(() => gate.entered, 'automatic update entered');
    const evidenceBefore = (await saved(a.id)).evidence.length;
    await fill('.add-note-panel textarea', 'QA_CASE_A 自動解析中の追加'); await submit(); await savedCount(a.id, evidenceBefore + 1);
    gate.release(); await until(() => count() === before + 2, 'automatic latest follow-up'); await idle();
    assert.equal(await status(), '');
    await setting([['.automation-panel .toggle input', false]]); await main();
  });
  await check('main-screen cancellation retains the previous result and additional input stays available', async () => {
    const prior = (await saved(a.id)).analysis, gate = holdResponse();
    await topButton('状況を更新'); await until(() => gate.entered, 'cancellable update entered');
    await topButton('解析を中止'); gate.release(); await idle();
    assert.equal(JSON.stringify((await saved(a.id)).analysis), JSON.stringify(prior));
    await fill('.add-note-panel textarea', 'QA_CASE_A 取消後の入力');
    assert.equal(await evaluate('document.querySelector(".add-note-panel button[type=submit]").disabled'), false);
    await submit(); await until(() => evaluate('document.querySelector(".add-note-panel textarea").value===""'), 'saved after cancel');
  });
  await check('complete and skip remain one click and leave other proposals and main-screen additions available', async () => {
    const action = (await saved(a.id)).analysis.actions[0], other = (await saved(a.id)).analysis.actions[1];
    const beforeComplete = calls.filter(c => c.name === 'completeAction').length;
    await click('[data-action-id="' + action.id + '"] .action-controls button:first-child');
    await until(async () => (await saved(a.id)).actionHistory.some(e => e.id === action.id && e.status === 'completed'), 'completed saved');
    assert.equal(calls.filter(c => c.name === 'completeAction').length, beforeComplete + 1);
    const beforeSkip = calls.filter(c => c.name === 'discardAction').length;
    await click('[data-action-id="' + other.id + '"] .action-controls button:last-child');
    await until(async () => (await saved(a.id)).actionHistory.some(e => e.id === other.id && e.status === 'discarded'), 'skip saved');
    assert.equal(calls.filter(c => c.name === 'discardAction').length, beforeSkip + 1);
    await fill('.add-note-panel textarea', 'QA_CASE_A 未処理の行動があるまま追加'); await submit();
    await until(() => evaluate('document.querySelector(".add-note-panel textarea").value===""'), 'addition independent of proposals');
    assert.ok((await saved(a.id)).analysis.actions.length > 0);
    await nav(3);
    const historySelector = '[data-history-id="' + other.id + '"] ';
    await click(historySelector + '.history-note-editor summary');
    await fill(historySelector + '.history-note-editor textarea', '今は話せる相手がいない');
    await submit(historySelector + 'form');
    await until(async () => (await saved(a.id)).actionHistory.find(e => e.id === other.id).retirementReason === '今は話せる相手がいない', 'optional reason saved');
  });
  await check('material editing, exclusion and restoration preserve source content and every secondary entry remains present', async () => {
    await evidence();
    assert.ok(await evaluate('Boolean(document.querySelector(".profile-panel"))'));
    const material = '#evidence-' + note.id;
    await click(material + ' .evidence-toggle');
    await click(material + ' .evidence-enabled');
    await until(async () => (await saved(a.id)).evidence.find(e => e.id === note.id).analysisEnabled === false, 'material excluded');
    await click(material + ' .evidence-enabled');
    await until(async () => (await saved(a.id)).evidence.find(e => e.id === note.id).analysisEnabled !== false, 'material restored');
    await click(material + ' .evidence-edit summary');
    await fill(material + ' .evidence-edit input', '現在の資料名');
    await fill(material + ' .evidence-edit textarea', 'CURRENT_EDIT_BODY 新しい補足本文');
    await submit(material + ' .evidence-edit form');
    await until(async () => (await saved(a.id)).evidence.find(e => e.id === note.id).editedText === 'CURRENT_EDIT_BODY 新しい補足本文', 'material edited');
    assert.equal((await saved(a.id)).evidence.find(e => e.id === note.id).extractedText, note.extractedText);
    await click(material + ' .evidence-source-open');
    await until(() => evaluate('document.querySelector(".source-panel")?.textContent.includes("CURRENT_EDIT_BODY")'), 'current original and edit');
    assert.equal(calls.filter(c => c.name === 'readSource').at(-1).args[0].current, true);
    await closeSource();
    await main();
    await click('.play-page .action-card:first-child .action-details summary');
    await click('.play-page .action-card:first-child .citation-chip');
    await until(() => evaluate('document.querySelector(".source-panel")?.textContent.includes("証言の原文")'), 'action source snapshot');
    assert.doesNotMatch(await evaluate('document.querySelector(".source-panel").textContent'), /CURRENT_EDIT_BODY/);
    assert.ok(calls.filter(c => c.name === 'readSource').at(-1).args[0].actionId);
    await closeSource();
    await evidence();
    for (const selector of ['.settings-link', '.footer-delete', '.session-footer button', '.side-nav-item']) assert.ok(await evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))'));
    await main();
  });
  await check('all mocked inference stayed serial and the actual React browser reported no runtime errors', async () => {
    assert.ok([...peak.values()].every(value => value <= 1));
    assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.qaErrors'), []);
    await fs.writeFile(path.join(runDir, 'final-case.json'), JSON.stringify(await saved(a.id), null, 2));
  });
  const report = { passed: reports.length, reports, layouts, screenshots, peak: Object.fromEntries(peak), providerCalls: count(), errors, root, runDir };
  await fs.writeFile(path.join(runDir, 'results.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(qaDir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: reports.length, report: path.join(qaDir, 'results.json'), runDir }));
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
