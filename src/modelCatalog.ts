import type { ModelInfo } from '@qoder-ai/qoder-agent-sdk';

const FALLBACK_MAX_INPUT_TOKENS = 114_688;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

export interface QoderModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxContextWindow?: number;
  readonly defaultContextWindow?: number;
  readonly availableContextWindows?: readonly number[];
  readonly imageInput: boolean;
  readonly detail?: string;
  readonly tooltip?: string;
}

export interface QoderModelQueryOptions {
  readonly model: string;
  readonly extraArgs?: Readonly<Record<string, string | null>>;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`;
  }
  if (value >= 1_000 && value % 1_000 === 0) {
    return `${value / 1_000}K`;
  }
  return `${value}`;
}

function maximumContextWindow(model: Pick<ModelInfo, 'availableContextWindows'>):
  number | undefined {
  const windows = model.availableContextWindows
    ?.map(positiveNumber)
    .filter((value): value is number => value !== undefined);
  return windows && windows.length > 0 ? Math.max(...windows) : undefined;
}

function detailForModel(model: ModelInfo, maxContextWindow?: number): string {
  const parts = ['Qoder'];
  if (model.priceFactor !== undefined && Number.isFinite(model.priceFactor)) {
    parts.push(`${model.priceFactor}x`);
  }
  if (model.isFree || model.priceFactor === 0) {
    parts.push('free');
  }
  if (maxContextWindow !== undefined) {
    parts.push(`max ${formatTokenCount(maxContextWindow)}`);
  }
  return parts.join(' · ');
}

export function modelInfoToDescriptor(
  model: ModelInfo,
): QoderModelDescriptor | undefined {
  if (model.isEnabled === false) {
    return undefined;
  }

  const id = (model.value || model.modelId || '').trim();
  if (!id) {
    return undefined;
  }

  const name = model.displayName?.trim() || id;
  const maxOutputTokens =
    positiveNumber(model.maxOutputTokens) ?? FALLBACK_MAX_OUTPUT_TOKENS;
  const maxContextWindow = maximumContextWindow(model);
  const maxInputTokens = maxContextWindow
    ? Math.max(1, maxContextWindow - maxOutputTokens)
    : positiveNumber(model.maxInputTokens) ?? FALLBACK_MAX_INPUT_TOKENS;
  const contextWindows = model.availableContextWindows
    ?.map(positiveNumber)
    .filter((value): value is number => value !== undefined);
  const defaultContextWindow = positiveNumber(model.defaultContextWindow);

  return {
    id,
    name,
    maxInputTokens,
    maxOutputTokens,
    maxContextWindow,
    defaultContextWindow,
    availableContextWindows: contextWindows,
    imageInput: model.isVl === true,
    detail: detailForModel(model, maxContextWindow),
    tooltip: [
      `${name} (${id})`,
      maxContextWindow
        ? `maximum context ${formatTokenCount(maxContextWindow)}`
        : undefined,
      defaultContextWindow
        ? `Qoder default ${formatTokenCount(defaultContextWindow)}`
        : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' · '),
  };
}

export function catalogToDescriptors(
  models: readonly ModelInfo[],
): QoderModelDescriptor[] {
  return models
    .map(modelInfoToDescriptor)
    .filter((model): model is QoderModelDescriptor => model !== undefined);
}

export function buildModelQueryOptions(
  model: Pick<QoderModelDescriptor, 'id' | 'maxContextWindow'>,
): QoderModelQueryOptions {
  if (model.maxContextWindow === undefined) {
    return { model: model.id };
  }

  return {
    model: model.id,
    extraArgs: {
      'context-window': String(model.maxContextWindow),
    },
  };
}

export function fallbackModelDescriptors(): QoderModelDescriptor[] {
  return [
    'auto',
    'ultimate',
    'performance',
    'efficient',
    'lite',
  ].map((id) => ({
    id,
    name: id === 'auto' ? 'Auto' : id[0].toUpperCase() + id.slice(1),
    maxInputTokens: FALLBACK_MAX_INPUT_TOKENS,
    maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    imageInput: false,
    detail: 'Qoder · catalog unavailable',
    tooltip: `${id} · configure a PAT to load the current Qoder model catalog`,
  }));
}
