import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import {
  readConfig,
  type ModelOverride,
  type ReasoningEffort,
} from './config.js';
import type { QoderModelProvider } from './provider.js';
import type { QoderModelInformation } from './modelInformation.js';
import { TokenStore } from './tokenStore.js';
import {
  usageSnapshotFromInfo,
  type UsageSnapshot,
} from './usagePresentation.js';

const GITHUB_REPOSITORY_URL =
  'https://github.com/qianxunslimg/qoder-vscode-bridge';

type SettingKey =
  | 'maxTurns'
  | 'nativeToolResultTimeoutMs'
  | 'showActivity'
  | 'nativeToolLoop'
  | 'debugLogging';

interface ControlCenterMessage {
  readonly type?: string;
  readonly key?: string;
  readonly modelId?: string;
  readonly value?: unknown;
}

interface ControlCenterState {
  readonly extensionVersion: string;
  readonly patConfigured: boolean;
  readonly workspace: string | undefined;
  readonly loadedFromQoder: boolean;
  readonly refreshedAt: number;
  readonly models: readonly ModelSnapshot[];
  readonly config: {
    readonly modelOverrides: Readonly<Record<string, ModelOverride>>;
    readonly maxTurns: number;
    readonly nativeToolResultTimeoutMs: number;
    readonly showActivity: boolean;
    readonly nativeToolLoop: boolean;
    readonly debugLogging: boolean;
  };
  readonly usageStatus:
    | 'not-loaded'
    | 'loading'
    | 'loaded'
    | 'unavailable'
    | 'error';
  readonly usageMessage?: string;
  readonly usageUpdatedAt?: number;
  readonly usage?: UsageSnapshot;
}

interface ModelSnapshot {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly detail?: string;
  readonly tooltip?: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxContextWindow?: number;
  readonly defaultContextWindow?: number;
  readonly availableContextWindows?: readonly number[];
  readonly imageInput: boolean;
  readonly isDefault?: boolean;
  readonly isFree?: boolean;
  readonly isReasoning?: boolean;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
  readonly supportsDisabled?: boolean;
  readonly priceFactor?: number;
  readonly tags?: readonly string[];
  readonly override?: ModelOverride;
}

function packageVersion(): string {
  try {
    const extension = vscode.extensions.getExtension('qianxunslimg.qoder-vscode-bridge');
    return extension?.packageJSON?.version ?? 'development';
  } catch {
    return 'development';
  }
}

