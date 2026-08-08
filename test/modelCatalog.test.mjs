import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelQueryOptions,
  catalogToDescriptors,
  modelInfoToDescriptor,
} from '../out/modelCatalog.js';
import { descriptorToInformation } from '../out/modelInformation.js';

test('marks Qoder models selectable and Agent-mode compatible', () => {
  const info = descriptorToInformation({
    id: 'qmodel_38max',
    name: 'Qwen3.8-Max',
    maxInputTokens: 968_000,
    maxOutputTokens: 32_000,
    maxContextWindow: 1_000_000,
    imageInput: true,
  });

  assert.equal(info.isUserSelectable, true);
  assert.equal(info.isBYOK, true);
  assert.equal(info.capabilities.toolCalling, true);
});

test('maps a Qoder frontier model to its real id and maximum context', () => {
  const descriptor = modelInfoToDescriptor({
    value: 'qmodel_38max',
    displayName: 'Qwen3.8-Max',
    isEnabled: true,
    isVl: true,
    priceFactor: 0.5,
    maxInputTokens: 180_000,
    maxOutputTokens: 32_000,
    availableContextWindows: [200_000, 400_000, 1_000_000],
    defaultContextWindow: 200_000,
  });

  assert.ok(descriptor);
  assert.equal(descriptor.id, 'qmodel_38max');
  assert.equal(descriptor.name, 'Qwen3.8-Max');
  assert.equal(descriptor.maxContextWindow, 1_000_000);
  assert.equal(descriptor.maxOutputTokens, 32_000);
  assert.equal(descriptor.maxInputTokens, 968_000);
  assert.equal(descriptor.imageInput, true);
});

test('filters disabled models and preserves account catalog order', () => {
  const descriptors = catalogToDescriptors([
    {
      value: 'first',
      displayName: 'First',
      isEnabled: true,
      maxInputTokens: 100,
      maxOutputTokens: 20,
    },
    {
      value: 'disabled',
      displayName: 'Disabled',
      isEnabled: false,
      maxInputTokens: 100,
      maxOutputTokens: 20,
    },
    {
      value: 'second',
      displayName: 'Second',
      isEnabled: true,
      maxInputTokens: 200,
      maxOutputTokens: 20,
    },
  ]);

  assert.deepEqual(
    descriptors.map((model) => model.id),
    ['first', 'second'],
  );
});

test('routes the selected concrete model with its maximum context window', () => {
  const options = buildModelQueryOptions({
    id: 'dmodel',
    name: 'DeepSeek-V4-Pro',
    maxInputTokens: 968_000,
    maxOutputTokens: 32_000,
    maxContextWindow: 1_000_000,
    imageInput: true,
  });

  assert.deepEqual(options, {
    model: 'dmodel',
    extraArgs: { 'context-window': '1000000' },
  });
});

test('does not send a context flag when the catalog has no context metadata', () => {
  const options = buildModelQueryOptions({
    id: 'auto',
    name: 'Auto',
    maxInputTokens: 114_688,
    maxOutputTokens: 8_192,
    imageInput: false,
  });

  assert.deepEqual(options, { model: 'auto' });
});
