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
import type { NativeToolDescriptor } from './nativeToolPolicy.js';

export const QODER_READ_FILE_TOOL_NAME = 'qoder_read_file';
const QODER_MCP_SERVER_NAME = 'qoder-vscode-bridge';
const NATIVE_CALL_ID_PREFIX = 'qoder-native-';
const QODER_NATIVE_TOOL_PREFIX = 'qoder_native_';

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
  readonly proxyName: string;
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
  readonly nativeTools: readonly NativeToolDescriptor[];
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

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function proxyNameFor(toolName: string, index: number): string {
  const normalized = toolName.replace(/[^A-Za-z0-9_-]+/g, '_');
  const suffix = normalized || `tool_${index}`;
  return `${QODER_NATIVE_TOOL_PREFIX}${index}_${suffix}`.slice(0, 64);
}

function jsonSchemaLiteral(value: unknown): any {
  if (value === null) {
    return z.null();
  }
  switch (typeof value) {
    case 'string':
      return z.literal(value);
    case 'number':
      return z.literal(value);
    case 'boolean':
      return z.literal(value);
    default:
      return z.unknown();
  }
}

function withJsonSchemaDescription(value: JsonObject, schema: any): any {
  const description = textValue(value.description)?.trim();
  return description ? schema.describe(description) : schema;
}

function jsonSchemaToZod(schema: unknown): any {
  const value = objectValue(schema);
  if (!value) {
    return z.unknown();
  }

  const enumValues = arrayValue(value.enum);
  if (enumValues && enumValues.length > 0) {
    if (enumValues.length === 1) {
      return withJsonSchemaDescription(value, jsonSchemaLiteral(enumValues[0]));
    }
    return withJsonSchemaDescription(
      value,
      z.union(enumValues.map(jsonSchemaLiteral) as [any, any, ...any[]]),
    );
  }

  const alternatives = arrayValue(value.oneOf ?? value.anyOf);
  if (alternatives && alternatives.length > 0) {
    if (alternatives.length === 1) {
      return withJsonSchemaDescription(
        value,
        jsonSchemaToZod(alternatives[0]),
      );
    }
    return withJsonSchemaDescription(
      value,
      z.union(
        alternatives.map(jsonSchemaToZod) as [any, any, ...any[]],
      ),
    );
  }

  const type = value.type;
  if (Array.isArray(type)) {
    if (type.length === 1) {
      return withJsonSchemaDescription(
        value,
        jsonSchemaToZod({ type: type[0] }),
      );
    }
    return withJsonSchemaDescription(
      value,
      z.union(
        type.map((item) => jsonSchemaToZod({ type: item })) as [
          any,
          any,
          ...any[],
        ],
      ),
    );
  }

  let parsed: any;
  switch (type) {
    case 'string':
      parsed = z.string();
      break;
    case 'integer':
      parsed = z.number().int();
      break;
    case 'number':
      parsed = z.number();
      break;
    case 'boolean':
      parsed = z.boolean();
      break;
    case 'array':
      parsed = z.array(jsonSchemaToZod(value.items));
      break;
    case 'object': {
      const shape = jsonSchemaShape(value);
      parsed = Object.keys(shape).length > 0
        ? z.object(shape)
        : z.record(z.string(), z.unknown());
      break;
    }
    default:
      parsed = z.unknown();
  }
  return withJsonSchemaDescription(value, parsed);
}

function jsonSchemaShape(schema: unknown): Record<string, any> {
  const value = objectValue(schema);
  const properties = objectValue(value?.properties);
  if (!properties) {
    return {};
  }
  const required = new Set(
    (arrayValue(value?.required) ?? []).filter(
      (item): item is string => typeof item === 'string',
    ),
  );
  const shape: Record<string, any> = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const parsed = jsonSchemaToZod(propertySchema);
    shape[name] = required.has(name) ? parsed : parsed.optional();
  }
  return shape;
}

