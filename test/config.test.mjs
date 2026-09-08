import assert from 'node:assert/strict';
import test from 'node:test';

import '../scripts/vscode-mock-require.cjs';

const {
  readConfig,
  DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS,
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

test('enables bridge diagnostics by default', () => {
  assert.equal(readConfig().debugLogging, true);
});
