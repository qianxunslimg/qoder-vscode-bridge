import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const { hasImageInput, messagesToPrompt } = await import('../out/messageAdapter.js');

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) {
    messages.push(message);
  }
  return messages;
}

test('forwards VS Code image data as a Qoder image content block', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelTextPart('请看这张图'),
        new vscode.LanguageModelDataPart(bytes, 'image/png'),
      ],
    },
  ]);

  assert.equal(
    hasImageInput([
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [new vscode.LanguageModelDataPart(bytes, 'image/png')],
      },
    ]),
    true,
  );
  assert.notEqual(typeof prompt, 'string');
  const [message] = await collect(prompt);
  const content = message.message.content;
  const image = content.find((part) => part.type === 'image');

  assert.ok(image);
  assert.deepEqual(image.source, {
    type: 'base64',
    media_type: 'image/png',
    data: Buffer.from(bytes).toString('base64'),
  });
  assert.match(
    content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
    /请看这张图/,
  );
  assert.doesNotMatch(JSON.stringify(content), /non-text input/);
});

test('keeps ordinary text prompts on the existing string path', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('你好')],
    },
  ]);

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /你好/);
});
