import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  NativeQoderSession,
  QODER_READ_FILE_TOOL_NAME,
} from '../out/nativeToolLoop.js';
import {
  QoderReadFileTool,
  readWorkspaceFile,
} from '../out/nativeReadFileTool.js';

const pat = process.env.QODER_PERSONAL_ACCESS_TOKEN?.trim();
if (!pat) {
  console.error('QODER_PERSONAL_ACCESS_TOKEN is required');
  process.exit(2);
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

function token() {
  const listeners = new Set();
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

const cwd = process.cwd();
const readmePath = `${cwd}/README.md`;

async function createSession(prompt) {
  return new NativeQoderSession({
    pat,
    cwd,
    model: process.env.QODER_SMOKE_MODEL?.trim() || 'qmodel_38max',
    extraArgs: { 'context-window': '1000000' },
    permissionMode: 'auto',
    allowDangerouslySkipPermissions: false,
    maxTurns: 6,
    prompt,
    nativeTools: [
      {
        name: QODER_READ_FILE_TOOL_NAME,
        description: 'Read one UTF-8 workspace file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            offset: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['file_path'],
        },
      },
    ],
  });
}

async function runHandoff() {
  const recorder = progressRecorder();
  const session = await createSession(
    [
      `Use ${QODER_READ_FILE_TOOL_NAME} exactly once to read ${readmePath}.`,
      'After the host returns the file content, reply with exactly NATIVE_TOOL_LOOP_OK.',
    ].join('\n'),
  );
  try {
    const first = await session.start(recorder);
    assert.equal(first.kind, 'tool_call');
    assert.equal(first.invocation.name, QODER_READ_FILE_TOOL_NAME);
    const fileContent = await readFile(first.invocation.input.file_path, 'utf8');
    const final = await session.continueWithToolResult(
      {
        callId: first.invocation.callId,
        text: fileContent.slice(0, 500),
        isError: false,
      },
      recorder,
    );
    assert.equal(final.kind, 'done');
    const output = recorder.parts
      .map((part) => part.value ?? '')
      .join('');
    assert.match(output, /NATIVE_TOOL_LOOP_OK/);
    return { marker: 'NATIVE_TOOL_LOOP_OK', toolCalls: 1 };
  } finally {
    await session.close();
  }
}

async function runCancellation() {
  const recorder = progressRecorder();
  const session = await createSession(
    `Use ${QODER_READ_FILE_TOOL_NAME} exactly once to read ${readmePath}.`,
  );
  const first = await session.start(recorder);
  assert.equal(first.kind, 'tool_call');
  await session.cancel('smoke cancellation');
  return { marker: 'NATIVE_TOOL_CANCEL_OK', toolCalls: 1 };
}

async function runErrorRetry() {
  const recorder = progressRecorder();
  const session = await createSession(
    [
      `First call ${QODER_READ_FILE_TOOL_NAME} on ${cwd}/missing-native-file.txt.`,
      'The host will return an error. You must then call the same tool again on README.md and reply with exactly NATIVE_TOOL_RETRY_OK.',
    ].join('\n'),
  );
  try {
    const first = await session.start(recorder);
    assert.equal(first.kind, 'tool_call');
    const retry = await session.continueWithToolResult(
      {
        callId: first.invocation.callId,
        text: 'ENOENT: file does not exist; retry with another path.',
        isError: true,
      },
      recorder,
    );
    assert.equal(retry.kind, 'tool_call');
    assert.equal(retry.invocation.name, QODER_READ_FILE_TOOL_NAME);
    const content = await readFile(readmePath, 'utf8');
    const final = await session.continueWithToolResult(
      {
        callId: retry.invocation.callId,
        text: content.slice(0, 500),
        isError: false,
      },
      recorder,
    );
    assert.equal(final.kind, 'done');
    const output = recorder.parts
      .map((part) => part.value ?? '')
      .join('');
    assert.match(output, /NATIVE_TOOL_RETRY_OK/);
    return { marker: 'NATIVE_TOOL_RETRY_OK', toolCalls: 2 };
  } finally {
    await session.close();
  }
}

async function runApprovalAndRead() {
  const readTool = new QoderReadFileTool();
  const prepared = readTool.prepareInvocation(
    { input: { file_path: readmePath } },
    token(),
  );
  assert.ok(prepared.confirmationMessages);
  const result = await readWorkspaceFile(
    { file_path: readmePath, offset: 0, limit: 3 },
    token(),
  );
  assert.match(result, /Lines 1-3/);
  return { marker: 'NATIVE_TOOL_APPROVAL_READY', lines: 3 };
}

try {
  const results = [];
  results.push(await runHandoff());
  results.push(await runCancellation());
  results.push(await runErrorRetry());
  results.push(await runApprovalAndRead());
  console.log(JSON.stringify({ marker: 'NATIVE_TOOL_LOOP_SMOKE_OK', results }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
