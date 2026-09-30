import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { z } from 'zod';

import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const {
  buildNativePrompt,
  NativeQoderSession,
  nativeToolInputShape,
  normalizeNativeToolInput,
  terminalNotificationToolResult,
} = await import('../out/nativeToolLoop.js');
const {
  QoderModelProvider,
  TEXT_ONLY_FALLBACK_TOOL_POLICY,
} = await import('../out/provider.js');
const { waitForSdkMessage } = await import('../out/sdkIdleTimeout.js');

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

test('SDK fallback disables built-in tools and denies attempted tool use', async () => {
  assert.deepEqual(TEXT_ONLY_FALLBACK_TOOL_POLICY.tools, []);
  assert.equal(TEXT_ONLY_FALLBACK_TOOL_POLICY.permissionMode, 'default');
  assert.deepEqual(TEXT_ONLY_FALLBACK_TOOL_POLICY.settingSources, []);
  assert.equal(TEXT_ONLY_FALLBACK_TOOL_POLICY.strictMcpConfig, true);
  assert.deepEqual(
    await TEXT_ONLY_FALLBACK_TOOL_POLICY.canUseTool('Bash', {}, {}),
    { behavior: 'deny', message: 'Tool use requires VS Code Chat host tools.' },
  );
});

test('SDK timeout keeps its error when cleanup aborts the same signal', async () => {
  const controller = new AbortController();
  await assert.rejects(
    waitForSdkMessage(
      () => new Promise(() => {}),
      20,
      () => controller.abort(),
      controller.signal,
    ),
    /Qoder SDK did not produce a message within 1 second/,
  );
  assert.equal(controller.signal.aborted, true);
});

test('SDK wait exits immediately on user cancellation without firing idle timeout', async () => {
  const controller = new AbortController();
  let timedOut = false;
  const waiting = waitForSdkMessage(
    () => new Promise(() => {}),
    100,
    () => { timedOut = true; },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(timedOut, false);
});

test('does not stringify an image prompt when adding native tool instructions', async () => {
  const prompt = (await import('../out/messageAdapter.js')).messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart('请看这张图'),
        new vscode.LanguageModelDataPart(
          new Uint8Array([0, 1, 2, 255]),
          'image/png',
        ),
      ],
    },
  ]);

  const nativePrompt = buildNativePrompt(prompt);
  assert.notEqual(typeof nativePrompt, 'string');
  const [message] = await (async () => {
    const result = [];
    for await (const item of nativePrompt) {
      result.push(item);
    }
    return result;
  })();
  const content = message.message.content;
  assert.ok(content.some((part) => part.type === 'image'));
  assert.match(
    content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'),
    /qoder_native_/,
  );
  assert.doesNotMatch(JSON.stringify(content), /\[object AsyncGenerator\]/);
});

test('preserves host field descriptions in the Qoder proxy schema', () => {
  const shape = nativeToolInputShape({
    type: 'object',
    properties: {
      timeout: {
        type: 'number',
        description: 'Optional hard cap in milliseconds.',
      },
    },
  });
  const generated = z.toJSONSchema(z.object(shape));

  assert.equal(
    generated.properties.timeout.description,
    'Optional hard cap in milliseconds.',
  );
});

test('repairs a seconds-sized timeout before invoking the VS Code terminal', () => {
  const input = { command: 'npm test', mode: 'sync', timeout: 900 };

  assert.deepEqual(normalizeNativeToolInput('run_in_terminal', input), {
    command: 'npm test',
    mode: 'sync',
    timeout: 900_000,
  });
  assert.deepEqual(normalizeNativeToolInput('run_in_terminal', {
    command: 'npm test',
    mode: 'sync',
    timeout: 120_000,
  }), {
    command: 'npm test',
    mode: 'sync',
    timeout: 120_000,
  });
  assert.deepEqual(normalizeNativeToolInput('run_in_terminal', {
    command: 'npm test',
    mode: 'async',
    timeout: 900,
  }), {
    command: 'npm test',
    mode: 'async',
    timeout: 900,
  });
  assert.equal(input.timeout, 900);
});

