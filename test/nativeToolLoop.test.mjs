import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { z } from 'zod';

import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const {
  nativeToolInputShape,
  normalizeNativeToolInput,
  terminalNotificationToolResult,
} = await import('../out/nativeToolLoop.js');
const { QoderModelProvider } = await import('../out/provider.js');

function cancellationToken() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

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
