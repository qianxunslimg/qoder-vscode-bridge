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

test('removes the compact Copilot context envelope seen in native Agent requests', () => {
  const hostEnvelope = [
    '<context>',
    'The current date is 2026-08-09.',
    'Terminals: zsh',
    '</context>',
    '<reminderInstructions>',
    'Prefer replace_string_in_file for edits.',
    '</reminderInstructions>',
    '<userRequest>检查当前改动并给出结论</userRequest>',
  ].join('\n');

  assert.equal(
    stripCopilotHostInstructions(hostEnvelope),
    '检查当前改动并给出结论',
  );
});

test('keeps user-authored userRequest XML without a Copilot envelope', () => {
  const xml = '示例：<userRequest>保留这段 XML</userRequest>';
  assert.equal(stripCopilotHostInstructions(xml), xml);
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

test('bounds old assistant activity while preserving its final summary', () => {
  const compacted = compactPromptEntries([
    {
      label: 'assistant',
      text: `${'old tool output\n'.repeat(4_000)}FINAL_REVIEW_SUMMARY`,
    },
    { label: 'user', text: '继续修复这个问题' },
  ]);
  const text = compacted.map((entry) => entry.text).join('\n');

  assert.match(text, /Earlier assistant activity omitted/);
  assert.match(text, /FINAL_REVIEW_SUMMARY/);
  assert.match(text, /继续修复这个问题/);
  assert.ok(text.length < 13_000);
});