test('turns a matching terminal completion notification into the pending tool result', () => {
  const terminalId = '2c59580e-06ff-4e59-b36e-9d9359fa60c8';
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart(
          `[Terminal ${terminalId} notification: command completed. The terminal has been cleaned up.]\nTerminal output:\n22/22 tests passed`,
        ),
      ],
    },
  ];

  assert.deepEqual(
    terminalNotificationToolResult(messages, {
      callId: 'qoder-native-tool-call-2',
      name: 'get_terminal_output',
      input: { id: terminalId },
    }),
    {
      callId: 'qoder-native-tool-call-2',
      text: '22/22 tests passed',
      isError: false,
    },
  );
});

test('does not consume a terminal notification for another pending call', () => {
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelTextPart(
          '[Terminal terminal-a notification: command completed.]\nTerminal output:\ndone',
        ),
      ],
    },
  ];

  assert.equal(
    terminalNotificationToolResult(messages, {
      callId: 'qoder-native-tool-call-2',
      name: 'get_terminal_output',
      input: { id: 'terminal-b' },
    }),
    undefined,
  );
});

test('provider resumes the original Qoder session on a raced terminal notification', async () => {
  const terminalId = '2c59580e-06ff-4e59-b36e-9d9359fa60c8';
  const callId = 'qoder-native-tool-call-2';
  let continuedWith;
  let closeCount = 0;
  const session = {
    async continueWithToolResult(result) {
      continuedWith = result;
      return { kind: 'done' };
    },
    async close() {
      closeCount += 1;
    },
    async cancel() {},
  };
  const provider = new QoderModelProvider({
    async get() {
      return 'fake-token';
    },
  });
  provider.nativeSessions.set(callId, {
    session,
    invocation: {
      callId,
      name: 'get_terminal_output',
      input: { id: terminalId },
    },
  });

  await provider.provideLanguageModelChatResponse(
    {
      id: 'ultimate',
      name: 'Ultimate',
      maxInputTokens: 100_000,
      maxOutputTokens: 8_000,
      isBYOK: true,
      isUserSelectable: true,
      capabilities: { toolCalling: true },
    },
    [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        content: [
          new vscode.LanguageModelTextPart(
            `[Terminal ${terminalId} notification: command completed. The terminal has been cleaned up.]\nTerminal output:\n22/22 tests passed`,
          ),
        ],
      },
    ],
    { tools: [], toolMode: undefined },
    { report() {} },
    cancellationToken(),
  );

  assert.deepEqual(continuedWith, {
    callId,
    text: '22/22 tests passed',
    isError: false,
  });
  assert.equal(closeCount, 1);
  assert.equal(provider.nativeSessions.size, 0);
  provider.dispose();
});

test('does not apply maxTurns as a second per-tool call limit', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const qoderCallId = 'toolu_31';
  const proxyRequest = {
    proxyName,
    input: { filePath: 'README.md' },
    result: {
      promise: Promise.resolve(),
      resolve() {},
      reject() {},
    },
  };
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.messages = {
    async next() {
      return {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: qoderCallId,
              name: proxyName,
              input: proxyRequest.input,
            },
          ],
        },
      };
    },
  };
  session.seenToolCalls = new Set(
    Array.from({ length: 30 }, (_, index) => `toolu_${index + 1}`),
  );
  session.proxyTools = new Map([
    [proxyName, { name: 'read_file', proxyName }],
  ]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return proxyRequest; } }],
  ]);
  session.pendingCalls = new Map();
  session.maxNativeToolCalls = 30;
  session.toolCallCount = 30;

  const boundary = await session.consumeUntilBoundary({ report() {} });

  assert.deepEqual(boundary, {
    kind: 'tool_call',
    invocation: {
      callId: `qoder-native-${qoderCallId}`,
      name: 'read_file',
      input: { filePath: 'README.md' },
    },
  });
});

