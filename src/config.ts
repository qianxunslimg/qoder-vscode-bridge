import * as vscode from 'vscode';
import type { PermissionMode } from '@qoder-ai/qoder-agent-sdk';
import { DEFAULT_MAX_INLINE_REFERENCE_CHARS } from './referenceAdapter.js';

export interface BridgeConfig {
  readonly permissionMode: PermissionMode;
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

const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'acceptEdits',
  'default',
  'plan',
  'bypassPermissions',
  'yolo',
  'dontAsk',
];

export function readConfig(): BridgeConfig {
  const configuration = vscode.workspace.getConfiguration('qoderBridge');
  const configuredMode = configuration.get<string>(
    'permissionMode',
    'bypassPermissions',
  );
  const permissionMode = PERMISSION_MODES.includes(configuredMode as PermissionMode)
    ? (configuredMode as PermissionMode)
    : 'bypassPermissions';
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
    permissionMode,
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
