const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function loadMockMain(t) {
  const root = path.resolve(__dirname, '..');
  const tempRoot = path.join(root, '.local');
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'pdf-provider-test-'));
  t.after(async () => {
    if (path.dirname(directory) !== tempRoot) throw new Error('Test directory escaped workspace');
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, 'openai-key.bin'), 'synthetic-key');
  const handlers = new Map();
  const requests = [];
  let output;
  let files = [];
  const preventUi = () => { throw new Error('GUI calls are forbidden in PDF tests'); };
  const electron = {
    app: { setName() {}, getPath: () => directory, whenReady: () => ({ then() {} }), on() {} },
    BrowserWindow: preventUi, ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: files }), showMessageBox: preventUi },
    shell: { openPath: preventUi }, safeStorage: { isEncryptionAvailable: () => true, decryptString: (value) => value.toString() }
  };
  class MockOpenAI {
    constructor() { this.responses = { create: async (request) => { requests.push({ provider: 'openai', request }); return { output_text: JSON.stringify(output), usage: null }; } }; }
  }
  const fakeCodex = {
    request: async (method) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'test' } };
      if (method === 'model/list') return { data: [{ id: 'synthetic-model', inputModalities: ['text', 'image'], supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }] };
      throw new Error('Unexpected mock method: ' + method);
    },
    runStructuredTurn: async (request) => {
      const images = [];
      for (const part of request.input) if (part.type === 'localImage') images.push(await fs.readFile(part.path));
      requests.push({ provider: 'codex', request, images });
      return { text: JSON.stringify(output) };
    }
  };
  const mainPath = path.join(root, 'electron/main.cjs');
  const realRequire = createRequire(mainPath);
  const context = { require: (name) => name === 'electron' ? electron : name === 'openai' ? { default: MockOpenAI } : realRequire(name),
    module: { exports: {} }, __dirname: path.dirname(mainPath), process, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, fakeCodex,
    fetch: async (url, options) => {
      if (url !== 'http://localhost:11434/api/chat') throw new Error('Live network is forbidden');
      requests.push({ provider: 'ollama', request: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(output) } }) };
    } };
  vm.runInNewContext(await fs.readFile(mainPath, 'utf8') + '\ngetCodexClient = async () => fakeCodex;\nmodule.exports = { analyzeCase, ANALYSIS_SCHEMA, SYSTEM_PROMPT };', context, { filename: mainPath });
  return { ...context.module.exports, directory, requests,
    setOutput(value) { output = value; }, selectFiles(value) { files = value; },
    invoke: (name, payload) => handlers.get(name)({}, payload),
    async store(scenario, provider = 'openai') {
      const caseRoot = path.join(directory, 'cases', scenario.id);
      await fs.mkdir(path.join(caseRoot, 'attachments'), { recursive: true });
      await fs.writeFile(path.join(caseRoot, 'case.json'), JSON.stringify(scenario));
      await fs.writeFile(path.join(directory, 'preferences.json'), JSON.stringify({ provider, cloudConsent: true, codexConsent: true, includeRoleProfile: false, ollamaModel: 'synthetic-model' }));
    },
    async attachment(scenario, name, bytes) {
      const file = path.join(directory, 'cases', scenario.id, 'attachments', name);
      await fs.writeFile(file, bytes);
      return file;
    },
    async read(scenario) { return JSON.parse(await fs.readFile(path.join(directory, 'cases', scenario.id, 'case.json'), 'utf8')); }
  };
}

module.exports = { loadMockMain };
