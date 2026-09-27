const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CodexAppServerClient, appServerArguments, buildCodexEnvironment } = require('../electron/codexAppServer.cjs');

class FakeChild extends EventEmitter {
  constructor(options) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.killed = false;
    this.sent = [];
    this.options = options;
    this.nextTurnBehavior = 'complete';
    this.holdThreadStart = false;
    this.heldThreadId = null;
    this.holdTurnStart = false;
    this.heldTurnStart = null;
    this.stdin.write = (line) => this.receive(JSON.parse(line));
    this.stdin.end = () => setImmediate(() => this.emit('exit', 0, null));
    setImmediate(() => this.emit('spawn'));
  }

  receive(message) {
    this.sent.push(message);
    if (message.method === 'initialized') return;
    if (message.id == null) return;
    if (message.method === 'initialize') return this.reply(message.id, { serverInfo: { name: 'codex', version: 'test' } });
    if (message.method === 'account/read') return this.reply(message.id, { account: { type: 'chatgpt', planType: 'plus', email: 'hidden@example.test' } });
    if (message.method === 'account/login/start') return this.reply(message.id, { type: 'chatgptDeviceCode', loginId: 'login-secret-id', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-1234' });
    if (message.method === 'thread/start') {
      if (this.holdThreadStart) { this.heldThreadId = message.id; return; }
      return this.reply(message.id, { thread: { id: 'ephemeral-case-thread', ephemeral: true } });
    }
    if (message.method === 'turn/start') {
      if (this.holdTurnStart) { this.heldTurnStart = message; return; }
      this.startTurn(message);
      return;
    }
    if (message.method === 'turn/interrupt' || message.method === 'thread/unsubscribe') return this.reply(message.id, {});
    this.reply(message.id, {});
  }

  reply(id, result) {
    this.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
  }

  notification(method, params) {
    this.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'));
  }

  serverRequest(id, method, params) {
    this.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'));
  }

  kill() {
    this.killed = true;
    setImmediate(() => this.emit('exit', null, 'SIGTERM'));
    return true;
  }

  releaseThreadStart() {
    this.reply(this.heldThreadId, { thread: { id: 'ephemeral-case-thread', ephemeral: true } });
    this.heldThreadId = null;
  }

  releaseTurnStart() {
    const message = this.heldTurnStart;
    this.heldTurnStart = null;
    this.startTurn(message);
  }

  startTurn(message) {
    this.reply(message.id, { turn: { id: 'turn-fixture', status: 'inProgress', items: [] } });
    if (this.nextTurnBehavior === 'complete') setImmediate(() => {
      this.notification('item/started', { threadId: 'ephemeral-case-thread', turnId: 'turn-fixture', item: { id: 'message-1', type: 'agentMessage' } });
      this.notification('item/completed', { threadId: 'ephemeral-case-thread', turnId: 'turn-fixture', item: { id: 'message-1', type: 'agentMessage', text: '{"overview":"ok"}', phase: 'final_answer' } });
      this.notification('turn/completed', { threadId: 'ephemeral-case-thread', turn: { id: 'turn-fixture', status: 'completed', items: [{ type: 'agentMessage', text: '{"overview":"ok"}', phase: 'final_answer' }] } });
    });
    if (this.nextTurnBehavior === 'tool') setImmediate(() => {
      this.notification('item/started', { threadId: 'ephemeral-case-thread', turnId: 'turn-fixture', item: { id: 'cmd-1', type: 'commandExecution' } });
      this.serverRequest(900, 'item/commandExecution/requestApproval', { threadId: 'ephemeral-case-thread', turnId: 'turn-fixture', itemId: 'cmd-1' });
    });
  }
}

function makeClient() {
  let child;
  const client = new CodexAppServerClient({
    executable: 'codex.exe',
    codexHome: 'C:\\app-data\\codex-profile',
    cwd: 'C:\\temp\\codex-empty',
    envSource: { PATH: 'C:\\Windows', OPENAI_API_KEY: 'must-not-leak', CODEX_ACCESS_TOKEN: 'must-not-leak', CODEX_API_KEY: 'must-not-leak', TEMP: 'C:\\temp' },
    spawnProcess: (_executable, _args, options) => {
      child = new FakeChild(options);
      return child;
    }
  });
  return { client, get child() { return child; } };
}

test('Codex child uses an allowlisted environment and disables supported tool features', async () => {
  const env = buildCodexEnvironment({
    PATH: 'C:\\Windows',
    USERPROFILE: 'C:\\fixture-home',
    OPENAI_API_KEY: 'api-secret',
    CODEX_ACCESS_TOKEN: 'codex-secret',
    CODEX_API_KEY: 'codex-api-secret',
    OPENAI_BASE_URL: 'https://override.example'
  }, 'C:\\app-data\\isolated-codex');
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.CODEX_HOME, 'C:\\app-data\\isolated-codex');
  assert.equal(env.USERPROFILE, 'C:\\fixture-home');
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('CODEX_ACCESS_TOKEN' in env, false);
  assert.equal('CODEX_API_KEY' in env, false);
  assert.equal('OPENAI_BASE_URL' in env, false);
  const args = appServerArguments();
  assert.ok(args.includes('shell_tool'));
  assert.ok(args.includes('apps'));
  assert.ok(args.includes('remote_plugin'));
  assert.ok(args.includes('multi_agent'));
  assert.ok(args.includes('web_search="disabled"'));
});

