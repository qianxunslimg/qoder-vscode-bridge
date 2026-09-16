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
  readonly description?: string;
  readonly maxContextWindow?: number;
  readonly defaultContextWindow?: number;
  readonly availableContextWindows?: readonly number[];
  readonly isDefault?: boolean;
  readonly isFree?: boolean;
  readonly isReasoning?: boolean;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly supportsDisabled?: boolean;
  readonly priceFactor?: number;
  readonly tags?: readonly string[];
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
    description: descriptor.description,
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
    defaultContextWindow: descriptor.defaultContextWindow,
    availableContextWindows: descriptor.availableContextWindows,
    isDefault: descriptor.isDefault,
    isFree: descriptor.isFree,
    isReasoning: descriptor.isReasoning,
    efforts: descriptor.efforts,
    defaultEffort: descriptor.defaultEffort,
    supportsDisabled: descriptor.supportsDisabled,
    priceFactor: descriptor.priceFactor,
    tags: descriptor.tags,
  };
}
