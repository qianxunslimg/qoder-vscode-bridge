import * as vscode from 'vscode';
import { compactPromptEntries, type PromptEntry } from './promptPolicy.js';

function jsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function partToText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[tool call ${part.name} ${jsonForPrompt(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const content = part.content
      .map((item) => {
        if (item instanceof vscode.LanguageModelTextPart) {
          return item.value;
        }
        return jsonForPrompt(item);
      })
      .join('');
    return `[tool result ${part.callId}] ${content}`;
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return `[non-text input: ${part.mimeType}]`;
  }

  return jsonForPrompt(part);
}

function roleToText(role: vscode.LanguageModelChatMessageRole): string {
  return role === vscode.LanguageModelChatMessageRole.Assistant
    ? 'assistant'
    : 'user';
}

export function messageToText(
  message: vscode.LanguageModelChatRequestMessage,
): string {
  const entry = messageToPromptEntry(message);
  return `[${entry.label}]\n${entry.text}`;
}

function messageToPromptEntry(
  message: vscode.LanguageModelChatRequestMessage,
): PromptEntry {
  const name = message.name ? ` (${message.name})` : '';
  return {
    label: `${roleToText(message.role)}${name}`,
    text: message.content.map(partToText).join(''),
  };
}

export function messagesToPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  const transcript = compactPromptEntries(
    messages.map(messageToPromptEntry),
  )
    .map((entry) => `[${entry.label}]\n${entry.text}`)
    .join('\n\n');
  return [
    'You are Qoder, responding through a VS Code language model provider.',
    'Use the current workspace as the working directory. When the user asks for code changes, you may inspect and modify files and run appropriate checks using your available Qoder tools.',
    'Return a concise final response describing the work and validation after completing the task.',
    '',
    transcript,
  ].join('\n');
}

export function estimateTokens(
  input: string | vscode.LanguageModelChatRequestMessage,
): number {
  const text = typeof input === 'string' ? input : messageToText(input);
  return Math.max(1, Math.ceil(text.length / 4));
}
