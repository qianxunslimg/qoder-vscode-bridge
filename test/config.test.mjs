import assert from 'node:assert/strict';
import test from 'node:test';

import '../scripts/vscode-mock-require.cjs';
import vscode from '../scripts/vscode-mock-runtime.cjs';

const {
  readConfig,
  DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS,
  DEFAULT_SDK_IDLE_TIMEOUT_MS,
} = await import('../out/config.js');

test('exposes the complete current VS Code host tool set by default', () => {
  assert.equal(readConfig().maxNativeTools, 91);
});

test('keeps inline references bounded by default', () => {
  assert.equal(readConfig().maxInlineReferenceChars, 24000);
});

test('waits five minutes for a native tool result by default', () => {
  assert.equal(
    readConfig().nativeToolResultTimeoutMs,
    DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS,
  );
});

test('bounds SDK message inactivity independently of host tool duration', () => {
  assert.equal(readConfig().sdkIdleTimeoutMs, DEFAULT_SDK_IDLE_TIMEOUT_MS);

  const original = vscode.workspace.getConfiguration;
  try {
    vscode.workspace.getConfiguration = () => ({
      get(key, fallback) {
        if (key === 'sdkIdleTimeoutMs') return 1;
        if (key === 'nativeToolResultTimeoutMs') return 1_800_000;
        return fallback;
      },
    });
    assert.equal(readConfig().sdkIdleTimeoutMs, 30_000);
    assert.equal(readConfig().nativeToolResultTimeoutMs, 1_800_000);

    vscode.workspace.getConfiguration = () => ({
      get(key, fallback) {
        return key === 'sdkIdleTimeoutMs' ? Number.POSITIVE_INFINITY : fallback;
      },
    });
    assert.equal(readConfig().sdkIdleTimeoutMs, DEFAULT_SDK_IDLE_TIMEOUT_MS);
  } finally {
    vscode.workspace.getConfiguration = original;
  }
});

test('enables bridge diagnostics by default', () => {
  assert.equal(readConfig().debugLogging, true);
});