function modelSnapshot(
  model: QoderModelInformation,
  override: ModelOverride | undefined,
): ModelSnapshot {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    detail: model.detail,
    tooltip: model.tooltip,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    maxContextWindow: model.maxContextWindow,
    defaultContextWindow: model.defaultContextWindow,
    availableContextWindows: model.availableContextWindows,
    imageInput: model.capabilities.imageInput === true,
    isDefault: model.isDefault,
    isFree: model.isFree,
    isReasoning: model.isReasoning,
    efforts: model.efforts,
    defaultEffort: model.defaultEffort,
    supportsDisabled: model.supportsDisabled,
    priceFactor: model.priceFactor,
    tags: model.tags,
    override,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return character;
    }
  });
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return '未提供';
  }
  if (value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`;
  }
  if (value >= 1_000 && value % 1_000 === 0) {
    return `${value / 1_000}K`;
  }
  return `${value}`;
}

export class QoderControlCenter implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private latestState: ControlCenterState | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly provider: QoderModelProvider,
    private readonly tokenStore: TokenStore,
  ) {}

  public open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.sendState(false);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'qoderControlCenter',
      'Qoder Control Center',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.latestState = undefined;
    }, undefined, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(
      (message: ControlCenterMessage) => this.handleMessage(message),
      undefined,
      this.context.subscriptions,
    );
    void this.sendState(false);
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.latestState = undefined;
  }

  private async handleMessage(message: ControlCenterMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        // Paint a local/fallback state first. Catalog and usage are fetched in
        // parallel afterwards, so the page and its buttons become usable at once.
        await this.sendState(false);
        void this.sendStateWithUsage({ refreshCatalog: true, forceUsage: false });
        return;
      case 'refreshModels':
        await this.provider.refreshModels();
        await this.sendState(false);
        return;
      case 'refreshUsage':
        void this.sendStateWithUsage({ refreshCatalog: false, forceUsage: true });
        return;
      case 'setPat':
        await vscode.commands.executeCommand('qoderBridge.setPat');
        await this.sendState(false);
        void this.sendStateWithUsage({ refreshCatalog: true, forceUsage: true });
        return;
      case 'clearPat':
        await vscode.commands.executeCommand('qoderBridge.clearPat');
        this.latestState = undefined;
        await this.sendState(false);
        return;
      case 'openSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:qianxunslimg.qoder-vscode-bridge',
        );
        return;
      case 'openRepository':
        await vscode.env.openExternal(vscode.Uri.parse(GITHUB_REPOSITORY_URL));
        return;
      case 'setSetting':
        await this.updateSetting(message.key, message.value);
        await this.sendState(false);
        return;
      case 'setModelSetting':
        await this.updateModelSetting(
          message.modelId,
          message.key,
          message.value,
        );
        await this.sendState(false);
        return;
      default:
        return;
    }
  }

  private async updateSetting(
    key: string | undefined,
    value: unknown,
  ): Promise<void> {
    const allowed: readonly SettingKey[] = [
      'maxTurns',
      'nativeToolResultTimeoutMs',
      'showActivity',
      'nativeToolLoop',
      'debugLogging',
    ];
    if (!key || !allowed.includes(key as SettingKey)) {
      return;
    }

    const normalized = this.normalizeSetting(key as SettingKey, value);
    if (normalized === undefined) {
      return;
    }
    await vscode.workspace.getConfiguration('qoderBridge').update(
      key,
      normalized,
      vscode.ConfigurationTarget.Global,
    );
  }

  private normalizeSetting(key: SettingKey, value: unknown): unknown {
    switch (key) {
      case 'maxTurns': {
        const number = numberValue(value);
        return number === undefined
          ? undefined
          : Math.max(1, Math.min(100, Math.round(number)));
      }
      case 'nativeToolResultTimeoutMs': {
        const number = numberValue(value);
        return number === undefined
          ? undefined
          : Math.max(5_000, Math.min(1_800_000, Math.round(number)));
      }
      case 'showActivity':
      case 'nativeToolLoop':
      case 'debugLogging':
        return booleanValue(value);
      default:
        return undefined;
    }
  }

  private async updateModelSetting(
    modelId: string | undefined,
    key: string | undefined,
    value: unknown,
  ): Promise<void> {
    if (!modelId || !key || !['contextWindow', 'reasoningEffort'].includes(key)) {
      return;
    }
    const config = readConfig();
    const overrides: Record<string, ModelOverride> = {
      ...config.modelOverrides,
    };
    const current = { ...(overrides[modelId] ?? {}) };
    if (
      value === '__model_default__' ||
      value === '' ||
      (key === 'reasoningEffort' && value === 'auto')
    ) {
      delete current[key as keyof ModelOverride];
    } else if (key === 'contextWindow') {
      const contextWindow = numberValue(value);
      if (contextWindow === undefined || contextWindow <= 0) {
        return;
      }
      current.contextWindow = Math.floor(contextWindow);
    } else {
      const effort = String(value);
      if (![
        'auto',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
        'off',
      ].includes(effort)) {
        return;
      }
      current.reasoningEffort = effort as ReasoningEffort;
    }
    if (Object.keys(current).length === 0) {
      delete overrides[modelId];
    } else {
      overrides[modelId] = current;
    }
    await vscode.workspace.getConfiguration('qoderBridge').update(
      'modelOverrides',
      overrides,
      vscode.ConfigurationTarget.Global,
    );
  }

  private async state(allowNetwork = true): Promise<ControlCenterState> {
    const snapshot = await this.provider.getCatalogSnapshot(false, allowNetwork);
    const config = readConfig();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return {
      extensionVersion: packageVersion(),
      patConfigured: Boolean(await this.tokenStore.get()),
      workspace,
      loadedFromQoder: snapshot.loadedFromQoder,
      refreshedAt: snapshot.refreshedAt,
      models: snapshot.models.map((model) =>
        modelSnapshot(model, config.modelOverrides[model.id]),
      ),
      config: {
        modelOverrides: config.modelOverrides,
        maxTurns: config.maxTurns,
        nativeToolResultTimeoutMs: config.nativeToolResultTimeoutMs,
        showActivity: config.showActivity,
        nativeToolLoop: config.nativeToolLoop,
        debugLogging: config.debugLogging,
      },
      usageStatus: 'not-loaded',
    };
  }

  private async postState(state: ControlCenterState): Promise<void> {
    if (!this.panel) {
      return;
    }
    this.latestState = state;
    await this.panel.webview.postMessage({ type: 'state', state });
  }

  private async sendState(allowNetwork = false): Promise<void> {
    if (!this.panel) {
      return;
    }
    try {
      const next = await this.state(allowNetwork);
      const previous = this.latestState;
      await this.postState({
        ...next,
        usageStatus: previous?.usageStatus ?? next.usageStatus,
        usageMessage: previous?.usageMessage,
        usageUpdatedAt: previous?.usageUpdatedAt,
        usage: previous?.usage,
      });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendStateWithUsage(options: {
    readonly refreshCatalog: boolean;
    readonly forceUsage: boolean;
  }): Promise<void> {
    if (!this.panel) {
      return;
    }

    const current = this.latestState ?? await this.state(false);
    await this.postState({
      ...current,
      usageStatus: 'loading',
      usageMessage: '正在读取 Qoder 用量…',
    });

    const pat = await this.tokenStore.get();
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!pat || !cwd) {
      await this.postState({
        ...current,
        usageStatus: 'unavailable',
        usageMessage: !pat
          ? '请先配置 Qoder PAT'
          : '请先打开一个工作区',
      });
      return;
    }

    const statePromise = this.state(options.refreshCatalog);
    const usagePromise = this.provider.fetchUsage(pat, cwd, {
      force: options.forceUsage,
    });
    const [stateResult, usageResult] = await Promise.allSettled([
      statePromise,
      usagePromise,
    ]);
    const nextState = stateResult.status === 'fulfilled'
      ? stateResult.value
      : current;

    if (usageResult.status === 'fulfilled') {
      const usage = usageResult.value;
      await this.postState({
        ...nextState,
        usageStatus: usage ? 'loaded' : 'unavailable',
        usageMessage: usage
          ? undefined
          : 'Qoder 当前没有返回配额明细（可能需要稍后重试）',
        usageUpdatedAt: usage ? Date.now() : current.usageUpdatedAt,
        usage: usage ? usageSnapshotFromInfo(usage) : current.usage,
      });
      return;
    }

    await this.postState({
      ...nextState,
      usageStatus: 'error',
      usageMessage: usageResult.reason instanceof Error
        ? usageResult.reason.message
        : String(usageResult.reason),
      usage: current.usage,
      usageUpdatedAt: current.usageUpdatedAt,
    });
  }

  private html(webview: vscode.Webview): string {
    const pageNonce = nonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${pageNonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Qoder Control Center</title>
  <style>
    :root { color-scheme: dark; --bg: #0f1117; --panel: #171b24; --panel-2: #1d2430; --line: #2a3443; --muted: #9aa7ba; --text: #e8edf5; --accent: #4da3ff; --good: #5bd49a; --warn: #f4b860; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px 20px 28px; background: var(--bg); color: var(--text); font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { max-width: 1500px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
    h1 { margin: 0 0 2px; font-size: 19px; letter-spacing: -0.02em; }
    h2 { margin: 0; font-size: 14px; }
    h3 { margin: 0 0 6px; font-size: 13px; }
    .subtitle, .muted { color: var(--muted); }
    .subtitle { font-size: 11px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    button, select, input { color: var(--text); background: var(--panel-2); border: 1px solid var(--line); border-radius: 7px; padding: 5px 8px; font: inherit; }
    button { cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button.primary { background: #1f6fbd; border-color: #358edc; }
    button.danger { color: #ffb7b7; }
    select { min-width: 145px; }
    input[type=number] { width: 110px; }
    input[type=search] { width: 220px; }
    .status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warn); display: inline-block; }
    .dot.good { background: var(--good); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .card, .section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
    .card { padding: 10px 12px; min-height: 66px; }
    .metric { margin-top: 4px; font-size: 16px; font-weight: 650; }
    .section { padding: 12px 14px; margin-bottom: 12px; }
    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; }
    .setting { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-bottom: 1px solid #242c38; }
    .setting:last-child { border-bottom: 0; }
    .setting label { font-weight: 600; }
    .setting small { display: block; color: var(--muted); font-weight: 400; margin-top: 1px; }
    .models { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; align-items: start; }
    .model { align-self: start; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: #151a22; transition: border-color .16s ease, background-color .16s ease; }
    .model:hover { border-color: #3d6790; background: #171d27; }
    .model-title { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .model-heading { display: flex; align-items: baseline; gap: 9px; min-width: 0; flex-wrap: wrap; }
    .model-name { font-size: 16px; line-height: 1.2; font-weight: 650; letter-spacing: -0.01em; }
    .model-id { color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .model-status { flex: 0 0 auto; padding: 3px 7px; border: 1px solid #2b6c56; border-radius: 6px; background: #173b31; color: #8ce0b6; font-size: 10px; white-space: nowrap; }
    .model-meta { display: flex; flex-wrap: wrap; gap: 5px 14px; margin-top: 11px; padding-top: 10px; border-top: 1px solid #242c38; color: var(--muted); font-size: 11px; }
    .model-meta span { white-space: nowrap; }
    .model-meta strong { color: var(--text); font-weight: 600; }
    .model-controls { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 9px; margin-top: 12px; padding-top: 11px; border-top: 1px solid #242c38; }
    .model-controls.single { grid-template-columns: minmax(0, 1fr); }
    .model-control { display: grid; gap: 5px; color: var(--muted); font-size: 10px; }
    .model-control > span { letter-spacing: .01em; }
    .model-control select { width: 100%; min-width: 0; min-height: 30px; padding: 5px 8px; color: var(--text); }
    .model-control select:disabled { opacity: .7; cursor: not-allowed; }
    .model-footer { display: flex; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 10px; }
    .model-footer span:last-child { color: #b4c0d0; }
    .empty { padding: 16px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; }
    .notice { padding: 8px 10px; border-radius: 8px; background: #202c3b; color: #c8dfff; margin-bottom: 10px; }
    .notice.warn { background: #3d3020; color: #ffda98; }
    .usage-layout { display: grid; gap: 7px; }
    .usage-topline { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .usage-label { color: var(--muted); font-size: 11px; }
    .usage-stats, .usage-meta { display: flex; align-items: center; justify-content: flex-end; gap: 14px; flex-wrap: wrap; }
    .usage-stats strong, .usage-meta strong { color: var(--good); }
    .usage-progress { height: 7px; margin: 1px 0 2px; background: #29313d; border-radius: 99px; overflow: hidden; }
    .usage-progress span { display: block; height: 100%; background: var(--good); border-radius: inherit; }
    .usage-meta { color: var(--muted); font-size: 11px; }
    .usage-actions { display: inline-flex; align-items: center; gap: 8px; }
    .usage-state { color: var(--muted); font-size: 11px; }
    .usage-state.good { color: var(--good); }
    .usage-state.warn { color: var(--warn); }
    .usage-refresh[disabled] { cursor: wait; opacity: .75; }
    .spinner { width: 10px; height: 10px; display: inline-block; border: 2px solid #526071; border-top-color: var(--accent); border-radius: 50%; animation: qoder-spin .8s linear infinite; vertical-align: -1px; }
    @keyframes qoder-spin { to { transform: rotate(360deg); } }
    .repo-link { padding: 0; border: 0; background: transparent; color: #9ecbff; font-size: 11px; }
    .repo-link:hover { color: var(--text); border: 0; }
    .usage-empty { color: var(--muted); }
    @media (max-width: 900px) { body { padding: 14px; } .grid, .settings { grid-template-columns: 1fr 1fr; } .usage-topline { align-items: flex-start; flex-direction: column; gap: 5px; } .usage-stats, .usage-meta { justify-content: flex-start; } }
    @media (max-width: 760px) { .models { grid-template-columns: 1fr; } }
    @media (max-width: 620px) { header, .section-head { align-items: stretch; flex-direction: column; } .grid, .models, .settings { grid-template-columns: 1fr; } .actions { justify-content: flex-start; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Qoder 设置</h1>
        <button class="repo-link" data-action="openRepository">GitHub 仓库 ↗</button>
      </div>
      <div class="actions">
        <button class="primary" data-action="refreshModels">刷新模型目录</button>
        <button data-action="openSettings">VS Code 设置</button>
      </div>
    </header>
    <div id="app"><div class="empty">正在读取 Qoder 状态…</div></div>
  </main>
  <script nonce="${pageNonce}">
    const vscode = acquireVsCodeApi();
    let currentState;
    let query = '';
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const tokenLabel = (value) => {
      if (value === undefined || value === null) return '未提供';
      if (value >= 1000000 && value % 1000000 === 0) return (value / 1000000) + 'M';
      if (value >= 1000 && value % 1000 === 0) return (value / 1000) + 'K';
      return String(value);
    };
    const option = (value, label, selected) => '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    const setting = (key, value) => vscode.postMessage({ type: 'setSetting', key, value });
    const modelSetting = (modelId, key, value) => vscode.postMessage({ type: 'setModelSetting', modelId, key, value });
    const modelContextWindows = (model) => {
      const values = [...new Set([...(model.availableContextWindows || []), ...(model.maxContextWindow ? [model.maxContextWindow] : []), ...(model.override?.contextWindow ? [model.override.contextWindow] : [])])];
      return values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    };
    const modelEfforts = (model) => {
      const values = [...new Set([...(model.efforts || []), ...(model.defaultEffort ? [model.defaultEffort] : []), ...(model.supportsDisabled ? ['off'] : [])])];
      return values.filter((value) => value && value !== 'auto');
    };
    function renderModel(model) {
      const efforts = model.efforts || [];
      const contextWindows = modelContextWindows(model);
      const maxContext = model.maxContextWindow ?? contextWindows[contextWindows.length - 1];
      const selectedContext = model.override?.contextWindow ?? maxContext;
      const contextControl = contextWindows.length
        ? '<label class="model-control"><span>上下文窗口</span><select data-model-setting="contextWindow" data-model-id="' + escapeHtml(model.id) + '">' + contextWindows.map((value) => option(String(value), value === maxContext ? '最大 ' + tokenLabel(value) : tokenLabel(value), selectedContext === value)).join('') + '</select></label>'
        : '<label class="model-control"><span>上下文窗口</span><select disabled><option>模型默认</option></select></label>';
      const effortValues = modelEfforts(model);
      const showEffort = Boolean(model.isReasoning || efforts.length || model.supportsDisabled);
      const selectedEffort = model.override?.reasoningEffort ?? 'auto';
      const defaultEffortLabel = model.defaultEffort ? '模型默认 (' + model.defaultEffort + ')' : '模型默认';
      const effortControl = showEffort
        ? '<label class="model-control"><span>推理强度</span><select data-model-setting="reasoningEffort" data-model-id="' + escapeHtml(model.id) + '">' + option('auto', defaultEffortLabel, selectedEffort === 'auto') + effortValues.map((value) => option(value, value, selectedEffort === value)).join('') + '</select></label>'
        : '';
      const facts = [
        model.maxContextWindow ? '<span>最大上下文 <strong>' + tokenLabel(model.maxContextWindow) + '</strong></span>' : '<span>上下文 <strong>未提供</strong></span>',
        '<span>最大输出 <strong>' + tokenLabel(model.maxOutputTokens) + '</strong></span>',
        model.isReasoning ? '<span>推理</span>' : '',
        model.imageInput ? '<span>视觉</span>' : '',
      ].filter(Boolean);
      const overrideLabel = model.override ? '已自定义' : '使用模型默认';
      return '<article class="model">' +
        '<div class="model-title"><div class="model-heading"><div class="model-name">' + escapeHtml(model.name) + '</div><div class="model-id">' + escapeHtml(model.id) + '</div></div>' +
        (model.isDefault ? '<span class="model-status">服务端默认</span>' : '') + '</div>' +
        '<div class="model-meta">' + facts.join('') + '</div>' +
        '<div class="model-controls' + (effortControl ? '' : ' single') + '">' + contextControl + effortControl + '</div>' +
        '<div class="model-footer"><span>计费 ' + escapeHtml(factorLabel(model)) + '</span><span>' + overrideLabel + '</span></div>' +
        '</article>';
    }
    const numberLabel = (value) => value === undefined || value === null ? '未提供' : new Intl.NumberFormat('zh-CN').format(value);
    const percentLabel = (value) => value === undefined || value === null ? '未提供' : (Number.isInteger(value) ? String(value) : value.toFixed(1)) + '%';
    const dateLabel = (value) => {
      if (value === undefined || value === null) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    };
    const timeLabel = (value) => {
      if (value === undefined || value === null) return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
    };
    const factorLabel = (model) => {
      if (typeof model.priceFactor === 'number' && model.priceFactor > 0) return model.priceFactor.toFixed(2).replace(/0+$/, '').replace(/\\.$/, '') + 'x';
      if (model.isFree) return '免费（Qoder目录）';
      return '计费未提供';
    };
    const usageMarkup = (state) => {
      const usage = state.usage;
      if (!usage || !usage.primary) {
        return '<div class="usage-empty">' + escapeHtml(state.usageMessage || '正在读取用量…') + '</div>';
      }
      const bucket = usage.primary;
      const percent = Math.max(0, Math.min(100, bucket.percentage || 0));
      const secondary = usage.source !== 'organization' && usage.organization
        ? '<span>组织剩余 <strong>' + numberLabel(usage.organization.remaining) + '</strong></span>'
        : '';
      const expiry = dateLabel(usage.expiresAt)
        ? '<span>方案到期 <strong>' + escapeHtml(dateLabel(usage.expiresAt)) + '</strong></span>'
        : '';
      return '<div class="usage-layout">' +
        '<div class="usage-topline"><span class="usage-label">' + (usage.source === 'organization' ? '组织资源包' : '个人配额') + '</span>' +
        '<div class="usage-stats"><span>总量 <strong>' + numberLabel(bucket.total) + '</strong> ' + escapeHtml(bucket.unit) + '</span><span>已用 <strong>' + numberLabel(bucket.used) + '</strong>（' + percentLabel(bucket.percentage) + '）</span><span>剩余 <strong>' + numberLabel(bucket.remaining) + '</strong> ' + escapeHtml(bucket.unit) + '</span></div></div>' +
        '<div class="usage-progress"><span style="width:' + percent + '%"></span></div>' +
        '<div class="usage-meta"><span>方案 <strong>' + escapeHtml(usage.plan) + '</strong></span>' + expiry + secondary + '</div></div>';
    };
    function render(state) {
      currentState = state;
      const config = state.config;
      const usageLoading = state.usageStatus === 'loading';
      const usageButtonLabel = usageLoading ? '读取中…' : (state.usageStatus === 'error' ? '重试' : '刷新');
      const usageStateLabel = usageLoading
        ? '<span class="usage-state"><span class="spinner"></span>正在请求 Qoder 用量</span>'
        : state.usageStatus === 'loaded'
          ? '<span class="usage-state good">已更新 ' + escapeHtml(timeLabel(state.usageUpdatedAt)) + '</span>'
          : state.usageStatus === 'error'
            ? '<span class="usage-state warn">读取失败，可重试</span>'
            : '';
      const models = (state.models || []).filter((model) => {
        const haystack = (model.name + ' ' + model.id + ' ' + (model.description || '')).toLowerCase();
        return !query || haystack.includes(query.toLowerCase());
      });
      const totalModels = (state.models || []).length;
      document.getElementById('app').innerHTML =
        '<div class="grid">' +
          '<div class="card"><div class="muted">连接</div><div class="metric"><span class="dot ' + (state.patConfigured ? 'good' : '') + '"></span> ' + (state.patConfigured ? '已连接' : '未配置') + '</div></div>' +
          '<div class="card"><div class="muted">模型</div><div class="metric">' + totalModels + ' 个</div></div>' +
          '<div class="card"><div class="muted">原生工具</div><div class="metric">' + (config.nativeToolLoop ? '已启用' : '已关闭') + '</div></div>' +
          '<div class="card"><div class="muted">版本</div><div class="metric">' + escapeHtml(state.extensionVersion) + '</div></div>' +
        '</div>' +
        (!state.patConfigured ? '<div class="notice warn">未配置 Qoder PAT</div>' : '') +
        '<section class="section"><div class="section-head"><div><h2>运行设置</h2><div class="subtitle">宿主工具审批由 VS Code Chat 控制。</div></div><div class="status"><span class="dot ' + (state.loadedFromQoder ? 'good' : '') + '"></span>' + escapeHtml(state.extensionVersion) + '</div></div>' +
          '<div class="settings">' +
            '<div class="setting"><label>最大轮数</label><input type="number" min="1" max="100" data-setting="maxTurns" value="' + config.maxTurns + '" /></div>' +
            '<div class="setting"><label>工具超时(ms)</label><input type="number" min="5000" max="1800000" step="1000" data-setting="nativeToolResultTimeoutMs" value="' + config.nativeToolResultTimeoutMs + '" /></div>' +
            '<div class="setting"><label>活动摘要</label><input type="checkbox" data-setting="showActivity" ' + (config.showActivity ? 'checked' : '') + ' /></div>' +
            '<div class="setting"><label>原生工具循环</label><input type="checkbox" data-setting="nativeToolLoop" ' + (config.nativeToolLoop ? 'checked' : '') + ' /></div>' +
            '<div class="setting"><label>调试日志</label><input type="checkbox" data-setting="debugLogging" ' + (config.debugLogging ? 'checked' : '') + ' /></div>' +
          '</div>' +
          '<div class="actions" style="margin-top:10px;justify-content:flex-start"><button data-action="setPat">配置 PAT</button><button class="danger" data-action="clearPat">清除 PAT</button></div>' +
        '</section>' +
        '<section class="section"><div class="section-head"><h2>用量</h2><div class="usage-actions">' + usageStateLabel + '<button class="usage-refresh" data-action="refreshUsage"' + (usageLoading ? ' disabled' : '') + '>' + usageButtonLabel + '</button></div></div>' + usageMarkup(state) + '</section>' +
        '<section class="section"><div class="section-head"><div><h2>模型目录</h2><div class="subtitle">上下文窗口和推理强度在每张模型卡内单独设置。</div></div><div class="actions"><button data-action="refreshModels">刷新</button><input type="search" placeholder="搜索名称或 ID" value="' + escapeHtml(query) + '" data-search="models" /></div></div>' +
          (models.length ? '<div class="models">' + models.map(renderModel).join('') + '</div>' : '<div class="empty">没有匹配的模型。</div>') +
        '</section>';
    }
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      event.preventDefault();
      if (target.dataset.action === 'refreshUsage') {
        target.disabled = true;
        target.textContent = '读取中…';
      }
      vscode.postMessage({ type: target.dataset.action });
    });
    document.addEventListener('change', (event) => {
      const target = event.target.closest('[data-model-setting]');
      if (!target) return;
      modelSetting(target.dataset.modelId, target.dataset.modelSetting, target.value);
    });
    document.addEventListener('change', (event) => {
      const target = event.target.closest('[data-setting]');
      if (!target) return;
      const key = target.dataset.setting;
      const value = target.type === 'checkbox' ? target.checked : (target.type === 'number' ? Number(target.value) : target.value);
      setting(key, value);
    });
    document.addEventListener('input', (event) => {
      const target = event.target.closest('[data-search]');
      if (!target) return;
      const value = target.value;
      query = value;
      if (currentState) {
        render(currentState);
        const search = document.querySelector('[data-search="models"]');
        if (search) {
          search.focus();
          search.setSelectionRange(value.length, value.length);
        }
      }
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'state') render(event.data.state);
      if (event.data?.type === 'error') document.getElementById('app').innerHTML = '<div class="notice warn">读取失败：' + escapeHtml(event.data.message) + '</div>';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