test('cancels a native session when the host tool queue never dispatches', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  let cancelledReason;
  session.nativeToolResultTimeoutMs = 20;
  session.sdkIdleTimeoutMs = 20;
  session.closed = false;
  session.messages = {
    async next() {
      return {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_queue_timeout',
            name: proxyName,
            input: { filePath: 'README.md' },
          }],
        },
      };
    },
  };
  session.proxyTools = new Map([
    [proxyName, { name: 'read_file', proxyName }],
  ]);
  let rejectWaitingProxy;
  const proxyQueue = {
    next() {
      return new Promise((_, reject) => { rejectWaitingProxy = reject; });
    },
    close(error) {
      rejectWaitingProxy?.(error);
    },
  };
  session.proxyRequests = new Map([
    [proxyName, proxyQueue],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.cancel = async (reason) => {
    cancelledReason = reason;
    session.closed = true;
    proxyQueue.close(new Error('queue closed during cancellation'));
  };

  await assert.rejects(
    session.consumeUntilBoundary({ report() {} }),
    /did not dispatch native proxy .* within 1 second/,
  );
  assert.match(cancelledReason, /qoderBridge\.sdkIdleTimeoutMs/);
});

test('cancels a native session when VS Code never returns the host result', async () => {
  const proxyName = 'qoder_native_0_read_file';
  let rejectResult;
  const resultPromise = new Promise((_, reject) => {
    rejectResult = reject;
  });
  // Keep the intentionally rejected proxy promise observed while exercising
  // the watchdog, matching the SDK's MCP consumer in a real session.
  resultPromise.catch(() => undefined);
  const proxyRequest = {
    proxyName,
    input: { filePath: 'README.md' },
    result: {
      promise: resultPromise,
      resolve() {},
      reject: rejectResult,
    },
  };
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  let cancelledReason;
  session.nativeToolResultTimeoutMs = 20;
  session.closed = false;
  session.messages = {
    async next() {
      return {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_result_timeout',
            name: proxyName,
            input: proxyRequest.input,
          }],
        },
      };
    },
  };
  session.proxyTools = new Map([
    [proxyName, { name: 'read_file', proxyName }],
  ]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return proxyRequest; } }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.cancel = async (reason) => {
    cancelledReason = reason;
    session.closed = true;
  };

  const boundary = await session.consumeUntilBoundary({ report() {} });
  assert.equal(boundary.kind, 'tool_call');
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.match(cancelledReason, /did not return a result within 1 seconds/);
  assert.equal(session.pendingCalls.size, 0);
});

test('clears the native result watchdog after a successful host result', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const proxyResult = (() => {
    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    return {
      promise,
      resolve: resolvePromise,
      reject() {},
    };
  })();
  const proxyRequest = {
    proxyName,
    input: { filePath: 'README.md' },
    result: proxyResult,
  };
  const messages = [
    {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_success',
          name: proxyName,
          input: proxyRequest.input,
        }],
      },
    },
    { type: 'result', subtype: 'success', result: 'done', errors: [] },
  ];
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  let cancelled = false;
  let closed = 0;
  session.nativeToolResultTimeoutMs = 20;
  session.closed = false;
  session.messages = { async next() { return messages.shift(); } };
  session.proxyTools = new Map([
    [proxyName, { name: 'read_file', proxyName }],
  ]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return proxyRequest; } }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.cancel = async () => {
    cancelled = true;
  };
  session.close = async () => {
    closed += 1;
  };

  const boundary = await session.consumeUntilBoundary({ report() {} });
  assert.equal(boundary.kind, 'tool_call');
  const done = await session.continueWithToolResult(
    {
      callId: boundary.invocation.callId,
      text: 'file contents',
      isError: false,
    },
    { report() {} },
  );

  assert.deepEqual(done, { kind: 'done' });
  assert.equal(closed, 1);
  assert.equal(session.pendingCalls.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(cancelled, false);
  assert.deepEqual(await proxyResult.promise, {
    content: [{ type: 'text', text: 'file contents' }],
    isError: false,
  });
});

