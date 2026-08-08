type JsonObject = Record<string, unknown>;

const INLINE_RESULT_MAX_CHARS = 2_400;
const INLINE_RESULT_MAX_LINES = 32;
const RESULT_PREVIEW_HEAD_LINES = 12;
const RESULT_PREVIEW_TAIL_LINES = 8;
const RESULT_PREVIEW_MAX_CHARS = 4_000;

function objectValue(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null
    ? (value as JsonObject)
    : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function displayText(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  const text = textValue(value)?.replace(/[\u0000-\u001f\u007f]/g, ' ');
  if (!text) {
    return fallback;
  }
  return redactSecrets(text.replace(/\s+/g, ' ')).slice(0, 160);
}

function errorText(value: unknown): string | undefined {
  const object = objectValue(value);
  return (
    textValue(object?.message) ??
    textValue(object?.error) ??
    textValue(value)
  );
}

function contentPreview(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return displayText(value, '');
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => contentPreview(item))
      .filter((item): item is string => Boolean(item))
      .join(' ');
    return text || undefined;
  }

  const object = objectValue(value);
  if (!object) {
    return undefined;
  }
  return (
    contentPreview(object.text) ??
    contentPreview(object.content) ??
    contentPreview(object.message)
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Extracts a readable result while preserving line breaks for code previews. */
function resultText(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    const text = redactSecrets(stripAnsi(value).replace(/\r\n?/g, '\n')).trim();
    return text || undefined;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => resultText(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('\n') : undefined;
  }

  const object = objectValue(value);
  if (!object) {
    return undefined;
  }

  const objectType = textValue(object.type);
  if (
    objectType &&
    objectType !== 'text' &&
    objectType !== 'json' &&
    objectType !== 'tool_result' &&
    object.source
  ) {
    return `[${objectType} 结果已省略]`;
  }

  const stdout = resultText(object.stdout, depth + 1);
  const stderr = resultText(object.stderr, depth + 1);
  if (stdout || stderr) {
    return [stdout, stderr ? `[stderr]\n${stderr}` : undefined]
      .filter((item): item is string => Boolean(item))
      .join('\n');
  }

  for (const key of [
    'text',
    'content',
    'output',
    'result',
    'message',
    'error',
  ]) {
    const nested = resultText(object[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  try {
    const serialized = JSON.stringify(object, null, 2);
    return serialized
      ? redactSecrets(stripAnsi(serialized)).trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function codeBlock(value: string): string {
  let longestBacktickRun = 0;
  for (const match of value.matchAll(/`+/g)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}text\n${value}\n${fence}\n\n`;
}

function resultMetrics(value: string): string {
  return `${value.split('\n').length} 行，${value.length} 字符`;
}

function resultBody(value: string): string {
  const lines = value.split('\n');
  const isInline =
    value.length <= INLINE_RESULT_MAX_CHARS &&
    lines.length <= INLINE_RESULT_MAX_LINES;
  if (isInline) {
    return codeBlock(value);
  }

  // VS Code renders provider text as Markdown, but does not turn arbitrary
  // HTML <details> tags into a collapsible card. Show a bounded head/tail
  // preview instead: the user gets evidence of what the tool found without
  // flooding the chat with a complete file or search result.
  const head = lines.slice(0, RESULT_PREVIEW_HEAD_LINES);
  const tail = lines.slice(-RESULT_PREVIEW_TAIL_LINES);
  const omittedLines = Math.max(0, lines.length - head.length - tail.length);
  const previewLines = omittedLines
    ? [
        ...head,
        `… 中间 ${omittedLines} 行已省略，完整结果未展开 …`,
        ...tail,
      ]
    : lines;
  let preview = previewLines.join('\n');
  if (preview.length > RESULT_PREVIEW_MAX_CHARS) {
    preview = `${preview.slice(0, RESULT_PREVIEW_MAX_CHARS)}\n… 预览已截断 …`;
  }

  const previewSummary = omittedLines
    ? `结果预览（${resultMetrics(value)}；显示前 ${head.length} 行和后 ${tail.length} 行，中间 ${omittedLines} 行已省略）`
    : `结果预览（${resultMetrics(value)}）`;
  return `**${previewSummary}**\n\n${codeBlock(preview)}`;
}

function toolResultNotice(
  toolName: string,
  failed: boolean,
  value: unknown,
): string {
  const text = resultText(value);
  if (!text) {
    return notice(`工具 \`${toolName}\` ${failed ? '失败' : '已完成'}。`);
  }

  const summary = failed ? contentPreview(value) : undefined;
  const header = `工具 \`${toolName}\` ${failed ? '失败' : '已完成'}（${resultMetrics(text)}）${
    summary ? `：${summary}` : '。'
  }`;
  return `${notice(header)}${resultBody(text)}`;
}

function notice(message: string): string {
  return `**Qoder**：${message}\n\n`;
}

function planNotice(taskDescription?: string): string {
  const task = taskDescription
    ? `执行子任务：${taskDescription}`
    : '按需调用工具并核对结果';
  return [
    '**Qoder**：执行计划',
    '',
    '1. 分析请求与上下文',
    `2. ${task}`,
    '3. 汇总结果并回复',
    '',
    '',
  ].join('\n');
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bpt-[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(
      /\b((?:api[-_ ]?key|access[-_ ]?token|password|passwd|secret|authorization))\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    );
}

function toolDetail(toolName: string, input: unknown): string | undefined {
  const values = objectValue(input);
  if (!values) {
    return undefined;
  }

  const normalizedName = toolName.toLowerCase();
  if (
    normalizedName.includes('bash') ||
    normalizedName.includes('shell') ||
    normalizedName.includes('command')
  ) {
    const command = textValue(values.command) ?? textValue(values.cmd) ?? textValue(values.script);
    return command
      ? `操作：执行命令 \`${displayText(command, '命令').replace(/`/g, "'")}\``
      : undefined;
  }

  const path =
    textValue(values.file_path) ??
    textValue(values.path) ??
    textValue(values.filename) ??
    textValue(values.file);
  if (path && /(read|write|edit|file|notebook|patch)/i.test(normalizedName)) {
    return `操作：处理文件 \`${displayText(path, '文件').replace(/`/g, "'")}\``;
  }

  const pattern = textValue(values.pattern) ?? textValue(values.query);
  if (pattern && /(grep|glob|search|find)/i.test(normalizedName)) {
    return `操作：搜索 \`${displayText(pattern, '内容').replace(/`/g, "'")}\``;
  }

  return undefined;
}

function contentParts(message: JsonObject): JsonObject[] {
  const content = messageValue(message, 'content');
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(objectValue).filter((part): part is JsonObject => !!part);
}

function messageValue(message: JsonObject, key: string): unknown {
  return message[key];
}

/**
 * Turns Qoder's event stream into concise, user-visible activity notices.
 *
 * The SDK exposes raw thinking deltas. We deliberately do not forward those
 * deltas: they are hidden chain-of-thought, not an auditable activity log.
 * Tool names and lifecycle events are safe, useful progress signals instead.
 */
export class QoderActivityTracker {
  private readonly toolNames = new Map<string, string>();
  private readonly startedTools = new Set<string>();
  private readonly detailedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly toolInputBuffers = new Map<string, string>();
  private thinkingActive = false;
  private thinkingRound = 0;
  private lastProgressKey: string | undefined;
  private activeToolId: string | undefined;
  private activeTaskDescription: string | undefined;
  private planShown = false;
  private startedToolCount = 0;
  private completedToolCount = 0;

  public begin(): string {
    this.thinkingActive = true;
    this.thinkingRound = 1;
    return notice('已接收请求，正在分析……');
  }

  public consume(message: unknown): string[] {
    const record = objectValue(message);
    if (!record) {
      return [];
    }

    const notices: string[] = [];
    const type = textValue(record.type);

    if (type === 'stream_event') {
      this.consumeStreamEvent(objectValue(record.event), notices);
    } else if (type === 'assistant' || type === 'user') {
      this.consumeMessageContent(objectValue(record.message), type, notices);
    } else if (type === 'system') {
      this.consumeSystemMessage(record, notices);
    } else if (type === 'result') {
      this.consumeResult(record, notices);
    }

    return notices;
  }

  private consumeStreamEvent(
    event: JsonObject | undefined,
    notices: string[],
  ): void {
    if (!event) {
      return;
    }

    const eventType = textValue(event.type);
    if (eventType === 'content_block_start') {
      const block = objectValue(event.content_block);
      const blockType = textValue(block?.type);
      if (blockType === 'thinking') {
        this.startThinking(notices);
      } else if (blockType === 'tool_use') {
        this.startTool(block, notices);
      } else if (blockType === 'text') {
        this.thinkingActive = false;
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = objectValue(event.delta);
      if (textValue(delta?.type) !== 'input_json_delta') {
        return;
      }

      const partialJson =
        typeof delta?.partial_json === 'string' ? delta.partial_json : '';
      if (!this.activeToolId || !partialJson) {
        return;
      }

      const inputJson =
        (this.toolInputBuffers.get(this.activeToolId) ?? '') + partialJson;
      this.toolInputBuffers.set(this.activeToolId, inputJson);
      try {
        const input = JSON.parse(inputJson) as unknown;
        this.reportToolDetail(
          this.activeToolId,
          this.toolNames.get(this.activeToolId) ?? '工具',
          input,
          notices,
        );
      } catch {
        // Tool arguments arrive in fragments. Wait until the JSON is complete.
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      this.thinkingActive = false;
      this.activeToolId = undefined;
      return;
    }

    // `thinking_delta` intentionally produces no text. It is hidden reasoning,
    // while `input_json_delta` above is an auditable tool operation preview.
  }

  private consumeMessageContent(
    message: JsonObject | undefined,
    messageType: string,
    notices: string[],
  ): void {
    if (!message) {
      return;
    }

    for (const part of contentParts(message)) {
      const partType = textValue(part.type);
      if (partType === 'thinking') {
        this.startThinking(notices);
      } else if (partType === 'tool_use') {
        this.startTool(part, notices);
      } else if (messageType === 'user' && partType === 'tool_result') {
        this.finishTool(part, notices);
      } else if (partType === 'text') {
        this.thinkingActive = false;
      }
    }
  }

  private startThinking(notices: string[]): void {
    if (this.thinkingActive) {
      return;
    }
    this.thinkingActive = true;
    this.thinkingRound += 1;
    if (this.thinkingRound === 1) {
      notices.push(notice('正在分析请求……'));
      return;
    }
    notices.push(
      notice(
        `思考摘要：第 ${this.thinkingRound} 轮，已完成 ${this.completedToolCount} 个工具，正在基于结果决定下一步……`,
      ),
    );
  }

  private startTool(block: JsonObject | undefined, notices: string[]): void {
    if (!block) {
      return;
    }

    const toolId = textValue(block.id) ?? displayText(block.name, 'tool');
    const toolName = displayText(block.name, '未知工具').replace(/`/g, "'");
    this.toolNames.set(toolId, toolName);
    this.activeToolId = toolId;
    this.thinkingActive = false;
    if (!this.startedTools.has(toolId)) {
      this.startedTools.add(toolId);
      this.startedToolCount += 1;
      this.ensurePlan(notices);
      const detail = toolDetail(toolName, block.input);
      if (detail) {
        this.detailedTools.add(toolId);
        notices.push(
          notice(
            `进度摘要：步骤 ${this.startedToolCount}，调用工具 \`${toolName}\`……\n\n${detail}`,
          ),
        );
      } else {
        notices.push(
          notice(
            `进度摘要：步骤 ${this.startedToolCount}，调用工具 \`${toolName}\`……`,
          ),
        );
      }
    }

    this.reportToolDetail(toolId, toolName, block.input, notices);
  }

  private reportToolDetail(
    toolId: string,
    toolName: string,
    input: unknown,
    notices: string[],
  ): void {
    const detail = toolDetail(toolName, input);
    if (detail && !this.detailedTools.has(toolId)) {
      this.detailedTools.add(toolId);
      notices.push(notice(detail));
    }
  }

  private finishTool(block: JsonObject, notices: string[]): void {
    const toolId = textValue(block.tool_use_id);
    if (!toolId || this.completedTools.has(toolId)) {
      return;
    }
    this.completedTools.add(toolId);
    this.completedToolCount += 1;
    const toolName = this.toolNames.get(toolId) ?? '工具';
    const failed = block.is_error === true;
    notices.push(toolResultNotice(toolName, failed, block.content));
    this.toolInputBuffers.delete(toolId);
  }

  private consumeSystemMessage(record: JsonObject, notices: string[]): void {
    const subtype = textValue(record.subtype);
    switch (subtype) {
      case 'init':
        this.pushDistinct(
          'runtime:init',
          `运行时已启动，当前模型：${displayText(record.model, '当前模型')}`,
          notices,
        );
        break;
      case 'task_started':
        this.activeTaskDescription = displayText(
          record.description,
          '执行子任务',
        );
        this.ensurePlan(notices);
        this.pushDistinct(
          `task:${displayText(record.task_id, 'unknown')}:started`,
          `进度摘要：开始任务「${this.activeTaskDescription}」`,
          notices,
        );
        break;
      case 'task_progress': {
        const summary = textValue(record.summary);
        const tool = textValue(record.last_tool_name);
        if (summary || tool) {
          this.ensurePlan(notices);
          this.pushDistinct(
            `task:${displayText(record.task_id, 'unknown')}:${summary ?? tool}`,
            summary
              ? `进度摘要：${displayText(summary, '继续执行')}`
              : `进度摘要：正在使用 \`${displayText(tool, '工具').replace(/`/g, "'")}\``,
            notices,
          );
        }
        break;
      }
      case 'task_notification':
        this.ensurePlan(notices);
        this.pushDistinct(
          `task:${displayText(record.task_id, 'unknown')}:${subtype}:${record.status}`,
          `进度摘要：任务${record.status === 'completed' ? '完成' : '未完成'}：${displayText(record.summary, '子任务已结束')}`,
          notices,
        );
        break;
      case 'hook_started':
        notices.push(notice(`执行钩子：${displayText(record.hook_name, 'hook')}`));
        break;
      case 'hook_response':
        notices.push(
          notice(
            `钩子 ${displayText(record.hook_name, 'hook')} ${record.outcome === 'success' ? '已完成' : '未成功'}。`,
          ),
        );
        break;
      case 'api_retry':
        {
          const delay =
            typeof record.retry_delay_ms === 'number' &&
            Number.isFinite(record.retry_delay_ms)
              ? `，${Math.max(0, Math.round(record.retry_delay_ms))}ms 后`
              : '';
          const status =
            typeof record.error_status === 'number'
              ? `，HTTP ${record.error_status}`
              : '';
          const error = errorText(record.error);
          const detail = error ? `：${displayText(error, '请求失败')}` : '……';
          notices.push(
            notice(
              `请求重试（第 ${displayText(record.attempt, '未知')} / ${displayText(record.max_retries, '未知')} 次${delay}${status}）${detail}`,
            ),
          );
        }
        break;
      case 'status':
        if (record.status === 'compacting') {
          notices.push(notice('正在整理上下文……'));
        }
        break;
      case 'permission_denied':
        notices.push(
          notice(
            `工具 \`${displayText(record.tool_name, '工具').replace(/`/g, "'")}\` 被权限策略拒绝。`,
          ),
        );
        break;
      default:
        break;
    }
  }

  private consumeResult(record: JsonObject, notices: string[]): void {
    if (record.subtype === 'success') {
      const turns = displayText(record.num_turns, '未知');
      notices.push(
        notice(
          `执行完成：共 ${turns} 轮，已完成 ${this.completedToolCount} 个工具。`,
        ),
      );
      return;
    }

    notices.push(
      notice(
        `执行未完成（${displayText(record.subtype, '未知原因')}），已完成 ${this.completedToolCount} 个工具。`,
      ),
    );
  }

  private ensurePlan(notices: string[]): void {
    if (this.planShown) {
      return;
    }
    this.planShown = true;
    notices.push(planNotice(this.activeTaskDescription));
  }

  private pushDistinct(key: string, message: string, notices: string[]): void {
    if (key === this.lastProgressKey) {
      return;
    }
    this.lastProgressKey = key;
    notices.push(notice(message));
  }
}
