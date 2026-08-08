import * as path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { QODER_READ_FILE_TOOL_NAME } from './nativeToolLoop.js';

const DEFAULT_LINE_LIMIT = 200;
const MAX_LINE_LIMIT = 2_000;

export interface QoderReadFileInput {
  readonly file_path: string;
  readonly offset?: number;
  readonly limit?: number;
}

function cancellationSignal(token: vscode.CancellationToken): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const disposable = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) {
    controller.abort();
  }
  return { signal: controller.signal, dispose: () => disposable.dispose() };
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.resolve(folder.uri.fsPath),
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveWorkspaceFile(filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error('qoder_read_file requires a non-empty file_path.');
  }
  const resolved = path.resolve(normalized);
  const roots = workspaceRoots();
  if (roots.length === 0) {
    throw new Error('Open a workspace folder before using qoder_read_file.');
  }
  if (!roots.some((root) => isInside(root, resolved))) {
    throw new Error('qoder_read_file can only read files inside the current workspace.');
  }
  return resolved;
}

function boundedLines(
  text: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, Math.floor(offset ?? 0));
  const count = Math.min(
    MAX_LINE_LIMIT,
    Math.max(1, Math.floor(limit ?? DEFAULT_LINE_LIMIT)),
  );
  const selected = lines.slice(start, start + count);
  const prefix = `Lines ${start + 1}-${Math.min(start + count, lines.length)} of ${lines.length}:\n`;
  const suffix = start + count < lines.length ? '\n… remaining lines omitted …' : '';
  return `${prefix}${selected.join('\n')}${suffix}`;
}

export async function readWorkspaceFile(
  input: QoderReadFileInput,
  token: vscode.CancellationToken,
): Promise<string> {
  const requestedPath = resolveWorkspaceFile(input.file_path);
  const filePath = await realpath(requestedPath);
  if (!workspaceRoots().some((root) => isInside(root, filePath))) {
    throw new Error('qoder_read_file cannot follow a symlink outside the current workspace.');
  }
  const { signal, dispose } = cancellationSignal(token);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Not a regular file: ${filePath}`);
    }
    const text = await readFile(filePath, { encoding: 'utf8', signal });
    return boundedLines(text, input.offset, input.limit);
  } finally {
    dispose();
  }
}

export class QoderReadFileTool
  implements vscode.LanguageModelTool<QoderReadFileInput>
{
  public prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<QoderReadFileInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const filePath = options.input.file_path || '未指定文件';
    return {
      invocationMessage: `读取文件 ${filePath}`,
      confirmationMessages: {
        title: '允许 Qoder 读取工作区文件？',
        message: new vscode.MarkdownString(
          `Qoder 请求以只读方式读取：\n\n\`${filePath.replace(/`/g, "'")}\``,
        ),
      },
    };
  }

  public async invoke(
    options: vscode.LanguageModelToolInvocationOptions<QoderReadFileInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const result = await readWorkspaceFile(options.input, token);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result),
    ]);
  }
}

export function registerQoderReadFileTool(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.lm.registerTool(QODER_READ_FILE_TOOL_NAME, new QoderReadFileTool()),
  );
}
