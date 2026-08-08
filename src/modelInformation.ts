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
      // Qoder runs the agent/tool loop internally. Advertising tool calling
      // makes these models eligible for Copilot's Agent-mode picker; native
      // VS Code tools are intentionally not forwarded into the Qoder SDK.
      toolCalling: true,
    },
    detail: descriptor.detail,
    tooltip: descriptor.tooltip,
    maxContextWindow: descriptor.maxContextWindow,
  };
}