export function nativeToolInputShape(
  schema: object | undefined,
): Record<string, any> {
  const shape = jsonSchemaShape(schema);
  // Some private tools omit their schema. Keep their arguments as a generic
  // object rather than silently forcing Qoder to call an empty-argument tool.
  return Object.keys(shape).length > 0
    ? shape
    : { input: z.record(z.string(), z.unknown()).optional() };
}

/**
 * Qoder's built-in Bash timeout is expressed in milliseconds, but models can
 * still emit a small seconds-style value after crossing a provider boundary.
 * Such sub-second host timeouts immediately background an ordinary sync command
 * and make VS Code inject a separate terminal-completion turn. Repair only the
 * unambiguously tiny range and leave explicit async calls untouched.
 */
export function normalizeNativeToolInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (name !== 'run_in_terminal' || input.mode === 'async') {
    return input;
  }
  const timeout = input.timeout;
  if (
    typeof timeout !== 'number' ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout >= 1_000
  ) {
    return input;
  }
  return { ...input, timeout: Math.round(timeout * 1_000) };
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

interface TerminalCompletionNotification {
  readonly terminalId: string;
  readonly output: string;
}

function latestTerminalCompletionNotification(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): TerminalCompletionNotification | undefined {
  const message = messages.at(-1);
  if (!message) {
    return undefined;
  }
  for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = message.content[partIndex];
    if (!(part instanceof vscode.LanguageModelTextPart)) {
      continue;
    }
    const match = part.value.match(
      /^\[Terminal ([^\]\r\n]+) notification: command completed\.[^\]]*\]\r?\nTerminal output:\r?\n([\s\S]*)$/,
    );
    if (match) {
      return { terminalId: match[1], output: match[2].trimEnd() };
    }
  }
  return undefined;
}

/**
 * VS Code can deliver terminal completion as a synthetic user message before
 * it invokes a pending get_terminal_output call. Match that notification to
 * the exact terminal and feed it into the still-live Qoder session instead of
 * treating it as a new user request.
 */
export function terminalNotificationToolResult(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  invocation: NativeToolInvocation,
): NativeToolResult | undefined {
  if (invocation.name !== 'get_terminal_output') {
    return undefined;
  }
  const terminalId = textValue(invocation.input.id);
  const notification = latestTerminalCompletionNotification(messages);
  if (!terminalId || notification?.terminalId !== terminalId) {
    return undefined;
  }
  return {
    callId: invocation.callId,
    text: notification.output || '(terminal completed with no output)',
    isError: false,
  };
}

export function isNativeToolCallId(callId: string): boolean {
  return callId.startsWith(NATIVE_CALL_ID_PREFIX);
}

/**
 * A real Agent request supplies the host tools to the provider. Proxy all of
 * them through the same native boundary; an empty tool list still uses the
 * legacy Qoder loop for ordinary text-only chat.
 */
export function hasNativeToolLoopTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): boolean {
  return (tools?.length ?? 0) > 0;
}

/**
 * Runs Qoder with one MCP proxy per host tool. A proxy never executes the
 * underlying operation: it pauses until VS Code invokes the matching native
 * tool and returns its result. This keeps the Qoder agent loop alive without
 * executing any tool twice.
 */
export class NativeQoderSession {
  private readonly q: Query;
  private readonly messages = new AsyncQueue<SDKMessage>();
  private readonly proxyRequests = new Map<string, AsyncQueue<ProxyRequest>>();
  private readonly proxyTools = new Map<
    string,
    NativeToolDescriptor & { readonly proxyName: string }
  >();
  private readonly pendingCalls = new Map<string, ProxyRequest>();
  private readonly seenToolCalls = new Set<string>();
  private readonly abortController = new AbortController();
  private readonly pumpPromise: Promise<void>;
  private readonly maxNativeToolCalls: number;
  private toolCallCount = 0;
  private closed = false;

