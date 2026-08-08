import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { QoderModelProvider } from '../out/provider.js';
import { QoderReadFileTool } from '../out/nativeReadFileTool.js';

const require = createRequire(import.meta.url);
const vscode = require('vscode');
const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim();
if (!pat) {
  console.error('QODER_PERSONAL_ACCESS_TOKEN is required');
  process.exit(2);
}

function token() {
  return {
    isCancellationRequested: false,
    onCancellationRequested() {
      return { dispose() {} };
    },
  };
}

function progressRecorder() {
  const parts = [];
  return {
    parts,
    report(part) {
      parts.push(part);
    },
  };
}

const cwd = process.cwd();
const readmePath = `${cwd}/README.md`;
const model = {
  id: 'qmodel_38max',
  qoderId: 'qmodel_38max',
  name: 'Qwen3.8-Max',
  family: 'qoder-agent',
  version: 'qmodel_38max',
  maxInputTokens: 900000,
  maxOutputTokens: 8192,
  maxContextWindow: 1000000,
  isBYOK: true,
  isUserSelectable: true,
  capabilities: { toolCalling: true },
};

const provider = new QoderModelProvider({
  async get() {
    return pat;
  },
});

const userMessage = {
  role: vscode.LanguageModelChatMessageRole.User,
  name: undefined,
  content: [
    new vscode.LanguageModelTextPart(
      `Read ${readmePath} and then reply with exactly PROVIDER_NATIVE_LOOP_OK.`,
    ),
  ],
};
const options = {
  tools: [
    {
      name: 'qoder_read_file',
      description: 'Read a workspace file.',
      inputSchema: { type: 'object' },
    },
  ],
  toolMode: vscode.LanguageModelChatToolMode?.Auto,
};

try {
  const firstProgress = progressRecorder();
  await provider.provideLanguageModelChatResponse(
    model,
    [userMessage],
    options,
    firstProgress,
    token(),
  );
  const toolCalls = firstProgress.parts.filter(
    (part) => part instanceof vscode.LanguageModelToolCallPart,
  );
  assert.equal(toolCalls.length, 1);
  const [toolCall] = toolCalls;
  assert.equal(toolCall.name, 'qoder_read_file');

  const nativeTool = new QoderReadFileTool();
  const nativeResult = await nativeTool.invoke(
    { input: toolCall.input, toolInvocationToken: undefined },
    token(),
  );
  assert.ok(nativeResult.content.length > 0);
  assert.match(nativeResult.content[0].value, /Lines/);

  const assistantMessage = {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    name: undefined,
    content: [toolCall],
  };
  const toolResultMessage = {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [
      new vscode.LanguageModelToolResultPart(
        toolCall.callId,
        nativeResult.content,
      ),
    ],
  };
  const secondProgress = progressRecorder();
  await provider.provideLanguageModelChatResponse(
    model,
    [userMessage, assistantMessage, toolResultMessage],
    options,
    secondProgress,
    token(),
  );
  const finalText = secondProgress.parts
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
  assert.match(finalText, /PROVIDER_NATIVE_LOOP_OK/);

  console.log(
    JSON.stringify({
      marker: 'PROVIDER_NATIVE_TOOL_LOOP_OK',
      toolCalls: toolCalls.length,
      nativeResultLines: nativeResult.content[0].value.split('\n').length,
      final: finalText.trim(),
    }),
  );
} finally {
  provider.dispose();
}
