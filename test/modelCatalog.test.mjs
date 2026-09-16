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
    description: 'Reasoning model',
    isEnabled: true,
    isVl: true,
    isReasoning: true,
    efforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'medium',
    supportsDisabled: true,
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
  assert.equal(descriptor.priceFactor, 0.5);
  assert.match(descriptor.detail ?? '', /0\.5x/);
  assert.deepEqual(descriptor.efforts, ['low', 'medium', 'xhigh']);
  assert.equal(descriptor.defaultEffort, 'medium');
  assert.equal(descriptor.supportsDisabled, true);
});

test('does not display a misleading zero price factor', () => {
  const descriptor = modelInfoToDescriptor({
    value: 'free-model',
    displayName: 'Free model',
    isEnabled: true,
    priceFactor: 0,
    maxInputTokens: 100,
    maxOutputTokens: 20,
  });

  assert.ok(descriptor);
  assert.equal(descriptor.priceFactor, undefined);
  assert.doesNotMatch(descriptor.detail ?? '', /0x/);
  assert.match(descriptor.detail ?? '', /free/);
});

test('prefers a numeric credit factor when the catalog also marks a model free', () => {
  const descriptor = modelInfoToDescriptor({
    value: 'qmodel_38max',
    displayName: 'Qwen3.8-Max',
    isEnabled: true,
    isFree: true,
    priceFactor: 0.5,
    maxInputTokens: 100,
    maxOutputTokens: 20,
  });

  assert.ok(descriptor);
  assert.equal(descriptor.priceFactor, 0.5);
  assert.match(descriptor.detail ?? '', /0\.5x/);
  assert.doesNotMatch(descriptor.detail ?? '', /free/);
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

test('uses the server default context when requested', () => {
  const options = buildModelQueryOptions(
    {
      id: 'kmodel_latest',
      maxContextWindow: 1_000_000,
      defaultContextWindow: 200_000,
      efforts: ['low', 'high', 'max'],
      supportsDisabled: true,
    },
    { contextWindowPolicy: 'default', reasoningEffort: 'high' },
  );

  assert.deepEqual(options, {
    model: 'kmodel_latest',
    extraArgs: {
      'context-window': '200000',
      'reasoning-effort': 'high',
    },
  });
});

test('uses a per-model context override when it is advertised', () => {
  const options = buildModelQueryOptions(
    {
      id: 'kmodel',
      maxContextWindow: 1_000_000,
      defaultContextWindow: 200_000,
      availableContextWindows: [200_000, 1_000_000],
    },
    { contextWindow: 200_000, contextWindowPolicy: 'maximum' },
  );

  assert.deepEqual(options, {
    model: 'kmodel',
    extraArgs: { 'context-window': '200000' },
  });
});

test('does not send an unsupported reasoning effort', () => {
  const options = buildModelQueryOptions(
    {
      id: 'kmodel',
      maxContextWindow: 256_000,
      efforts: [],
      supportsDisabled: false,
    },
    { contextWindowPolicy: 'maximum', reasoningEffort: 'max' },
  );

  assert.deepEqual(options, {
    model: 'kmodel',
    extraArgs: { 'context-window': '256000' },
  });
});

test('can explicitly disable thinking when the model advertises it', () => {
  const options = buildModelQueryOptions(
    {
      id: 'qmodel',
      supportsDisabled: true,
    },
    { reasoningEffort: 'off' },
  );

  assert.deepEqual(options, {
    model: 'qmodel',
    extraArgs: { 'reasoning-effort': 'off' },
  });
});