test('SDK idle timeout does not limit the VS Code host tool runtime', async () => {
  const proxyName = 'qoder_native_0_read_file';
  let resolveResult;
  const proxyRequest = {
    proxyName,
    input: { filePath: 'README.md' },
    result: {
      promise: new Promise((resolve) => { resolveResult = resolve; }),
      resolve(value) { resolveResult(value); },
      reject() {},
    },
  };
  const messages = [
    {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_long_host_operation',
          name: proxyName,
          input: proxyRequest.input,
        }],
      },
    },
    { type: 'result', subtype: 'success', result: 'done', errors: [] },
  ];
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.sdkIdleTimeoutMs = 20;
  session.nativeToolResultTimeoutMs = 1_000;
  session.closed = false;
  session.messages = { async next() { return messages.shift(); } };
  session.proxyTools = new Map([[proxyName, { name: 'read_file', proxyName }]]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return proxyRequest; } }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.close = async () => {};
  let cancelled = false;
  session.cancel = async () => { cancelled = true; };

  const boundary = await session.consumeUntilBoundary({ report() {} });
  assert.equal(boundary.kind, 'tool_call');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cancelled, false);
  const done = await session.continueWithToolResult({
    callId: boundary.invocation.callId,
    text: 'host result',
    isError: false,
  }, { report() {} });
  assert.deepEqual(done, { kind: 'done' });
});

test('cancels when the SDK stops producing messages after a host result', async () => {
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.sdkIdleTimeoutMs = 20;
  session.nativeToolResultTimeoutMs = 1_800_000;
  session.closed = false;
  session.messages = { next: () => new Promise(() => {}) };
  let cancelledReason;
  session.cancel = async (reason) => {
    cancelledReason = reason;
    session.closed = true;
  };

  let safetyTimeout;
  try {
    await assert.rejects(
      Promise.race([
        session.consumeUntilBoundary({ report() {} }),
        new Promise((_, reject) => {
          safetyTimeout = setTimeout(() => {
            reject(new Error('SDK idle watchdog did not fire'));
          }, 150);
        }),
      ]),
      /Qoder SDK did not produce a message within 1 second/,
    );
  } finally {
    clearTimeout(safetyTimeout);
  }
  assert.match(cancelledReason, /qoderBridge\.sdkIdleTimeoutMs/);
});

test('SDK idle timeout resets on each message and never caps an active session', async () => {
  const messages = [
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'a' } } },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'b' } } },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'c' } } },
    { type: 'result', subtype: 'success', result: 'abc', errors: [] },
  ];
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.sdkIdleTimeoutMs = 50;
  session.closed = false;
  session.messages = {
    async next() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return messages.shift();
    },
  };
  let cancelled = false;
  let closed = false;
  session.cancel = async () => { cancelled = true; };
  session.close = async () => { closed = true; };
  const chunks = [];

  const boundary = await session.consumeUntilBoundary({
    report(part) { chunks.push(part.value); },
  });

  assert.deepEqual(boundary, { kind: 'done' });
  assert.deepEqual(chunks, ['a', 'b', 'c']);
  assert.equal(closed, true);
  assert.equal(cancelled, false);
});

test('dispatches every tool use from one assistant message', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const requests = ['first.txt', 'second.txt'].map((filePath) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {
      proxyName,
      input: { filePath },
      result: { promise, resolve, reject() {} },
    };
  });
  const messages = [
    {
      type: 'assistant',
      message: {
        content: requests.map((request, index) => ({
          type: 'tool_use',
          id: `toolu_parallel_${index + 1}`,
          name: proxyName,
          input: request.input,
        })),
      },
    },
    { type: 'result', subtype: 'success', result: 'done', errors: [] },
  ];
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.nativeToolResultTimeoutMs = 1_000;
  session.closed = false;
  session.messages = { async next() { return messages.shift(); } };
  session.proxyTools = new Map([[proxyName, { name: 'read_file', proxyName }]]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return requests.shift(); } }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.close = async () => {};

  const first = await session.consumeUntilBoundary({ report() {} });
  assert.equal(first.invocation.callId, 'qoder-native-toolu_parallel_1');
  assert.deepEqual(first.invocation.input, { filePath: 'first.txt' });

  const second = await session.continueWithToolResult({
    callId: first.invocation.callId,
    text: 'first result',
    isError: false,
  }, { report() {} });
  assert.equal(second.invocation.callId, 'qoder-native-toolu_parallel_2');
  assert.deepEqual(second.invocation.input, { filePath: 'second.txt' });

  const done = await session.continueWithToolResult({
    callId: second.invocation.callId,
    text: 'second result',
    isError: false,
  }, { report() {} });
  assert.deepEqual(done, { kind: 'done' });
  assert.equal(session.pendingCalls.size, 0);
});

