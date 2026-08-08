import type * as vscode from 'vscode';
import type { QoderModelDescriptor } from './modelCatalog.js';

/**
 * The extra metadata is consumed by Copilot Chat's native model picker.
 * It is not present in the older VS Code type definitions used to build the
 * extension, so keep it in our local provider type.
 */
export interface QoderModelInformation
  extends vscode.LanguageModelChatInformation {
  readonly qoderId: string;
  readonly maxContextWindow?: number;
  readonly isBYOK: true;
  readonly isUserSelectable: true;
}

export function descriptorToInformation(
  descriptor: QoderModelDescriptor,
): QoderModelInformation {
  return {
    id: descriptor.id,
    qoderId: descriptor.id,
    name: descriptor.name,
    family: 'qoder-agent',
    version: descriptor.id,
    maxInputTokens: descriptor.maxInputTokens,
    maxOutputTokens: descriptor.maxOutputTokens,
    isBYOK: true,
    isUserSelectable: true,
    capabilities: {
      imageInput: descriptor.imageInput,
      // Native mode delegates the read-only bridge tool to VS Code; the
      // fallback path still uses Qoder's internal agent loop.
      toolCalling: true,
    },
    detail: descriptor.detail,
    tooltip: descriptor.tooltip,
    maxContextWindow: descriptor.maxContextWindow,
  };
}
