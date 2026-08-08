import assert from 'node:assert/strict';
import test from 'node:test';

import { QoderActivityTracker } from '../out/activity.js';

test('summarizes thinking without exposing the hidden reasoning text', () => {
  const tracker = new QoderActivityTracker();

  assert.deepEqual(
    tracker.consume({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'thinking' },
      },
    }),
    ['> **Qoder**：正在分析请求……\n\n'],
  );

  assert.deepEqual(
    tracker.consume({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'secret chain of thought' },
      },
    }),
    [],
  );
});

test('reports tool start and completion without exposing tool input', () => {
  const tracker = new QoderActivityTracker();

  assert.deepEqual(
    tracker.consume({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tool-1', name: 'Bash' },
      },
    }),
    ['> **Qoder**：调用工具 `Bash`……\n\n'],
  );

  assert.deepEqual(
    tracker.consume({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            is_error: false,
            content: 'secret command output',
          },
        ],
      },
    }),
    ['> **Qoder**：工具 `Bash` 已完成。\n\n'],
  );
});

test('shows a redacted operation preview when the full tool input arrives', () => {
  const tracker = new QoderActivityTracker();
  tracker.consume({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'tool-2', name: 'Bash' },
    },
  });

  const updates = tracker.consume({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'Bash',
          input: { command: 'echo pt-secret-token' },
        },
      ],
    },
  });

  assert.deepEqual(updates, [
    '> **Qoder**：操作：执行命令 `echo [redacted-token]`\n\n',
  ]);
  assert.equal(updates.join('').includes('pt-secret-token'), false);
});

test('shows a redacted operation preview when tool input is streamed as JSON deltas', () => {
  const tracker = new QoderActivityTracker();
  tracker.consume({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'tool-stream', name: 'Bash', input: {} },
    },
  });

  assert.deepEqual(
    tracker.consume({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: {
          type: 'input_json_delta',
          partial_json: '{"command":"git status',
        },
      },
    }),
    [],
  );

  const updates = tracker.consume({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: {
        type: 'input_json_delta',
        partial_json: ' --short", "description":"Inspect pt-secret-token"}',
      },
    },
  });

  assert.deepEqual(updates, [
    '> **Qoder**：操作：执行命令 `git status --short`\n\n',
  ]);
  assert.equal(updates.join('').includes('pt-secret-token'), false);
});

test('includes a redacted failure summary for a failed tool result', () => {
  const tracker = new QoderActivityTracker();
  tracker.consume({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'tool-failed', name: 'Bash' },
    },
  });

  const updates = tracker.consume({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-failed',
          is_error: true,
          content: 'command failed: access-token=pt-secret-token',
        },
      ],
    },
  });

  assert.deepEqual(updates, [
    '> **Qoder**：工具 `Bash` 失败：command failed: access-token=[redacted]\n\n',
  ]);
  assert.equal(updates.join('').includes('pt-secret-token'), false);
});

test('reports task progress and result turns', () => {
  const tracker = new QoderActivityTracker();

  assert.deepEqual(
    tracker.consume({
      type: 'system',
      subtype: 'task_started',
      description: 'Inspect the workspace',
    }),
    ['> **Qoder**：开始任务：Inspect the workspace\n\n'],
  );

  assert.deepEqual(
    tracker.consume({
      type: 'result',
      subtype: 'success',
      num_turns: 3,
    }),
    ['> **Qoder**：完成，共 3 轮。\n\n'],
  );
});

test('explains retry timing and status without leaking the error token', () => {
  const tracker = new QoderActivityTracker();

  const updates = tracker.consume({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 1500,
    error_status: 429,
    error: { message: 'access-token=pt-secret-token was rate limited' },
  });

  assert.deepEqual(updates, [
    '> **Qoder**：请求重试（第 1 / 10 次，1500ms 后，HTTP 429）：access-token=[redacted] was rate limited\n\n',
  ]);
  assert.equal(updates.join('').includes('pt-secret-token'), false);
});

test('marks the runtime boundary so startup latency is visible', () => {
  const tracker = new QoderActivityTracker();

  assert.deepEqual(
    tracker.consume({
      type: 'system',
      subtype: 'init',
      model: 'Auto',
    }),
    ['> **Qoder**：运行时已启动，当前模型：Auto\n\n'],
  );
});
