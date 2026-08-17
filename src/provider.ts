import * as vscode from 'vscode';
import {
  accessToken,
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type UsageInfo,
} from '@qoder-ai/qoder-agent-sdk';
import { QoderActivityTracker } from './activity.js';
import { readConfig } from './config.js';
import {
  buildModelQueryOptions,
  catalogToDescriptors,
  fallbackModelDescriptors,
  type QoderModelDescriptor,
} from './modelCatalog.js';
import { QoderMetadataSession } from './modelCatalogService.js';
import {
  estimateTokens,
  hasImageInput,
  messagesToPrompt,
} from './messageAdapter.js';
import type { ActiveEditorReference } from './referenceAdapter.js';
import {
  descriptorToInformation,
  type QoderModelInformation,
} from './modelInformation.js';
import {
  hasNativeToolLoopTools,
  isNativeToolCallId,
  latestNativeToolResult,
  NativeQoderSession,
  terminalNotificationToolResult,
  type NativeToolInvocation,
  type NativeToolResult,
  type NativeSessionBoundary,
} from './nativeToolLoop.js';
import {
  selectNativeTools,
  type NativeToolDescriptor,
} from './nativeToolPolicy.js';
import { TokenStore } from './tokenStore.js';

const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_CACHE_TTL_MS = 5 * 1000;
const REFERENCE_CUE_PATTERN =
  /引用|选中|这段|文件|代码|内容|查看|看看|读取|评审|审查|分析|参考|修改|修复|实现|review|file|selection|attached/i;
const CASUAL_PROMPT_PATTERN =
  /^(?:你好|您好|嗨|hi|hello|hey|谢谢|感谢|在吗)[\s!！,.。?？]*$/i;

function latestUserText(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }
    return message.content
      .filter((part): part is vscode.LanguageModelTextPart =>
        part instanceof vscode.LanguageModelTextPart,
      )
      .map((part) => part.value)
      .join(' ')
      .trim();
  }
  return '';
}

function activeEditorReferenceFor(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ActiveEditorReference | undefined {
  const editor = vscode.window?.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const prompt = latestUserText(messages);
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const isReferenceRequest = REFERENCE_CUE_PATTERN.test(prompt);
  if ((!hasSelection && !isReferenceRequest) ||
      (hasSelection && CASUAL_PROMPT_PATTERN.test(prompt))) {
    return undefined;
  }

  const resource =
    editor.document.uri.scheme === 'file'
      ? editor.document.uri.fsPath
      : editor.document.uri.toString();
  if (!resource) {
    return undefined;
  }

  const range = hasSelection
    ? `lines ${selection.start.line + 1}-${Math.max(
        selection.start.line + 1,
        selection.end.line + 1,
      )}, columns ${selection.start.character}-${selection.end.character}`
    : undefined;
  let text: string | undefined;
  if (hasSelection) {
    try {
      text = editor.document.getText(selection);
    } catch {
      text = undefined;
    }
  }

  return { resource, range, text };
}

function promptOptionsFor(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  maxInlineChars: number,
) {
  return {
    maxInlineChars,
    activeEditorReference: activeEditorReferenceFor(messages),
  };
}

interface CatalogLoadResult {
  readonly models: QoderModelInformation[];
  readonly loadedFromQoder: boolean;
}

interface TrackedNativeSession {
  readonly session: NativeQoderSession;
  readonly invocation: NativeToolInvocation;
}

function deduplicateModels(
  descriptors: readonly QoderModelDescriptor[],
): QoderModelInformation[] {
  const seen = new Set<string>();
  const models: QoderModelInformation[] = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      continue;
    }
    seen.add(descriptor.id);
    models.push(descriptorToInformation(descriptor));
  }
  return models;
}

function isResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result';
}

function textDelta(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event') {
    return undefined;
  }

  const event = message.event as { delta?: { type?: string; text?: string } };
  if (event.delta?.type !== 'text_delta') {
    return undefined;
  }
  return event.delta.text;
}

function resultError(message: SDKResultMessage): string {
  if (message.subtype === 'success') {
    return '';
  }
  return message.errors.join('\n') || 'Qoder returned an execution error.';
}

