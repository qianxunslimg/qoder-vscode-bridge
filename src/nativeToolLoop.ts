import * as vscode from 'vscode';
import {
  accessToken,
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
} from '@qoder-ai/qoder-agent-sdk';
import { z } from 'zod';

export const QODER_READ_FILE_TOOL_NAME = 'qoder_read_file';
const QODER_MCP_SERVER_NAME = 'qoder-vscode-bridge';
const NATIVE_CALL_ID_PREFIX = 'qoder-native-';
const MAX_NATIVE_TOOL_CALLS = 3;

type JsonObject = Record<string, unknown>;

export interface NativeToolResult {
  readonly callId: string;
  readonly text: string;
  readonly isError: boolean;
}

export interface NativeToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type NativeSessionBoundary =
  | { readonly kind: 'tool_call'; readonly invocation: NativeToolInvocation }
  | { readonly kind: 'done' };

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface ProxyRequest {
  readonly input: Record<string, unknown>;
  readonly result: Deferred<CallToolResult>;
}

interface CallToolResult {
  readonly [key: string]: unknown;
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
}

interface NativeSessionOptions {
  readonly pat: string;
  readonly cwd: string;
  readonly model: string;
  readonly extraArgs?: Readonly<Record<string, string | null>>;
  readonly permissionMode: Parameters<Query['setPermissionMode']>[0];
  readonly allowDangerouslySkipPermissions: boolean;
  readonly maxTurns: number;
  readonly prompt: string;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<Deferred<T | undefined>> = [];
  private closed = false;
  private closeError: unknown;

  public push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  public close(error?: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        continue;
      }
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve(undefined);
      }
    }
  }

  public async next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) {
      return value;
    }
    if (this.closed) {
      if (this.closeError) {
        throw this.closeError;
      }
      return undefined;
    }
    const waiter = deferred<T | undefined>();
    this.waiters.push(waiter);
    return waiter.promise;
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null
    ? (value as JsonObject)
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function contentParts(value: unknown): JsonObject[] {
  const message = objectValue(value);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map(objectValue)
    .filter((part): part is JsonObject => part !== undefined);
}

function messageToolCall(message: SDKMessage): NativeToolInvocation | undefined {
  if (message.type !== 'assistant') {
    return undefined;
  }

  for (const part of contentParts(message.message)) {
    if (textValue(part.type) !== 'tool_use') {
      continue;
    }
    const callId = textValue(part.id);
    const name = textValue(part.name);
    const input = objectValue(part.input);
    if (!callId || !name || !input) {
      continue;
    }
    return { callId, name, input };
  }
  return undefined;
}

function textDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') {
    return undefined;
  }
  const event = objectValue(message.event);
  const delta = objectValue(event?.delta);
  if (textValue(delta?.type) !== 'text_delta') {
    return undefined;
  }
  return textValue(delta?.text);
}

function resultError(message: SDKMessage): string {
  if (message.type !== 'result' || message.subtype === 'success') {
    return '';
  }
  return message.errors.join('\n') || 'Qoder returned an execution error.';
}

