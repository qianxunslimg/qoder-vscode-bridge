import * as vscode from 'vscode';
import type { PermissionMode } from '@qoder-ai/qoder-agent-sdk';

export interface BridgeConfig {
  readonly permissionMode: PermissionMode;
  readonly maxTurns: number;
  readonly includePartialMessages: boolean;
  readonly showActivity: boolean;
}

const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'acceptEdits',
  'default',
  'plan',
  'bypassPermissions',
];

export function readConfig(): BridgeConfig {
  const configuration = vscode.workspace.getConfiguration('qoderBridge');
  const configuredMode = configuration.get<string>('permissionMode', 'auto');
  const permissionMode = PERMISSION_MODES.includes(configuredMode as PermissionMode)
    ? (configuredMode as PermissionMode)
    : 'auto';
  const maxTurns = Math.max(
    1,
    Math.min(100, configuration.get<number>('maxTurns', 30)),
  );

  return {
    permissionMode,
    maxTurns,
    includePartialMessages: configuration.get<boolean>(
      'includePartialMessages',
      true,
    ),
    showActivity: configuration.get<boolean>('showActivity', true),
  };
}
