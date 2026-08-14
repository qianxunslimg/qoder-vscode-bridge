import * as vscode from 'vscode';
import type { SDKUserMessage } from '@qoder-ai/qoder-agent-sdk';
import { compactPromptEntries, type PromptEntry } from './promptPolicy.js';

export type QoderPromptInput = string | AsyncIterable<SDKUserMessage>;

interface QoderImageContentBlock {
  readonly [key: string]: unknown;
  readonly type: 'image';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: string;
    readonly data: string;
  };
}

interface QoderTextContentBlock {
  readonly [key: string]: unknown;
  readonly type: 'text';
  readonly text: string;
}

type QoderContentBlock =
  | QoderTextContentBlock
  | QoderImageContentBlock;

export function hasImageInput(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  return messages.some((message) =>
    message.content.some(
      (part) =>
        part instanceof vscode.LanguageModelDataPart &&
        part.mimeType.startsWith('image/'),
    ),
  );
}

function jsonForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function partToText(
  part: unknown,
  images: QoderImageContentBlock[],
): string {
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
    if (part.mimeType.startsWith('image/')) {
      images.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: Buffer.from(part.data).toString('base64'),
        },
      });
      return '';
    }
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
  const entry = messageToPromptEntry(message, []);
  return `[${entry.label}]\n${entry.text}`;
}

function messageToPromptEntry(
  message: vscode.LanguageModelChatRequestMessage,
  images: QoderImageContentBlock[],
): PromptEntry {
  const name = message.name ? ` (${message.name})` : '';
  return {
    label: `${roleToText(message.role)}${name}`,
    text: message.content.map((part) => partToText(part, images)).join(''),
  };
}

export function messagesToPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): QoderPromptInput {
  const images: QoderImageContentBlock[] = [];
  const transcript = compactPromptEntries(
    messages.map((message) => messageToPromptEntry(message, images)),
  )
    .map((entry) => `[${entry.label}]\n${entry.text}`)
    .join('\n\n');
  const text = [
    'You are Qoder, responding through a VS Code language model provider.',
    'Answer greetings and ordinary conversation directly without inspecting the workspace.',
    'For coding tasks, use the current workspace and its tools only when needed. After making changes, concisely report what changed and how it was validated.',
    '',
    transcript,
  ].join('\n');

  if (images.length === 0) {
    return text;
  }

  const content: QoderContentBlock[] = [{ type: 'text', text }];
  images.forEach((image, index) => {
    content.push({
      type: 'text',
      text: `\n\n[Attached image ${index + 1}: ${image.source.media_type}]`,
    });
    content.push(image);
  });

  return (async function* imagePrompt(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    };
  })();
}

export function estimateTokens(
  input: string | vscode.LanguageModelChatRequestMessage,
): number {
  const text = typeof input === 'string' ? input : messageToText(input);
  return Math.max(1, Math.ceil(text.length / 4));
}