function resultText(message: vscode.LanguageModelToolResultPart): string {
  return message.content
    .map((item) => {
      if (item instanceof vscode.LanguageModelTextPart) {
        return item.value;
      }
      const object = objectValue(item);
      if (typeof object?.text === 'string') {
        return object.text;
      }
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join('');
}

function resultIsError(message: vscode.LanguageModelToolResultPart): boolean {
  return message.content.some((item) => {
    const object = objectValue(item);
    return object?.isError === true || object?.is_error === true;
  });
}

export function latestNativeToolResult(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): NativeToolResult | undefined {
  // A tool result is only a continuation boundary when it is the newest
  // message. Looking through the whole transcript would mistake an old,
  // already-completed Qoder tool call for the current user turn.
  const message = messages.at(-1);
  if (!message) {
    return undefined;
  }
  for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = message.content[partIndex];
    if (!(part instanceof vscode.LanguageModelToolResultPart)) {
      continue;
    }
    if (!part.callId.startsWith(NATIVE_CALL_ID_PREFIX)) {
      continue;
    }
    return {
      callId: part.callId,
      text: resultText(part),
      isError: resultIsError(part),
    };
  }
  return undefined;
}

export function isNativeToolCallId(callId: string): boolean {
  return callId.startsWith(NATIVE_CALL_ID_PREFIX);
}

/**
 * The first vertical slice is deliberately strict: if Copilot provides any
 * other tools, keep the existing Qoder loop instead of silently removing
 * those tools from the request. This prevents ordinary Agent-mode edits and
 * shell tasks from regressing while only the read-file path is migrated.
 */
export function hasOnlyNativeReadFileTool(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): boolean {
  return (
    tools?.length === 1 &&
    tools[0]?.name === QODER_READ_FILE_TOOL_NAME
  );
}

/**
 * Runs Qoder with exactly one MCP proxy tool. The proxy never reads files: it
 * pauses until VS Code invokes the matching native extension tool and returns
 * its result. This keeps the Qoder agent loop alive without executing the
 * underlying tool twice.
 */
export class NativeQoderSession {
  private readonly q: Query;
  private readonly messages = new AsyncQueue<SDKMessage>();
  private readonly proxyRequests = new AsyncQueue<ProxyRequest>();
  private readonly pendingCalls = new Map<string, ProxyRequest>();
  private readonly seenToolCalls = new Set<string>();
  private readonly abortController = new AbortController();
  private readonly pumpPromise: Promise<void>;
  private toolCallCount = 0;
  private closed = false;

  public constructor(options: NativeSessionOptions) {
    let bridgeHandler: (input: Record<string, unknown>) => Promise<CallToolResult>;
    const server = createSdkMcpServer({
      name: QODER_MCP_SERVER_NAME,
      tools: [
        tool(
          QODER_READ_FILE_TOOL_NAME,
          'Ask the VS Code host to read one UTF-8 workspace file. This tool is read-only and must be used instead of any other tool.',
          {
            file_path: z.string(),
            offset: z.number().int().nonnegative().optional(),
            limit: z.number().int().positive().optional(),
          },
          async (input) => bridgeHandler(input),
          {
            exposedName: QODER_READ_FILE_TOOL_NAME,
            alwaysLoad: true,
            permissionPolicy: 'always_allow',
            annotations: { readOnlyHint: true },
          },
        ),
      ],
    });
    bridgeHandler = async (input) => {
      const request = {
        input,
        result: deferred<CallToolResult>(),
      };
      this.proxyRequests.push(request);
      return request.result.promise;
    };

    this.q = query({
      prompt: [
        options.prompt,
        '',
        `Only one tool is available: ${QODER_READ_FILE_TOOL_NAME}.`,
        'Use it for read-only workspace inspection; do not use or simulate any other tool.',
        'If the host returns a tool error, you may retry this same tool with corrected arguments.',
        'After the tool result is available, return the concise final answer to the user.',
      ].join('\n'),
      options: {
        auth: accessToken(options.pat),
        cwd: options.cwd,
        model: options.model,
        extraArgs: options.extraArgs ? { ...options.extraArgs } : undefined,
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions:
          options.allowDangerouslySkipPermissions,
        maxTurns: options.maxTurns,
        includePartialMessages: true,
        tools: [QODER_READ_FILE_TOOL_NAME],
        mcpServers: { [QODER_MCP_SERVER_NAME]: server },
        abortController: this.abortController,
      },
    });
    this.pumpPromise = this.pump();
  }

  public async start(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<NativeSessionBoundary> {
    return this.consumeUntilBoundary(progress);
  }

  public async continueWithToolResult(
    result: NativeToolResult,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<NativeSessionBoundary> {
    const pending = this.pendingCalls.get(result.callId);
    if (!pending) {
      throw new Error(`Qoder native tool session has no pending call ${result.callId}.`);
    }
    this.pendingCalls.delete(result.callId);
    pending.result.resolve({
      content: [{ type: 'text', text: result.text || '(empty tool result)' }],
      isError: result.isError,
    });
    return this.consumeUntilBoundary(progress);
  }

  public async cancel(reason = 'Qoder native tool request cancelled.'): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error(reason);
    for (const pending of this.pendingCalls.values()) {
      pending.result.reject(error);
    }
    this.pendingCalls.clear();
    this.messages.close(error);
    this.proxyRequests.close(error);
    this.abortController.abort();
    await this.q.interrupt().catch(() => undefined);
    await this.q.close().catch(() => undefined);
    await this.pumpPromise.catch(() => undefined);
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error('Qoder native tool session closed.');
    for (const pending of this.pendingCalls.values()) {
      pending.result.reject(error);
    }
    this.pendingCalls.clear();
    this.messages.close();
    this.proxyRequests.close(error);
    this.abortController.abort();
    await this.q.close().catch(() => undefined);
    await this.pumpPromise.catch(() => undefined);
  }

  private async pump(): Promise<void> {
    try {
      for await (const message of this.q) {
        this.messages.push(message);
      }
      this.messages.close();
    } catch (error) {
      this.messages.close(error);
    }
  }

  private async consumeUntilBoundary(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): Promise<NativeSessionBoundary> {
    let streamedText = false;
    while (true) {
      const message = await this.messages.next();
      if (!message) {
        throw new Error('Qoder native tool session ended before returning a result.');
      }

      const delta = textDelta(message);
      if (delta) {
        streamedText = true;
        progress.report(new vscode.LanguageModelTextPart(delta));
      }

      const qoderInvocation = messageToolCall(message);
      if (
        qoderInvocation &&
        !this.seenToolCalls.has(qoderInvocation.callId)
      ) {
        if (qoderInvocation.name !== QODER_READ_FILE_TOOL_NAME) {
          throw new Error(
            `Qoder requested unsupported native tool ${qoderInvocation.name}; only ${QODER_READ_FILE_TOOL_NAME} is enabled.`,
          );
        }
        if (this.toolCallCount >= MAX_NATIVE_TOOL_CALLS) {
          throw new Error(
            `Qoder requested ${MAX_NATIVE_TOOL_CALLS + 1} native tool calls; stopping to prevent an unbounded loop.`,
          );
        }
        this.seenToolCalls.add(qoderInvocation.callId);
        this.toolCallCount += 1;
        const proxyRequest = await this.proxyRequests.next();
        if (!proxyRequest) {
          throw new Error('Qoder requested a native tool without a proxy request.');
        }
        const invocation = {
          ...qoderInvocation,
          callId: `${NATIVE_CALL_ID_PREFIX}${qoderInvocation.callId}`,
        };
        this.pendingCalls.set(invocation.callId, proxyRequest);
        progress.report(
          new vscode.LanguageModelTextPart(
            '**Qoder**：已将只读工具 `' +
              QODER_READ_FILE_TOOL_NAME +
              '` 交给 VS Code 执行。\n\n',
          ),
        );
        return { kind: 'tool_call', invocation };
      }

      if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(resultError(message));
        }
        if (!streamedText && message.result.trim()) {
          progress.report(new vscode.LanguageModelTextPart(message.result));
        }
        await this.close();
        return { kind: 'done' };
      }
    }
  }
}
