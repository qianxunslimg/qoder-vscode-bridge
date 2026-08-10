import assert from 'node:assert/strict';
import test from 'node:test';

import '../scripts/vscode-mock-require.cjs';

const { readConfig } = await import('../out/config.js');

test('exposes the complete current VS Code host tool set by default', () => {
  assert.equal(readConfig().maxNativeTools, 91);
});