test('matches parallel callbacks by input when one proxy queues them out of order', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const requests = ['second.txt', 'first.txt'].map((filePath) => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return {
      proxyName,
      input: { filePath },
      result: { promise, resolve, reject() {} },
    };
  });
  const messages = [
    {
      type: 'assistant',
      message: {
        content: ['first.txt', 'second.txt'].map((filePath, index) => ({
          type: 'tool_use',
          id: `toolu_reordered_${index + 1}`,
          name: proxyName,
          input: { filePath },
        })),
      },
    },
    { type: 'result', subtype: 'success', result: 'done', errors: [] },
  ];
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.unmatchedProxyRequests = new Map();
  session.nativeToolResultTimeoutMs = 1_000;
  session.closed = false;
  session.messages = { async next() { return messages.shift(); } };
  session.proxyTools = new Map([[proxyName, { name: 'read_file', proxyName }]]);
  session.proxyRequests = new Map([
    [proxyName, { async next() { return requests.shift(); } }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.close = async () => {};

  const first = await session.consumeUntilBoundary({ report() {} });
  assert.equal(first.invocation.callId, 'qoder-native-toolu_reordered_1');
  assert.deepEqual(first.invocation.input, { filePath: 'first.txt' });

  const second = await session.continueWithToolResult({
    callId: first.invocation.callId,
    text: 'first result',
    isError: false,
  }, { report() {} });
  assert.equal(second.invocation.callId, 'qoder-native-toolu_reordered_2');
  assert.deepEqual(second.invocation.input, { filePath: 'second.txt' });

  const done = await session.continueWithToolResult({
    callId: second.invocation.callId,
    text: 'second result',
    isError: false,
  }, { report() {} });
  assert.deepEqual(done, { kind: 'done' });
});

test('matches a proxy callback after Zod strips undeclared input fields', async () => {
  const proxyName = 'qoder_native_0_read_file';
  const proxyRequest = {
    proxyName,
    input: { filePath: 'README.md' },
    result: {
      promise: Promise.resolve(),
      resolve() {},
      reject() {},
    },
  };
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.unmatchedProxyRequests = new Map();
  session.nativeToolResultTimeoutMs = 20;
  session.closed = false;
  session.messages = {
    async next() {
      return {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_zod_strips_unknown',
            name: proxyName,
            input: { filePath: 'README.md', undeclared: 'removed by Zod' },
          }],
        },
      };
    },
  };
  session.proxyTools = new Map([[proxyName, {
    name: 'read_file',
    proxyName,
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath'],
    },
  }]]);
  let requestDelivered = false;
  session.proxyRequests = new Map([
    [proxyName, {
      async next() {
        if (requestDelivered) {
          return new Promise(() => {});
        }
        requestDelivered = true;
        return proxyRequest;
      },
    }],
  ]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();
  session.cancel = async () => {};

  const boundary = await session.consumeUntilBoundary({ report() {} });
  assert.equal(boundary.kind, 'tool_call');
  assert.deepEqual(boundary.invocation.input, { filePath: 'README.md' });
  clearTimeout(session.pendingCalls.get(boundary.invocation.callId).timeout);
});

test('rejects a single proxy callback with mismatched arguments', async () => {
  const proxyName = 'qoder_native_0_read_file';
  let rejectResult;
  const proxyResult = new Promise((_, reject) => { rejectResult = reject; });
  const rejected = proxyResult.catch((error) => error);
  const session = Object.create(NativeQoderSession.prototype);
  session.queuedToolCalls = [];
  session.unmatchedProxyRequests = new Map();
  session.nativeToolResultTimeoutMs = 1_000;
  session.sdkIdleTimeoutMs = 20;
  session.closed = false;
  session.messages = {
    async next() {
      return {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: 'toolu_expected',
            name: proxyName,
            input: { filePath: 'expected.txt' },
          }],
        },
      };
    },
  };
  session.proxyTools = new Map([[proxyName, { name: 'read_file', proxyName }]]);
  session.proxyRequests = new Map([[proxyName, {
    async next() {
      return {
        proxyName,
        input: { filePath: 'wrong.txt' },
        result: { promise: proxyResult, resolve() {}, reject: rejectResult },
      };
    },
  }]]);
  session.seenToolCalls = new Set();
  session.pendingCalls = new Map();

  await assert.rejects(
    session.consumeUntilBoundary({ report() {} }),
    /arguments that do not match the pending tool call/,
  );
  assert.match((await rejected).message, /arguments that do not match/);
});

