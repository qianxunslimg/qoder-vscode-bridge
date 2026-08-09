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
    return '';
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return '';
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
    'Answer greetings and ordinary conversation directly without inspecting the workspace.',
    'For coding tasks, use the current workspace and its tools only when needed. After making changes, concisely report what changed and how it was validated.',
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
