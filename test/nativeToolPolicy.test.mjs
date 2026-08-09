import assert from 'node:assert/strict';
import test from 'node:test';

import { selectNativeTools } from '../out/nativeToolPolicy.js';

test('caps optional host tools while retaining core coding tools', () => {
  const optional = Array.from({ length: 60 }, (_, index) => ({
    name: `optional_${index}`,
    description: 'optional provider tool',
    inputSchema: { type: 'object' },
  }));
  const tools = [
    ...optional,
    {
      name: 'run_in_terminal',
      description: `Run a command. ${'verbose '.repeat(80)}`,
      inputSchema: { type: 'object' },
    },
    { name: 'read_file', description: 'Read a file.' },
    { name: 'run_in_terminal', description: 'duplicate' },
  ];

  const selected = selectNativeTools(tools, 8);
  const names = selected.map((tool) => tool.name);

  assert.equal(selected.length, 8);
  assert.equal(new Set(names).size, selected.length);
  assert.ok(names.includes('run_in_terminal'));
  assert.ok(names.includes('read_file'));
  assert.ok(selected.every((tool) => tool.description.length <= 240));
});
