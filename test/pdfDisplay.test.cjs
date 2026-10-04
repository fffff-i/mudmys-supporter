const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { extractPdfDocument, renderPdfPage } = require('../electron/pdfDocuments.cjs');
const { pdfFixture } = require('../test-support/pdfFixtures.cjs');

async function loadDisplay(react = React, window = {}) {
  const ts = require('typescript');
  const appPath = path.resolve(__dirname, '../src/App.tsx');
  const source = await fs.readFile(appPath, 'utf8');
  const compiled = ts.transpileModule(source + '\nexport { App, EventRow, Citation, SourcePanel, EvidenceCard };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const realRequire = createRequire(appPath);
  const context = { exports: {}, window, setTimeout, clearTimeout, require: (name) => name === 'react' ? react : realRequire(name) };
  vm.runInNewContext(compiled, context, { filename: appPath });
  return context.exports;
}

function findElement(node, predicate, expand = false) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const found = findElement(child, predicate, expand); if (found) return found; } return null; }
  if (predicate(node)) return node;
  if (expand && typeof node.type === 'function') return findElement(node.type(node.props), predicate, expand);
  return findElement(node.props?.children, predicate, expand);
}

test('a PDF citation passes its exact page and verification to the original panel; unreadable pages are explicit', async () => {
  const display = await loadDisplay();
  const metadata = await extractPdfDocument(pdfFixture());
  const scenario = { evidence: [{ id: 'pdf', title: 'synthetic.pdf', kind: 'pdf', visibility: 'unknown', ...metadata }], analysis: null };
  const event = { sourceId: 'pdf', page: '3', quote: '10:30 lantern on', quoteVerification: 'image_unverified', people: [], timeText: '', what: 'lantern', type: 'recorded', ambiguity: '' };
  const calls = [];
  const row = display.EventRow({ event, scenario, onEvidence: (...args) => calls.push(args) });
  const citation = findElement(row, (node) => node.type === 'button' && node.props.className === 'citation-chip', true);
  citation.props.onClick();
  assert.deepEqual(calls, [['pdf', '3', 'image_unverified']]);
  const rendered = await renderPdfPage(pdfFixture(), 3);
  const view = { request: { id: 'scenario', evidenceId: 'pdf', page: '3' }, verification: 'image_unverified', loading: false, error: '',
    preview: { kind: 'pdf', title: 'synthetic.pdf', text: metadata.pdfPages[2].text, dataUrl: rendered.dataUrl, pageNumber: 3, pageCount: 5, pdfPages: metadata.pdfPages, extractionMessage: metadata.extractionMessage } };
  const pages = [];
  let closed = false;
  const panel = display.SourcePanel({ view, title: '', onClose: () => { closed = true; }, onPage: (page) => pages.push(page) });
  const html = renderToStaticMarkup(panel);
  assert.match(html, /原本を確認/);
  assert.match(html, /画像読取・引用未照合/);
  assert.match(html, /原本 p\.3/);
  assert.match(html, /10:00 courtyard closed/);
  assert.doesNotMatch(html, /08:10 returned key/);
  findElement(panel, (node) => node.type === 'button' && node.props['aria-label'] === '原本を閉じる').props.onClick();
  assert.equal(closed, true);
  findElement(panel, (node) => node.type === 'button' && node.props.children === '次へ').props.onClick();
  assert.deepEqual(pages, [4]);
  const broken = { ...view, error: '原本を読み取れません', preview: { ...view.preview, dataUrl: '' } };
  assert.match(renderToStaticMarkup(React.createElement(display.SourcePanel, { view: broken, title: '', onClose() {}, onPage() {} })), /role="alert"/);
  const cardHtml = renderToStaticMarkup(React.createElement(display.EvidenceCard, { item: scenario.evidence[0], index: 0, selected: false, preview: '', provider: 'ollama', onSelect() {}, onVisibility() {}, onPreview() {}, onSource() {} }));
  assert.match(cardHtml, /PDF画像は解析対象外/);
  assert.match(cardHtml, /p\.5/);
  assert.match(cardHtml, /本文抽出なし/);
});

test('the actual App opens and closes source viewing while staying on the same overview', async () => {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const react = { ...React,
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial) { const index = cursor++; const slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slot.value, (value) => { slot.value = typeof value === 'function' ? value(slot.value) : value; }]; },
    useMemo(factory) { cursor += 1; return factory(); },
    useEffect(factory, deps) { const index = cursor++; const slot = slots[index] ??= {};
      if (!slot.deps || !deps || deps.some((value, i) => value !== slot.deps[i])) { slot.deps = deps; effects.push(() => { slot.cleanup?.(); slot.cleanup = factory(); }); } }
  };
  const scenario = { id: '11111111-1111-4111-8111-111111111111', revision: 1, title: '架空シナリオ', synopsis: '', roleProfile: {}, evidence: [{ id: 'pdf', title: 'fixture.pdf', kind: 'pdf' }], analysis: null, actionHistory: [], updatedAt: '' };
  const requests = [];
  const window = { addEventListener() {}, removeEventListener() {}, makua: {
    listScenarios: async () => [scenario], getSettings: async () => ({ provider: 'none', autoUpdate: false, textLimitCharacters: 300000 }), getScenario: async () => scenario,
    readSource: async (request) => { requests.push(request); return { kind: 'pdf', title: 'fixture.pdf', dataUrl: '', text: '', pageNumber: 2, pageCount: 5, pdfPages: [], extractionMessage: '' }; }
  } };
  const display = await loadDisplay(react, window);
  const render = () => { cursor = 0; return display.App(); };
  render();
  for (const effect of effects.splice(0)) effect();
  await new Promise(setImmediate);
  const initial = render();
  const overview = findElement(initial, (node) => node.type?.name === 'Overview');
  assert.ok(overview);
  overview.props.onEvidence('pdf', '2', 'image_unverified');
  await new Promise(setImmediate);
  const opened = render();
  assert.ok(findElement(opened, (node) => node.type?.name === 'Overview'));
  assert.equal(findElement(opened, (node) => node.type?.name === 'EvidencePage'), null);
  const panel = findElement(opened, (node) => node.type?.name === 'SourcePanel');
  assert.equal(panel.props.view.preview.pageNumber, 2);
  assert.equal(requests[0].page, '2');
  assert.equal(requests[0].id, scenario.id);
  panel.props.onClose();
  const closed = render();
  assert.equal(findElement(closed, (node) => node.type?.name === 'SourcePanel'), null);
  assert.ok(findElement(closed, (node) => node.type?.name === 'Overview'));
});

test('a historical fixed-source citation selects its own snapshot even when the fixed ID is reused', async () => {
  const display = await loadDisplay();
  const snapshots = ['older profile', 'newer profile'].map((text, revision) => ({ revision, sources: [{ id: 'scenario:role-profile', title: '役プロフィール', kind: 'text', extractedText: text }] }));
  const scenario = { evidence: [], analysis: snapshots[0], analysisHistory: snapshots };
  const calls = [];
  const citation = display.Citation({ scenario, id: 'scenario:role-profile', onEvidence: (...args) => calls.push(args) });
  citation.props.onClick();
  assert.equal(calls[0][0], 'scenario:role-profile');
  assert.equal(calls[0][3], 0);
  const newer = display.Citation({ scenario: { ...scenario, analysis: snapshots[1] }, id: 'scenario:role-profile', onEvidence: (...args) => calls.push(args) });
  newer.props.onClick();
  assert.equal(calls[1][3], 1);
});