test('cancellation rejects deferred proxy callbacks', async () => {
  let rejectResult;
  const proxyResult = new Promise((_, reject) => { rejectResult = reject; });
  const rejected = proxyResult.catch((error) => error);
  const session = Object.create(NativeQoderSession.prototype);
  session.closed = false;
  session.pendingCalls = new Map();
  session.messages = { close() {} };
  session.proxyRequests = new Map();
  session.unmatchedProxyRequests = new Map([['proxy', [{
    proxyName: 'proxy',
    input: {},
    result: { promise: proxyResult, resolve() {}, reject: rejectResult },
  }]]]);
  session.abortController = new AbortController();
  session.q = { async close() {} };
  session.pumpPromise = Promise.resolve();

  await session.cancel();

  assert.equal(session.unmatchedProxyRequests.size, 0);
  assert.match((await rejected).message, /cancelled/);
});

test('cancel does not wait for an unresponsive SDK interrupt', async () => {
  const session = Object.create(NativeQoderSession.prototype);
  session.closed = false;
  session.messages = { close() {} };
  session.proxyRequests = new Map();
  session.pendingCalls = new Map();
  session.abortController = new AbortController();
  session.pumpPromise = Promise.resolve();
  let closeCalled = false;
  session.q = {
    interrupt: () => new Promise(() => {}),
    close: async () => { closeCalled = true; },
  };

  let safetyTimeout;
  try {
    await Promise.race([
      session.cancel('test cancellation'),
      new Promise((_, reject) => {
        safetyTimeout = setTimeout(() => reject(new Error('cancel stalled')), 150);
      }),
    ]);
  } finally {
    clearTimeout(safetyTimeout);
  }
  assert.equal(session.abortController.signal.aborted, true);
  assert.equal(closeCalled, true);
});

test('close does not wait for an unresponsive SDK shutdown', async () => {
  const session = Object.create(NativeQoderSession.prototype);
  session.closed = false;
  session.messages = { close() {} };
  session.proxyRequests = new Map();
  session.pendingCalls = new Map();
  session.abortController = new AbortController();
  session.pumpPromise = new Promise(() => {});
  let closeCalled = false;
  session.q = {
    close: () => {
      closeCalled = true;
      return new Promise(() => {});
    },
  };

  let safetyTimeout;
  try {
    await Promise.race([
      session.close(),
      new Promise((_, reject) => {
        safetyTimeout = setTimeout(() => reject(new Error('close stalled')), 150);
      }),
    ]);
  } finally {
    clearTimeout(safetyTimeout);
  }
  assert.equal(session.abortController.signal.aborted, true);
  assert.equal(closeCalled, true);
});

test('provider restarts from transcript when a native result has no live session', async () => {
  const callId = 'qoder-native-stale-call';
  const messages = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('Finish the coding task.')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelToolCallPart(
          callId,
          'read_file',
          { filePath: 'README.md' },
        ),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelToolResultPart(
          callId,
          [new vscode.LanguageModelTextPart('previous tool result')],
        ),
      ],
    },
  ];
  let restartCount = 0;
  const provider = new QoderModelProvider({
    async get() {
      return 'fake-token';
    },
  });
  provider.startNativeSession = async (...args) => {
    restartCount += 1;
    assert.equal(args[5], messages);
  };

  await provider.provideLanguageModelChatResponse(
    {
      id: 'ultimate',
      name: 'Ultimate',
      maxInputTokens: 1_000_000,
      maxOutputTokens: 8_000,
      isBYOK: true,
      isUserSelectable: true,
      capabilities: { toolCalling: true },
    },
    messages,
    {
      tools: [
        {
          name: 'read_file',
          description: 'Read a file.',
          inputSchema: { type: 'object' },
        },
      ],
      toolMode: undefined,
    },
    { report() {} },
    cancellationToken(),
  );

  assert.equal(restartCount, 1);
  provider.dispose();
});
