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
      'Run Bash exactly once with command "printf PROVIDER_NATIVE_LOOP_OK" and then reply with exactly PROVIDER_NATIVE_LOOP_OK.',
    ),
  ],
};
const hostToolNames = [
  'Agent',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'ImageGen',
  'ImageSearch',
  'NotebookEdit',
  'Read',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'WebFetch',
  'WebSearch',
  'Write',
  'qoder_read_file',
  ...Array.from({ length: 72 }, (_, index) => `OptionalProviderTool${index}`),
];
const options = {
  tools: hostToolNames.map((name) => ({
    name,
    description:
      name === 'Bash'
        ? 'Run one shell command in the workspace.'
        : name === 'qoder_read_file'
          ? 'Read a workspace file.'
          : `Host tool ${name}.`,
    inputSchema:
      name === 'Bash'
        ? {
            type: 'object',
            properties: {
              command: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['command'],
          }
        : name === 'qoder_read_file'
          ? {
              type: 'object',
              properties: {
                file_path: { type: 'string' },
                offset: { type: 'number' },
                limit: { type: 'number' },
              },
              required: ['file_path'],
            }
          : { type: 'object', properties: {} },
  })),
  toolMode: vscode.LanguageModelChatToolMode?.Auto,
};

try {
  const greetingProgress = progressRecorder();
  await provider.provideLanguageModelChatResponse(
    model,
    [
      {
        role: vscode.LanguageModelChatMessageRole.User,
        name: undefined,
        content: [
          new vscode.LanguageModelTextPart(
            '你好。这只是普通对话，不要使用任何工具，只回复 GREETING_OK。',
          ),
        ],
      },
    ],
    options,
    greetingProgress,
    token(),
  );
  const greetingToolCalls = greetingProgress.parts.filter(
    (part) => part instanceof vscode.LanguageModelToolCallPart,
  );
  const greetingText = greetingProgress.parts
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
  assert.equal(greetingToolCalls.length, 0);
  assert.match(greetingText, /GREETING_OK/);

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
  const firstText = firstProgress.parts
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
  assert.doesNotMatch(
    firstText,
    /已启用 VS Code 原生工具循环|进度摘要：步骤|等待 VS Code 执行结果/,
  );
  assert.equal(toolCalls.length, 1);
  const [toolCall] = toolCalls;
  assert.equal(toolCall.name, 'Bash');

  const nativeTool = new QoderReadFileTool();
  const readToolResult = await nativeTool.invoke(
    { input: { file_path: readmePath, limit: 3 }, toolInvocationToken: undefined },
    token(),
  );
  assert.ok(readToolResult.content.length > 0);
  assert.match(readToolResult.content[0].value, /Lines/);

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
        [new vscode.LanguageModelTextPart('stdout: PROVIDER_NATIVE_LOOP_OK')],
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
  assert.doesNotMatch(finalText, /已收到工具结果|正在继续分析/);

  console.log(
    JSON.stringify({
      marker: 'PROVIDER_NATIVE_TOOL_LOOP_OK',
      greetingToolCalls: greetingToolCalls.length,
      toolCalls: toolCalls.length,
      toolName: toolCall.name,
      availableTools: options.tools.length,
      nativeResultLines: readToolResult.content[0].value.split('\n').length,
      final: finalText.trim(),
    }),
  );
} finally {
  provider.dispose();
}
