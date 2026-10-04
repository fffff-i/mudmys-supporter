const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

// Only synthetic storage and mocked external boundaries. Importing main never launches Electron.
async function evidenceHarness(t) {
  const root = path.resolve(__dirname, '..');
  const tempRoot = path.join(root, '.local');
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'evidence-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), tempRoot); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'openai-key.bin'), 'synthetic-key');
  const handlers = new Map();
  const requests = [];
  const reads = [];
  const controls = { paths: [], failWrite: false, renameFailures: 0, output: null, turn: null, modalities: ['text', 'image'] };
  const preventGui = () => { throw new Error('GUI forbidden'); };
  const electron = {
    app: { setName() {}, getPath: () => directory, whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: preventGui, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: controls.paths }), showMessageBox: preventGui },
    shell: { openPath: preventGui }, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'synthetic-key' }
  };
  const nextResult = async (provider, request) => {
    requests.push({ provider, request });
    if (controls.turn) await controls.turn();
    return JSON.stringify(controls.output);
  };
  class FakeOpenAI { constructor() { this.responses = { create: async (request) => ({ output_text: await nextResult('openai', request) }) }; } }
  const fakeCodex = {
    request: async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'test' } };
      if (method === 'model/list') return { data: [{ id: 'mock-model', inputModalities: controls.modalities, supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }] };
      throw new Error('Unexpected mock protocol method: ' + method);
    },
    runStructuredTurn: async (request) => ({ text: await nextResult('codex', request) })
  };
  const mainPath = path.join(root, 'electron', 'main.cjs');
  const realRequire = createRequire(mainPath);
  const context = {
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'openai') return { default: FakeOpenAI };
      if (name === 'node:fs/promises') return { ...fs,
        readFile: async (filename, ...args) => { reads.push(filename); return fs.readFile(filename, ...args); },
        rename: async (...args) => {
          if (controls.failWrite) throw new Error('Synthetic write failure');
          if (controls.renameFailures > 0) { controls.renameFailures--; throw Object.assign(new Error('Synthetic file busy'), { code: 'EPERM' }); }
          return fs.rename(...args);
        }
      };
      if (name === './codexInput.cjs') { const actual = realRequire(name); return { ...actual, prepareCodexInput: (record, data, options) => actual.prepareCodexInput(record, data, { ...options, tempRoot: directory }) }; }
      return realRequire(name);
    },
    module: { exports: {} }, __dirname: path.dirname(mainPath), process, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fakeCodex,
    fetch: async (url, options) => {
      assert.equal(url, 'http://localhost:11434/api/chat');
      return { ok: true, json: async () => ({ message: { content: await nextResult('ollama', JSON.parse(options.body)) } }) };
    }
  };
  vm.runInNewContext(await fs.readFile(mainPath, 'utf8') + '\ngetCodexClient = async () => fakeCodex; module.exports = { analyzeCase, evidenceForRequest, ANALYSIS_SCHEMA };', context, { filename: mainPath });
  const invoke = (name, payload) => handlers.get(name)({}, payload);
  return {
    ...context.module.exports, directory, requests, reads, controls, invoke,
    async fixture(name, bytes) { const filename = path.join(directory, name); await fs.writeFile(filename, bytes); return filename; },
    async store(record, provider = 'none', includeRoleProfile = false) {
      const caseDir = path.join(directory, 'cases', record.id); await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(record));
      await fs.writeFile(path.join(directory, 'preferences.json'), JSON.stringify({ provider, includeRoleProfile, cloudConsent: true, codexConsent: true, ollamaModel: 'mock-model' }));
    },
    async read(id) { return invoke('scenario:get', id); }
  };
}

module.exports = { evidenceHarness };
