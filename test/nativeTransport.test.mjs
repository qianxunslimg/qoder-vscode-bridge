import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const Module = require('node:module');
const sdk = require('@qoder-ai/qoder-agent-sdk');
const originalLoad = Module._load;
let makeQuery;
Module._load = function (request, parent, isMain) {
  if (request === '@qoder-ai/qoder-agent-sdk') {
    return { ...sdk, query: (...args) => makeQuery(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NativeQoderSession, latestNativeToolResult } = require('../out/nativeToolLoop.js');
Module._load = originalLoad;

test('native stream drains buffered final output before EOF', async () => {
  const events = [
    { type: 'system', subtype: 'init' },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'finished' } } },
    { type: 'result', subtype: 'success', result: 'finished', errors: [] },
  ];
  makeQuery = () => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { return events.length ? { value: events.shift(), done: false } : { done: true }; },
    async close() {},
  });
  const session = new NativeQoderSession({
    pat: 'fixture-token', cwd: process.cwd(), model: 'ultimate', maxTurns: 2,
    prompt: 'fixture', nativeTools: [], sdkIdleTimeoutMs: 100,
  });
  const output = [];
  try {
    assert.deepEqual(await session.start({ report: part => output.push(part.value) }), { kind: 'done' });
    assert.equal(output.join(''), 'finished');
  } finally {
    await session.close();
  }
});

test('native EOF without a result still fails instead of reporting success', async () => {
  makeQuery = () => ({
    async *[Symbol.asyncIterator]() { yield { type: 'system', subtype: 'init' }; },
    async close() {},
  });
  const session = new NativeQoderSession({
    pat: 'fixture-token', cwd: process.cwd(), model: 'ultimate', maxTurns: 2,
    prompt: 'fixture', nativeTools: [], sdkIdleTimeoutMs: 100,
  });
  try {
    await assert.rejects(session.start({ report() {} }), /ended before returning a result/);
  } finally { await session.close(); }
});

test('a late transport error does not erase an already buffered final result', async () => {
  makeQuery = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init' };
      yield { type: 'result', subtype: 'success', result: 'finished', errors: [] };
      throw new Error('transport closed');
    },
    async close() {},
  });
  const session = new NativeQoderSession({
    pat: 'fixture-token', cwd: process.cwd(), model: 'ultimate', maxTurns: 2,
    prompt: 'fixture', nativeTools: [], sdkIdleTimeoutMs: 100,
  });
  const output = [];
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(await session.start({ report: part => output.push(part.value) }), { kind: 'done' });
    assert.equal(output.join(''), 'finished');
  } finally { await session.close(); }
});

test('cancellation discards messages buffered at a graceful EOF', async () => {
  makeQuery = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', result: 'must not be shown', errors: [] };
    },
    async close() {},
  });
  const session = new NativeQoderSession({
    pat: 'fixture-token', cwd: process.cwd(), model: 'ultimate', maxTurns: 2,
    prompt: 'fixture', nativeTools: [], sdkIdleTimeoutMs: 100,
  });
  await new Promise(resolve => setImmediate(resolve));
  await session.cancel();
  const output = [];
  await assert.rejects(session.start({ report: part => output.push(part.value) }), /cancelled/);
  assert.deepEqual(output, []);
});

test('native tool images survive extraction and the MCP result boundary', async () => {
  const bytes = Buffer.from([137, 80, 78, 71]);
  const callId = 'qoder-native-image';
  const result = latestNativeToolResult([{
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelToolResultPart(callId, [
      new vscode.LanguageModelTextPart('Screenshot'),
      new vscode.LanguageModelDataPart(bytes, 'image/png'),
    ])],
  }]);
  const expected = [
    { type: 'text', text: 'Screenshot' },
    { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') },
  ];
  assert.deepEqual(result.content, expected);
  assert.equal(result.text, 'Screenshot');

  let returned;
  const session = Object.create(NativeQoderSession.prototype);
  session.pendingCalls = new Map([[callId, {
    timeout: setTimeout(() => {}, 1000), result: { resolve: value => { returned = value; } },
  }]]);
  session.consumeUntilBoundary = async () => ({ kind: 'done' });
  try {
    await session.continueWithToolResult(result, { report() {} });
    assert.deepEqual(returned.content, expected);
  } finally {
    session.clearPendingCall(callId);
  }
});
