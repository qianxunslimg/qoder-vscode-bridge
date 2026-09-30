import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const vscode = require('vscode');
const sdk = require('@qoder-ai/qoder-agent-sdk');
const originalLoad = Module._load;
let makeQuery;

Module._load = function loadWithFakeQuery(request, parent, isMain) {
  if (request === '@qoder-ai/qoder-agent-sdk') {
    return { ...sdk, query: (...args) => makeQuery(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { QoderModelProvider } = await import('../out/provider.js');
const { NativeQoderSession } = await import('../out/nativeToolLoop.js');
Module._load = originalLoad;

const model = {
  id: 'ultimate',
  name: 'Ultimate',
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  isBYOK: true,
  isUserSelectable: true,
  capabilities: { toolCalling: true },
};

const messages = [{
  role: vscode.LanguageModelChatMessageRole.User,
  content: [new vscode.LanguageModelTextPart('Explain this.')],
}];

const token = {
  isCancellationRequested: false,
  onCancellationRequested() {
    return { dispose() {} };
  },
};

function request(provider, output, requestToken = token) {
  return provider.provideLanguageModelChatResponse(
    model,
    messages,
    { tools: [] },
    { report(part) { output.push(part); } },
    requestToken,
  );
}

async function raceWithTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(() => 'completed', (error) => error),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('timed out'), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('text-only fallback completes when the SDK emits a result but leaves its stream open', async () => {
  let nextCalls = 0;
  let closeCalls = 0;
  const query = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      nextCalls += 1;
      if (nextCalls === 1) {
        return {
          done: false,
          value: { type: 'result', subtype: 'success', result: 'finished', errors: [] },
        };
      }
      return new Promise(() => {});
    },
    async close() { closeCalls += 1; },
    async interrupt() {},
  };
  makeQuery = () => query;
  const provider = new QoderModelProvider({ async get() { return 'fake-token'; } });
  const output = [];

  const outcome = await raceWithTimeout(request(provider, output), 100);

  assert.equal(outcome, 'completed');
  assert.equal(nextCalls, 1);
  assert.equal(closeCalls, 1);
  assert.ok(output.some((part) => part.value === 'finished'));
  provider.dispose();
});

test('text-only fallback does not wait forever when SDK close never settles', async () => {
  let closeCalls = 0;
  let nextCalls = 0;
  const query = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      nextCalls += 1;
      if (nextCalls > 1) {
        return { done: true };
      }
      return {
        done: false,
        value: { type: 'result', subtype: 'success', result: 'finished', errors: [] },
      };
    },
    async close() {
      closeCalls += 1;
      return new Promise(() => {});
    },
    async interrupt() {},
  };
  makeQuery = () => query;
  const provider = new QoderModelProvider({ async get() { return 'fake-token'; } });
  const output = [];

  const outcome = await raceWithTimeout(request(provider, output), 4_500);

  assert.equal(outcome, 'completed');
  assert.equal(closeCalls, 1);
  assert.ok(output.some((part) => part.value === 'finished'));
  provider.dispose();
});

test('text-only fallback cancellation exits a stalled SDK read promptly', async () => {
  let closeCalls = 0;
  let cancelListener;
  const cancellingToken = {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      cancelListener = listener;
      return { dispose() {} };
    },
  };
  makeQuery = () => ({
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(() => {}); },
    async close() { closeCalls += 1; },
  });
  const provider = new QoderModelProvider({ async get() { return 'fake-token'; } });
  const output = [];
  const pending = request(provider, output, cancellingToken);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof cancelListener, 'function');

  cancellingToken.isCancellationRequested = true;
  cancelListener();
  const outcome = await raceWithTimeout(pending, 100);

  assert.ok(outcome instanceof Error, String(outcome));
  assert.equal(closeCalls, 1);
  provider.dispose();
});

test('native session isolates its MCP tools from local Qoder settings', async () => {
  let queryOptions;
  makeQuery = ({ options }) => {
    queryOptions = options;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() { return { done: true }; },
      async close() {},
    };
  };
  const session = new NativeQoderSession({
    pat: 'fake-token',
    cwd: process.cwd(),
    model: 'ultimate',
    maxTurns: 3,
    prompt: 'hello',
    nativeTools: [],
  });

  assert.deepEqual(queryOptions.tools, []);
  assert.deepEqual(queryOptions.settingSources, []);
  assert.equal(queryOptions.strictMcpConfig, true);
  assert.deepEqual(queryOptions.allowedMcpServerNames, ['qoder-vscode-bridge']);
  assert.deepEqual(Object.keys(queryOptions.mcpServers), ['qoder-vscode-bridge']);
  await session.close();
});
