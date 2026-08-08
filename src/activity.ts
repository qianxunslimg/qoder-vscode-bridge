type JsonObject = Record<string, unknown>;

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

function notice(message: string): string {
  return `> **Qoder**：${message}\n\n`;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bpt-[A-Za-z0-9_-]+\b/g, '[redacted-token]')
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
  private lastProgressKey: string | undefined;
  private activeToolId: string | undefined;

  public begin(): string {
    this.thinkingActive = true;
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
    notices.push(notice('正在分析请求……'));
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
      notices.push(notice(`调用工具 \`${toolName}\`……`));
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
    const toolName = this.toolNames.get(toolId) ?? '工具';
    const failed = block.is_error === true;
    const summary = failed ? contentPreview(block.content) : undefined;
    notices.push(
      notice(
        `工具 \`${toolName}\` ${failed ? '失败' : '已完成'}${
          summary ? `：${summary}` : '。'
        }`,
      ),
    );
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
        this.pushDistinct(
          `task:${displayText(record.task_id, 'unknown')}:started`,
          `开始任务：${displayText(record.description, '执行子任务')}`,
          notices,
        );
        break;
      case 'task_progress': {
        const summary = textValue(record.summary);
        const tool = textValue(record.last_tool_name);
        if (summary || tool) {
          this.pushDistinct(
            `task:${displayText(record.task_id, 'unknown')}:${summary ?? tool}`,
            summary
              ? `任务进度：${displayText(summary, '继续执行')}`
              : `任务进度：正在使用 \`${displayText(tool, '工具').replace(/`/g, "'")}\``,
            notices,
          );
        }
        break;
      }
      case 'task_notification':
        this.pushDistinct(
          `task:${displayText(record.task_id, 'unknown')}:${subtype}:${record.status}`,
          `任务${record.status === 'completed' ? '完成' : '未完成'}：${displayText(record.summary, '子任务已结束')}`,
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
      notices.push(notice(`完成，共 ${turns} 轮。`));
      return;
    }

    notices.push(notice(`执行未完成（${displayText(record.subtype, '未知原因')}）。`));
  }

  private pushDistinct(key: string, message: string, notices: string[]): void {
    if (key === this.lastProgressKey) {
      return;
    }
    this.lastProgressKey = key;
    notices.push(notice(message));
  }
}
