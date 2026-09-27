const { spawn } = require('node:child_process');

const SAFE_ENV_KEYS = [
  'PATH', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP'
];
const SAFE_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'userMessage', 'plan', 'contextCompaction']);
const CANCEL_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval'
]);
const DENY_PERMISSION_METHOD = 'item/permissions/requestApproval';
const CANCEL_ELICITATION_METHOD = 'mcpServer/elicitation/request';
const BLOCKED_REQUEST_METHODS = new Set([
  'item/tool/call',
  'item/tool/requestUserInput',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read'
]);

class CodexAppServerError extends Error {
  constructor(message, code = 'CODEX_APP_SERVER_ERROR') {
    super(message);
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

function buildCodexEnvironment(source = process.env, codexHome) {
  const env = {};
  const sourceKeys = new Map(Object.keys(source || {}).map((key) => [key.toLowerCase(), key]));
  for (const safeName of SAFE_ENV_KEYS) {
    const key = sourceKeys.get(safeName.toLowerCase());
    if (key && typeof source[key] === 'string') env[safeName] = source[key];
  }
  env.CODEX_HOME = codexHome;
  return env;
}

function appServerArguments() {
  return [
    'app-server', '--stdio', '--strict-config',
    '--disable', 'shell_tool',
    '--disable', 'apps',
    '--disable', 'remote_plugin',
    '--disable', 'multi_agent',
    '--config', 'approval_policy="never"',
    '--config', 'sandbox_mode="read-only"',
    '--config', 'web_search="disabled"'
  ];
}

class CodexAppServerClient {
  constructor({ executable, codexHome, cwd, envSource, spawnProcess = spawn, onSecurityEvent }) {
    this.executable = executable;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.envSource = envSource || process.env;
    this.spawnProcess = spawnProcess;
    this.onSecurityEvent = onSecurityEvent || (() => {});
    this.child = null;
    this.ready = false;
    this.closed = false;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.activeTurns = new Map();
    this.subscribers = new Set();
    this.exitPromise = null;
  }

  async start() {
    if (this.ready) return this;
    if (this.closed) throw new CodexAppServerError('Codex接続は終了しています。', 'CLOSED');
    if (!this.executable) throw new CodexAppServerError('Codex CLIが見つかりません。', 'NOT_INSTALLED');
    this.child = this.spawnProcess(this.executable, appServerArguments(), {
      cwd: this.cwd,
      env: buildCodexEnvironment(this.envSource, this.codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    this.child.stdout.on('data', (chunk) => this._consume(chunk));
    this.child.stderr.on('data', () => { /* App Server stderr can include private paths; never retain or display it. */ });
    this.child.stdin.on('error', () => this._fail(new CodexAppServerError('Codex接続が切れました。', 'DISCONNECTED')));
    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        this.closed = true;
        this.ready = false;
        this._fail(new CodexAppServerError('Codex接続が終了しました。', 'DISCONNECTED'));
        resolve(code);
      });
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new CodexAppServerError('Codex CLIの起動が時間切れになりました。', 'START_TIMEOUT')), 10000);
        timer.unref?.();
        this.child.once('spawn', () => { clearTimeout(timer); resolve(); });
        this.child.once('error', () => { clearTimeout(timer); reject(new CodexAppServerError('Codex CLIを起動できません。インストール先を確認してください。', 'SPAWN_FAILED')); });
      });
      await this.request('initialize', {
        clientInfo: { name: 'makua_mystery_notebook', title: '幕間ノート', version: '0.2.0' },
        capabilities: { experimentalApi: false }
      }, 10000);
      this.notify('initialized', {});
      this.ready = true;
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  request(method, params = {}, timeoutMs = 20000) {
    if (!this.child || this.closed) return Promise.reject(new CodexAppServerError('Codex接続がありません。', 'DISCONNECTED'));
    if (method !== 'initialize' && !this.ready) return Promise.reject(new CodexAppServerError('Codex接続を初期化できません。', 'NOT_INITIALIZED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError('Codexからの応答が時間切れになりました。', 'REQUEST_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexAppServerError('Codexへの要求を送信できませんでした。', 'WRITE_FAILED'));
      }
    });
  }

  notify(method, params = {}) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  async startDeviceCodeLogin() {
    const result = await this.request('account/login/start', { type: 'chatgptDeviceCode' }, 15000);
    const verificationUrl = String(result && result.verificationUrl || '');
    const userCode = String(result && result.userCode || '');
    const loginId = String(result && result.loginId || '');
    if (!/^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(verificationUrl) || !userCode || !loginId) {
      throw new CodexAppServerError('Codexの認証案内を確認できませんでした。CLIを更新して再試行してください。', 'BAD_LOGIN_RESPONSE');
    }
    return { verificationUrl, userCode, loginId };
  }

  async runStructuredTurn({ input, schema, model, effort, developerInstructions, timeoutMs = 180000, startTimeoutMs = 30000, signal }) {
    if (!this.ready) throw new CodexAppServerError('Codex接続がありません。', 'DISCONNECTED');
    if (signal && signal.aborted) throw new CodexAppServerError('解析をキャンセルしました。', 'CANCELLED');
    const cwd = this.cwd;
    const threadStartRequest = this.request('thread/start', {
      ephemeral: true,
      model,
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions,
      serviceName: 'makua_mystery_notebook',
      environments: []
    }, 20000);
    let threadResult;
    if (signal) {
      let abortThreadStart;
      const abortPromise = new Promise((_, reject) => {
        abortThreadStart = () => reject(new CodexAppServerError('解析をキャンセルしました。', 'CANCELLED'));
        signal.addEventListener('abort', abortThreadStart, { once: true });
        if (signal.aborted) abortThreadStart();
      });
      try {
        threadResult = await Promise.race([threadStartRequest, abortPromise]);
      } catch (error) {
        if (signal.aborted) {
          threadStartRequest.then((lateResult) => {
            const lateThreadId = lateResult && lateResult.thread && lateResult.thread.id;
            if (lateThreadId) this.request('thread/delete', { threadId: lateThreadId }, 10000).catch(() => {});
          }).catch(() => {});
          throw new CodexAppServerError('解析をキャンセルしました。資料は送信していません。', 'CANCELLED');
        }
        throw error;
      } finally {
        signal.removeEventListener('abort', abortThreadStart);
      }
    } else {
      threadResult = await threadStartRequest;
    }
    const thread = threadResult && threadResult.thread;
    if (!thread || !thread.id) throw new CodexAppServerError('Codexが解析用の会話を開始できませんでした。', 'BAD_THREAD_RESPONSE');
    if (thread.ephemeral !== true) {
      if (thread.ephemeral === false) {
        this.request('thread/delete', { threadId: thread.id }, 10000).catch(() => {});
      }
      throw new CodexAppServerError('Codex CLIが一時会話に対応していません。最新版へ更新してください。資料は送信していません。', 'EPHEMERAL_UNSUPPORTED');
    }
    if (signal && signal.aborted) {
      this.request('thread/delete', { threadId: thread.id }, 10000).catch(() => {});
      throw new CodexAppServerError('解析をキャンセルしました。資料は送信していません。', 'CANCELLED');
    }

    let resolveTurn;
    let rejectTurn;
    let finished = false;
    let timeout;
    let resolveTurnStarted;
    const state = {
      threadId: thread.id, turnId: null, fail: null, resolve: null, reject: null,
      startRequest: null, startResponseReceived: false, cancelPromise: null, cancelForSafety: null,
      turnStarted: new Promise((resolve) => { resolveTurnStarted = resolve; }),
      resolveTurnStarted
    };
    const completion = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
    completion.catch(() => {});
    state.resolve = (turn) => {
      if (finished || state.fail) return;
      finished = true;
      clearTimeout(timeout);
      resolveTurn(turn);
    };
    state.reject = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      rejectTurn(error);
    };
    this.activeTurns.set(thread.id, state);
    const cancelForSafety = (reason, code = 'TOOL_BLOCKED') => {
      if (!state.fail) state.fail = new CodexAppServerError(reason, code);
      if (state.cancelPromise) return state.cancelPromise;
      state.cancelPromise = (async () => {
        let turnId = state.turnId;
        if (!turnId && state.startRequest) {
          let graceTimer;
          const grace = new Promise((resolve) => { graceTimer = setTimeout(() => resolve(null), 5000); graceTimer.unref?.(); });
          try {
            const observed = await Promise.race([
              state.turnStarted,
              state.startRequest.then((result) => result && result.turn && result.turn.id || null, () => null),
              grace
            ]);
            turnId = observed || state.turnId;
          } catch { turnId = state.turnId; }
          finally { clearTimeout(graceTimer); }
          if (!turnId) await this.close();
        }
        if (turnId && !this.closed) {
          try { await this.request('turn/interrupt', { threadId: state.threadId, turnId }, 5000); }
          catch { await this.close(); }
        }
        state.reject(state.fail);
      })();
      state.cancelPromise.catch(() => state.reject(state.fail));
      return state.cancelPromise;
    };
    state.cancelForSafety = cancelForSafety;
    const abort = () => {
      if (!state.fail) state.fail = new CodexAppServerError('解析をキャンセルしました。', 'CANCELLED');
      cancelForSafety(state.fail.message, 'CANCELLED');
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    timeout = setTimeout(() => cancelForSafety('Codex解析が時間切れになりました。', 'TIMEOUT'), timeoutMs);
    timeout.unref?.();

    try {
      if (state.fail) throw state.fail;
      state.startRequest = this.request('turn/start', {
        threadId: thread.id,
        input,
        outputSchema: schema,
        model,
        effort,
        cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: []
      }, startTimeoutMs);
      const completionFailure = completion.then(
        () => new Promise(() => {}),
        (error) => Promise.reject(error)
      );
      const started = await Promise.race([
        state.startRequest,
        completionFailure
      ]);
      state.startResponseReceived = true;
      state.turnId = started && started.turn && started.turn.id || null;
      if (!state.turnId) throw new CodexAppServerError('Codexが解析を開始できませんでした。', 'BAD_TURN_RESPONSE');
      state.resolveTurnStarted(state.turnId);
      if (state.fail) {
        if (state.cancelPromise) await state.cancelPromise;
        throw state.fail;
      }
      const turn = await completion;
      if (turn.status !== 'completed') {
        const code = turn.status === 'interrupted' ? 'CANCELLED' : 'TURN_FAILED';
        throw new CodexAppServerError(turn.status === 'interrupted' ? '解析をキャンセルしました。' : 'Codexの解析に失敗しました。', code);
      }
      const items = Array.isArray(turn.items) ? turn.items : [];
      const messages = items.filter((item) => item && item.type === 'agentMessage' && typeof item.text === 'string');
      const finalMessage = [...messages].reverse().find((item) => !item.phase || item.phase === 'final_answer') || messages.at(-1);
      if (!finalMessage) throw new CodexAppServerError('Codexから解析結果を受け取れませんでした。', 'NO_FINAL_MESSAGE');
      return { text: finalMessage.text, turnId: state.turnId };
    } catch (error) {
      if (state.startRequest && !this.closed && (!state.startResponseReceived || !state.turnId || state.fail)) {
        if (state.fail && state.cancelPromise) await state.cancelPromise;
        else await cancelForSafety(error instanceof Error ? error.message : 'Codexの解析開始に失敗しました。', error && error.code || 'TURN_FAILED');
      }
      if (state.fail) throw state.fail;
      if (error instanceof CodexAppServerError) throw error;
      throw new CodexAppServerError('Codex解析に失敗しました。', 'TURN_FAILED');
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abort);
      this.activeTurns.delete(thread.id);
      this.request('thread/unsubscribe', { threadId: thread.id }, 5000).catch(() => {});
    }
  }

  async close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.ready = false;
    this._fail(new CodexAppServerError('Codex接続を終了しました。', 'CLOSED'));
    try { this.child.stdin.end(); } catch { /* already closed */ }
    if (this.exitPromise) {
      await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1200);
          timer.unref?.();
        })
      ]);
    }
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* process already ended */ }
    }
  }

  _write(message) {
    if (!this.child || !this.child.stdin || this.closed) throw new Error('closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  _consume(chunk) {
    if (this.closed) return;
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 8 * 1024 * 1024) {
      this._fail(new CodexAppServerError('Codex応答が大きすぎるため接続を停止しました。', 'RESPONSE_TOO_LARGE'));
      this.close().catch(() => {});
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this._fail(new CodexAppServerError('Codexから不正な通信形式が返りました。', 'BAD_MESSAGE'));
        this.close().catch(() => {});
        return;
      }
      this._receive(message);
    }
  }

  _receive(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
      this._handleServerRequest(message);
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexAppServerError('Codex要求に失敗しました。', 'RPC_ERROR'));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }
    if (!message || !message.method) return;
    this._emit(message);
    this._handleNotification(message);
  }

  _handleNotification(message) {
    const params = message.params || {};
    const threadId = params.threadId;
    const state = threadId && this.activeTurns.get(threadId);
    if (!state) return;
    if (message.method === 'turn/started' && params.turn && params.turn.id && !state.turnId) {
      state.turnId = params.turn.id;
      state.resolveTurnStarted(params.turn.id);
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const type = params.item && params.item.type;
      if (type && !SAFE_ITEM_TYPES.has(type)) {
        this._rejectForTool(state, 'Codexが許可されていない機能を要求したため、解析を停止しました。');
      }
      return;
    }
    if (message.method === 'turn/completed' && params.turn) state.resolve(params.turn);
  }

  _handleServerRequest(message) {
    const { id, method, params = {} } = message;
    if (CANCEL_APPROVAL_METHODS.has(method)) {
      this._reply(id, { decision: 'cancel' });
      this._rejectMatchingTurn(params, 'Codexがコマンドや変更を要求したため、解析を停止しました。');
      return;
    }
    if (method === DENY_PERMISSION_METHOD) {
      this._reply(id, { permissions: { fileSystem: { entries: [] }, network: { enabled: false } }, scope: 'turn' });
      this._rejectMatchingTurn(params, 'Codexが追加アクセス権を要求したため、解析を停止しました。');
      return;
    }
    if (method === CANCEL_ELICITATION_METHOD) {
      this._reply(id, { action: 'cancel', content: null });
      this._rejectMatchingTurn(params, 'Codexが外部サービス連携を要求したため、解析を停止しました。');
      return;
    }
    if (BLOCKED_REQUEST_METHODS.has(method)) {
      this._replyError(id, -32601, 'This operation is unavailable.');
      this._rejectMatchingTurn(params, 'Codexが許可されていない機能を要求したため、解析を停止しました。');
      return;
    }
    this._replyError(id, -32601, 'This operation is unavailable.');
    this._rejectMatchingTurn(params, 'Codexが未対応の操作を要求したため、解析を停止しました。');
  }

  _rejectMatchingTurn(params, reason) {
    const state = params.threadId && this.activeTurns.get(params.threadId);
    if (state) this._rejectForTool(state, reason, params.turnId);
    try { this.onSecurityEvent({ kind: 'blocked-operation' }); } catch { /* never surface details */ }
  }

  _rejectForTool(state, reason, turnId) {
    if (turnId && !state.turnId) {
      state.turnId = turnId;
      state.resolveTurnStarted(turnId);
    }
    if (state.cancelForSafety) state.cancelForSafety(reason, 'TOOL_BLOCKED').catch(() => {});
    else state.reject(new CodexAppServerError(reason, 'TOOL_BLOCKED'));
  }

  _reply(id, result) {
    try { this._write({ jsonrpc: '2.0', id, result }); } catch { /* process is closing */ }
  }

  _replyError(id, code, message) {
    try { this._write({ jsonrpc: '2.0', id, error: { code, message } }); } catch { /* process is closing */ }
  }

  _emit(message) {
    for (const callback of this.subscribers) {
      try { callback(message); } catch { /* subscriber errors cannot break RPC handling */ }
    }
  }

  _fail(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const state of this.activeTurns.values()) state.reject(error);
  }
}

module.exports = { CodexAppServerClient, CodexAppServerError, buildCodexEnvironment, appServerArguments, SAFE_ITEM_TYPES };
