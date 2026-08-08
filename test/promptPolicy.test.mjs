import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactPromptEntries,
  stripCopilotHostInstructions,
} from '../out/promptPolicy.js';

test('removes Copilot host instructions but preserves the current user request', () => {
  const hostEnvelope = [
    'You are an expert AI programming assistant, working with a user in the VS Code editor.',
    'When asked for your name, you must respond with "GitHub Copilot".',
    'Follow Microsoft content policies.',
    '<instructions>very long host instructions</instructions>',
    '<context>large editor context</context>',
    '<userRequest>你好</userRequest>',
  ].join('\n');

  assert.equal(stripCopilotHostInstructions(hostEnvelope), '你好');
});

test('keeps the newest conversation entries when the prompt exceeds the budget', () => {
  const entries = [
    { label: 'user', text: 'old context '.repeat(20) },
    { label: 'assistant', text: 'old answer '.repeat(20) },
    { label: 'user', text: 'current request: inspect config.cpp' },
  ];

  const compacted = compactPromptEntries(entries, 120);
  const text = compacted.map((entry) => entry.text).join('\n');

  assert.match(text, /current request: inspect config\.cpp/);
  assert.match(text, /earlier conversation omitted/i);
  assert.ok(text.length <= 120);
});