test('initializes the official protocol, asks for an ephemeral structured turn, and returns only the final message', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  const result = await fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: '[架空資料] 8時10分に鍵を戻したというメモ。' }],
    schema: { type: 'object', required: ['overview'], additionalProperties: false, properties: { overview: { type: 'string' } } },
    model: 'gpt-6-sol',
    effort: 'low',
    developerInstructions: '入力された架空資料だけを使う。'
  });
  assert.equal(JSON.parse(result.text).overview, 'ok');
  const sent = fixture.child.sent;
  assert.equal(sent.find((item) => item.method === 'initialized') != null, true);
  const threadStart = sent.find((item) => item.method === 'thread/start');
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.developerInstructions, '入力された架空資料だけを使う。');
  assert.equal(threadStart.params.developerInstructions.includes('鍵を戻した'), false);
  const turnStart = sent.find((item) => item.method === 'turn/start');
  assert.deepEqual(turnStart.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turnStart.params.outputSchema.required[0], 'overview');
  assert.equal('tools' in turnStart.params, false);
  await fixture.client.close();
});

test('device-code response is validated and limited to the verification URL and user code', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  const login = await fixture.client.startDeviceCodeLogin();
  assert.deepEqual(login, {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'TEST-1234',
    loginId: 'login-secret-id'
  });
  assert.equal(fixture.child.sent.some((item) => item.method === 'account/logout'), false);
  await fixture.client.close();
});

test('a command approval request is canceled and the turn fails closed', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.nextTurnBehavior = 'tool';
  await assert.rejects(fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture'
  }), { code: 'TOOL_BLOCKED' });
  const response = fixture.child.sent.find((item) => item.id === 900);
  assert.deepEqual(response.result, { decision: 'cancel' });
  assert.ok(fixture.child.sent.some((item) => item.method === 'turn/interrupt'));
  await fixture.client.close();
});

test('a forbidden item seen before the turn/start response waits for the late turn id and interrupts', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdTurnStart = true;
  fixture.child.nextTurnBehavior = 'wait';
  const pending = fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture'
  });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child.notification('item/started', {
    threadId: 'ephemeral-case-thread',
    item: { id: 'blocked-1', type: 'commandExecution' }
  });
  fixture.child.releaseTurnStart();
  await assert.rejects(pending, { code: 'TOOL_BLOCKED' });
  const interrupt = fixture.child.sent.find((message) => message.method === 'turn/interrupt');
  assert.equal(interrupt.params.turnId, 'turn-fixture');
  await fixture.client.close();
});

test('timeout interrupts the turn and reports a timeout instead of returning partial output', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.nextTurnBehavior = 'wait';
  await assert.rejects(fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture',
    timeoutMs: 15
  }), { code: 'TIMEOUT' });
  assert.ok(fixture.child.sent.some((item) => item.method === 'turn/interrupt'));
  await fixture.client.close();
});

test('cancel while opening the ephemeral thread sends no scenario input and deletes the late thread', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdThreadStart = true;
  const controller = new AbortController();
  const pending = fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: '秘密: late-room-key' }],
    schema: { type: 'object' },
    developerInstructions: 'static system instruction',
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(fixture.child.sent.some((message) => message.method === 'turn/start'), false);
  const start = fixture.child.sent.find((message) => message.method === 'thread/start');
  assert.equal(start.params.developerInstructions.includes('late-room-key'), false);
  fixture.child.releaseThreadStart();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(fixture.child.sent.some((message) => message.method === 'thread/delete'));
  await fixture.client.close();
});

test('cancel during a delayed turn/start interrupts its late turn id before returning', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdTurnStart = true;
  fixture.child.nextTurnBehavior = 'wait';
  const controller = new AbortController();
  const pending = fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fictional fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture',
    signal: controller.signal
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child.releaseTurnStart();
  await assert.rejects(pending, { code: 'CANCELLED' });
  const interrupt = fixture.child.sent.find((message) => message.method === 'turn/interrupt');
  assert.equal(interrupt.params.turnId, 'turn-fixture');
  await fixture.client.close();
});

test('buffers a completed turn notification that arrives before the turn/start response', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdTurnStart = true;
  fixture.child.nextTurnBehavior = 'wait';
  const pending = fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture'
  });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child.notification('turn/started', { threadId: 'ephemeral-case-thread', turn: { id: 'turn-fixture' } });
  fixture.child.notification('turn/completed', { threadId: 'ephemeral-case-thread', turn: { id: 'turn-fixture', status: 'completed', items: [{ type: 'agentMessage', text: '{"overview":"early"}', phase: 'final_answer' }] } });
  fixture.child.releaseTurnStart();
  assert.equal(JSON.parse((await pending).text).overview, 'early');
  await fixture.client.close();
});

test('an unresolved turn/start request timeout closes the dedicated child process', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdTurnStart = true;
  fixture.child.nextTurnBehavior = 'wait';
  await assert.rejects(fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture',
    startTimeoutMs: 15
  }), { code: 'REQUEST_TIMEOUT' });
  assert.equal(fixture.client.closed, true);
  assert.equal(fixture.child.killed, true);
});

test('a turn/start timeout after the started notification interrupts the known turn', async () => {
  const fixture = makeClient();
  await fixture.client.start();
  fixture.child.holdTurnStart = true;
  fixture.child.nextTurnBehavior = 'wait';
  const pending = fixture.client.runStructuredTurn({
    input: [{ type: 'text', text: 'fixture' }],
    schema: { type: 'object' },
    developerInstructions: 'fixture',
    startTimeoutMs: 15
  });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.child.notification('turn/started', {
    threadId: 'ephemeral-case-thread',
    turn: { id: 'turn-fixture' }
  });
  await assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
  const interrupt = fixture.child.sent.find((message) => message.method === 'turn/interrupt');
  assert.equal(interrupt.params.turnId, 'turn-fixture');
  await fixture.client.close();
});
