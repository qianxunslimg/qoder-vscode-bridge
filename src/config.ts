import * as vscode from 'vscode';
import type { PermissionMode } from '@qoder-ai/qoder-agent-sdk';
import { DEFAULT_MAX_INLINE_REFERENCE_CHARS } from './referenceAdapter.js';

export interface BridgeConfig {
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly includePartialMessages: boolean;
  readonly showActivity: boolean;
  readonly nativeToolLoop: boolean;
  readonly maxNativeTools: number;
  readonly maxInlineReferenceChars: number;
}

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
    maxNativeTools,
    maxInlineReferenceChars,
  };
}
