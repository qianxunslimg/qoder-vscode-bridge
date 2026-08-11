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

test('keeps all 91 host tools when using the default limit', () => {
  const tools = Array.from({ length: 91 }, (_, index) => ({
    name: `host_tool_${index}`,
    description: `Host tool ${index}.`,
    inputSchema: { type: 'object' },
  }));

  const selected = selectNativeTools(tools, 91);

  assert.equal(selected.length, 91);
  assert.deepEqual(
    selected.map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
});

test('prefers the host read_file over the workspace-only fallback', () => {
  const selected = selectNativeTools([
    {
      name: 'qoder_read_file',
      description: 'Read a UTF-8 file inside the current workspace.',
      inputSchema: { type: 'object' },
    },
    {
      name: 'read_file',
      description: 'Read files and VS Code chat-session resources.',
      inputSchema: { type: 'object' },
    },
  ], 91);

  assert.deepEqual(selected.map((tool) => tool.name), ['read_file']);
});

test('keeps qoder_read_file when the host has no native read_file', () => {
  const selected = selectNativeTools([
    {
      name: 'qoder_read_file',
      description: 'Read a UTF-8 file inside the current workspace.',
      inputSchema: { type: 'object' },
    },
  ], 91);

  assert.deepEqual(selected.map((tool) => tool.name), ['qoder_read_file']);
});