  public constructor(options: NativeSessionOptions) {
    this.maxNativeToolCalls = Math.max(1, options.maxTurns);
    const proxyTools = options.nativeTools.map((descriptor, index) => ({
      ...descriptor,
      proxyName: proxyNameFor(descriptor.name, index),
    }));
    for (const descriptor of proxyTools) {
      this.proxyTools.set(descriptor.proxyName, descriptor);
      this.proxyRequests.set(descriptor.proxyName, new AsyncQueue<ProxyRequest>());
    }

    const server = createSdkMcpServer({
      name: QODER_MCP_SERVER_NAME,
      tools: proxyTools.map((descriptor) =>
        tool(
          descriptor.proxyName,
          [
            `Proxy for the VS Code host tool ${descriptor.name}.`,
            descriptor.description,
            descriptor.name === 'run_in_terminal'
              ? 'Its timeout field is milliseconds: use at least 10000 for short commands and 120000 or more for builds and tests.'
              : '',
            'Return the host result to Qoder without executing the operation inside Qoder.',
          ].filter(Boolean).join(' '),
          nativeToolInputShape(descriptor.inputSchema),
          async (input) => {
            const queue = this.proxyRequests.get(descriptor.proxyName);
            if (!queue) {
              throw new Error(`Missing proxy queue for ${descriptor.proxyName}.`);
            }
            const request = {
              proxyName: descriptor.proxyName,
              input: normalizeNativeToolInput(
                descriptor.name,
                input as Record<string, unknown>,
              ),
              result: deferred<CallToolResult>(),
            };
            queue.push(request);
            return request.result.promise;
          },
          {
            exposedName: descriptor.proxyName,
            alwaysLoad: true,
            permissionPolicy: 'always_allow',
            annotations: {
              readOnlyHint: descriptor.name === QODER_READ_FILE_TOOL_NAME,
              destructiveHint: descriptor.name !== QODER_READ_FILE_TOOL_NAME,
            },
          },
        ),
      ),
    });

    this.q = query({
      prompt: [
        options.prompt,
        '',
        'Tools whose names start with qoder_native_ are VS Code host proxies. Use only those proxy names when a tool is necessary; do not call or simulate Qoder built-in tools.',
        'The host, not Qoder, executes the operation and returns its result.',
        'Do not use tools for greetings, casual conversation, or questions that can be answered from the current context.',
        'For a task that needs tools, briefly state one concrete plan sentence before the first call. Do not repeat generic progress narration between calls because VS Code renders tool activity.',
        'If the host returns a tool error, correct the arguments and retry the same proxy when appropriate.',
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
        tools: proxyTools.map((descriptor) => descriptor.proxyName),
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
    if (result.isError) {
      progress.report(
        new vscode.LanguageModelTextPart(
          '工具执行失败，Qoder 正在根据错误决定是否重试。\n\n',
        ),
      );
    }
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
    for (const queue of this.proxyRequests.values()) {
      queue.close(error);
    }
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
    for (const queue of this.proxyRequests.values()) {
      queue.close(error);
    }
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
        const proxy = this.proxyTools.get(qoderInvocation.name);
        if (!proxy) {
          throw new Error(
            `Qoder requested unsupported native proxy ${qoderInvocation.name}.`,
          );
        }
        if (this.toolCallCount >= this.maxNativeToolCalls) {
          throw new Error(
            `Qoder requested more than ${this.maxNativeToolCalls} native tool calls; stopping to prevent an unbounded loop.`,
          );
        }
        this.seenToolCalls.add(qoderInvocation.callId);
        this.toolCallCount += 1;
        const queue = this.proxyRequests.get(proxy.proxyName);
        if (!queue) {
          throw new Error(`Missing native proxy queue for ${proxy.proxyName}.`);
        }
        const proxyRequest = await queue.next();
        if (!proxyRequest) {
          throw new Error(
            `Qoder requested ${proxy.proxyName} without a proxy request.`,
          );
        }
        const invocation = {
          name: proxy.name,
          callId: `${NATIVE_CALL_ID_PREFIX}${qoderInvocation.callId}`,
          input: proxyRequest.input,
        };
        this.pendingCalls.set(invocation.callId, proxyRequest);
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
