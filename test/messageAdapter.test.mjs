import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import '../scripts/vscode-mock-require.cjs';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const { hasImageInput, messagesToPrompt } = await import('../out/messageAdapter.js');
const { imageDataFromUnknown } = await import('../out/referenceAdapter.js');

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

test('forwards opaque image-shaped parts instead of stringifying their bytes', async () => {
  const bytes = new Uint8Array([3, 4, 5]);
  const part = { mimeType: 'image/png', data: bytes };
  assert.equal(imageDataFromUnknown(part).mimeType, 'image/png');
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [part],
    },
  ]);

  assert.equal(hasImageInput([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [part],
    },
  ]), true);
  const [message] = await collect(prompt);
  const image = message.message.content.find((item) => item.type === 'image');
  assert.deepEqual(image.source, {
    type: 'base64',
    media_type: 'image/png',
    data: Buffer.from(bytes).toString('base64'),
  });
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

test('forwards pasted text data instead of replacing it with a MIME placeholder', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelTextPart('请评审我选中的内容：'),
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode('message Foo {\n  string name = 1;\n}'),
          'text/plain',
        ),
      ],
    },
  ]);

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /\[Attached text \(text\/plain\)\]/);
  assert.match(prompt, /message Foo/);
  assert.doesNotMatch(prompt, /non-text input/);
});

test('forwards a whole-file URI reference with a path the host can read', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode('file:///home/plusai/project/proto/demo.proto\n'),
          'text/uri-list',
        ),
      ],
    },
  ]);

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /Attached file reference/);
  assert.match(prompt, /\/home\/plusai\/project\/proto\/demo\.proto/);
  assert.match(prompt, /read_file/);
});

test('parses VS Code URI-list line fragments as selected ranges', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode('file:///workspace/src/main.cpp#L12,3-L16,8\n'),
          'text/uri-list',
        ),
      ],
    },
  ]);

  assert.match(prompt, /Selected range: lines 12-16, columns 3-8/);
  assert.match(prompt, /\/workspace\/src\/main\.cpp/);
});

test('preserves selected text, file range, and file path from structured references', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelDataPart(
          new TextEncoder().encode(
            JSON.stringify({
              uri: 'file:///workspace/src/config.cpp',
              range: {
                start: { line: 9, character: 2 },
                end: { line: 14, character: 7 },
              },
              selectedText: 'return config.apply();',
            }),
          ),
          'application/json',
        ),
      ],
    },
  ]);

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /\/workspace\/src\/config\.cpp/);
  assert.match(prompt, /Selected range: lines 10-15, columns 2-7/);
  assert.match(prompt, /return config\.apply\(\);/);
});

test('renders unknown VS Code reference-shaped parts', () => {
  const prompt = messagesToPrompt([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        {
          uri: { fsPath: '/workspace/include/config.hpp' },
          range: {
            start: { line: 0, character: 0 },
            end: { line: 3, character: 12 },
          },
          value: 'struct Config {};',
        },
      ],
    },
  ]);

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /\/workspace\/include\/config\.hpp/);
  assert.match(prompt, /Selected range: lines 1-4, columns 0-12/);
  assert.match(prompt, /struct Config/);
});

test('bounds large selected content while retaining a read hint', () => {
  const prompt = messagesToPrompt(
    [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelDataPart(
            new TextEncoder().encode('x'.repeat(100)),
            'text/plain',
          ),
        ],
      },
    ],
    { maxInlineChars: 16 },
  );

  assert.equal(typeof prompt, 'string');
  assert.match(prompt, /x{16}/);
  assert.match(prompt, /已省略/);
});
