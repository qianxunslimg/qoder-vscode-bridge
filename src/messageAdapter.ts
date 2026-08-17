import * as vscode from 'vscode';
import type { SDKUserMessage } from '@qoder-ai/qoder-agent-sdk';
import { compactPromptEntries, type PromptEntry } from './promptPolicy.js';
import {
  imageDataFromUnknown,
  renderActiveEditorReference,
  renderDataPart,
  renderUnknownPart,
  type ReferenceRenderOptions,
} from './referenceAdapter.js';

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

function latestUserMessageIndex(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === vscode.LanguageModelChatMessageRole.User) {
      return index;
    }
  }
  return -1;
}

export function hasImageInput(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): boolean {
  const latestUserIndex = latestUserMessageIndex(messages);
  if (latestUserIndex < 0) {
    return false;
  }
  return messages[latestUserIndex].content.some(
    (part) =>
      (part instanceof vscode.LanguageModelDataPart &&
        part.mimeType.startsWith('image/')) ||
      Boolean(imageDataFromUnknown(part)),
  );
}

function unknownImageBlock(
  part: unknown,
): QoderImageContentBlock | undefined {
  const image = imageDataFromUnknown(part);
  if (!image) {
    return undefined;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mimeType,
      data:
        typeof image.data === 'string'
          ? image.data
          : Buffer.from(image.data).toString('base64'),
    },
  };
}

function partToText(
  part: unknown,
  images: QoderImageContentBlock[],
  options: ReferenceRenderOptions,
  includeImage: boolean,
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
      if (!includeImage) {
        return '[历史图片已省略]';
      }
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
    return renderDataPart(part.mimeType, part.data, options);
  }

  const image = unknownImageBlock(part);
  if (image) {
    if (!includeImage) {
      return '[历史图片已省略]';
    }
    images.push(image);
    return '';
  }

  return renderUnknownPart(part, options);
}

function roleToText(role: vscode.LanguageModelChatMessageRole): string {
  return role === vscode.LanguageModelChatMessageRole.Assistant
    ? 'assistant'
    : 'user';
}

export function messageToText(
  message: vscode.LanguageModelChatRequestMessage,
): string {
  const entry = messageToPromptEntry(message, [], {}, true);
  return `[${entry.label}]\n${entry.text}`;
}

function messageToPromptEntry(
  message: vscode.LanguageModelChatRequestMessage,
  images: QoderImageContentBlock[],
  options: ReferenceRenderOptions,
  includeImages: boolean,
): PromptEntry {
  const name = message.name ? ` (${message.name})` : '';
  return {
    label: `${roleToText(message.role)}${name}`,
    text: message.content
      .map((part) => partToText(part, images, options, includeImages))
      .join(''),
  };
}

export function messagesToPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: ReferenceRenderOptions = {},
): QoderPromptInput {
  const images: QoderImageContentBlock[] = [];
  const latestUserIndex = latestUserMessageIndex(messages);
  const transcript = compactPromptEntries(
    messages.map((message, index) =>
      messageToPromptEntry(
        message,
        images,
        options,
        index === latestUserIndex,
      ),
    ),
  )
    .map((entry) => `[${entry.label}]\n${entry.text}`)
    .join('\n\n');
  const activeEditorReference = options.activeEditorReference
    ? renderActiveEditorReference(options.activeEditorReference, options)
    : undefined;
  const hasExplicitReference =
    transcript.includes('[Attached file reference]') ||
    transcript.includes('[Attached text reference]') ||
    transcript.includes('[Selected content]');
  const text = [
    'You are Qoder, responding through a VS Code language model provider.',
    'Answer greetings and ordinary conversation directly without inspecting the workspace.',
    'For coding tasks, use the current workspace and its tools only when needed. After making changes, concisely report what changed and how it was validated.',
    'When the prompt contains [Attached file reference], inspect the supplied path or URI before answering if the file is relevant. When [Selected content] is present, treat it as the user-selected range and do not replace it with a workspace-wide search.',
    'When [Active editor file] or [Active editor selection] is present, treat it as the current user reference. Do not describe older image attachments as the current reference when this section is available.',
    '',
    activeEditorReference && !hasExplicitReference ? activeEditorReference : '',
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