export class QoderModelProvider
  implements
    vscode.LanguageModelChatProvider<QoderModelInformation>,
    vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private cachedModels: QoderModelInformation[] | undefined;
  private cachedLoadedFromQoder = false;
  private cacheExpiresAt = 0;
  private inFlight: Promise<CatalogLoadResult> | undefined;
  private readonly metadataSession = new QoderMetadataSession();
  private readonly nativeSessions = new Map<string, TrackedNativeSession>();

  public readonly onDidChangeLanguageModelChatInformation =
    this.changeEmitter.event;

  public constructor(private readonly tokenStore: TokenStore) {}

  public async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<QoderModelInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }
    return (await this.getModels(false)).models;
  }

  /** Clear the cache, reload the account catalog, and notify VS Code. */
  public async refreshModels(): Promise<boolean> {
    this.cachedModels = undefined;
    this.cachedLoadedFromQoder = false;
    this.cacheExpiresAt = 0;
    const loaded = await this.getModels(true);
    this.changeEmitter.fire();
    return loaded.loadedFromQoder;
  }

  public async fetchUsage(pat: string, cwd: string): Promise<UsageInfo | null> {
    return this.metadataSession.getUsageInfo(pat, cwd);
  }

  public async provideLanguageModelChatResponse(
    model: QoderModelInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const pat = await this.tokenStore.get();
    if (!pat) {
      throw new Error(
        'Qoder PAT is not configured. Run "Qoder: Set Personal Access Token" first.',
      );
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust the current VS Code workspace before using Qoder.');
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('Open a workspace folder before using Qoder.');
    }
    if (hasImageInput(messages) && model.capabilities.imageInput !== true) {
      throw new Error(
        'The selected Qoder model does not support image input. Select a model marked as vision-capable and retry.',
      );
    }

    const abortController = new AbortController();
    const config = readConfig();
    const activity = config.showActivity ? new QoderActivityTracker() : undefined;
    const modelOptions = buildModelQueryOptions(model);

    const nativeToolResult = latestNativeToolResult(messages);
    if (config.nativeToolLoop && nativeToolResult) {
      if (!isNativeToolCallId(nativeToolResult.callId)) {
        throw new Error('Invalid Qoder native tool call id. Retry the request.');
      }
      const tracked = this.nativeSessions.get(nativeToolResult.callId);
      if (tracked) {
        await this.continueNativeSession(
          tracked.session,
          nativeToolResult,
          progress,
          token,
        );
        return;
      }
      // VS Code can replay the last ToolResult after a provider error or an
      // extension-host restart. The old in-memory Qoder query cannot be
      // resumed, so fall through and rebuild a session from the transcript
      // and current workspace state instead of trapping Try Again in an
      // unrecoverable "session expired" loop.
    }

    if (config.nativeToolLoop) {
      for (const tracked of this.nativeSessions.values()) {
        const terminalResult = terminalNotificationToolResult(
          messages,
          tracked.invocation,
        );
        if (!terminalResult) {
          continue;
        }
        await this.continueNativeSession(
          tracked.session,
          terminalResult,
          progress,
          token,
        );
        return;
      }
    }

    if (config.nativeToolLoop && hasNativeToolLoopTools(options.tools)) {
      await this.startNativeSession(
        pat,
        workspaceFolder.uri.fsPath,
        modelOptions,
        config,
        messages,
        selectNativeTools(options.tools, config.maxNativeTools),
        progress,
        token,
      );
      return;
    }

    let q: Query | undefined;
    let streamedText = false;
    let finalText = '';
    let executionError = '';

    try {
      if (activity) {
        progress.report(new vscode.LanguageModelTextPart(activity.begin()));
      }

      q = query({
        prompt: messagesToPrompt(
          messages,
          promptOptionsFor(messages, config.maxInlineReferenceChars),
        ),
        options: {
          auth: accessToken(pat),
          cwd: workspaceFolder.uri.fsPath,
          model: modelOptions.model,
          extraArgs: modelOptions.extraArgs
            ? { ...modelOptions.extraArgs }
            : undefined,
          permissionMode: config.permissionMode,
          allowDangerouslySkipPermissions:
            config.permissionMode === 'bypassPermissions',
          maxTurns: config.maxTurns,
          includePartialMessages: config.includePartialMessages,
          includeHookEvents: config.showActivity,
          abortController,
        },
      });

      const cancellation = token.onCancellationRequested(() => {
        abortController.abort();
        void q?.interrupt().catch(() => undefined);
      });

      try {
        for await (const message of q) {
          if (activity) {
            for (const update of activity.consume(message)) {
              progress.report(new vscode.LanguageModelTextPart(update));
            }
          }

          const delta = textDelta(message);
          if (delta) {
            streamedText = true;
            progress.report(new vscode.LanguageModelTextPart(delta));
          }

          if (isResult(message)) {
            if (message.subtype === 'success') {
              finalText = message.result;
            } else {
              executionError = resultError(message);
            }
          }
        }
      } finally {
        cancellation.dispose();
      }

      if (executionError) {
        throw new Error(executionError);
      }
      if (!streamedText && finalText) {
        progress.report(new vscode.LanguageModelTextPart(finalText));
      }
    } finally {
      await q?.close().catch(() => undefined);
    }
  }

  public provideTokenCount(
    _model: QoderModelInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    return Promise.resolve(estimateTokens(text));
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    void this.metadataSession.close();
    for (const tracked of this.nativeSessions.values()) {
      void tracked.session.cancel('Qoder native tool provider disposed.');
    }
    this.nativeSessions.clear();
  }

  private async startNativeSession(
    pat: string,
    cwd: string,
    modelOptions: ReturnType<typeof buildModelQueryOptions>,
    config: ReturnType<typeof readConfig>,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    nativeTools: readonly NativeToolDescriptor[],
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const session = new NativeQoderSession({
      pat,
      cwd,
      model: modelOptions.model,
      extraArgs: modelOptions.extraArgs,
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions:
        config.permissionMode === 'bypassPermissions',
      maxTurns: config.maxTurns,
      prompt: messagesToPrompt(
        messages,
        promptOptionsFor(messages, config.maxInlineReferenceChars),
      ),
      nativeTools,
    });

    const cancellation = token.onCancellationRequested(() => {
      void session.cancel();
    });
    try {
      const boundary = await session.start(progress);
      this.trackNativeBoundary(session, boundary, progress);
      if (boundary.kind === 'done') {
        await session.close();
      }
    } catch (error) {
      await session.cancel();
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  private async continueNativeSession(
    session: NativeQoderSession,
    result: NativeToolResult,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const cancellation = token.onCancellationRequested(() => {
      void session.cancel();
    });
    try {
      const boundary = await session.continueWithToolResult(result, progress);
      this.removeNativeSession(session);
      this.trackNativeBoundary(session, boundary, progress);
      if (boundary.kind === 'done') {
        await session.close();
      }
    } catch (error) {
      this.removeNativeSession(session);
      await session.cancel();
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  private trackNativeBoundary(
    session: NativeQoderSession,
    boundary: NativeSessionBoundary,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    if (boundary.kind === 'tool_call') {
      progress.report(
        new vscode.LanguageModelToolCallPart(
          boundary.invocation.callId,
          boundary.invocation.name,
          boundary.invocation.input,
        ),
      );
      this.nativeSessions.set(boundary.invocation.callId, {
        session,
        invocation: boundary.invocation,
      });
    }
  }

  private removeNativeSession(session: NativeQoderSession): void {
    for (const [callId, candidate] of this.nativeSessions) {
      if (candidate.session === session) {
        this.nativeSessions.delete(callId);
      }
    }
  }

  private async getModels(force: boolean): Promise<CatalogLoadResult> {
    const now = Date.now();
    if (!force && this.cachedModels && now < this.cacheExpiresAt) {
      return {
        models: this.cachedModels,
        loadedFromQoder: this.cachedLoadedFromQoder,
      };
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = this.loadModels()
      .then((result) => {
        this.cachedModels = result.models;
        this.cachedLoadedFromQoder = result.loadedFromQoder;
        this.cacheExpiresAt =
          Date.now() +
          (result.loadedFromQoder
            ? CATALOG_CACHE_TTL_MS
            : FALLBACK_CACHE_TTL_MS);
        return result;
      })
      .finally(() => {
        this.inFlight = undefined;
      });

    return this.inFlight;
  }

  private async loadModels(): Promise<CatalogLoadResult> {
    const pat = await this.tokenStore.get();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!pat || !workspaceFolder) {
      await this.metadataSession.close();
      return {
        models: deduplicateModels(fallbackModelDescriptors()),
        loadedFromQoder: false,
      };
    }

    try {
      const catalog = await this.metadataSession.getAvailableModels(
        pat,
        workspaceFolder.uri.fsPath,
      );
      const models = deduplicateModels(catalogToDescriptors(catalog));
      if (models.length > 0) {
        return { models, loadedFromQoder: true };
      }
    } catch {
      // Keep the provider visible even if the account catalog is temporarily
      // unavailable. The next refresh retries the live catalog.
    }

    return {
      models: deduplicateModels(fallbackModelDescriptors()),
      loadedFromQoder: false,
    };
  }
}
