import * as vscode from 'vscode';
import { DEFAULT_MAX_INLINE_REFERENCE_CHARS } from './referenceAdapter.js';

export type ReasoningEffort =
  | 'auto'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'off';

export interface ModelOverride {
  readonly contextWindow?: number;
  readonly reasoningEffort?: ReasoningEffort;
}

export interface BridgeConfig {
  readonly modelOverrides: Readonly<Record<string, ModelOverride>>;
  readonly maxTurns: number;
  readonly includePartialMessages: boolean;
  readonly showActivity: boolean;
  readonly nativeToolLoop: boolean;
  readonly nativeToolResultTimeoutMs: number;
  readonly debugLogging: boolean;
  readonly maxNativeTools: number;
  readonly maxInlineReferenceChars: number;
}

export const DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_NATIVE_TOOL_RESULT_TIMEOUT_MS = 5 * 1000;
export const MAX_NATIVE_TOOL_RESULT_TIMEOUT_MS = 30 * 60 * 1000;

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'off',
];

function readModelOverrides(value: unknown): Readonly<Record<string, ModelOverride>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const overrides: Record<string, ModelOverride> = {};
  for (const [modelId, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const contextWindow = candidate.contextWindow;
    const reasoningEffort = candidate.reasoningEffort;
    const normalizedContext = typeof contextWindow === 'number' &&
      Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.floor(contextWindow)
      : undefined;
    const normalizedEffort = typeof reasoningEffort === 'string' &&
      REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort)
      ? (reasoningEffort as ReasoningEffort)
      : undefined;
    if (normalizedContext !== undefined || normalizedEffort !== undefined) {
      overrides[modelId] = {
        ...(normalizedContext !== undefined
          ? { contextWindow: normalizedContext }
          : {}),
        ...(normalizedEffort !== undefined
          ? { reasoningEffort: normalizedEffort }
          : {}),
      };
    }
  }
  return overrides;
}

export function readConfig(): BridgeConfig {
  const configuration = vscode.workspace.getConfiguration('qoderBridge');
  const modelOverrides = readModelOverrides(
    configuration.get<unknown>('modelOverrides', {}),
  );
  const maxTurns = Math.max(
    1,
    Math.min(100, configuration.get<number>('maxTurns', 30)),
  );
  const maxNativeTools = Math.max(
    8,
    Math.min(128, configuration.get<number>('maxNativeTools', 91)),
  );
  const configuredNativeToolResultTimeoutMs = configuration.get<number>(
    'nativeToolResultTimeoutMs',
    DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS,
  );
  const nativeToolResultTimeoutMs = Number.isFinite(
    configuredNativeToolResultTimeoutMs,
  )
    ? Math.max(
        MIN_NATIVE_TOOL_RESULT_TIMEOUT_MS,
        Math.min(
          MAX_NATIVE_TOOL_RESULT_TIMEOUT_MS,
          configuredNativeToolResultTimeoutMs,
        ),
      )
    : DEFAULT_NATIVE_TOOL_RESULT_TIMEOUT_MS;
  const maxInlineReferenceChars = Math.max(
    0,
    Math.min(
      100_000,
      configuration.get<number>(
        'maxInlineReferenceChars',
        DEFAULT_MAX_INLINE_REFERENCE_CHARS,
      ),
    ),
  );

  return {
    modelOverrides,
    maxTurns,
    includePartialMessages: configuration.get<boolean>(
      'includePartialMessages',
      true,
    ),
    showActivity: configuration.get<boolean>('showActivity', true),
    nativeToolLoop: configuration.get<boolean>('nativeToolLoop', true),
    nativeToolResultTimeoutMs,
    debugLogging: configuration.get<boolean>('debugLogging', true),
    maxNativeTools,
    maxInlineReferenceChars,
  };
}
